import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import type { AppContext } from "../core/context.js";
import type { CommandFlags } from "../core/command_dispatch.js";
import { detectBrowserRuntime, verifyBrowserLaunch, type VerifyResult } from "../core/browser_runtime.js";
import { openTargetChecked } from "../core/opener.js";
import { PcActionBroker, type PcActionReceipt } from "../core/pc/broker.js";
import { controlledEdgeExecutable, inspectControlledPage, type BrowserInspection } from "../core/pc/browser_inspect.js";
import { PcFileAudit, PcHostGateway } from "../core/pc/gateway.js";
import { PC_TARGETS, isPcTarget, pcDoctor, pcMap, pcMapV2, pcTargetUrl, type PcDoctorReport } from "../core/pc/doctor.js";

function renderDoctor(report: PcDoctorReport): string {
  const lines = [`PC doctor · ${report.target} · ${report.observedAt}`];
  for (const metric of report.metrics) {
    const repeat = metric.sampleCount ? ` (${metric.sampleCount} samples, range ${metric.range ?? 0} ${metric.unit})` : "";
    lines.push(`  ${metric.id.padEnd(27)} ${metric.state === "measured" ? `${metric.value} ${metric.unit}${repeat}` : `${metric.state}: ${metric.reason ?? "unknown"}`}`);
  }
  lines.push(`  processes                   ${report.processes.state}: ${report.processes.items.length} matching app/browser processes`);
  if (report.processes.reason) lines.push(`  process detail              ${report.processes.reason}`);
  lines.push(`  target HTTP                 ${report.networkProbe.state}: ${report.networkProbe.httpClass}`);
  if (report.networkProbe.statusCodes.length) lines.push(`  HTTP statuses               ${report.networkProbe.statusCodes.join(", ")}`);
  if (report.networkProbe.state === "inconclusive" || report.networkProbe.state === "unavailable") lines.push(`  probe detail                ${report.networkProbe.reason}`);
  if (report.recommendations.length) {
    lines.push("Suggestions:");
    for (const item of report.recommendations) lines.push(`  - ${item}`);
  }
  return lines.join("\n") + "\n";
}

async function explicitApproval(message: string, signal?: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      const done = (value: string) => { signal?.removeEventListener("abort", abort); resolve(value); };
      const abort = () => { rl.close(); done(""); };
      if (signal?.aborted) { done(""); return; }
      signal?.addEventListener("abort", abort, { once: true });
      rl.question(`${message}\nApprove this one action? [y/N] `, done);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function draftLine(): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const value = await new Promise<string>((resolve) => rl.question("Draft text (one line, at most 2000 characters): ", resolve));
    return value.length > 0 && value.length <= 2000 && !/[\r\n\0]/.test(value) ? value : null;
  } finally {
    rl.close();
  }
}

