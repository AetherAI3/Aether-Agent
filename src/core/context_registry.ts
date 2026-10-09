// src/core/context_registry.ts — session-scoped context memory manager.
//
// /pin    — force a file/module into persistent context
// /drop   — evict a file from context
// /snapshot — save registry + session metadata to disk
// /limit  — hard UVT cap for the session
//
// All data is in-memory for the current REPL session. /snapshot serializes
// to ~/.aether-agent/snapshots/<timestamp>.json so sessions can be resumed.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApiClient } from "./transport.js";
import { AGENT_CONTEXT_PATH } from "./transport.js";
import type { HudElementId, HudTimer } from "./hud.js";
import { createTimer, timerSwitch } from "./hud.js";
import type { AdmittedContext, PinSelection } from "./selected_context.js";

// ── Types ──
import { confineToWorkspace, isCurrentWorkspace, normalizeWorkspace, resolveOpaqueChild } from "./workspace_scope.js";
export interface PinnedEntry {
  /** File path or module identifier. */
  path: string;
  /** Human label (filename, interface name, etc.). */
  label: string;
  /** Why it was pinned — shown on /snapshot resume so agent knows what mattered. */
  reason: string;
  /** ISO timestamp when pinned. */
  pinnedAt: string;
}

export interface SnapshotData {
  /** ISO timestamp of snapshot. */
  createdAt: string;
  /** The active branch / task description. */
  sessionLabel: string;
  /** Pinned entries at snapshot time. */
  pins: PinnedEntry[];
  /** Dropped paths (for reference — what was intentionally evicted). */
  drops: string[];
  /** UVT cap if set. */
  uvtCap: number | null;
  /** UVT spent so far (read from custody log). */
  uvtSpent: number;
  /** Active plan file path (if any). */
  planPath: string | null;
  /** Working directory. */
  cwd?: string;
  /** Active HUD elements. */
  hudElements: HudElementId[];
  /** HUD timer state. */
  hudTimer: HudTimer;
}

// ── In-memory state (one per REPL session) ──

export class ContextRegistry {
  pins: PinnedEntry[] = [];
  drops: string[] = [];
  /** Workspace from which pin paths were selected; never sent in registry sync. */
  originWorkspace: string | null = null;
  /** Frozen turn context for the local /context inspector, never snapshotted. */
  lastAdmitted: AdmittedContext | null = null;
  uvtCap: number | null = null;

  /**
   * Session UVT actually reported by the server. null means NO authoritative
   * frame has been seen — which is not the same as zero, and must never be
   * rendered as it. Only the server knows what a turn cost; nothing here
   * estimates it from token counts.
   */
  uvtObserved: number | null = null;

  /** Turn ids already settled, so a replayed terminal frame cannot double-count. */
  private readonly settledTurns = new Set<string>();

  /** True once this session is known to run on a local, un-metered brain. */
  private localUnmetered = false;

  /**
   * Back-compat accessor for the HUD, which needs a number. It reports 0 when
   * usage is UNKNOWN, so anything that must tell those apart has to read
   * uvtObserved instead.
   */
  get uvtSpent(): number {
    return this.uvtObserved ?? 0;
  }
  set uvtSpent(value: number) {
    this.uvtObserved = value;
  }
  planPath: string | null = null;
  sessionLabel = "untitled";

  // HUD state
  hudElements: HudElementId[] = [];
  hudTimer: HudTimer = createTimer();

  pin(path: string, label: string, reason: string, originWorkspace?: string): PinnedEntry {
    if (originWorkspace) {
      const origin = normalizeWorkspace(originWorkspace);
      if (this.originWorkspace && !isCurrentWorkspace(this.originWorkspace, origin)) {
        throw new Error("pins belong to another workspace; clear or restore that context before pinning here");
      }
      path = confineToWorkspace(origin, path);
      this.originWorkspace = origin;
    }
    // Deduplicate — remove from drops if it was dropped, update pin
    this.drops = this.drops.filter((d) => d !== path);
    const existing = this.pins.findIndex((p) => p.path === path);
    const entry: PinnedEntry = { path, label, reason, pinnedAt: new Date().toISOString() };
    if (existing >= 0) {
      this.pins[existing] = entry;
    } else {
      this.pins.push(entry);
    }
    return entry;
  }

