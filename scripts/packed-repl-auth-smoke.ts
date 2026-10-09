// Exercise the installed npm package's interactive chat path without a real
// credential or Cloud request. A 401 whose body never closes must return to the
// prompt within the configured stream bound, instead of parking the terminal.
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL_DIR = resolve(process.cwd(), "node_modules", "aether-agents");
const INSTALLED_ENTRY = process.argv[2]
  ? resolve(process.argv[2])
  : join(INSTALL_DIR, "dist", "src", "main.js");
const SMOKE_PROMPT = "just testing reply 1";
const TIMEOUT_MS = 300;
const DEADLINE_MS = 8_000;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  submitted: boolean;
  exitSent: boolean;
  timedOut: boolean;
}

async function runInstalledRepl(baseUrl: string, scratch: string): Promise<ChildResult> {
  // Pipes are used for deterministic CI input, while this preload enters the
  // CLI's raw-key REPL branch. This covers the same input handler as a Windows
  // console; a real ConPTY/desktop canary remains a separate live check.
  const preload = join(scratch, "tty-preload.cjs");
  writeFileSync(preload, [
    "Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });",
    "process.stdin.setRawMode = () => process.stdin;",
    "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });",
  ].join("\n") + "\n");

  const child = spawn(process.execPath, ["--require", preload, INSTALLED_ENTRY], {
    cwd: scratch,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AETHER_CONFIG_DIR: scratch,
      AETHER_BASE_URL: baseUrl,
      AETHER_TOKEN: "aek_offline_release_smoke",
      AETHER_BACKEND: "cloud",
      AETHER_NO_HISTORY: "1",
      AETHER_NO_ANIM: "1",
      AETHER_STREAM_TIMEOUT_MS: String(TIMEOUT_MS),
      AETHER_REQUEST_TIMEOUT_MS: String(TIMEOUT_MS),
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
  let stdout = "";
  let stderr = "";
  let submitted = false;
  let exitSent = false;
  let timedOut = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const maybeDrive = (): void => {
    if (!submitted && stdout.includes("Type a prompt, or /help for commands")) {
      submitted = true;
      child.stdin.write(`${SMOKE_PROMPT}\r`);
    }
    if (submitted && !exitSent && stderr.includes("✗")) {
      exitSent = true;
      // A failed submission is intentionally restored as a draft. Ctrl+C
      // clears that draft, then /exit demonstrates that the REPL accepts input.
      exitTimer = setTimeout(() => child.stdin.write("\x03/exit\r\r"), 100);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); maybeDrive(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); maybeDrive(); });
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, DEADLINE_MS);
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("exit", done);
    });
    return { code, stdout, stderr, submitted, exitSent, timedOut };
  } finally {
    clearTimeout(deadline);
    if (exitTimer) clearTimeout(exitTimer);
    child.kill();
  }
}

async function main(): Promise<void> {
  if (!existsSync(INSTALLED_ENTRY)) {
    throw new Error(`packed CLI entry missing: ${INSTALLED_ENTRY}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "aether-packed-repl-401-"));
  let requests = 0;
  const hangingResponses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === "/cloud/agent/chat/stream" && req.method === "POST") {
      requests += 1;
      if (req.headers.authorization !== "Bearer aek_offline_release_smoke") {
        res.writeHead(500).end("fixture token missing");
        return;
      }
      hangingResponses.add(res);
      res.writeHead(401, { "content-type": "application/json" });
      res.write('{"detail":"unauthorized fixture');
      return; // deliberately never end the 401 body
    }
    res.writeHead(404).end("fixture route unavailable");
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
    const result = await runInstalledRepl(`http://127.0.0.1:${address.port}/cloud`, scratch);
    if (result.timedOut || result.code !== 0 || !result.submitted || !result.exitSent || requests !== 1) {
      throw new Error(`installed REPL did not recover from the 401: ${JSON.stringify({
        code: result.code, timedOut: result.timedOut, submitted: result.submitted,
        exitSent: result.exitSent, requests, stdout: result.stdout.slice(-1600),
        stderr: result.stderr.slice(-1600),
      })}`);
    }
    if (!/timeout|timed out|HTTP 401/i.test(result.stderr)) {
      throw new Error(`installed REPL did not show a terminal 401/timeout error: ${result.stderr.slice(-1600)}`);
    }
    process.stdout.write("packed interactive 401 recovery verified\n");
  } finally {
    for (const response of hangingResponses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
