// src/core/diagnostics.ts — `aether doctor` fast mode: read-only inspection.
//
// Fast mode makes no network call, spends no tokens, creates no session,
// launches no opener, refreshes no credential and writes no file. It answers
// "is this machine configured correctly", and it is explicit that it has not
// answered "does any of it work right now" — every remote axis reports
// `not-checked` rather than an optimistic pass. `--live` is what turns those
// into verified.

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppContext } from "./context.js";
import { configDir } from "./config.js";
import { isCredentialSafeUrl } from "./transport.js";
import { gateActionFor } from "./autonomy.js";
import { validateToolDefinitionCoverage } from "./tool_registry.js";
import { localMemoryReport, type MemoryRoots } from "./memory.js";
import { LocalMcpStore } from "./mcp_store.js";
import type { McpClient } from "./mcp.js";
import { custodyLogPath } from "./custody.js";
import { skillCheckSpecs } from "./diagnostics_skills.js";
import { ghAvailable } from "./repo.js";
import { planOpen } from "./opener.js";
import { historyPaths, loadHistory } from "./media_history.js";
import {
  axis,
  buildReport,
  notApplicable,
  notChecked,
  renderHealthReport,
  type HealthCheck,
  type HealthReport,
  type Severity,
} from "./health.js";

export { renderHealthReport as renderDiagnosticReport };
export type { HealthReport, HealthCheck };

export const DIAGNOSTIC_CONCURRENCY = 8;

/** What a single check produces. Axes it does not speak to default sensibly. */
export interface CheckOutcome {
  configured: HealthCheck["configured"];
  reachable?: HealthCheck["reachable"];
  verified?: HealthCheck["verified"];
  severity: Severity;
  repairId?: string;
  remediation?: string;
}

export interface DiagnosticCheckSpec {
  id: string;
  category: string;
  title: string;
  run(): Promise<CheckOutcome> | CheckOutcome;
}

export interface DiagnosticDependencies {
  now?: string;
  mcpClient?: McpClient;
  mcpStore?: LocalMcpStore;
  memoryRoots?: MemoryRoots;
  /** Where generated media lands. Injected so tests get a sandbox. */
  outputDir?: string;
  custodyPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const LIVE_HINT = "run: aether doctor --live";

export async function executeDiagnosticChecks(
  specs: readonly DiagnosticCheckSpec[],
  concurrency = DIAGNOSTIC_CONCURRENCY,
): Promise<HealthCheck[]> {
  const width = Math.max(1, Math.min(Math.floor(concurrency), 32));
  const results: HealthCheck[] = new Array(specs.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= specs.length) return;
      const spec = specs[index]!;
      try {
        const outcome = await spec.run();
        results[index] = {
          id: spec.id,
          category: spec.category,
          title: spec.title,
          configured: outcome.configured,
          reachable: outcome.reachable ?? notChecked(LIVE_HINT),
          verified: outcome.verified ?? notChecked(LIVE_HINT),
          severity: outcome.severity,
          ...(outcome.repairId ? { repairId: outcome.repairId } : {}),
          ...(outcome.remediation ? { remediation: outcome.remediation } : {}),
        };
      } catch {
        results[index] = {
          id: spec.id,
          category: spec.category,
          title: spec.title,
          configured: axis("unknown", { evidence: "check failed safely" }),
          reachable: notChecked(LIVE_HINT),
          verified: notChecked(LIVE_HINT),
          severity: "error",
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, specs.length) }, () => worker()));
  return results;
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

