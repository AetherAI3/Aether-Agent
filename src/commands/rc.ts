// `aether rc` — the viewer host's command surface (spec §7).
//
//   aether rc start [--name <name>]   begin publishing observation events
//   aether rc status                  what is being published, and to whom
//   aether rc exposure                the same, framed as "what can be seen"
//   aether rc viewers                 who is currently observing
//   aether rc off                     stop, locally first and server-final
//   aether rc link                    mint a fresh one-time observer invitation
//
// THIS COMMAND CANNOT CONTROL ANYTHING
//
// Not "does not yet" — cannot. There is no inbound path in src/core/rc for it
// to expose: the host writes to the broker and never reads work from it, and
// test/rc_host.test.ts reads that directory's source to keep it so. Every
// human-facing surface here prints the literal line "No terminal or tool
// control", because an operator deciding whether to let somebody watch is
// entitled to read that guarantee rather than infer it from an absence.
//
// WHY THE RENDERERS ARE PURE
//
// renderStatus and renderExposure take a plain view object and return a
// string. That is what makes "no credential is ever printed" a property of the
// output rather than of whichever code paths a test happened to walk: the view
// type has no field that could hold one, so the renderers cannot print one.

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { configDir } from "../core/config.js";
import { checkoutDiffSummary } from "../core/rc/diff_summary.js";
import type { CommandFlags } from "../core/command_dispatch.js";
import type { AppContext } from "../core/context.js";
import { digestOf } from "../core/device_runtime/canonical_json.js";
import { detectBrowserRuntime } from "../core/browser_runtime.js";
import { McpClient } from "../core/mcp.js";
import { loadEnrollmentMetadata } from "../core/device_runtime/identity.js";
import {
  RC_HOST_SCHEMA,
  RcError,
  abandonSession,
  attachHost,
  confirmCloudRevoke,
  fetchSessionStatus,
  flushOutbox,
  isTerminalRcCode,
  mintObserverGrant,
  persistRecord,
  registerSession,
  revokeHost,
  type FlushOutcome,
  type RcCode,
  type RcHostDeps,
  type RcSessionStatus,
  type RcStatusReading,
  type RcStatusUnknownReason,
  type RepoSummary,
} from "../core/rc/host.js";
import {
  createOutbox,
  enqueueEvent,
  loadOutbox,
  setAsideOutbox,
  type OutboxRecord,
} from "../core/rc/outbox.js";
import {
  RC_OPENING_PROTOCOL_VERSION,
  hostPresenceEvent,
  producerCoverage,
  sessionOpenedEvent,
} from "../core/rc/producers.js";
import { VIEWER_CAPABILITIES } from "../core/rc/viewer_profile.js";
import { newObserverId, observerLink, observerQr } from "../core/rc/observer_handoff.js";

/** Printed verbatim on every human-facing RC surface. Spec §7. */
export const RC_NO_CONTROL_LINE = "No terminal or tool control";

export const EXIT_OK = 0;
export const EXIT_OPERATIONAL = 1;
export const EXIT_USAGE = 2;

/** How long any rc command waits to re-confirm an earlier unconfirmed revoke. */
const RC_RECONCILE_TIMEOUT_MS = 4_000;

// ── paths ───────────────────────────────────────────────────────────────────

/** A stable, non-reversible handle for a working tree. The absolute path is
 *  never sent anywhere; only this digest identifies the project. */
export function projectRefFor(projectRoot: string): string {
  return digestOf({ project_root: projectRoot }).replace("sha256:", "").slice(0, 32);
}

export function rcOutboxPath(projectRef: string): string {
  return join(configDir(), "device-runtime", "rc", `${projectRef}.json`);
}

// ── repo summary (identifiers only) ─────────────────────────────────────────

function git(cwd: string, args: readonly string[]): string | null {
  const out = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5_000,
  });
  if (out.status !== 0 || typeof out.stdout !== "string") return null;
  return out.stdout.trim();
}

/**
 * Identifiers describing the checkout, never its contents.
 *
 * `repo` is the remote's owner/name when there is one and the directory name
 * otherwise — deliberately not the absolute path, which would carry a username
 * and the machine's layout to every viewer.
 */
export function repoSummary(cwd: string): RepoSummary {
  const remote = git(cwd, ["remote", "get-url", "origin"]) ?? "";
  const slug = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  const dirty = git(cwd, ["status", "--porcelain"]) ?? "";
  return {
    repo: slug ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? "workspace",
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown",
    base_commit: git(cwd, ["rev-parse", "HEAD"]) ?? "unknown",
    dirty_file_count: dirty ? dirty.split("\n").filter(Boolean).length : 0,
  };
}

// ── the view, and its renderers ─────────────────────────────────────────────

/**
 * Everything the status surfaces may show.
 *
 * There is no field here that could hold a token, a SecretRef or a redemption
 * value, which is the point: the renderers cannot print one because they are
 * never handed one.
 */
