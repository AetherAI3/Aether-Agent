// `aether rc` — the viewer host's command surface (spec §7).
//
//   aether rc start [--name <name>]   begin publishing observation events
//   aether rc status                  what is being published, and to whom
//   aether rc exposure                the same, framed as "what can be seen"
//   aether rc viewers                 who is currently observing
//   aether rc off                     stop, locally first and server-final
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
import { join } from "node:path";

import { configDir } from "../core/config.js";
import type { CommandFlags } from "../core/command_dispatch.js";
import type { AppContext } from "../core/context.js";
import { digestOf } from "../core/device_runtime/canonical_json.js";
import { detectBrowserRuntime } from "../core/browser_runtime.js";
import { McpClient } from "../core/mcp.js";
import { loadEnrollmentMetadata } from "../core/device_runtime/identity.js";
import {
  RcError,
  attachHost,
  flushOutbox,
  registerSession,
  revokeHost,
  type RcHostDeps,
  type RepoSummary,
} from "../core/rc/host.js";
import {
  enqueueEvent,
  loadOutbox,
  saveOutbox,
  type OutboxRecord,
} from "../core/rc/outbox.js";
import {
  hostPresenceEvent,
  producerCoverage,
  sessionOpenedEvent,
} from "../core/rc/producers.js";
import { VIEWER_CAPABILITIES } from "../core/rc/viewer_profile.js";

/** Printed verbatim on every human-facing RC surface. Spec §7. */
export const RC_NO_CONTROL_LINE = "No terminal or tool control";

export const EXIT_OK = 0;
export const EXIT_OPERATIONAL = 1;
export const EXIT_USAGE = 2;

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
  /** ISO timestamp of the last accepted receipt, or null when none. */
  last_receipt: string | null;
  device_id: string | null;
  device_name: string | null;
  session_id: string | null;
  project_ref: string | null;
  repo: RepoSummary | null;
  state: string;
  expires_at: string | null;
  observers: number | null;
  pending: number;
  acked: number;
  dropped: number;
  quarantined: number;
  revoke_pending: boolean;
}