export function fastCheckSpecs(
  ctx: AppContext,
  dependencies: DiagnosticDependencies = {},
): DiagnosticCheckSpec[] {
  const mcpStore = dependencies.mcpStore ?? new LocalMcpStore();
  const outputDir = dependencies.outputDir ?? "./aether-output";
  const custody = dependencies.custodyPath ?? custodyLogPath();
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;

  return [
    {
      id: "runtime.node",
      category: "runtime",
      title: "Node runtime",
      run: (): CheckOutcome => {
        // Must track package.json's engines.node — this project's own test
        // script needs Node 24 (`--test --test-isolation` support).
        const MIN_SUPPORTED_NODE_MAJOR = 24;
        const major = Number(process.versions.node.split(".")[0]);
        const ok = major >= MIN_SUPPORTED_NODE_MAJOR;
        return {
          configured: axis(ok ? "yes" : "no", { evidence: `Node ${process.versions.node}` }),
          reachable: notApplicable("local runtime"),
          verified: axis(ok ? "yes" : "no"),
          severity: ok ? "info" : "error",
          ...(ok ? {} : { remediation: `install Node ${MIN_SUPPORTED_NODE_MAJOR} or newer` }),
        };
      },
    },
    {
      id: "workspace.directory",
      category: "workspace",
      title: "Workspace directory",
      run: (): CheckOutcome => {
        const target = resolve(ctx.flags.cwd);
        const valid = existsSync(target) && statSync(target).isDirectory();
        return {
          configured: axis(valid ? "yes" : "no", { evidence: target }),
          reachable: notApplicable("local path"),
          verified: axis(valid ? "yes" : "no"),
          severity: valid ? "info" : "error",
        };
      },
    },
    {
      id: "workspace.git",
      category: "workspace",
      title: "Git checkout",
      run: (): CheckOutcome => {
        const isRepo = existsSync(join(ctx.flags.cwd, ".git"));
        return {
          configured: axis(isRepo ? "yes" : "no", {
            evidence: isRepo ? "git metadata detected" : "workspace is not a git checkout",
          }),
          reachable: notChecked("remote branch state is compared only in --live"),
          verified: axis(isRepo ? "yes" : "na"),
          severity: isRepo ? "info" : "warning",
        };
      },
    },
    {
      id: "agent.transport",
      category: "agent",
      title: "Agent transport",
      run: (): CheckOutcome => {
        const safe = isCredentialSafeUrl(ctx.cfg.baseUrl);
        return {
          // Configured means the URL is well-formed and credential-safe. It
          // says nothing about whether anything answers there.
          configured: axis(safe ? "yes" : "no", { evidence: ctx.cfg.baseUrl }),
          severity: safe ? "info" : "error",
          ...(safe ? {} : { remediation: "backend URL transport is unsafe for credentials" }),
        };
      },
    },
    {
      id: "auth.credential",
      category: "auth",
      title: "Authentication",
      run: async (): Promise<CheckOutcome> => {
        // Reads the stored token; never refreshes, never contacts the issuer.
        const configured = Boolean(await ctx.tokens.get());
        return {
          configured: axis(configured ? "yes" : "no", {
            evidence: configured ? "credential stored locally" : "signed out",
          }),
          severity: configured ? "info" : "warning",
          ...(configured ? {} : { remediation: "run: aether auth login" }),
        };
      },
    },
    {
      id: "agent.catalog",
      category: "agent",
      title: "Capability manifest and model catalog",
      run: (): CheckOutcome => ({
        configured: axis(isCredentialSafeUrl(ctx.cfg.baseUrl) ? "yes" : "no"),
        severity: "info",
      }),
    },
    {
      id: "tools.schemas",
      category: "tools",
      title: "Tool schema coverage",
      run: (): CheckOutcome => {
        const errors = validateToolDefinitionCoverage();
        return {
          configured: axis(errors.length ? "no" : "yes", {
            evidence: errors.length
              ? "tool schema coverage incomplete"
              : "all protocol tools have schemas",
          }),
          reachable: notApplicable("local registry"),
          verified: axis(errors.length ? "no" : "yes"),
          severity: errors.length ? "error" : "info",
        };
      },
    },
    {
      id: "tools.gates",
      category: "tools",
      title: "Side-effect gates",
      run: (): CheckOutcome => {
        const valid =
          gateActionFor("write_file") === "write" &&
          gateActionFor("run_shell") === "shell" &&
          gateActionFor("run_tests") === "shell" &&
          gateActionFor("git_commit") === "shell" &&
          gateActionFor("read_file") === null;
        return {
          configured: axis(valid ? "yes" : "no", {
            evidence: valid ? "side-effect gates are fail-closed" : "tool gate mapping drifted",
          }),
          reachable: notApplicable("local registry"),
          verified: axis(valid ? "yes" : "no"),
          severity: valid ? "info" : "error",
        };
      },
    },
    {
      id: "memory.health",
      category: "memory",
      title: "Local memory stores",
      run: (): CheckOutcome => {
        const report = localMemoryReport(
          ctx.flags.cwd,
          undefined,
          dependencies.memoryRoots,
          dependencies.now,
        );
        const sources = report.tiers.flatMap((tier) => tier.sources);
        const degraded = sources.some((source) => source.status === "degraded");
        const unscoped = sources.reduce((sum, source) => sum + source.unscoped, 0);
        return {
          configured: axis(degraded ? "no" : "yes", {
            evidence:
              (degraded ? "one or more stores are degraded; " : "") +
              `${unscoped} legacy unscoped record(s), never auto-injected`,
          }),
          reachable: notApplicable("local store"),
          verified: axis(degraded ? "no" : "yes"),
          severity: degraded ? "warning" : "info",
        };
      },
    },
    {
      id: "mcp.registry",
      category: "mcp",
      title: "Local MCP registry",
      run: (): CheckOutcome => {
        const state = mcpStore.inspect();
        const broken = state.status === "corrupt" || state.status === "unreadable";
        return {
          configured: axis(broken ? "no" : state.status === "missing" ? "unknown" : "yes", {
            evidence: `local MCP registry ${state.status}`,
          }),
          reachable: notApplicable("local file"),
          verified: axis(broken ? "no" : "yes"),
          severity: broken ? "error" : state.status === "missing" ? "warning" : "info",
          ...(broken ? { remediation: "run: aether mcp repair" } : {}),
        };
      },
    },
    {
      id: "mcp.broker",
      category: "mcp",
      title: "MCP broker",
      run: (): CheckOutcome => {
        const registered = mcpStore.inspect().servers.length;
        return {
          configured: axis(registered ? "yes" : "unknown", {
            evidence: `${registered} server(s) registered`,
          }),
          severity: "info",
        };
      },
    },
    {
      id: "persistence.local",
      category: "persistence",
      title: "Local persistence root",
      run: (): CheckOutcome => {
        try {
          accessSync(nearestExisting(configDir()), constants.R_OK | constants.W_OK);
          return {
            configured: axis("yes", { evidence: configDir() }),
            reachable: notApplicable("local path"),
            verified: axis("yes"),
            severity: "info",
          };
        } catch {
          return {
            configured: axis("no", { evidence: "local persistence root is unavailable" }),
            reachable: notApplicable("local path"),
            verified: axis("no"),
            severity: "error",
            repairId: "state.directories",
          };
        }
      },
    },
    {
      id: "media.history",
      category: "media",
      title: "Media output history",
      run: (): CheckOutcome => {
        const paths = historyPaths(outputDir);
        if (!existsSync(paths.primary)) {
          return {
            configured: axis("unknown", { evidence: "no generations recorded yet" }),
            reachable: notApplicable("local index"),
            verified: axis("na"),
            severity: "info",
          };
        }
        const load = loadHistory(paths, dependencies.now);
        const healthy = load.state === "ok" || load.state === "migrated";
        return {
          configured: axis(healthy ? "yes" : "no", {
            evidence:
              `schema v${load.doc.schemaVersion}, ${load.doc.entries.length} retained, ` +
              `next reference ${load.doc.nextSequence}`,
          }),
          reachable: notApplicable("local index"),
          verified: axis(healthy ? "yes" : "no", {
            evidence: load.warning ? load.warning.message : `history state: ${load.state}`,
          }),
          severity: load.state === "degraded" ? "error" : healthy ? "info" : "warning",
          ...(healthy ? {} : { repairId: "media.rebuild" }),
        };
      },
    },
    {
      id: "opener.local",
      category: "opener",
      title: "Browser and file opener",
      run: (): CheckOutcome => {
        // planOpen validates and selects the command WITHOUT spawning, which
        // is what makes this safe in a read-only mode.
        const plan = planOpen("https://example.invalid/", { platform, env });
        const ok = plan.status === "spawned";
        return {
          configured: axis(ok ? "yes" : "no", {
            evidence: ok ? `${plan.executable} (argument array, no shell)` : plan.detail,
          }),
          reachable: notChecked("a real open is proven only in --live"),
          verified: notChecked("a real open is proven only in --live"),
          severity: plan.status === "unavailable" ? "warning" : ok ? "info" : "error",
        };
      },
    },
    {
      id: "github.connection",
      category: "github",
      title: "GitHub identity",
      run: (): CheckOutcome => {
        // Presence of the binary only. `gh auth status` is a network call and
        // belongs in --live.
        const hasGh = ghAvailable();
        return {
          configured: axis(hasGh ? "yes" : "no", {
            evidence: hasGh ? "local gh CLI present" : "gh CLI not on PATH",
          }),
          severity: hasGh ? "info" : "warning",
          ...(hasGh ? {} : { remediation: "install the GitHub CLI to publish branches and PRs" }),
        };
      },
    },
    {
      id: "custody.receipts",
      category: "custody",
      title: "Protocol-C receipt persistence",
      run: (): CheckOutcome => {
        try {
          accessSync(nearestExisting(dirname(custody)), constants.R_OK | constants.W_OK);
          return {
            configured: axis("yes", { evidence: custody }),
            reachable: notApplicable("local log"),
            verified: notChecked("a signed receipt round trip runs only in --live"),
            severity: "info",
          };
        } catch {
          return {
            configured: axis("no", { evidence: "receipt log directory is not writable" }),
            reachable: notApplicable("local log"),
            verified: axis("no"),
            severity: "error",
            repairId: "state.directories",
          };
        }
      },
    },
    {
      id: "actions.dispatch",
      category: "automation",
      title: "GitHub Actions dispatch",
      run: (): CheckOutcome => ({
        // This CLI has no workflow-dispatch surface. Saying so is honest;
        // reporting a green pass for something that does not exist is not.
        configured: notApplicable("this build has no workflow-dispatch surface"),
        reachable: notApplicable("this build has no workflow-dispatch surface"),
        verified: notApplicable("this build has no workflow-dispatch surface"),
        severity: "info",
      }),
    },
    {
      id: "predator.readiness",
      category: "automation",
      title: "Predator readiness",
      run: (): CheckOutcome => ({
        configured: axis("yes", { evidence: "read-only Cloud Drive G0 diagnosis is available" }),
        reachable: notChecked("fast doctor makes no network calls"),
        verified: notChecked("run: aether mcp doctor drive"),
        severity: "warning",
      }),
    },
    // Skill and instruction health. Filesystem-only, so they belong in fast
    // mode alongside the rest: no network call, no write, no token spend.
    ...skillCheckSpecs(ctx),
  ];
}

export interface DiagnosticOptions {
  dependencies?: DiagnosticDependencies;
}

/**
 * Fast, read-only health report. Performs no network call, no model call, no
 * session creation, no opener launch and no write.
 */
export async function diagnosticReport(
  ctx: AppContext,
  options: DiagnosticOptions = {},
): Promise<HealthReport> {
  const dependencies = options.dependencies ?? {};
  const checks = await executeDiagnosticChecks(fastCheckSpecs(ctx, dependencies));
  return buildReport("fast", checks, dependencies.now ?? new Date().toISOString());
}