  selectedPins(): PinSelection {
    return { originRoot: this.originWorkspace, entries: this.pins.map((pin) => ({ ...pin })) };
  }

  drop(path: string): boolean {
    this.pins = this.pins.filter((p) => p.path !== path);
    if (this.pins.length === 0) this.originWorkspace = null;
    if (!this.drops.includes(path)) {
      this.drops.push(path);
      return true;
    }
    return false; // already dropped
  }

  isPinned(path: string): boolean {
    return this.pins.some((p) => p.path === path);
  }

  setUvtCap(amount: number): void {
    this.uvtCap = amount;
  }

  /** Mark a turn as in flight. Idempotent. */
  beginTurn(turnId: string): void {
    this.settledTurns.delete(turnId);
  }

  /**
   * Record a turn's authoritative cost, once. The terminal frame carries the
   * turn total, and a reconnect can replay it, so settling is keyed by turn id
   * rather than accumulated blindly.
   */
  settleTurn(turnId: string, uvt: number): void {
    if (this.settledTurns.has(turnId)) return;
    if (!Number.isFinite(uvt) || uvt < 0) return;
    this.settledTurns.add(turnId);
    this.uvtObserved = (this.uvtObserved ?? 0) + uvt;
  }

  /** This session runs on a local brain, so Aether meters nothing. */
  markLocalUnmetered(): void {
    this.localUnmetered = true;
  }

  usageStatus(): "unknown" | "observed" | "local-unmetered" {
    if (this.localUnmetered) return "local-unmetered";
    return this.uvtObserved == null ? "unknown" : "observed";
  }

  /** Track a temporary file so /purge can clean it up. */
  tempFiles: string[] = [];

  trackTempFile(path: string): void {
    if (!this.tempFiles.includes(path)) {
      this.tempFiles.push(path);
    }
  }

  /** Purge all transient state: pins, drops, UVT cap, temp files.
   *  Session label is preserved so the goal isn't lost. */
  purge(): { clearedPins: number; removedFiles: number } {
    const clearedPins = this.pins.length;
    this.pins = [];
    this.originWorkspace = null;
    this.lastAdmitted = null;
    this.drops = [];
    this.uvtCap = null;
    this.uvtObserved = null;
    this.settledTurns.clear();

    let removedFiles = 0;
    for (const f of this.tempFiles) {
      try { if (existsSync(f)) { unlinkSync(f); removedFiles++; } } catch { /* best effort */ }
    }
    this.tempFiles = [];

    return { clearedPins, removedFiles };
  }

  /**
   * Is the operator's session cap reached?
   *
   * This is a local circuit breaker, not a billing ledger. The server remains
   * the billing authority; tripping this stops the terminal from starting
   * another billable turn, and changes nothing about the account.
   *
   * Two states deliberately do NOT trip it: an unmetered local session (there
   * is no Aether spend to cap) and a session where no authoritative usage has
   * been seen (there is no evidence the cap was reached, and guessing would
   * either block work that cost nothing or wave through work that cost a lot).
   */
  checkUvtCap(): {
    capped: boolean;
    /** null when there is no measured spend to subtract — NOT the full cap. */
    remaining: number | null;
    cap: number | null;
    observed: number | null;
    status: "unknown" | "observed" | "local-unmetered";
  } {
    const status = this.usageStatus();
    const observed = this.uvtObserved;
    // Unknown spend yields a null headroom, never the whole cap. Reporting the
    // full cap as remaining is the same false zero in a different costume: it
    // tells the user they have their entire budget left when the truth is that
    // nobody has measured any of it.
    if (status !== "observed" || observed == null) {
      return { capped: false, remaining: null, cap: this.uvtCap, observed, status };
    }
    if (this.uvtCap == null) {
      return { capped: false, remaining: null, cap: null, observed, status };
    }
    const remaining = this.uvtCap - observed;
    return { capped: remaining <= 0, remaining: Math.max(0, remaining), cap: this.uvtCap, observed, status };
  }

  // ── HUD methods ──

  addHudElement(id: HudElementId): boolean {
    if (this.hudElements.includes(id)) return false;
    this.hudElements.push(id);
    return true;
  }

  removeHudElement(id: HudElementId): boolean {
    const idx = this.hudElements.indexOf(id);
    if (idx === -1) return false;
    this.hudElements.splice(idx, 1);
    return true;
  }

  hasHudElement(id: HudElementId): boolean {
    return this.hudElements.includes(id);
  }

