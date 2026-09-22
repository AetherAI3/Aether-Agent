import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext, GlobalFlags } from "../src/core/context.js";
import type { AgentEvent } from "../src/core/agent_events.js";
import {
  McpOperationCancelledError,
  McpOperationSupervisor,
} from "../src/core/mcp_lifecycle.js";
import { createAgentSettingsRegistry } from "../src/core/settings_adapters.js";
import { VersionedSettingsStore } from "../src/core/settings_store.js";
import type { SkillIndex } from "../src/core/skills/skill_types.js";
import type { TerminalCapabilities } from "../src/core/terminal_capabilities.js";
import {
  DEFAULT_VOICE_SETTINGS,
  type AgentVoiceBridge,
  type CapturedAudio,
  type SynthesizedAudio,
  type VoiceCapturePort,
  type VoicePlaybackPort,
  type VoiceTransport,
} from "../src/core/voice.js";
import { StringSink } from "../src/ui/sink.js";
import {
  createTerminalSession,
  type DetachableAgentSource,
} from "../src/ui/terminal_session.js";

const CYCLES = 100;
const TRACKED_ACTIVE_RESOURCES = [
  "Timeout",
  "FSReqCallback",
  "FileHandle",
  "ChildProcess",
  "TCPSocketWrap",
  "TCPServerWrap",
] as const;

class StressSource implements DetachableAgentSource {
  private readonly handlers = new Set<(event: AgentEvent) => void>();
  maxListeners = 0;
  closeCalls = 0;

  get listenerCount(): number {
    return this.handlers.size;
  }