export interface RcStatusView {
  running: boolean;
  /** Typed browser-runtime code from core/browser_runtime, or null when unasked. */
  browser: string | null;
  /** Aether connector state, or null when it could not be determined. */
  connector: string | null;
  device_id: string | null;
  device_name: string | null;
  session_id: string | null;
  project_ref: string | null;
  repo: RepoSummary | null;
  /**
   * Stable token: off, pending, active, reconnecting, offline, revoked,
   * expired, closed, not-found, pending-revoke, recovery-required, unknown.
   */
  state: string;
  /** Human qualifier for `state`, never machine-parsed. */
  state_detail?: string | null;
  /** The Cloud's verified view, why it is unknown, or that this command did not ask. */
  cloud: RcCloudView;
  /** Events queued locally, not yet proven stored. */
  pending: number;
  /** Highest Cloud sequence a receipt proved stored (the durable cursor). */
  acked: number;
  dropped: number;
  quarantined: number;
  revoke_pending: boolean;
  /** Event categories a viewer of this session can receive right now. */
  exposed: string[];
  /**
   * True only when the Cloud verified a non-terminal session this host has
   * delivered to. While pending or unknown, `exposed` is what WOULD reach a
   * viewer once delivered, and the surfaces say so.
   */
  exposure_confirmed: boolean;
}

/**
 * "unchecked" only where the command itself just heard from the Cloud (start,
 * link, off) or never had a session to ask about. `rc status`, `rc exposure`
 * and `rc viewers` always ask.
 */
export type RcCloudView = { kind: "unchecked" } | RcStatusReading;

function line(label: string, value: string | number | null): string {
  return `  ${label.padEnd(16)} ${value ?? "—"}`;
}

const UNKNOWN_REASON_TEXT: Readonly<Record<RcStatusUnknownReason, string>> = {
  timeout: "timed out",
  unreachable: "broker unreachable",
  route_absent: "this Cloud does not report session status",
  disabled: "remote sessions are disabled on this Cloud",
  not_authorized: "not authorized",
  rate_limited: "rate limited",
  invalid_response: "the Cloud's answer could not be verified",
  broker_error: "the broker answered with an error",
};

function cloudText(cloud: RcCloudView): string {
  switch (cloud.kind) {
    case "unchecked": return "not checked";
    case "known": return cloud.status.state;
    case "not_found": return "no such session for this account";
    case "unknown": return `unknown (${UNKNOWN_REASON_TEXT[cloud.reason]})`;
  }
}

/** A Cloud-owned fact: shown when verified, "unknown (why)" when it could not be asked. */
function cloudFact(cloud: RcCloudView, known: (status: RcSessionStatus) => string): string {
  switch (cloud.kind) {
    case "unchecked": return "not checked";
    case "known": return known(cloud.status);
    case "not_found": return "— (no such session)";
    case "unknown": return `unknown (${UNKNOWN_REASON_TEXT[cloud.reason]})`;
  }
}

function observersText(view: RcStatusView): string {
  return cloudFact(view.cloud, (status) => `${status.observer_count} / ${status.observer_cap}`);
}

function expiresText(view: RcStatusView): string {
  return cloudFact(view.cloud, (status) =>
    status.revoked_at ? `${status.expires_at} (revoked ${status.revoked_at})` : status.expires_at);
}

function heartbeatText(view: RcStatusView): string {
  return cloudFact(view.cloud, (status) => status.host_last_heartbeat_at ?? "none yet");
}

function lastReceiptText(view: RcStatusView): string {
  const local = view.acked > 0 ? `seq ${view.acked}` : "none yet";
  return view.cloud.kind === "known" ? `${local} (Cloud last seq ${view.cloud.status.last_seq})` : local;
}

function exposedText(view: RcStatusView): string {
  if (view.exposed.length === 0) return "nothing";
  const list = view.exposed.join(", ");
  return view.exposure_confirmed ? list : `${list} (once delivered; not confirmed by the Cloud)`;
}

/**
 * The coverage line, from the producer registry rather than module presence.
 *
 * "13 / 13 available" is a claim about producers that exist, and it is computed
 * every time rather than written down, so it cannot drift into a lie when
 * somebody adds a fourteenth event type or removes a producer.
 */
function coverageLine(): string {
  const coverage = producerCoverage();
  const total = coverage.produced.length + coverage.unproduced.length;
  return `${coverage.produced.length} / ${total} available`;
}

function hostStateText(view: RcStatusView): string {
  if (!view.running) return "off";
  return view.state_detail ? `${view.state} (${view.state_detail})` : view.state;
}

