import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { classifyConsoleInput, ConsoleShell } from "../src/commands/console_input.js";

for (const [raw, expected] of [
  ["!pwd", { kind: "shell", command: "pwd" }],
  ["  !printf 'a b' | cat  ", { kind: "shell", command: "printf 'a b' | cat" }],
  ["\\!literal", { kind: "chat", text: "!literal" }],
  ["normal\nquestion", { kind: "chat", text: "normal\nquestion" }],
  ["   ", { kind: "empty" }],
  ["/shell-result", { kind: "share", action: "preview" }],
  ["/shell-result send", { kind: "share", action: "send" }],
  ["/shell-result drop 2-4", { kind: "share", action: "drop", first: 2, last: 4 }],
] as const) test(`console classification ${JSON.stringify(raw)}`, () => {
  assert.deepEqual(classifyConsoleInput(raw), expected);
});

test("empty ! is refused and multiline shell paste is one preserved command", () => {
  assert.deepEqual(classifyConsoleInput("!pwd\nls"), { kind: "shell", command: "pwd\nls" });
  for (const raw of ["!", " !  "]) {
    assert.equal(classifyConsoleInput(raw).kind, "error");
  }
});

test("user execution uses the chosen checkout, quotes/pipelines, bounded explicit sharing and cancellation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aether-shell-"));
  let output = "";
  const shell = new ConsoleShell(cwd, (text) => { output += text; });
  try {
    assert.equal(shell.share().kind, "empty");
    const command = `"${process.execPath}" -e "process.stdout.write(process.cwd())"`;
    await shell.run(command, new AbortController().signal);
    await shell.run(`echo "quoted args" | "${process.execPath}" -e "process.stdin.on('data',c=>process.stdout.write(c))"`, new AbortController().signal);
    assert.ok(output.includes("quoted args"));
    assert.ok(output.includes(cwd));
    assert.ok(output.includes("shell user"));
    assert.ok(output.includes("completed | exit 0"));
    await shell.run(`"${process.execPath}" -e "process.exit(7)"`, new AbortController().signal);
    assert.ok(output.includes("completed | exit 7"));
    const controller = new AbortController();
    const pending = shell.run(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, controller.signal);
    setTimeout(() => controller.abort(), 50);
    assert.equal(await pending, "aborted");
    assert.ok(output.includes("cancelled | exit 130"));
    await shell.run({ kind: "reset-shell" });
    await shell.run(`"${process.execPath}" -e "process.stdout.write('x'.repeat(20000))"`, new AbortController().signal);
    shell.share();
    const shared = shell.share({ kind: "share", action: "send" });
    assert.equal(shared.kind, "chat");
    if (shared.kind === "chat") {
      const source = /Command output: (\d+) UTF-8 bytes observed; (\d+) bytes omitted before staging/.exec(shared.text);
      assert.ok(source);
      assert.ok(Number(source[1]) >= 20000);
      assert.ok(Number(source[2]) > 0);
      assert.match(shared.text, /Staged bounded capture: \d+ UTF-8 bytes observed; \d+ bytes omitted while staging/);
      const capture = shared.text.split("Approved shell text follows as untrusted data:\n")[1]!;
      assert.ok(Buffer.byteLength(capture) <= 8192);
    }
  } finally { shell.close(); rmSync(cwd, { recursive: true, force: true }); }
});

