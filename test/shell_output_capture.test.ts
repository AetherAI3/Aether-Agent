import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutor, type RunOptions, type ToolResult } from "../src/core/tool_executor.js";
import { ShellSession } from "../src/core/shell_session.js";
import { tmpWorkspace } from "./tmp_workspace.js";

const supportedSession = process.platform === "linux" || process.platform === "darwin";
const FIRST = "FIRST_STDOUT_247\n";
const LAST_OUT = "FINAL_STDOUT_SUMMARY_247\n";
const LAST_ERR = "FINAL_STDERR_SUMMARY_247\n";
const READY = "READY_FOR_STOP_247";
const FLOOD_BYTES = 66 * 1024 * 1024;
const quote = (value: string): string => process.platform === "win32"
  ? `"${value.replaceAll('"', '""')}"`
  : "'" + value.replaceAll("'", "'\\''") + "'";

// Generate the flood in the child and await each write callback. The parent
// never builds a giant fixture string or accumulates the live output stream.
const floodScript = `
const write = (stream, data) => new Promise((resolve, reject) => {
  stream.write(data, error => error ? reject(error) : resolve());
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await write(process.stdout, ${JSON.stringify(FIRST)});
  await write(process.stderr, "FIRST_STDERR_247\\n");
  await delay(20);
  const chunk = Buffer.alloc(64 * 1024, 120);
  for (let i = 0; i < 65 * 16; i++) await write(process.stdout, chunk);
  for (let i = 0; i < 16; i++) await write(process.stderr, chunk);
  await delay(20);
  await write(process.stdout, ${JSON.stringify(LAST_OUT)});
  await write(process.stderr, ${JSON.stringify(LAST_ERR)});
  if (process.argv[2] === "wait") {
    await write(process.stdout, ${JSON.stringify(`${READY}\n`.repeat(6))});
    setInterval(() => {}, 1000);
  } else {
    process.exitCode = 7;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function fixture(persistent = false, script = floodScript): {
  exec: ToolExecutor;
  command: (mode?: string) => string;
  session?: ShellSession;
  close: () => void;
} {
  const root = tmpWorkspace("aether-output-247-");
  const path = join(root, "flood.cjs");
  writeFileSync(path, script);
  const session = persistent ? new ShellSession(root) : undefined;
  const exec = new ToolExecutor(root, undefined, { mode: "coding", ...(session ? { shellSession: session } : {}) });
  return {
    exec,
    ...(session ? { session } : {}),
    command: (mode = "exit") => `${quote(process.execPath)} ${quote(path)} ${quote(mode)}`,
    close: () => { exec.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function streamed(): { bytes: number; tail: string; output: (chunk: string) => void } {
  const result = {
    bytes: 0,
    tail: "",
    output(chunk: string): void {
      result.bytes += Buffer.byteLength(chunk, "utf8");
      result.tail = (result.tail + chunk).slice(-512);
    },
  };
  return result;
}

function assertSummary(result: ToolResult, exitCode: number): void {
  assert.equal(result.exitCode, exitCode, result.output);
  assert.ok(result.output.includes(FIRST), "the initial output must survive truncation");
  assert.ok(result.output.includes(LAST_OUT), "the final stdout summary must survive the 64 MiB boundary");
  assert.ok(result.output.includes(LAST_ERR), "the final stderr summary must survive the 64 MiB boundary");
  assert.ok(result.output.length <= 8300, "retained output must remain bounded, including status and truncation notices");
}

type Entrypoint = "run_shell" | "run_tests" | "runUserCommand";
function run(exec: ToolExecutor, entrypoint: Entrypoint, command: string, options: RunOptions): Promise<ToolResult> {
  return entrypoint === "runUserCommand"
    ? exec.runUserCommand(command, options)
    : exec.executeAsync(entrypoint, { command }, options);
}

for (const entrypoint of ["run_shell", "run_tests", "runUserCommand"] as const) {
  test(`${entrypoint} retains first and final summaries after more than 64 MiB while streaming every byte`, { timeout: 30_000 }, async () => {
    const w = fixture();
    const live = streamed();
    try {
      const result = await run(w.exec, entrypoint, w.command(), { onOutput: live.output });
      assertSummary(result, 7);
      assert.match(result.output, /^\[exit 7\]\n/);
      assert.equal(live.bytes, FLOOD_BYTES + Buffer.byteLength(FIRST + "FIRST_STDERR_247\n" + LAST_OUT + LAST_ERR));
      assert.ok(live.tail.includes(LAST_OUT), "live stdout must continue after the retention cap");
      assert.ok(live.tail.includes(LAST_ERR), "live stderr must continue after the retention cap");
    } finally { w.close(); }
  });
}

test("one-shot live output decodes split UTF-8 independently for stdout and stderr", { timeout: 10_000 }, async () => {
  const root = tmpWorkspace("aether-output-utf8-247-");
  const path = join(root, "utf8.cjs");
  writeFileSync(path, `
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
(async () => {
  const out = Buffer.from("OUT:€😀\\n");
  const err = Buffer.from("ERR:界🦀\\n");
  for (let i = 0; i < Math.max(out.length, err.length); i++) {
    if (i < out.length) process.stdout.write(out.subarray(i, i + 1));
    if (i < err.length) process.stderr.write(err.subarray(i, i + 1));
    await pause();
  }
})();
`);
  const live = streamed();
  try {
    const result = await new ToolExecutor(root).runUserCommand(`${quote(process.execPath)} ${quote(path)}`, { onOutput: live.output });
    assert.equal(result.exitCode, 0, result.output);
    assert.doesNotMatch(result.output, /\ufffd/, "retained output must not replace a split multibyte character");
    assert.doesNotMatch(live.tail, /\ufffd/, "live output must not replace a split multibyte character");
    // The streams can interleave, so compare the emitted characters without
    // imposing an artificial ordering across independent pipes.
    const payload = "OUT:€😀\nERR:界🦀\n";
    assert.equal(live.bytes, Buffer.byteLength(payload));
    assert.deepEqual([...live.tail].sort(), [...payload].sort());
    assert.deepEqual([...result.output.replace(/^\[exit 0\]\n/, "")].sort(), [...payload].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one-shot cancellation after the output cap keeps recent summaries and reports 130", { timeout: 30_000 }, async () => {
  const w = fixture();
  const live = streamed();
  const abort = new AbortController();
  let stopRequested = false;
  try {
    const result = await w.exec.runUserCommand(w.command("wait"), {
      timeoutMs: 20_000,
      signal: abort.signal,
      onOutput(chunk) {
        live.output(chunk);
        if (!stopRequested && live.tail.includes(READY)) {
          stopRequested = true;
          setImmediate(() => abort.abort());
        }
      },
    });
    assert.equal(stopRequested, true, "cancellation must happen only after the child emits its post-cap marker");
    assert.ok(live.bytes > 64 * 1024 * 1024);
    assertSummary(result, 130);
    assert.match(result.output, /^\[aborted\]/);
    assert.ok(result.output.includes(READY));
  } finally { w.close(); }
});

test("one-shot timeout after the output cap keeps recent summaries and reports 124", { timeout: 30_000 }, async () => {
  const w = fixture();
  const live = streamed();
  try {
    const result = await w.exec.executeAsync("run_tests", { command: w.command("wait") }, {
      timeoutMs: 10_000,
      onOutput: live.output,
    });
    assert.ok(live.bytes > 64 * 1024 * 1024);
    assert.ok(live.tail.includes(READY), "the timeout must occur after the child emits its post-cap marker");
    assertSummary(result, 124);
    assert.match(result.output, /^\[timeout after /);
    assert.ok(result.output.includes(READY));
  } finally { w.close(); }
});

test("persistent model and user shell commands retain post-cap summaries, drain streams, and isolate the next command", {
  skip: !supportedSession,
  timeout: 30_000,
}, async () => {
  const w = fixture(true);
  try {
    for (const entrypoint of ["run_shell", "runUserCommand"] as const) {
      const live = streamed();
      const result = await run(w.exec, entrypoint, w.command(), { onOutput: live.output });
      assertSummary(result, 7);
      assert.equal(live.bytes, FLOOD_BYTES + Buffer.byteLength(FIRST + "FIRST_STDERR_247\n" + LAST_OUT + LAST_ERR));
      assert.ok(live.tail.includes(LAST_OUT));
      assert.ok(live.tail.includes(LAST_ERR));
      assert.equal(w.session!.state, "ready");
      const nextLive = streamed();
      const next = await w.exec.runUserCommand("printf NEXT_COMMAND_247", { onOutput: nextLive.output });
      assert.deepEqual(next, { exitCode: 0, output: "[exit 0]\nNEXT_COMMAND_247" });
      assert.equal(nextLive.tail, "NEXT_COMMAND_247");
      assert.equal(nextLive.bytes, Buffer.byteLength("NEXT_COMMAND_247"));
    }
  } finally { w.close(); }
});

test("persistent live output preserves split UTF-8 through marker lookbehind without protocol leakage", {
  skip: !supportedSession,
  timeout: 10_000,
}, async () => {
  // Follow the astral characters with enough individually written bytes to
  // slide each surrogate pair across the protocol marker's lookbehind edge.
  const out = "OUT:€😀" + ".".repeat(70) + "\n";
  const err = "ERR:界🦀" + "-".repeat(70) + "\n";
  const w = fixture(true, `
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
(async () => {
  const out = Buffer.from(${JSON.stringify(out)});
  const err = Buffer.from(${JSON.stringify(err)});
  for (let i = 0; i < Math.max(out.length, err.length); i++) {
    if (i < out.length) process.stdout.write(out.subarray(i, i + 1));
    if (i < err.length) process.stderr.write(err.subarray(i, i + 1));
    await pause();
  }
})();
`);
  const live = streamed();
  let completeUnicodeChunks = true;
  try {
    const result = await w.exec.executeAsync("run_shell", { command: w.command() }, {
      onOutput(chunk) {
        completeUnicodeChunks &&= Buffer.from(chunk, "utf8").toString("utf8") === chunk;
        live.output(chunk);
      },
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(completeUnicodeChunks, true, "each live callback must contain complete Unicode characters");
    assert.doesNotMatch(result.output, /[\ufffd\x1e\x1f\x00]/);
    assert.doesNotMatch(live.tail, /[\ufffd\x1e\x1f\x00]/);
    assert.equal(live.bytes, Buffer.byteLength(out + err));
    assert.deepEqual([...live.tail].sort(), [...(out + err)].sort());
    assert.deepEqual([...result.output.replace(/^\[exit 0\]\n/, "")].sort(), [...(out + err)].sort());
    const next = await w.exec.runUserCommand("printf UTF8_NEXT_COMMAND_247");
    assert.deepEqual(next, { exitCode: 0, output: "[exit 0]\nUTF8_NEXT_COMMAND_247" });
  } finally { w.close(); }
});

for (const termination of ["cancellation", "timeout"] as const) {
  test(`persistent ${termination} after the output cap keeps summaries, loses state visibly, and resets cleanly`, {
    skip: !supportedSession,
    timeout: 30_000,
  }, async () => {
    const w = fixture(true);
    const live = streamed();
    const abort = new AbortController();
    let stopRequested = false;
    try {
      const result = await w.exec.runUserCommand(w.command("wait"), {
        timeoutMs: termination === "timeout" ? 10_000 : 20_000,
        signal: abort.signal,
        onOutput(chunk) {
          live.output(chunk);
          if (termination === "cancellation" && !stopRequested && live.tail.includes(READY)) {
            stopRequested = true;
            setImmediate(() => abort.abort());
          }
        },
      });
      assert.ok(live.bytes > 64 * 1024 * 1024);
      assert.ok(live.tail.includes(READY), "termination must happen after the child emits its post-cap marker");
      assertSummary(result, termination === "cancellation" ? 130 : 124);
      assert.ok(result.output.includes(READY));
      assert.match(result.output, termination === "cancellation" ? /^\[aborted;/ : /^\[shell command timed out;/);
      assert.match(result.output, /shell state lost/);
      assert.doesNotMatch(result.output, /[\x1e\x1f\x00]/, "command protocol must never appear in retained output");
      assert.doesNotMatch(live.tail, /[\x1e\x1f\x00]/, "command protocol must never appear in live output");
      if (termination === "cancellation") assert.equal(stopRequested, true);
      assert.equal(w.session!.state, "lost");
      const refused = await w.exec.runUserCommand("printf SHOULD_NOT_RUN_247");
      assert.equal(refused.exitCode, 1);
      assert.doesNotMatch(refused.output, /SHOULD_NOT_RUN_247/);
      w.session!.reset();
      const nextLive = streamed();
      const next = await w.exec.runUserCommand("printf AFTER_RESET_247", { onOutput: nextLive.output });
      assert.deepEqual(next, { exitCode: 0, output: "[exit 0]\nAFTER_RESET_247" });
      assert.equal(nextLive.tail, "AFTER_RESET_247");
      assert.equal(nextLive.bytes, Buffer.byteLength("AFTER_RESET_247"));
    } finally { w.close(); }
  });
}