/** `aether rc status` — what is being published, and to whom. */
export function renderStatus(view: RcStatusView): string {
  const rows = [
    "Aether RC — viewer-only observation host",
    "",
    line("Viewer events", coverageLine()),
    line("Control", "NONE"),
    line("Inbound socket", "NONE"),
    line("Host state", hostStateText(view)),
    line("Cloud", cloudText(view.cloud)),
    line("Outbox", `${view.pending} queued / ${view.dropped} dropped / ${view.quarantined} quarantined`),
    line("Last receipt", lastReceiptText(view)),
    line("Exposed now", exposedText(view)),
    line("Browser", view.browser),
    line("Connector", view.connector),
    "",
    line("mode", `observe (capabilities: ${VIEWER_CAPABILITIES.join(", ")})`),
    line("device", view.device_name ? `${view.device_name} (${view.device_id})` : view.device_id),
    line("session", view.session_id),
    line("project", view.project_ref),
    line("repo", view.repo ? `${view.repo.repo} @ ${view.repo.branch}` : null),
    line("observed head", view.repo ? view.repo.base_commit.slice(0, 12) : null),
    line("dirty files", view.repo ? view.repo.dirty_file_count : null),
    line("expires", expiresText(view)),
    line("last heartbeat", heartbeatText(view)),
    line("observers", observersText(view)),
    `  ${RC_NO_CONTROL_LINE}`,
  ];
  if (view.revoke_pending) {
    rows.push(
      "",
      "  RC is off locally, but the Cloud has not confirmed revocation.",
      "  It will not resume automatically. Every `aether rc` command retries the revoke;",
      "  `aether rc off` retries it explicitly.",
    );
  }
  if (view.state === "recovery-required") {
    rows.push(
      "",
      "  The saved RC state could not be read, so nothing is published from it.",
      "  Run `aether rc off` to revoke the session it names and set it aside.",
    );
  }
  return `${rows.join("\n")}\n`;
}

/**
 * `aether rc exposure` — the same facts, framed as what a viewer can see.
 *
 * The declared vocabulary and the events that actually get sent are listed
 * SEPARATELY. Printing all thirteen viewer types under one "shared" heading
 * would tell an operator a viewer can watch their CI and test results when
 * nothing emits either yet, and the whole purpose of this screen is to be the
 * thing somebody can trust before letting another person watch them work.
 */
export function renderExposure(view: RcStatusView): string {
  const coverage = producerCoverage();
  const rows = [
    "Aether RC — what an observer can see",
    `  ${RC_NO_CONTROL_LINE}`,
    "",
    line("Viewer events", coverageLine()),
    line("Control", "NONE"),
    line("Inbound socket", "NONE"),
    "",
    "  Shared, as bounded structured events:",
    ...coverage.produced.map((type) => `    · ${type}`),
    ...(coverage.unproduced.length > 0
      ? [
          "",
          "  Declared by the viewer contract, but nothing sends them yet:",
          ...coverage.unproduced.map((type) => `    · ${type}`),
        ]
      : []),
    "",
    "  Never shared:",
    "    · your prompts, model reasoning, or private memory",
    "    · file contents, diffs, shell history, stdout or stderr",
    "    · environment variables, tokens, or MCP credentials",
    "    · absolute paths (project-relative identifiers only)",
    "",
    line("Host state", hostStateText(view)),
    line("Exposed now", exposedText(view)),
    line("session", view.session_id),
    line("observers", observersText(view)),
  ];
  return `${rows.join("\n")}\n`;
}

/**
 * `aether rc viewers` — how many observers the broker has attached, against
 * its cap. The Cloud reports a count, not identities, so that is all this
 * claims; when the Cloud cannot be asked the answer is unknown, never zero.
 */
export function renderViewers(view: RcStatusView): string {
  const rows = [
    "Aether RC — who is observing",
    `  ${RC_NO_CONTROL_LINE}`,
    "",
    line("Host state", hostStateText(view)),
    line("Cloud", cloudText(view.cloud)),
    line("observers", observersText(view)),
    line("expires", expiresText(view)),
    line("session", view.session_id),
  ];
  return `${rows.join("\n")}\n`;
}