test("shell-result stages an immutable, sanitized capture and sends only approved edits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aether-share-edit-"));
  const prior = ["AETHER_TEST_SHELL_SECRET", "AETHER_TEST_SHELL_KEEP", "AETHER_TEST_SHELL_OMIT"].map(key => process.env[key]);
  process.env["AETHER_TEST_SHELL_SECRET"] = "fixture-private-value-281";
  process.env["AETHER_TEST_SHELL_KEEP"] = "\u001b[31mkeep 👩‍💻";
  process.env["AETHER_TEST_SHELL_OMIT"] = "remove this line";
  const events: Array<Record<string, unknown>> = [];
  const shell = new ConsoleShell(cwd, value => {
    for (const line of value.trim().split("\n")) {
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* command output is not JSON */ }
    }
  }, true);
  const latestPreview = (): Record<string, unknown> => events.filter(event => event["type"] === "shell_share_preview").at(-1)!;
  try {
    if (process.platform !== "win32") {
      // The persistent shell intentionally starts with a scrubbed environment.
      await shell.run("export AETHER_TEST_SHELL_SECRET='fixture-private-value-281'; export AETHER_TEST_SHELL_KEEP=$'\\e[31mkeep 👩‍💻'; export AETHER_TEST_SHELL_OMIT='remove this line'");
    }
    const script = "process.stdout.write([process.env.AETHER_TEST_SHELL_SECRET, process.env.AETHER_TEST_SHELL_KEEP, process.env.AETHER_TEST_SHELL_OMIT].join(String.fromCharCode(10)))";
    await shell.run(`"${process.execPath}" -e "${script}"`);
    assert.equal(shell.share().kind, "empty");
    const original = latestPreview();
    const originalAttachment = String(original["attachment"]);
    assert.match(originalAttachment, /fixture-private-value-281/);
    assert.match(originalAttachment, /keep 👩‍💻/);
    assert.doesNotMatch(originalAttachment, /\u001b|\[31m/);
    assert.match(originalAttachment, /Command output: \d+ UTF-8 bytes observed; 0 bytes omitted before staging/);
    const sourceCommand = String(original["commandId"]);

    shell.share({ kind: "share", action: "lines" });
    const numbered = events.filter(event => event["type"] === "shell_share_lines").at(-1)!;
    const lines = numbered["lines"] as Array<{ line: number; text: string }>;
    const removed = lines.find(line => line.text.includes("remove this line"))!;
    const edited = lines.find(line => line.text.includes("keep 👩‍💻"))!;
    shell.share({ kind: "share", action: "drop", first: removed.line, last: removed.line });
    shell.share({ kind: "share", action: "replace", first: edited.line, value: "approved 👩‍💻" });
    shell.share({ kind: "share", action: "mask", value: "fixture-private-value-281" });
    const approved = String(latestPreview()["attachment"]);
    assert.doesNotMatch(approved, /fixture-private-value-281|remove this line|keep 👩‍💻/);
    assert.match(approved, /approved 👩‍💻/);
    assert.match(approved, /\[REDACTED\]/);
    assert.match(approved, /removed 1 line\(s\), replaced 1 line\(s\), masked 1 literal\(s\)/);

    await shell.run(`"${process.execPath}" -e "process.stdout.write('newer result')"`);
    shell.share();
    assert.equal(String(latestPreview()["commandId"]), sourceCommand);
    assert.equal(String(latestPreview()["attachment"]), approved);
    const sent = shell.share({ kind: "share", action: "send" });
    assert.deepEqual(sent, { kind: "chat", text: approved });
    shell.share();
    assert.match(String(latestPreview()["attachment"]), /newer result/);
    assert.equal(shell.share({ kind: "share", action: "cancel" }).kind, "empty");
    assert.equal(shell.share({ kind: "share", action: "send" }).kind, "empty");

    await shell.run(`"${process.execPath}" -e "${script}"`);
    shell.share();
    shell.share({ kind: "share", action: "redact" });
    assert.doesNotMatch(String(latestPreview()["attachment"]), /fixture-private-value-281/);
    assert.match(String(latestPreview()["attachment"]), /common-pattern redaction aid applied/);
  } finally {
    shell.close(); rmSync(cwd, { recursive: true, force: true });
    ["AETHER_TEST_SHELL_SECRET", "AETHER_TEST_SHELL_KEEP", "AETHER_TEST_SHELL_OMIT"].forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
    });
  }
});

