import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import type { AppContext } from "../core/context.js";
import type { CommandFlags } from "../core/command_dispatch.js";
import { detectBrowserRuntime, verifyBrowserLaunch, type VerifyResult } from "../core/browser_runtime.js";
import { openTargetChecked } from "../core/opener.js";
import { PcActionBroker } from "../core/pc/broker.js";
import { PcFileAudit, PcHostGateway } from "../core/pc/gateway.js";
import { PC_TARGETS, isPcTarget, pcDoctor, pcMap, pcTargetUrl, type PcDoctorReport } from "../core/pc/doctor.js";

function renderDoctor(report: PcDoctorReport): string {
  const lines = [`PC doctor · ${report.target} · ${report.observedAt}`];
  for (const metric of report.metrics) {
    lines.push(`  ${metric.id.padEnd(27)} ${metric.state === "measured" ? `${metric.value} ${metric.unit}` : `${metric.state}: ${metric.reason ?? "unknown"}`}`);
  }
  lines.push(`  processes                   ${report.processes.state}: ${report.processes.items.length} matching app/browser processes`);
  if (report.processes.reason) lines.push(`  process detail              ${report.processes.reason}`);
  if (report.recommendations.length) {
    lines.push("Suggestions:");
    for (const item of report.recommendations) lines.push(`  - ${item}`);
  }
  return lines.join("\n") + "\n";
}

async function explicitApproval(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${message}\nApprove this one action? [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function cmdPc(ctx: AppContext, argv: string[], flags: CommandFlags): Promise<number> {
  const sub = argv[0] ?? "map";
  if (sub === "map" && argv.length <= 1) {
    const map = pcMap();
    process.stdout.write(ctx.flags.json ? JSON.stringify(map) + "\n" :
      `PC capabilities · ${map.platform}\n` + map.capabilities.map((row) => `  ${row.id.padEnd(22)} ${row.state.padEnd(11)} ${row.detail}`).join("\n") + "\n");
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
        return verification.proof.verified;
      },
    );
    process.stdout.write(ctx.flags.json ? JSON.stringify({ receipt, proof: verification.proof ?? null }) + "\n" :
      `Browser readiness: ${verification.proof?.verified ? "verified" : receipt.status}\n${verification.proof?.evidence ?? receipt.reason}\n`);
    return receipt.status === "succeeded" ? 0 : 3;
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
  process.stderr.write("usage: aether pc map | doctor [aether-cloud|claude|chatgpt|ollama] [--probe-network] | verify-browser | open [aether-cloud|claude|chatgpt]\n");
  return 2;
}