  on(handler: (event: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    this.maxListeners = Math.max(this.maxListeners, this.handlers.size);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closeCalls++;
    this.handlers.clear();
  }

  push(event: AgentEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}

class StressCapture implements VoiceCapturePort {
  readonly id = "stress-capture";
  permissionCalls = 0;
  startCalls = 0;
  disposeCalls = 0;
  private readonly partials = new Set<(text: string) => void>();
  private readonly losses = new Set<(message: string) => void>();

  get listenerCount(): number {
    return this.partials.size + this.losses.size;
  }

  async requestPermission(): Promise<void> {
    this.permissionCalls++;
  }

  async start(_options: { signal: AbortSignal }): Promise<void> {
    this.startCalls++;
  }

  async stop(): Promise<CapturedAudio> {
    return { bytes: new Uint8Array([1]), mime: "audio/wav", durationSeconds: 0.01 };
  }

  abort(): void {}

  onPartial(callback: (text: string) => void): () => void {
    this.partials.add(callback);
    return () => this.partials.delete(callback);
  }

  onLost(callback: (message: string) => void): () => void {
    this.losses.add(callback);
    return () => this.losses.delete(callback);
  }

  dispose(): void {
    this.disposeCalls++;
  }
}

class StressPlayback implements VoicePlaybackPort {
  readonly id = "stress-playback";
  disposeCalls = 0;

  async play(_audio: SynthesizedAudio, _signal: AbortSignal): Promise<void> {}
  stop(): void {}
  dispose(): void { this.disposeCalls++; }
}

function activeResourceCounts(): Record<(typeof TRACKED_ACTIVE_RESOURCES)[number], number> {
  const active = process.getActiveResourcesInfo();
  return Object.fromEntries(
    TRACKED_ACTIVE_RESOURCES.map((name) => [name, active.filter((entry) => entry === name).length]),
  ) as Record<(typeof TRACKED_ACTIVE_RESOURCES)[number], number>;
}

function processListenerCounts(): Record<string, number> {
  return Object.fromEntries(
    ["exit", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].map(
      (name) => [name, process.listenerCount(name)],
    ),
  );
}

function flags(cwd: string): GlobalFlags {
  return { json: false, audit: false, yes: false, cwd };
}

const terminalCapabilities: TerminalCapabilities = {
  host: "electron",
  columns: 100,
  rows: 30,
  color: false,
  unicode: true,
  mouse: false,
  keyReleaseEvents: true,
  audioInput: true,
  audioOutput: true,
};

const noSkills: SkillIndex = {
  skills: [],
  errors: [],
  generatedAt: "2026-09-04T00:00:00.000Z",
};

test("100 mixed terminal/Voice/settings/MCP lifecycles have zero measurable resource growth", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aether-cross-lane-stress-"));
  const paths = {
    global: join(root, "settings", "global.json"),
    project: join(root, "settings", "project.json"),
    session: join(root, "settings", "session.json"),
  };
  mkdirSync(join(root, "settings"), { recursive: true });
  writeFileSync(paths.global, JSON.stringify({
    schema_version: 1,
    settings: { "voice.enabled": true },
  }, null, 2) + "\n", "utf8");
  const originalSettingsBytes = readFileSync(paths.global, "utf8");
  let receiptId = 0;
  const store = new VersionedSettingsStore(paths, { nextId: () => `stress-${++receiptId}` });
  let mcpInspections = 0;
  let voiceDoctors = 0;
  const ctx: Pick<AppContext, "cfg" | "flags"> = {
    cfg: { ...DEFAULT_CONFIG },
    flags: flags(root),
  };
  const registry = createAgentSettingsRegistry(ctx, {
    store,
    env: {},
    terminalCapabilities,
    config: { exists: () => false, save: () => {} },
    mcpStore: {
      inspect: () => {
        mcpInspections++;
        return {
          status: "ok" as const,
          servers: [{ name: "fixture", url: "https://mcp.example.test", transport: "http" as const }],
        };
      },
      filePath: () => join(root, "mcp.json"),
    },
    skillIndex: noSkills,
    skillSettings: { load: () => ({ schemaVersion: 1, settings: [] }), save: () => {} },
    voiceRuntime: {
      consumesStore: true,
      doctor: async () => {
        voiceDoctors++;
        return { state: "verified", summary: "deterministic fake audio loop" };
      },
    },
    ciConfigPath: join(root, ".aether-ci.yml"),
  });
  const source = new StressSource();
  const mcp = new McpOperationSupervisor();
  let activeMcpCancelSubscriptions = 0;
  let terminalOutcomes = 0;
  const terminalOutcomeCounts = { succeeded: 0, failed: 0, cancelled: 0 };
  let voiceStarts = 0;
  let settingsCancellations = 0;
  let mcpCancellations = 0;
  const stdinDataListenersBefore = process.stdin.listenerCount("data");
  const stdinRawBefore = process.stdin.isRaw;
  const listenersBefore = processListenerCounts();
  const resourcesBefore = activeResourceCounts();

  t.after(() => {
    mcp.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // Exercise the real settings composition (including MCP and Voice leaves),
    // stage a valid edit, then cancel before mutation. The same durable bytes
    // must remain authoritative across every terminal cycle.
    const tx = await registry.begin({ doctor: true });
    const voiceEnabled = tx.snapshot.settings["voice.enabled"];
    const mcpCount = tx.snapshot.settings["mcp.local_server_count"];
    assert.equal(voiceEnabled?.state === "known" && voiceEnabled.value, true);
    assert.equal(mcpCount?.state === "known" && mcpCount.value, 1);
    const staged = tx.stage("voice.hotkey", "global", `Ctrl+Shift+${cycle}`);
    assert.equal(staged.ok && staged.changed, true);
    assert.equal(tx.preview().length, 1);
    const cancellation = tx.cancel();
    assert.equal(cancellation.status, "cancelled");
    assert.equal(cancellation.mutated, false);
    settingsCancellations++;

    const capture = new StressCapture();
    const playback = new StressPlayback();
    const bridge: AgentVoiceBridge = {
      send(): never {
        throw new Error("cancelled capture must not submit an agent turn");
      },
    };
    const transport: VoiceTransport = {
      transcribe(): never {
        throw new Error("cancelled capture must not reach STT");
      },
      synthesize(): never {
        throw new Error("cancelled capture must not reach TTS");
      },
    };
    const sink = new StringSink({ isTTY: false });
    const session = createTerminalSession({
      source,
      sink,
      prompt: `cycle ${cycle}`,
      turnId: `stress-turn-${cycle}`,
      requireSequence: true,
      onOutcome: (outcome) => {
        terminalOutcomes++;
        if (outcome.state === "succeeded" || outcome.state === "failed" || outcome.state === "cancelled") {
          terminalOutcomeCounts[outcome.state]++;
        }
      },
      voice: {
        capture,
        playback,
        bridge,
        transport,
        settings: { ...DEFAULT_VOICE_SETTINGS, enabled: true },
        timeouts: {
          permissionMs: 1_000,
          captureStartMs: 1_000,
          captureStopMs: 1_000,
          transcriptionMs: 1_000,
          agentMs: 1_000,
          synthesisMs: 1_000,
          playbackMs: 1_000,
          adapterDrainMs: 1_000,
          idleMs: 1_000,
        },
      },
    });
    try {
      source.push({ type: "log", line: `cycle ${cycle} started`, seq: 1 });
      assert.equal(await session.voice?.start("push"), true);
      voiceStarts++;
      assert.equal(capture.listenerCount, 2);
      assert.equal(session.voice?.resources().total, 3, "capture controller plus two capture listeners");

      let cancelMcp: (() => void) | undefined;
      let providerSignal: AbortSignal | undefined;
      const mcpResult = mcp.run(
        `cycle ${cycle} provider wait`,
        async (signal) => {
          providerSignal = signal;
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("fixture provider aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        },
        {
          timeoutMs: 60_000,
          subscribeCancel(cancel) {
            activeMcpCancelSubscriptions++;
            cancelMcp = cancel;
            return () => { activeMcpCancelSubscriptions--; };
          },
        },
      );
      await Promise.resolve();
      assert.equal(providerSignal?.aborted, false);
      assert.deepEqual(mcp.resources(), { operations: 1, timers: 1, cancellationSubscriptions: 1 });

      cancelMcp?.();
      let expectedTerminalState: "succeeded" | "failed" | "cancelled";
      let expectedTerminalText: string;
      if (cycle % 3 === 0) {
        expectedTerminalState = "succeeded";
        expectedTerminalText = "turn completed";
        source.push({ type: "done", seq: 2 });
      } else if (cycle % 3 === 1) {
        expectedTerminalState = "cancelled";
        expectedTerminalText = `cycle ${cycle} cancelled`;
        session.cancel(expectedTerminalText);
      } else {
        expectedTerminalState = "failed";
        expectedTerminalText = `cycle ${cycle} fixture failure`;
        source.push({ type: "error", message: expectedTerminalText, seq: 2 });
      }
      const stableOutcome = session.cancel("duplicate terminal attempt");
      assert.equal(stableOutcome.state, expectedTerminalState);
      assert.equal(stableOutcome.turnId, `stress-turn-${cycle}`);
      await assert.rejects(mcpResult, McpOperationCancelledError);
      mcpCancellations++;
      await session.voice?.whenIdle();

      assert.equal(providerSignal?.aborted, true);
      assert.equal(activeMcpCancelSubscriptions, 0);
      assert.deepEqual(mcp.resources(), { operations: 0, timers: 0, cancellationSubscriptions: 0 });
      assert.equal(session.voice?.resources().total, 0);
      session.voice?.assertPlaybackSettled();
      assert.equal(capture.listenerCount, 0);
      assert.equal(source.listenerCount, 0);
      assert.equal(session.outcome?.state, expectedTerminalState);
      assert.match(sink.buffer, new RegExp(expectedTerminalText));
    } finally {
      session.dispose();
    }
    assert.equal(capture.disposeCalls, 1);
    assert.equal(playback.disposeCalls, 1);
    assert.equal(readFileSync(paths.global, "utf8"), originalSettingsBytes);
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  const remainingFiles = readdirSync(root, { recursive: true }).map(String);
  assert.equal(remainingFiles.some((name) => /\.tmp$|\.lock$/.test(name)), false);
  assert.equal(terminalOutcomes, CYCLES);
  assert.deepEqual(terminalOutcomeCounts, { succeeded: 34, failed: 33, cancelled: 33 });
  assert.equal(voiceStarts, CYCLES);
  assert.equal(settingsCancellations, CYCLES);
  assert.equal(mcpCancellations, CYCLES);
  assert.ok(mcpInspections >= CYCLES, "each settings lifecycle reads the real MCP registry adapter");
  assert.ok(voiceDoctors >= CYCLES, "each settings lifecycle runs the injected Voice doctor");
  assert.equal(source.maxListeners, 1);
  assert.equal(source.closeCalls, 0, "host-owned source is detached, never closed by a UI cycle");
  assert.equal(source.listenerCount, 0);
  assert.equal(activeMcpCancelSubscriptions, 0);
  assert.deepEqual(mcp.resources(), { operations: 0, timers: 0, cancellationSubscriptions: 0 });
  assert.equal(process.stdin.listenerCount("data"), stdinDataListenersBefore);
  assert.equal(process.stdin.isRaw, stdinRawBefore);
  const listenersAfter = processListenerCounts();
  const resourcesAfter = activeResourceCounts();
  assert.deepEqual(listenersAfter, listenersBefore);
  // The suite can release an unrelated TCP socket during these 100 cycles.
  // This is a no-growth check: fewer live resources are safe, while any
  // increase still fails with the exact resource named.
  for (const name of TRACKED_ACTIVE_RESOURCES) {
    assert.ok(resourcesAfter[name] <= resourcesBefore[name],
      `${name} grew from ${resourcesBefore[name]} to ${resourcesAfter[name]}`);
  }
  t.diagnostic(JSON.stringify({
    cycles: CYCLES,
    terminalOutcomes,
    terminalOutcomeCounts,
    voiceStarts,
    settingsCancellations,
    mcpCancellations,
    mcpInspections,
    voiceDoctors,
    maxSourceListeners: source.maxListeners,
    remainingFilesystemEntries: remainingFiles.length,
    stdinDataListenersBefore,
    stdinDataListenersAfter: process.stdin.listenerCount("data"),
    stdinRawBefore: stdinRawBefore ?? null,
    stdinRawAfter: process.stdin.isRaw ?? null,
    listenersBefore,
    listenersAfter,
    resourcesBefore,
    resourcesAfter,
  }));
});