export async function cmdPc(ctx: AppContext, argv: string[], flags: CommandFlags): Promise<number> {
  const sub = argv[0] ?? "map";
  if (sub === "map" && (argv.length === 1 || (argv.length === 2 && (argv[1] === "v1" || argv[1] === "v2")))) {
    if (argv[1] === "v1") {
      const map = pcMap();
      process.stdout.write(ctx.flags.json ? JSON.stringify(map) + "\n" :
        `PC capabilities · ${map.platform} · legacy v1\n` + map.capabilities.map((row) => `  ${row.id.padEnd(22)} ${row.state.padEnd(11)} ${row.detail}`).join("\n") + "\n");
      return 0;
    }
    const map = pcMapV2();
    process.stdout.write(ctx.flags.json ? JSON.stringify(map) + "\n" :
      `PC capabilities · ${map.platform} · v2\n` + map.capabilities.map((row) =>
        `  ${row.id.padEnd(22)} ${row.runtimeReadiness.padEnd(15)} ${row.permission.padEnd(22)} ${row.detail}`,
      ).join("\n") + "\n");
    return 0;
  }
  if (sub === "doctor" && argv.length <= 2) {
    const target = argv[1] ?? "aether-cloud";
    if (!isPcTarget(target)) {
      process.stderr.write(`Unknown PC target. Choose: ${PC_TARGETS.join(", ")}\n`);
      return 2;
    }
    const report = await pcDoctor(target, ctx.flags.cwd, flags.bool("probe-network"));
    process.stdout.write(ctx.flags.json ? JSON.stringify(report) + "\n" : renderDoctor(report));
    return 0;
  }
  if (sub === "verify-browser" && argv.length === 1) {
    if (ctx.flags.yes || !process.stdin.isTTY) {
      process.stderr.write("Browser verification opens a local tab and requires fresh interactive approval; --yes and headless execution do not grant it.\n");
      return 3;
    }
    const browser = detectBrowserRuntime();
    if (!browser.available) {
      process.stderr.write(`Browser unavailable: ${browser.evidence}\n`);
      return 3;
    }
    const expectedState = browser.browser ?? browser.launcher ?? "browser-ready";
    const broker = new PcActionBroker(randomUUID(), userInfo().username, {
      interactive: true,
      approve: () => explicitApproval("Open a local Aether browser readiness page on 127.0.0.1?"),
    });
    const plan = broker.plan({ adapter: "browser.verify", operation: "verify", target: "127.0.0.1", expectedState });
    const verification: { proof?: VerifyResult } = {};
    const receipt = await new PcHostGateway(broker, new PcFileAudit()).execute(plan,
      () => {
        const current = detectBrowserRuntime();
        return current.available ? current.browser ?? current.launcher ?? "browser-ready" : "unavailable";
      },
      async () => {
        verification.proof = await verifyBrowserLaunch({ timeoutMs: 10_000 });
        return {
          dispatched: verification.proof.code === "BROWSER_READY" || verification.proof.code === "BROWSER_UNVERIFIED",
          verified: verification.proof.verified,
        };
      },
    );
    process.stdout.write(ctx.flags.json ? JSON.stringify({ receipt, proof: verification.proof ?? null }) + "\n" :
      `Browser readiness: ${verification.proof?.verified ? "verified" : receipt.status}\n${verification.proof?.evidence ?? receipt.reason}\n`);
    return receipt.status === "succeeded" && verification.proof?.verified ? 0 : 3;
  }
  if (sub === "open" && argv.length === 2) {
    const target = argv[1]!;
    if (!isPcTarget(target) || target === "ollama") {
      process.stderr.write("PC open supports aether-cloud, claude and chatgpt.\n");
      return 2;
    }
    if (ctx.flags.yes || !process.stdin.isTTY) {
      process.stderr.write("PC actions require a fresh interactive approval; --yes and headless execution do not grant it.\n");
      return 3;
    }
    const browser = detectBrowserRuntime();
    if (!browser.available) {
      process.stderr.write(`Browser unavailable: ${browser.evidence}\n`);
      return 3;
    }
    const url = pcTargetUrl(target);
    const broker = new PcActionBroker(randomUUID(), userInfo().username, {
      interactive: true,
      approve: (plan) => explicitApproval(`Open ${plan.target} in the default browser: ${url}`),
    });
    const plan = broker.plan({ adapter: "browser.open", operation: "open", target, expectedState: browser.browser ?? browser.launcher ?? "browser-ready" });
    const receipt = await new PcHostGateway(broker, new PcFileAudit()).execute(plan,
      () => {
        const current = detectBrowserRuntime();
        return current.available ? current.browser ?? current.launcher ?? "browser-ready" : "unavailable";
      },
      async () => (await openTargetChecked(url)).status === "spawned",
    );
    process.stdout.write(ctx.flags.json ? JSON.stringify(receipt) + "\n" : `${receipt.status}: ${receipt.reason}\n`);
    return receipt.status === "succeeded" ? 0 : 3;
  }
  if (sub === "inspect-browser" && argv.length === 2) {
    const target = argv[1]!;
    if (!isPcTarget(target) || target === "ollama") {
      process.stderr.write("PC browser inspection supports aether-cloud, claude and chatgpt.\n");
      return 2;
    }
    if (ctx.flags.yes || !process.stdin.isTTY) {
      process.stderr.write("PC browser inspection requires fresh interactive approval; --yes and headless execution do not grant it.\n");
      return 3;
    }
    const executable = controlledEdgeExecutable();
    if (!executable) {
      process.stderr.write("Controlled Edge browser unavailable on this Windows installation.\n");
      return 3;
    }
    const url = pcTargetUrl(target);
    const broker = new PcActionBroker(randomUUID(), userInfo().username, {
      interactive: true,
      approve: () => explicitApproval(`Inspect only page readiness and structural presence at ${new URL(url).origin} in a disposable Edge profile?`),
    });
    const plan = broker.plan({ adapter: "browser.inspect", operation: "inspect", target, expectedState: executable });
    const observation: { proof?: BrowserInspection } = {};
    const receipt = await new PcHostGateway(broker, new PcFileAudit()).execute(plan,
      () => controlledEdgeExecutable() ?? "unavailable",
      async () => {
        observation.proof = await inspectControlledPage(url);
        return {
          dispatched: observation.proof.browserLaunched,
          verified: observation.proof.profileCleaned &&
            (observation.proof.state === "rendered" || observation.proof.state === "login-required"),
        };
      },
    );
    const proof = observation.proof ?? null;
    process.stdout.write(ctx.flags.json ? JSON.stringify({ receipt, proof }) + "\n" :
      `Browser inspection: ${proof?.state ?? receipt.status}\n${proof?.reason ?? receipt.reason}\n`);
    return receipt.status === "succeeded" ? 0 : 3;
  }
  if (sub === "draft-browser" && argv.length === 2) {
    const target = argv[1]!;
    if (!isPcTarget(target) || target === "ollama") {
      process.stderr.write("PC browser draft supports aether-cloud, claude and chatgpt.\n");
      return 2;
    }
    if (ctx.flags.yes || !process.stdin.isTTY) {
      process.stderr.write("PC browser draft requires fresh interactive approval; --yes and headless execution do not grant it.\n");
      return 3;
    }
    const executable = controlledEdgeExecutable();
    if (!executable) {
      process.stderr.write("Controlled Edge browser unavailable on this Windows installation.\n");
      return 3;
    }
    const text = await draftLine();
    if (text === null) {
      process.stderr.write("Draft text must be one nonempty line of at most 2000 characters.\n");
      return 2;
    }
    const url = pcTargetUrl(target);
    let draftAbort: AbortController | null = null;
    const broker = new PcActionBroker(randomUUID(), userInfo().username, {
      interactive: true,
      approve: (plan) => plan.adapter === "browser.inspect"
        ? explicitApproval(`Open and inspect ${new URL(url).origin} in a disposable Edge profile?`)
        : explicitApproval(`Insert ${text.length} characters into the observed empty ${plan.operation} at ${new URL(url).origin}? Element ${plan.target.split(":").at(-1)}. The site may save or send data when focused or typed into.`, draftAbort?.signal),
    });
    const gateway = new PcHostGateway(broker, new PcFileAudit());
    const plan = broker.plan({ adapter: "browser.inspect", operation: "inspect", target, expectedState: executable });
    const observation: { inspection?: BrowserInspection; draftReceipt?: PcActionReceipt } = {};
    const openReceipt = await gateway.execute(plan, () => controlledEdgeExecutable() ?? "unavailable", async () => {
      draftAbort = new AbortController();
      const onInterrupt = () => draftAbort?.abort();
      process.once("SIGINT", onInterrupt);
      try {
        observation.inspection = await inspectControlledPage(url, { signal: draftAbort.signal }, async (composer) => {
          const action = broker.plan({
            adapter: "browser.draft", operation: composer.kind,
            target: `${target}:${composer.identity}`, expectedState: composer.identity,
          }, 60_000);
          observation.draftReceipt = await gateway.execute(action, () => composer.observe(), () => composer.insert(text));
        });
      } finally {
        process.removeListener("SIGINT", onInterrupt);
      }
      return {
        dispatched: observation.inspection.browserLaunched,
        verified: observation.inspection.profileCleaned && (observation.inspection.state === "rendered" || observation.inspection.state === "login-required"),
      };
    });
    const finalReceipt = observation.draftReceipt?.status === "succeeded" && openReceipt.status !== "succeeded"
      ? { ...observation.draftReceipt, status: "unknown" as const, reason: "draft insertion succeeded but browser inspection or cleanup failed; verify before retry" }
      : observation.draftReceipt;
    process.stdout.write(ctx.flags.json ? JSON.stringify({ openReceipt, draftReceipt: finalReceipt ?? null, proof: observation.inspection ?? null }) + "\n"
      : `Browser draft: ${finalReceipt?.status ?? "unavailable"}\n${finalReceipt?.reason ??
        (observation.inspection?.state === "rendered" ? "No single empty editable composer was observed." : observation.inspection?.reason) ?? openReceipt.reason}\n`);
    return openReceipt.status === "succeeded" && finalReceipt?.status === "succeeded" ? 0 : 3;
  }
  process.stderr.write("usage: aether pc map [v1|v2] | doctor [aether-cloud|claude|chatgpt|ollama] [--probe-network] | verify-browser | open [aether-cloud|claude|chatgpt] | inspect-browser [aether-cloud|claude|chatgpt] | draft-browser [aether-cloud|claude|chatgpt]\n");
  return 2;
}