function line(label: string, value: string | number | null): string {
  return `  ${label.padEnd(16)} ${value ?? "—"}`;
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

/** `aether rc status` — what is being published, and to whom. */
export function renderStatus(view: RcStatusView): string {
  const rows = [
    "Aether RC — viewer-only observation host",
    "",
    line("Viewer events", coverageLine()),
    line("Control", "NONE"),
    line("Inbound socket", "NONE"),
    line("Host state", view.running ? view.state : "off"),
    line("Outbox", `${view.pending} pending / ${view.quarantined} quarantined`),
    line("Last receipt", view.last_receipt ?? (view.acked > 0 ? `seq ${view.acked}` : "none yet")),
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
    line("expires", view.expires_at),
    line("observers", view.observers === null ? "unknown (broker unreachable)" : view.observers),
    line("dropped", view.dropped),
    `  ${RC_NO_CONTROL_LINE}`,
  ];
  if (view.revoke_pending) {
    rows.push(
      "",
      "  RC is off locally, but the Cloud has not confirmed revocation.",
      "  It will not resume automatically. Re-run `aether rc off` when online.",
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
    line("session", view.session_id),
    line("observers", view.observers === null ? "unknown (broker unreachable)" : view.observers),
  ];
  return `${rows.join("\n")}\n`;
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
}

function viewOf(record: OutboxRecord, deps: RcCommandDeps, observers: number | null): RcStatusView {
  const enrolled = deps.enrollment();
  const browser = deps.browser();
  return {
    running: Boolean(record.session_id),
    browser: browser?.code ?? null,
    connector: deps.connector(),
    last_receipt: null,
    device_id: enrolled?.device_id ?? null,
    device_name: enrolled?.display_name ?? null,
    session_id: record.session_id || null,
    project_ref: record.project_ref || null,
    repo: record.session_id ? deps.repo(deps.cwd) : null,
    state: record.revoke_pending ? "revoked (unconfirmed)" : "active",
    expires_at: null,
    observers,
    pending: record.events.length,
    acked: record.cursor,
    dropped: record.dropped,
    quarantined: record.quarantined,
    revoke_pending: record.revoke_pending,
  };
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
  if (record.revoke_pending) {
    // §5.4 step 6: an unreconciled revoke never resumes by itself.
    deps.err(
      "RC_REVOKE_UNCONFIRMED: a previous `rc off` was not confirmed by the Cloud; run `aether rc off` again before starting\n",
    );
    return EXIT_OPERATIONAL;
  }
  if (record.session_id) {
    deps.err(`RC is already running for this project (session ${record.session_id})\n`);
    return EXIT_OPERATIONAL;
  }

  const repo = deps.repo(deps.cwd);
  const sessionName = name?.trim() || `${repo.repo}@${repo.branch}`;
  try {
    const session = await registerSession(hostDeps, {
      project_ref: projectRef,
      device_id: enrolled.device_id,
      session_name: sessionName,
      repo,
    });
    await attachHost(hostDeps, session.session_id, enrolled.device_id);

    record.session_id = session.session_id;
    record.project_ref = projectRef;
    record.device_id = enrolled.device_id;
    record.epoch = 1;

    const opened = sessionOpenedEvent({
      session_name: sessionName,
      repo: repo.repo,
      branch: repo.branch,
      base_commit: repo.base_commit,
      dirty_file_count: repo.dirty_file_count,
      protocol_version: "1",
    });
    enqueueEvent(record, opened.event_type, opened.payload);
    const presence = hostPresenceEvent(enrolled.device_id, "online");
    enqueueEvent(record, presence.event_type, presence.payload);
    saveOutbox(hostDeps.outboxPath, record);
    await flushOutbox(hostDeps, record);

    deps.out(renderStatus(viewOf(record, deps, null)));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof RcError) {
      deps.err(`${error.code}: ${error.detail}\n`);
      return EXIT_OPERATIONAL;
    }
    throw error;
  }
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
    cwd: overrides.cwd ?? process.cwd(),
    // Detection is local and cheap (one registry read on win32, one stat
    // elsewhere) and never launches anything, so status can report it honestly
    // without side effects.
    browser: overrides.browser ?? (() => detectBrowserRuntime()),
    connector: overrides.connector ?? ((): string | null => connectorState),
    enrollment: overrides.enrollment ?? loadEnrollmentMetadata,
    repo: overrides.repo ?? repoSummary,
    out: overrides.out ?? ((text): void => void process.stdout.write(text)),
    err: overrides.err ?? ((text): void => void process.stderr.write(text)),
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
  const hostDeps: RcHostDeps = { api: ctx.api, outboxPath, projectRoot: deps.cwd };

  switch (argv[0] ?? "status") {
    case "start":
      return start(deps, hostDeps, record, flags.str("name"), projectRef);

    case "status":
      deps.out(renderStatus(viewOf(record, deps, null)));
      return EXIT_OK;

    case "exposure":
      deps.out(renderExposure(viewOf(record, deps, null)));
      return EXIT_OK;

    case "viewers": {
      if (!record.session_id) {
        deps.err("RC is not running for this project\n");
        return EXIT_OPERATIONAL;
      }
      // The broker owns observer presence. When it cannot be reached the honest
      // answer is "unknown", never zero — reporting that nobody is watching
      // when we simply could not ask is the one wrong answer here.
      deps.out(renderExposure(viewOf(record, deps, null)));
      return EXIT_OK;
    }

    case "off": {
      const outcome = await revokeHost(hostDeps, record);
      if (!outcome.ok) {
        deps.err(`${outcome.code}: ${outcome.detail}\n`);
        return EXIT_OPERATIONAL;
      }
      deps.out("RC is off. The session, its grants and its streams are revoked.\n");
      return EXIT_OK;
    }

    default:
      deps.err(
        `unknown subcommand: ${String(argv[0])}\nusage: aether rc <start|status|exposure|viewers|off>\n`,
      );
      return EXIT_USAGE;
  }
}
