import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { CloudBrain } from "../src/core/brain_cloud.js";
import { OllamaBrain } from "../src/core/brain_ollama.js";
import type { ApiClient } from "../src/core/transport.js";
import { SessionLog } from "../src/core/session_log.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { MAX_PROMPT_FILE_BYTES, promptFileConflict, promptInputLabel, readPromptFile } from "../src/commands/prompt_file.js";
import { renderManifestHelp } from "../src/commands/command_manifest.js";

const SPEC = "  /literal command\n!not shell\n`code` and $()\n\nlast line  \n";

test("file and stdin each admit the complete literal UTF-8 task once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-prompt-"));
  try {
    const path = join(dir, "task.md");
    writeFileSync(path, SPEC, "utf8");
    const file = await readPromptFile(path);
    const pipe = await readPromptFile("-", Readable.from([Buffer.from(SPEC.slice(0, 12)), Buffer.from(SPEC.slice(12))]));
    assert.equal(file.task, SPEC);
    assert.equal(pipe.task, SPEC);
    assert.deepEqual(file.input, { kind: "file", path, bytes: Buffer.byteLength(SPEC) });
    assert.deepEqual(pipe.input, { kind: "stdin", bytes: Buffer.byteLength(SPEC) });
    assert.equal(promptInputLabel(file.input), "prompt file");
    assert.equal(promptInputLabel(pipe.input), "stdin prompt");
    writeFileSync(path, "changed after admission", "utf8");

    // The ordinary local coding brain receives one user message, with no slash
    // or shell re-dispatch of syntax that happens to begin a line.
    const localCalls: string[] = [];
    const local = new OllamaBrain({ chat: async (messages) => {
      localCalls.push(messages.find((message) => message.role === "user")?.content ?? "");
      return { role: "assistant", content: "done" };
    } });
    for await (const _event of local.run({ type: "task", text: file.task, cwd: dir, poolGb: 5 })) { /* drain */ }
    local.close();
    assert.deepEqual(localCalls, [SPEC]);

    // The hosted coding transport creates one dev session with the same text.
    const hostedCalls: string[] = [];
    const api = {
      postJson: async (_path: string, body: { task: string }) => {
        hostedCalls.push(body.task);
        throw new Error("fixture stops after session-create request");
      },
    } as unknown as ApiClient;
    const hosted = new CloudBrain(api, undefined, { requireLocalAuthority: true });
    for await (const _event of hosted.run({ type: "task", text: pipe.task, cwd: dir, poolGb: 5 })) { /* drain */ }
    hosted.close();
    assert.deepEqual(hostedCalls, [SPEC]);

    const log = new SessionLog(
      { task: promptInputLabel(file.input), promptInput: file.input, model: "", poolGb: 5, brain: "local", cwd: dir },
      "2026-10-09T00:00:00.000Z", dir, () => undefined,
    );
    const manifest = readFileSync(join(log.dir, "manifest.json"), "utf8");
    assert.equal((JSON.parse(manifest) as { promptInput: { bytes: number } }).promptInput.bytes, Buffer.byteLength(SPEC));
    assert.doesNotMatch(manifest, /literal command|not shell|\$\(\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt input rejects invalid, blank, missing, unreadable, and oversized sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-prompt-errors-"));
  try {
    const path = join(dir, "task.md");
    await assert.rejects(readPromptFile(path), /cannot read prompt file/);
    await assert.rejects(readPromptFile(dir), /cannot read prompt file/);
    await assert.rejects(readPromptFile("-", Readable.from([Buffer.from(" \n\t ")])), /whitespace only/);
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readPromptFile(path), /not valid UTF-8/);
    writeFileSync(path, Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1, 0x41));
    await assert.rejects(readPromptFile(path), /exceeds 262144 bytes/);
    await assert.rejects(readPromptFile("-", Readable.from([Buffer.alloc(MAX_PROMPT_FILE_BYTES), Buffer.from("x")])), /exceeds 262144 bytes/);
    writeFileSync(path, Buffer.alloc(MAX_PROMPT_FILE_BYTES, 0x41));
    assert.equal((await readPromptFile(path)).input.bytes, MAX_PROMPT_FILE_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicts are refused before stdin or any coding session starts", () => {
  assert.match(renderManifestHelp("shell", "agent"), /aether agent --prompt-file task\.md/);
  assert.match(renderManifestHelp("shell", "code"), /cat task\.md \| aether agent --prompt-file -/);
  assert.match(promptFileConflict(["task"], {}) ?? "", /positional task/);
  assert.match(promptFileConflict([], { resume: "old" }) ?? "", /--resume/);
  assert.match(promptFileConflict([], { interactive: true }) ?? "", /--interactive/);
  assert.match(promptFileConflict([], { withToken: true }) ?? "", /--with-token/);
  assert.match(promptFileConflict([], { managedAgent: true }) ?? "", /managed-agent/);
  assert.equal(promptFileConflict([], {}), null);

  const cli = resolve("dist", "src", "main.js");
  for (const flags of [["extra"], ["--resume", "old"], ["--interactive"], ["--with-token"]]) {
    const result = spawnSync(process.execPath, [cli, "agent", "--prompt-file", "-", ...flags], {
      input: SPEC, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 2, String(result.stderr));
    assert.match(String(result.stderr), /--prompt-file/);
    assert.doesNotMatch(String(result.stdout), /prompt_input/);
  }
});

test("existing verification command values remain independent of prompt input on both path styles", () => {
  for (const testCmd of ["./scripts/check.sh", ".\\scripts\\check.cmd"]) {
    assert.equal(promptFileConflict([], {}), null);
    const executor = new ToolExecutor(process.cwd(), testCmd);
    assert.equal(executor.configuredTestCommand, testCmd);
    executor.close();
    const cli = resolve("dist", "src", "main.js");
    const result = spawnSync(process.execPath, [cli, "agent", "--prompt-file", "missing-task.md", "--test-cmd", testCmd], {
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 2, String(result.stderr));
    assert.match(String(result.stderr), /cannot read prompt file/);
    assert.doesNotMatch(String(result.stderr), /test-cmd|nothing to do/);
  }
});