  clearHud(): void {
    this.hudElements = [];
  }

  startAgentTimer(): void {
    timerSwitch(this.hudTimer, "agent");
  }

  startUserTimer(): void {
    timerSwitch(this.hudTimer, "user");
  }

  /** Export snapshot data for serialization. */
  toSnapshot(cwd: string): SnapshotData {
    return {
      createdAt: new Date().toISOString(),
      sessionLabel: this.sessionLabel,
      pins: [...this.pins],
      drops: [...this.drops],
      uvtCap: this.uvtCap,
      uvtSpent: this.uvtSpent,
      planPath: this.planPath,
      cwd: normalizeWorkspace(cwd),
      hudElements: [...this.hudElements],
      hudTimer: { ...this.hudTimer },
    };
  }

  /** Restore from a snapshot file. */
  static fromSnapshot(data: SnapshotData, cwd: string): ContextRegistry {
    if (!isCurrentWorkspace(data.cwd, cwd)) {
      throw new Error(data.cwd ? "snapshot belongs to another workspace" : "legacy unscoped snapshot cannot be restored");
    }
    if (!Array.isArray(data.pins) || !Array.isArray(data.drops)) throw new Error("invalid snapshot");
    const reg = new ContextRegistry();
    reg.originWorkspace = normalizeWorkspace(cwd);
    reg.sessionLabel = data.sessionLabel;
    reg.pins = data.pins.map((pin) => ({ ...pin, path: confineToWorkspace(cwd, pin.path) }));
    reg.drops = data.drops.map((path) => confineToWorkspace(cwd, path));
    reg.uvtCap = data.uvtCap;
    reg.uvtSpent = data.uvtSpent;
    reg.planPath = data.planPath;
    reg.hudElements = data.hudElements ?? [];
    reg.hudTimer = data.hudTimer ?? createTimer();
    return reg;
  }
}

// ── Singleton ──

let _registry: ContextRegistry | null = null;

export function getRegistry(): ContextRegistry {
  if (!_registry) _registry = new ContextRegistry();
  return _registry;
}

/** Reset the registry (e.g., on /clear or new session). */
export function resetRegistry(): void {
  _registry = new ContextRegistry();
}

// ── Snapshot persistence ──

export function snapshotsRoot(): string {
  return process.env["AETHER_SNAPSHOT_DIR"] ?? join(homedir(), ".aether-agent", "snapshots");
}

export function saveSnapshot(reg: ContextRegistry, cwd: string, dir: string = snapshotsRoot()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = reg.toSnapshot(cwd);
  const filename = `snapshot-${data.createdAt.replace(/[:.]/g, "-")}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  return path;
}

export function loadSnapshot(id: string, dir: string = snapshotsRoot()): SnapshotData | null {
  const path = resolveOpaqueChild(dir, id, "snapshot id");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotData;
  } catch {
    return null;
  }
}

export function listSnapshots(cwd?: string, dir: string = snapshotsRoot()): Array<{ id: string; data: SnapshotData }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ id: string; data: SnapshotData }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const data = loadSnapshot(name, dir);
    if (data && (!cwd || isCurrentWorkspace(data.cwd, cwd))) results.push({ id: name, data });
  }
  results.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
  return results;
}

// ── Backend sync ──

/**
 * Push the current registry state to the AETHER-CLOUD backend.
 * Fail-soft: logs a warning on network error, never throws.
 * Returns true if the sync succeeded.
 */
export async function syncToBackend(api: ApiClient, cwd: string): Promise<boolean> {
  try {
    const reg = getRegistry();
    await api.postJson(AGENT_CONTEXT_PATH, reg.toSnapshot(cwd));
    return true;
  } catch (err) {
    // Best-effort — backend may be offline or vault not configured
    return false;
  }
}

/**
 * Pull the last-saved context state from the backend into the registry.
 * Returns true if state was loaded, false if no state or error.
 */
export async function loadFromBackend(api: ApiClient, cwd: string): Promise<boolean> {
  try {
    const resp = await api.getJson<{ found: boolean; state: SnapshotData | null }>(AGENT_CONTEXT_PATH);
    if (!resp.found || !resp.state) return false;
    const restored = ContextRegistry.fromSnapshot(resp.state, cwd);
    Object.assign(getRegistry(), restored);
    return true;
  } catch {
    return false;
  }
}