function cloudJson(cloud: RcCloudView): Record<string, unknown> {
  switch (cloud.kind) {
    case "unchecked": return { checked: false };
    case "known": return { checked: true, status: "known", ...cloud.status };
    case "not_found": return { checked: true, status: "not_found" };
    case "unknown": return { checked: true, status: "unknown", reason: cloud.reason };
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

export interface RcCommandDeps {
  cwd: string;
  /** Resolved once per invocation, before rendering. Best-effort. */
  connectorState?: string | null;
  /** Typed browser runtime, from the #148 detection seam. */
  browser: () => { code: string } | null;
  /** Aether connector state, or null when it could not be determined. */
  connector: () => string | null;
  enrollment: () => { device_id: string; display_name: string } | null;
  repo: (cwd: string) => RepoSummary;
  out: (text: string) => void;
  err: (text: string) => void;
  isTTY: boolean;
  columns: number | undefined;
  json: boolean;
  /** Durable local-state writer. Injected only to fail a write at a chosen boundary. */
  persist?: (path: string, record: OutboxRecord) => void;
  /** Bound on the Cloud status read; defaults to RC_STATUS_TIMEOUT_MS. */
  statusTimeoutMs?: number;
}

interface RcObserverInvitation {
  url: string;
  expires_at: string;
}

/**
 * Stable machine handoff for a caller that must bind its own browser session.
 *
 * Built field by field from the view, which holds no credential, grant token,
 * absolute path or event payload. The one-time observer link appears only in
 * the result of `start` or `link`, the commands that mint it.
 */
export function renderStatusJson(view: RcStatusView, invitation: RcObserverInvitation | null = null): string {
  const coverage = producerCoverage();
  return JSON.stringify({
    schema: RC_HOST_SCHEMA,
    host_state: view.running ? view.state : "off",
    state_detail: view.running ? view.state_detail ?? null : null,
    session_id: view.session_id,
    device_id: view.device_id,
    project_ref: view.project_ref,
    revoke_pending: view.revoke_pending,
    outbox_pending: view.pending,
    outbox_dropped: view.dropped,
    outbox_quarantined: view.quarantined,
    acked_seq: view.acked,
    cloud: cloudJson(view.cloud),
    exposed_categories: view.exposed,
    exposure_confirmed: view.exposure_confirmed,
    viewer_events: { produced: coverage.produced, unproduced: coverage.unproduced },
    viewer_capabilities: VIEWER_CAPABILITIES,
    observer: invitation,
  }) + "\n";
}

async function printObserverLink(
  deps: RcCommandDeps,
  hostDeps: RcHostDeps,
  sessionId: string,
): Promise<RcObserverInvitation | null> {
  try {
    const grant = await mintObserverGrant(hostDeps, sessionId, newObserverId());
    const link = observerLink(grant);
    if (!deps.json) {
      deps.out(`\nObserver link (expires ${grant.expires_at}):\n${link}\n`);
      const qr = deps.isTTY ? observerQr(link, deps.columns) : null;
      if (qr) deps.out(`${qr}\n`);
      else deps.out("Open the link directly; this terminal cannot fit a scannable QR.\n");
    }
    return { url: link, expires_at: grant.expires_at };
  } catch (error) {
    const code = error instanceof RcError ? error.code : "RC_BROKER_UNREACHABLE";
    deps.err(SESSION_REFUSALS.has(code)
      ? `${code}: the Cloud no longer accepts this RC session, so no observer link was minted. ` +
        "Run `aether rc off` to clear it.\n"
      : `${code}: RC is running, but an observer link could not be minted. Retry with \`aether rc link\`.\n`);
    return null;
  }
}

/**
 * Answers after which this session will never deliver or admit a viewer again
 * (#227). Saying "pending" or "running" after one of these would be false;
 * the honest next step is `aether rc off`.
 */
const SESSION_REFUSALS: ReadonlySet<RcCode> = new Set<RcCode>([
  "RC_SESSION_NOT_FOUND",
  "RC_SESSION_TERMINAL",
  "RC_HOST_CONFLICT",
  "RC_NOT_AUTHORIZED",
  "RC_EVENT_REJECTED",
  "RC_EVENT_ID_CONFLICT",
]);

/**
 * What the LOCAL record alone can honestly say (#227), as a stable token for
 * machines plus a human qualifier. "active" requires the durable proof of a
 * receipted first append; anything short of it is pending.
 */
function localState(record: OutboxRecord): { state: string; detail: string | null } {
  if (record.recovery) {
    return {
      state: "recovery-required",
      detail: record.recovery.reason === "unreadable"
        ? "saved RC state could not be read (I/O error); retry"
        : "saved RC state is damaged",
    };
  }
  if (record.revoke_pending) return { state: "pending-revoke", detail: "Cloud revocation not yet confirmed" };
  if (!record.session_id) return { state: "off", detail: null };
  if (record.start_phase === "registered") return { state: "pending", detail: "start did not finish" };
  if (record.start_phase === "attached") return { state: "pending", detail: "opening events not yet accepted" };
  return { state: "active", detail: null };
}

/**
 * The host state an operator is shown (#226): the local record's proof
 * combined with the Cloud's verified view. "active" needs BOTH a receipted
 * first append locally and the Cloud saying live; a Cloud that could not be
 * asked makes the state unknown, never active.
 */
function hostState(record: OutboxRecord, cloud: RcCloudView): { state: string; detail: string | null } {
  const local = localState(record);
  const attached = record.start_phase === "attached" || record.start_phase === "confirmed";
  if (cloud.kind === "unchecked" || !attached || (local.state !== "active" && local.state !== "pending")) {
    return local;
  }
  const confirmed = record.start_phase === "confirmed";
  switch (cloud.kind) {
    case "unknown":
      return {
        state: "unknown",
        detail: `Cloud status unavailable: ${UNKNOWN_REASON_TEXT[cloud.reason]}` +
          (confirmed ? "; the opening events were accepted earlier" : ""),
      };
    case "not_found":
      return {
        state: "not-found",
        detail: "the Cloud has no such session for this account; `aether rc off` clears local state",
      };
    case "known":
      switch (cloud.status.state) {
        case "live":
          return confirmed ? { state: "active", detail: null } : { state: "pending", detail: "opening events not yet accepted" };
        case "pending_host":
          return { state: "pending", detail: "the Cloud has not seen this host attach" };
        case "host_reconnecting":
          return { state: "reconnecting", detail: "the Cloud missed this host's recent heartbeats" };
        case "host_offline":
          return { state: "offline", detail: "no heartbeat from this host; a coding run keeps it live" };
        case "revoked":
          return { state: "revoked", detail: "revoked in the Cloud; `aether rc off` clears local state" };
        case "expired":
          return { state: "expired", detail: "the session lease lapsed; `aether rc off` clears local state" };
        case "closed":
          return { state: "closed", detail: "`aether rc off` clears local state" };
      }
  }
}

/** States in which the Cloud verified a session this host has delivered to. */
const CONFIRMED_EXPOSURE_STATES: ReadonlySet<string> = new Set(["active", "reconnecting", "offline"]);

/** States in which the host is still publishing, so a viewer can receive events. */
const EXPOSING_STATES: ReadonlySet<string> = new Set(["active", "pending", "reconnecting", "offline", "unknown"]);

/**
 * What a viewer can receive right now: the produced categories while an
 * attached session is publishing, and nothing once it is off, revoked,
 * expired, closed, gone from the Cloud, or was never attached.
 */
function exposedNow(record: OutboxRecord, state: string): string[] {
  const publishing = Boolean(record.session_id) && !record.revoke_pending && !record.recovery &&
    (record.start_phase === "attached" || record.start_phase === "confirmed");
  return publishing && EXPOSING_STATES.has(state) ? [...producerCoverage().produced] : [];
}

function viewOf(record: OutboxRecord, deps: RcCommandDeps, cloud: RcCloudView = { kind: "unchecked" }): RcStatusView {
  const enrolled = deps.enrollment();
  const browser = deps.browser();
  const host = hostState(record, cloud);
  return {
    running: Boolean(record.session_id) || Boolean(record.recovery),
    browser: browser?.code ?? null,
    connector: deps.connector(),
    device_id: record.session_id ? record.device_id : enrolled?.device_id ?? null,
    device_name: enrolled?.display_name ?? null,
    session_id: record.session_id || null,
    project_ref: record.project_ref || null,
    repo: record.session_id ? deps.repo(deps.cwd) : null,
    state: host.state,
    state_detail: host.detail,
    cloud,
    pending: record.events.length,
    acked: record.cursor,
    dropped: record.dropped,
    quarantined: record.quarantined,
    revoke_pending: record.revoke_pending,
    exposed: exposedNow(record, host.state),
    exposure_confirmed: CONFIRMED_EXPOSURE_STATES.has(host.state) && cloud.kind === "known",
  };
}

/**
 * The Cloud's view, for an attached session only. A record that is off,
 * unreadable, mid-revoke or never attached has nothing the Cloud can add, so
 * it is not asked (and its local state is what is shown).
 */
async function cloudReading(hostDeps: RcHostDeps, record: OutboxRecord, timeoutMs?: number): Promise<RcCloudView> {
  if (!record.session_id || record.recovery || record.revoke_pending) return { kind: "unchecked" };
  if (record.start_phase !== "attached" && record.start_phase !== "confirmed") return { kind: "unchecked" };
  return fetchSessionStatus(hostDeps, record.session_id, timeoutMs);
}

async function start(
  deps: RcCommandDeps,
  hostDeps: RcHostDeps,
  record: OutboxRecord,
  name: string | undefined,
  projectRef: string,
): Promise<number> {
  const enrolled = deps.enrollment();
  if (!enrolled) {
    // Enrollment is identity, not permission: RC needs a canonical device id to
    // name the machine an observer is watching. A self-minted one authenticates
    // nothing, so there is deliberately no fallback here.
    deps.err(
      "RC_NOT_ENROLLED: run `aether device enroll` first — RC needs an enrolled device to name this machine\n",
    );
    return EXIT_OPERATIONAL;
  }
  if (record.recovery) {
    deps.err(`${recoveryMessage(record)}\n`);
    return EXIT_OPERATIONAL;
  }
  if (record.revoke_pending) {
    // §5.4 step 6: an unreconciled revoke never resumes by itself. cmdRc has
    // already retried it once for this command; it is still unconfirmed.
    deps.err(
      "RC_REVOKE_UNCONFIRMED: a previous RC session's revocation is still not confirmed by the Cloud; run `aether rc off` again before starting\n",
    );
    return EXIT_OPERATIONAL;
  }
  if (record.session_id) {
    deps.err(record.start_phase === "registered"
      ? `A previous \`aether rc start\` did not finish (session ${record.session_id}). Run \`aether rc off\` to revoke it before starting again.\n`
      : record.start_phase === "attached"
        ? `RC is already started for this project but not live yet (session ${record.session_id}): its opening ` +
          "events are queued for delivery. Run `aether rc off` to revoke it before starting again.\n"
        : `RC is already running for this project (session ${record.session_id})\n`);
    return EXIT_OPERATIONAL;
  }

  const repo = deps.repo(deps.cwd);
  const sessionName = name?.trim() || `${repo.repo}@${repo.branch}`;

  // 1. register. Nothing exists yet, so a failure here has nothing to undo.
  let sessionId: string;
  try {
    sessionId = (await registerSession(hostDeps, {
      project_ref: projectRef,
      device_id: enrolled.device_id,
      session_name: sessionName,
      repo,
    })).session_id;
  } catch (error) {
    if (!(error instanceof RcError)) throw error;
    deps.err(`${error.code}: ${error.detail}\n`);
    return EXIT_OPERATIONAL;
  }

  // 2. durable BEFORE anything else can fail, so a crash from here on leaves
  //    a record `rc off` can revoke rather than an orphaned Cloud session.
  //    "registered" never publishes: nothing reads this record as live.
  const session = createOutbox({
    session_id: sessionId,
    project_ref: projectRef,
    device_id: enrolled.device_id,
    epoch: 1,
    project_root: hostDeps.projectRoot,
    start_phase: "registered",
  });
  if (!persistRecord(hostDeps, session)) return rollbackStart(deps, hostDeps, session, UNWRITABLE);

  // 3. attach. A refusal means this host will never own the session.
  try {
    await attachHost(hostDeps, sessionId, enrolled.device_id);
  } catch (error) {
    if (!(error instanceof RcError)) throw error;
    return rollbackStart(deps, hostDeps, session, error);
  }

  // 4. the opening events, durable before they are sent.
  const opened = sessionOpenedEvent({
    session_name: sessionName,
    repo: repo.repo,
    branch: repo.branch,
    base_commit: repo.base_commit,
    dirty_file_count: repo.dirty_file_count,
    protocol_version: RC_OPENING_PROTOCOL_VERSION,
  });
  const presence = hostPresenceEvent(enrolled.device_id, "live");
  session.start_phase = "attached";
  if (!enqueueEvent(session, opened.event_type, opened.payload) ||
      !enqueueEvent(session, presence.event_type, presence.payload)) {
    return rollbackStart(deps, hostDeps, session,
      new RcError("RC_EVENT_REJECTED", "the opening events did not pass the local allowlist"));
  }
  // Git's measured checkout snapshot rides in the opening batch (#218). It is
  // optional: an unmeasurable count adds nothing and never fails the start.
  try {
    const diff = await checkoutDiffSummary(deps.cwd);
    if (diff) enqueueEvent(session, diff.event_type, diff.payload);
  } catch {
    // Diff observation is optional; session opening still succeeds.
  }
  if (!persistRecord(hostDeps, session)) return rollbackStart(deps, hostDeps, session, UNWRITABLE);

  // 5. the first append. Only a receipt, made durable, proves the session live.
  let flushed: FlushOutcome;
  try {
    flushed = await flushOutbox(hostDeps, session);
  } catch {
    // flushOutbox throws only when the receipt could not be made durable.
    return rollbackStart(deps, hostDeps, session, UNWRITABLE);
  }
  if (!flushed.ok) {
    if (isTerminalRcCode(flushed.code)) return rollbackStart(deps, hostDeps, session, flushed);
    // An outage, a rate limit or an unproven receipt: the session is real and
    // its opening events are durable, but nothing has proven it live. Say so,
    // keep the queue for the next delivery, and do not exit 0.
    deps.out(deps.json ? renderStatusJson(viewOf(session, deps)) : renderStatus(viewOf(session, deps)));
    deps.err(
      `${flushed.code}: RC is registered, but the Cloud has not accepted its opening events, so it is not live yet. ` +
      "They stay queued and are delivered during your next coding run or `aether rc link`; `aether rc off` revokes it.\n",
    );
    return EXIT_OPERATIONAL;
  }

  if (!deps.json) deps.out(renderStatus(viewOf(session, deps)));
  const invitation = await printObserverLink(deps, hostDeps, sessionId);
  if (deps.json) deps.out(renderStatusJson(viewOf(session, deps), invitation));
  return EXIT_OK;
}

const UNWRITABLE = new RcError("RC_STATE_UNWRITABLE", "local RC state could not be written");

/**
 * Undo a start that cannot be reported live (#227).
 *
 * The Cloud session is revoked whatever the local disk allows, and every
 * outcome is printed as what it is: revoked, revoked-but-not-recorded, or a
 * pending revoke that the next `rc` command retries. Never a success.
 */
async function rollbackStart(
  deps: RcCommandDeps,
  hostDeps: RcHostDeps,
  record: OutboxRecord,
  cause: { code: string; detail: string },
): Promise<number> {
  const outcome = await abandonSession(hostDeps, record);
  deps.err(`${cause.code}: ${cause.detail}\n`);
  if (outcome.revoked && outcome.durable) {
    deps.err("RC did not start. The Cloud session it registered was revoked; nothing is live.\n");
  } else if (outcome.revoked) {
    deps.err(
      "RC did not start. The Cloud session it registered was revoked, but local RC state could not be updated.\n",
    );
  } else if (outcome.durable) {
    deps.err(
      "RC_REVOKE_UNCONFIRMED: RC did not start, and the Cloud has not confirmed revoking the session it registered. " +
      "Publication is off; the next `aether rc` command retries the revoke, or run `aether rc off` when online.\n",
    );
  } else {
    deps.err(
      "RC_REVOKE_UNCONFIRMED: RC did not start, the Cloud has not confirmed revoking the session it registered, " +
      "and local RC state could not be written. Nothing renews that session; it expires on its own.\n",
    );
  }
  return EXIT_OPERATIONAL;
}

function recoveryMessage(record: OutboxRecord): string {
  if (record.recovery?.reason === "unreadable") return UNREAD_MESSAGE;
  const reason = record.recovery?.reason === "incompatible" ? "from an incompatible version" : "unreadable";
  return `RC_STATE_UNREADABLE: the saved RC state for this project is ${reason}. It may be the only record of a ` +
    "live session, so RC will not start over it. Run `aether rc off` to revoke what it names and set it aside.";
}

/**
 * A read that FAILED (a lock, an access error) is not damage: the bytes may be
 * a perfectly good record of a live session. Nothing acts on it — no start
 * over it, and no `rc off` setting it aside — until it can be read.
 */
const UNREAD_MESSAGE =
  "RC_STATE_UNREADABLE: the saved RC state for this project could not be read (an I/O error, not damage). " +
  "It was left untouched, and RC will not start over it. Check that nothing is holding the file or blocking " +
  "access to the Aether config directory, then retry.";

/**
 * `rc off` for state that could not be read (#227).
 *
 * Revokes the session the damaged bytes still name, and only then moves them
 * aside. When the Cloud cannot confirm, nothing local changes: the damaged
 * file stays the record and the next `rc off` retries. When no session id is
 * legible there is nothing this host can revoke, and it says so rather than
 * claiming a revocation it never made.
 */
async function offRecovery(deps: RcCommandDeps, hostDeps: RcHostDeps, record: OutboxRecord): Promise<number> {
  if (record.recovery?.reason === "unreadable") {
    deps.err(`${UNREAD_MESSAGE}\n`);
    return EXIT_OPERATIONAL;
  }
  const named = record.recovery?.session_id ?? null;
  if (named && !(await confirmCloudRevoke(hostDeps, named))) {
    deps.err(
      `RC_REVOKE_UNCONFIRMED: the saved RC state is unreadable and names session ${named}, but the Cloud did not ` +
      "confirm revoking it. Nothing was changed; run `aether rc off` again when online.\n",
    );
    return EXIT_OPERATIONAL;
  }
  if (!setAsideOutbox(hostDeps.outboxPath)) {
    deps.err("RC_STATE_UNWRITABLE: the unreadable RC state could not be moved aside; RC stays off.\n");
    return EXIT_OPERATIONAL;
  }
  if (!named) {
    deps.err(
      "RC_REVOKE_UNCONFIRMED: the unreadable RC state named no session this host could revoke. It was set aside; " +
      "any Cloud session it described is no longer renewed by this host and expires on its own.\n",
    );
    return EXIT_OPERATIONAL;
  }
  deps.out(deps.json ? renderStatusJson(viewOf(loadOutbox(hostDeps.outboxPath, deps.cwd), deps)) :
    `RC is off. Session ${named} was revoked, and the unreadable RC state was set aside.\n`);
  return EXIT_OK;
}

/**
 * `aether rc <subcommand>`.
 *
 * Reads only global flags off ctx.flags, exactly as `aether device` does; the
 * manifest gives this command one owned flag (--name) and nothing else.
 */
export async function cmdRc(
  ctx: AppContext,
  argv: string[],
  flags: CommandFlags,
  overrides: Partial<RcCommandDeps> = {},
): Promise<number> {
  const deps: RcCommandDeps = {
    cwd: resolve(overrides.cwd ?? ctx.flags.cwd),
    // Detection is local and cheap (one registry read on win32, one stat
    // elsewhere) and never launches anything, so status can report it honestly
    // without side effects.
    browser: overrides.browser ?? (() => detectBrowserRuntime()),
    connector: overrides.connector ?? ((): string | null => connectorState),
    enrollment: overrides.enrollment ?? loadEnrollmentMetadata,
    repo: overrides.repo ?? repoSummary,
    out: overrides.out ?? ((text): void => void process.stdout.write(text)),
    err: overrides.err ?? ((text): void => void process.stderr.write(text)),
    isTTY: overrides.isTTY ?? Boolean(process.stdout.isTTY),
    columns: overrides.columns ?? process.stdout.columns,
    json: overrides.json ?? ctx.flags.json,
    ...(overrides.persist ? { persist: overrides.persist } : {}),
    ...(overrides.statusTimeoutMs !== undefined ? { statusTimeoutMs: overrides.statusTimeoutMs } : {}),
  };

  // Connector state is read once, best-effort, before anything renders. A
  // broker that cannot be reached leaves it null, which renders as unknown --
  // never as "disconnected", because we did not establish that.
  let connectorState: string | null = null;
  if (!overrides.connector) {
    try {
      const conns = await new McpClient(ctx.api).listConnections({ timeoutMs: 4_000 });
      connectorState = conns.length > 0 ? `connected (${conns.length})` : "none connected";
    } catch {
      connectorState = null;
    }
  }

  const projectRef = projectRefFor(deps.cwd);
  const outboxPath = rcOutboxPath(projectRef);
  const record = loadOutbox(outboxPath, deps.cwd);
  const hostDeps: RcHostDeps = {
    api: ctx.api,
    outboxPath,
    projectRoot: deps.cwd,
    ...(deps.persist ? { persist: deps.persist } : {}),
  };
  const subcommand = argv[0] ?? "status";

  // #227: a revoke the Cloud never confirmed is retried on the next rc
  // command, whichever it is, rather than only when the operator thinks to run
  // `off` again. Bounded, so an offline status still answers promptly; on
  // failure the tombstone simply stays and the subcommand reports it.
  if (record.revoke_pending && subcommand !== "off") {
    const named = record.session_id;
    const reconciled = await revokeHost(hostDeps, record, { timeoutMs: RC_RECONCILE_TIMEOUT_MS });
    // A stale tombstone naming no session is merely cleared: nothing was revoked.
    if (reconciled.ok && named && !deps.json) deps.err("RC: the Cloud confirmed revocation of the previous session.\n");
  }

  switch (subcommand) {
    case "start":
      return start(deps, hostDeps, record, flags.str("name"), projectRef);

    case "status":
    case "exposure":
    case "viewers": {
      if (subcommand === "viewers" && !record.session_id) {
        deps.err(record.recovery ? `${recoveryMessage(record)}\n` : "RC is not running for this project\n");
        return EXIT_OPERATIONAL;
      }
      // The broker owns liveness, expiry and observer presence (#226). It is
      // asked every time, with a short bound; what it cannot answer is shown
      // as unknown, never filled in from the local file.
      const view = viewOf(record, deps, await cloudReading(hostDeps, record, deps.statusTimeoutMs));
      deps.out(deps.json ? renderStatusJson(view)
        : subcommand === "status" ? renderStatus(view)
        : subcommand === "exposure" ? renderExposure(view)
        : renderViewers(view));
      // `viewers` exists to answer one question; when the Cloud could not
      // answer it, the exit code says so too.
      return subcommand === "viewers" && view.cloud.kind !== "known" ? EXIT_OPERATIONAL : EXIT_OK;
    }

    case "link":
      if (record.recovery) {
        deps.err(`${recoveryMessage(record)}\n`);
        return EXIT_OPERATIONAL;
      }
      if (!record.session_id || record.revoke_pending || record.start_phase === "registered") {
        deps.err("RC is not running for this project\n");
        return EXIT_OPERATIONAL;
      }
      {
        let flushed: FlushOutcome;
        try {
          flushed = await flushOutbox(hostDeps, record);
        } catch {
          flushed = { ok: false, code: UNWRITABLE.code, detail: UNWRITABLE.detail };
        }
        if (!flushed.ok && SESSION_REFUSALS.has(flushed.code)) {
          deps.err(`${flushed.code}: ${flushed.detail}; this RC session cannot deliver events or admit a viewer. ` +
            "Run `aether rc off` to clear it.\n");
          return EXIT_OPERATIONAL;
        }
        // No invitation into a session nothing has proven live (#227).
        if (!flushed.ok || record.start_phase !== "confirmed") {
          const code = flushed.ok ? "RC_RECEIPTS_UNPROVEN" : flushed.code;
          deps.err(`${code}: RC opening events are still pending. Retry \`aether rc link\` after reconnecting.\n`);
          return EXIT_OPERATIONAL;
        }
        const invitation = await printObserverLink(deps, hostDeps, record.session_id);
        if (deps.json && invitation) deps.out(renderStatusJson(viewOf(record, deps), invitation));
        return invitation ? EXIT_OK : EXIT_OPERATIONAL;
      }

    case "off": {
      if (record.recovery) return offRecovery(deps, hostDeps, record);
      const outcome = await revokeHost(hostDeps, record);
      if (!outcome.ok) {
        deps.err(`${outcome.code}: ${outcome.detail}\n`);
        return EXIT_OPERATIONAL;
      }
      deps.out(deps.json ? renderStatusJson(viewOf(record, deps)) :
        "RC is off. The session, its grants and its streams are revoked.\n");
      return EXIT_OK;
    }

    default:
      deps.err(
        `unknown subcommand: ${String(argv[0])}\nusage: aether rc <start|link|status|exposure|viewers|off>\n`,
      );
      return EXIT_USAGE;
  }
}