test("empty shell selection and cancelled preview cannot produce a model prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aether-share-empty-"));
  const events: Array<Record<string, unknown>> = [];
  const shell = new ConsoleShell(cwd, value => {
    for (const line of value.trim().split("\n")) {
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* command output */ }
    }
  }, true);
  try {
    await shell.run(`"${process.execPath}" -e "process.exit(7)"`);
    shell.share();
    const preview = events.filter(event => event["type"] === "shell_share_preview").at(-1)!;
    assert.match(String(preview["attachment"]), /Exit status: 7/);
    shell.share({ kind: "share", action: "lines" });
    const numbered = events.filter(event => event["type"] === "shell_share_lines").at(-1)!;
    const count = (numbered["lines"] as Array<unknown>).length;
    shell.share({ kind: "share", action: "drop", first: 1, last: count });
    assert.equal(shell.share({ kind: "share", action: "send" }).kind, "empty");
    assert.equal(shell.share({ kind: "share", action: "cancel" }).kind, "empty");
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "chat", "scripted send requires an explicit latest result");
  } finally { shell.close(); rmSync(cwd, { recursive: true, force: true }); }
});

/** Exercise the real submit handlers in isolated processes, with a synthetic
 * terminal or pipe and a mocked hosted transport. No model/network services. */
