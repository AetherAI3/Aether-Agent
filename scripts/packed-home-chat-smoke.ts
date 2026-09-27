// Exercise the installed npm tarball from a synthetic, broad home directory.
// The fixture crosses the instruction-scan entry budget, so the warning is
// observable and a 0.3.2 package fails this smoke even if its full scan happens
// to finish quickly on a fast CI runner. No real home files or credentials are used.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prompt = "just testing reply 1";
const continuationPrompt = "just testing reply 2";

function npm(args: string[], cwd: string): string {
  const npmCli = process.platform === "win32"
    ? [process.env["npm_execpath"], join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
      .find((path) => path && existsSync(path))
    : undefined;
  if (process.platform === "win32" && !npmCli) throw new Error("Node's npm CLI was not found beside the installed Node runtime");
  const result = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args[0]} failed: ${result.error?.message ?? result.stderr?.slice(-2_000) ?? result.status}`);
  }
  return result.stdout;
}

async function runInstalled(main: string, cwd: string, baseUrl: string, configDir: string, lines: string, streamTimeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const child = spawn(process.execPath, [main], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      AETHER_CONFIG_DIR: configDir,
      AETHER_TOKEN: "aek_packed_smoke_only",
      AETHER_BACKEND: "cloud",
      AETHER_BASE_URL: baseUrl,
      AETHER_NO_HISTORY: "1",
      ...(streamTimeoutMs ? { AETHER_STREAM_TIMEOUT_MS: String(streamTimeoutMs) } : {}),
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk.slice(0, 65_536); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk.slice(0, 65_536); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20_000);
  child.stdin.end(lines);
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    return { stdout, stderr, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const fixture = mkdtempSync(join(tmpdir(), "aether-packed-home-"));
  const home = join(fixture, "home");
  const prefix = join(fixture, "prefix");
  const configDir = join(fixture, "config");
  mkdirSync(home);
  // A single real home directory can contain thousands of child names. This
  // deterministic fixture trips the same entry cap without touching user data.
  for (let i = 0; i < 2_100; i++) mkdirSync(join(home, `folder-${String(i).padStart(4, "0")}`));
  let requests = 0;
  let requestBodies: string[] = [];
  let mode: "success" | "recover-401" = "success";
  let heldResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk.slice(0, 32_768); });
    request.on("end", () => {
      if (request.url?.endsWith("/agent/chat/stream")) {
        requests++;
        requestBodies.push(body);
        if (mode === "recover-401" && requests === 1) {
          // Headers arrive, but the optional JSON detail never completes.
          // The installed CLI must show the known 401, then accept the next
          // queued REPL prompt without retrying the uncertain first request.
          response.writeHead(401, { "Content-Type": "application/json" });
          response.write('{"detail":');
          heldResponse = response;
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const answer = body.includes(continuationPrompt) ? "2" : "1";
        response.end(`data: {"type":"delta","text":"${answer}"}\n\ndata: {"type":"done","uvt":1,"cents":0}\n\n`);
      } else if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"models":[]}');
      } else {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end('{"detail":"unexpected smoke route"}');
      }
    });
  });
  try {
    const givenTarball = process.argv[2];
    const tarball = givenTarball
      ? resolve(repoRoot, givenTarball)
      : join(fixture, (JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", fixture], repoRoot)) as Array<{ filename: string }>)[0]!.filename);
    if (!existsSync(tarball)) throw new Error("packed npm tarball is missing");
    npm(["install", "--global", "--prefix", prefix, tarball, "--ignore-scripts", "--no-audit", "--no-fund"], repoRoot);
    const installedRoot = join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "aether-agents");
    const installedMain = join(installedRoot, "dist", "src", "main.js");
    if (!existsSync(installedMain)) throw new Error("installed package has no CLI entrypoint");

    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}/cloud`;
    const result = await runInstalled(installedMain, home, baseUrl, configDir, prompt + "\n");
    if (result.timedOut || result.code !== 0 || requests !== 1 || !requestBodies[0]?.includes(prompt) || !/\b1\b/.test(result.stdout) || !/nested AGENTS\.md scan reached 2048 entries/.test(result.stderr)) {
      throw new Error(`packed home chat smoke failed: ${JSON.stringify({ ...result, requests, requestBodies })}`);
    }
    mode = "recover-401";
    requests = 0;
    requestBodies = [];
    const recovered = await runInstalled(installedMain, home, baseUrl, configDir, `${prompt}\n${continuationPrompt}\n`, 800);
    if (recovered.timedOut || recovered.code !== 0 || requests !== 2 || !requestBodies[0]?.includes(prompt) || !requestBodies[1]?.includes(continuationPrompt) || !/HTTP 401/.test(recovered.stderr) || !/aether auth login/.test(recovered.stderr) || !/\b2\b/.test(recovered.stdout)) {
      throw new Error(`packed 401 continuation smoke failed: ${JSON.stringify({ ...recovered, requests, requestBodies })}`);
    }
    heldResponse?.destroy();
    process.stdout.write("packed home chat smoke passed: bounded scan, answer 1, visible 401 and continued answer 2\n");
  } finally {
    heldResponse?.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (dirname(fixture) === tmpdir() && basename(fixture).startsWith("aether-packed-home-")) {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