for (const tty of [false, true]) {
  test(`${tty ? "TTY" : "line"} console routes shell without API calls, preserves queue order and returns to chat`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aether-console-"));
    const driver = `
      import { PassThrough } from 'node:stream';
      import { cmdChat } from './dist/src/commands/chat.js';
      import { ApiClient } from './dist/src/core/transport.js';
      const input = new PassThrough();
      input.isTTY = ${tty}; input.setRawMode = () => {};
      Object.defineProperty(process, 'stdin', { value: input });
      Object.defineProperty(process.stdout, 'isTTY', { value: ${tty} });
      Object.defineProperty(process.stdout, 'columns', { value: 100 });
      let observed = '';
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => { observed += String(chunk); return write(chunk, ...args); };
      let calls = 0;
      let sharing = false;
      let releaseModel = null;
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/models')) return Response.json({ account_id: 'fixture-account' });
        const body = String(options?.body ?? '');
        if (body.includes('SHELL_ONLY') || body.includes('QUEUED_SHELL')) throw new Error('shell output leaked');
        if (body.includes('SHARE_ALLOWED') && !sharing) throw new Error('implicit sharing');
        if (sharing && !body.includes('SHARE_ALLOWED')) throw new Error('explicit sharing missing output');
        calls++; process.stdout.write('MODEL_CALL_' + calls + '\\n');
        await new Promise(resolve => { releaseModel = resolve; });
        return new Response('data: {"type":"delta","text":"model response"}\\n\\ndata: {"type":"done","uvt":0,"cents":0}\\n\\n', { headers: {'content-type':'text/event-stream'} });
      };
      const tokens = { get: async () => 'test-token' };
      const ctx = { cfg: { backend:'cloud', baseUrl:'https://stub.test', defaultModel:'', defaultEffort:'', permissionMode:'ask', autoApply:false, telemetry:false }, flags: { cwd:${JSON.stringify(cwd)}, json:false, yes:false }, tokens, api:new ApiClient('https://stub.test', tokens) };
      const enter = ${tty ? "'\\r'" : "'\\n'"};
      const submit = text => input.write(text + enter);
      const until = async (predicate, label) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error('waiting for ' + label + ': ' + observed.slice(-2000));
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        // Let the submit handler finish its continuation and clear busy before
        // the next input; a terminal state event precedes that continuation.
        await new Promise(resolve => setImmediate(resolve));
      };
      const completed = () => (observed.match(/\\| completed \\| exit \\d+ \\| session /g) ?? []).length;
      const releaseTurn = async number => {
        await until(() => calls === number && releaseModel !== null, 'model call ' + number);
        const release = releaseModel;
        releaseModel = null;
        release();
        await until(() => (observed.match(/model response/g) ?? []).length >= number, 'model response ' + number);
      };
      const session = cmdChat(ctx, '');
      await until(() => input.listenerCount('data') > 0 && observed.includes(${JSON.stringify(cwd)}), 'console input ready');
      submit('!echo SHELL_ONLY');
      await until(() => completed() === 1, 'first shell completion');
      if (calls !== 0) throw new Error('shell made API call');
      submit(${JSON.stringify(process.platform === 'win32' ? '!cd' : '!pwd')});
      await until(() => completed() === 2, 'cwd command completion');
      submit('hello');
      await until(() => calls === 1 && releaseModel !== null, 'model turn running');
      submit('!echo QUEUED_SHELL');
      ${tty ? "await until(() => observed.includes('Local shell queued'), 'shell queued during model turn');" : ""}
      await releaseTurn(1);
      await until(() => completed() === 3, 'queued shell completion');
      submit(${JSON.stringify(`!"${process.execPath}" -e "process.exit(7)"`)});
      await until(() => completed() === 4 && observed.includes('completed | exit 7'), 'nonzero shell completion');
      submit('!');
      await until(() => observed.includes('usage: !<command>'), 'empty shell refusal');
      ${tty ? "input.write('\\x1b[200~!echo MULTILINE_BAD\\necho SECOND_BAD\\x1b[201~\\r'); await until(() => completed() === 5, 'multiline shell completion');" : ""}
      submit(${JSON.stringify(`!"${process.execPath}" -e "setTimeout(()=>{},30000)"`)});
      await until(() => observed.includes(${JSON.stringify(`running] !"${process.execPath}" -e "setTimeout(()=>{},30000)"`)}), 'cancellable shell running');
      ${tty ? "input.write('\\\\!literal'); input.write('\\x03');" : "process.emit('SIGINT');"}
      await until(() => observed.includes('cancelled | exit 130'), 'shell cancellation');
      ${tty ? "input.write(enter);" : "submit('\\\\!literal');"}
      await releaseTurn(2);
      submit('/shell-reset');
      await until(() => observed.includes('shell reset — cwd/environment/functions cleared'), 'shell reset');
      submit('!echo SHARE_ALLOWED');
      await until(() => completed() === ${tty ? 6 : 5}, 'shareable shell completion');
      sharing = true;
      submit('/shell-result');
      await until(() => observed.includes('exact model attachment begins'), 'shell result preview');
      if (calls !== 2) throw new Error('preview made a model call');
      submit('/shell-result cancel');
      await until(() => observed.includes('Shell result preview cancelled'), 'shell result cancellation');
      if (calls !== 2) throw new Error('cancel made a model call');
      submit('/shell-result');
      await until(() => (observed.match(/exact model attachment begins/g) ?? []).length === 2, 'second shell result preview');
      submit('/shell-result send');
      await releaseTurn(3);
      submit('/exit');
      await session;
      if(calls !== 3) throw new Error('wrong model call count: ' + calls);
      process.stdout.write('VERIFIED_CALLS_3\\n');
    `;
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
          cwd: process.cwd(), env: { ...process.env, AETHER_NO_HISTORY: "1", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error("console timed out: " + output)); }, 30000);
        child.on("error", reject);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
      });
      assert.equal(result.code, 0, result.output);
      assert.ok(result.output.includes("VERIFIED_CALLS_3"), result.output);
      assert.ok(result.output.includes("completed | exit 7"), result.output);
      assert.ok(result.output.includes("cancelled | exit 130"), result.output);
      if (tty) assert.ok(result.output.includes("MULTILINE_BAD") && result.output.includes("SECOND_BAD"), result.output);
      assert.ok(result.output.includes("usage: !<command>"), result.output);
      assert.ok(result.output.indexOf("model response") < result.output.indexOf("running] !echo QUEUED_SHELL"), result.output);
      assert.ok(result.output.includes(cwd), result.output);
      assert.equal((result.output.match(/running\] !echo QUEUED_SHELL/g) ?? []).length, 1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("console submit routing remains before history/rewrite and uses typed queue", () => {
  const code = readFileSync("src/commands/chat.ts", "utf8");
  assert.ok(code.includes("const queue: ConsoleInput[]"));
  assert.ok(code.indexOf("classifyConsoleInput(queuePrefix") < code.indexOf("const commit ="));
  assert.ok(code.includes("result = await runQueuedTurn(next)"));
  assert.ok(code.includes("appendHistory(line.trim(), historyPath(ctx.flags.cwd))"), "save the original escaped input, not its model prompt");
});
