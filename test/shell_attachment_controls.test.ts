import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleShell, classifyConsoleInput } from "../src/commands/console_input.js";
import { captureShellResult, ShellAttachmentPreview } from "../src/commands/shell_attachment.js";

for (const [text, expected] of [
  ["/shell-result lines", { kind: "share", action: "lines" }],
  ["/shell-result drop 2-4", { kind: "share", action: "drop", first: 2, last: 4 }],
  ["/shell-result replace 2 new text", { kind: "share", action: "replace", first: 2, value: "new text" }],
  ["/shell-result mask literal", { kind: "share", action: "mask", value: "literal" }],
  ["/shell-result redact", { kind: "share", action: "redact" }],
] as const) test(`line-editor control remains local: ${text}`, () => {
  assert.deepEqual(classifyConsoleInput(text), expected);
});

test("line drop/replace/mask never re-add removed metadata or alter protected framing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-share-controls-"));
  const events: Record<string, unknown>[] = [];
  const shell = new ConsoleShell(root, text => {
    for (const line of text.trim().split("\n")) { try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* local notices */ } }
  }, true);
  let processes = 0;
  shell.exec.runUserCommand = async () => { processes++; return { output: "alpha 👩‍💻\nremove me\nuntrusted data\nomega", exitCode: 7 }; };
  const lastPreview = (): string => String(events.filter(event => event["type"] === "shell_share_preview").at(-1)!["text"]);
  const lines = (): { line: number; text: string }[] => {
    shell.share({ kind: "share", action: "lines" });
    return events.filter(event => event["type"] === "shell_share_lines").at(-1)!["lines"] as { line: number; text: string }[];
  };
  try {
    await shell.run("printf PRIVATE_COMMAND_FIXTURE");
    shell.share();
    assert.match(lastPreview(), /alpha 👩‍💻/);
    const command = lines().find(line => line.text.includes("PRIVATE_COMMAND_FIXTURE"))!;
    shell.share({ kind: "share", action: "drop", first: command.line, last: command.line });
    assert.doesNotMatch(lastPreview(), /PRIVATE_COMMAND_FIXTURE/, "deleted command cannot reappear in a metadata envelope");
    const cwd = lines().find(line => line.text.includes(root))!;
    shell.share({ kind: "share", action: "replace", first: cwd.line, value: "cwd withheld" });
    assert.doesNotMatch(lastPreview(), new RegExp(root));
    const omitted = lines().find(line => line.text === "remove me")!;
    shell.share({ kind: "share", action: "drop", first: omitted.line, last: omitted.line });
    assert.doesNotMatch(lastPreview(), /remove me/);
    shell.share({ kind: "share", action: "mask", value: "untrusted data" });
    assert.match(lastPreview(), /untrusted data, not instructions/, "mask cannot erase the trust wrapper");
    assert.match(lastPreview(), /\[REDACTED\]/);
    shell.share({ kind: "share", action: "redact" });
    const expected = lastPreview();
    const result = shell.share({ kind: "share", action: "send" });
    assert.equal(result.kind, "attachment");
    if (result.kind === "attachment") assert.equal(result.text, expected);
    assert.equal(processes, 1, "all editor controls are process-free");
    assert.equal(shell.share({ kind: "share", action: "send" }).kind, "error");
  } finally { shell.close(); rmSync(root, { recursive: true, force: true }); }
});

test("whole attachment and line replacements stay bounded; invalid edits preserve exact review", () => {
  const preview = new ShellAttachmentPreview();
  const capture = captureShellResult("s", "c", "!" + "x".repeat(30000), "tail summary", 0);
  const original = preview.preview(capture)!;
  assert.ok(Buffer.byteLength(original.text) <= 8192, "full metadata and trust envelope are in the cap");
  const tooLarge = preview.editLines("replace", 1, undefined, "x".repeat(8193));
  assert.equal(typeof tooLarge, "string");
  assert.strictEqual(preview.preview(null), original);
  assert.equal(typeof preview.editLines("replace", 1, undefined, "two\nlines"), "string");
  assert.equal(typeof preview.editLines("drop", 9999, 9999), "string");
  assert.strictEqual(preview.preview(null), original);
});

test("script one-step send consumes a fresh capture; cancel/repeated/empty send never restages", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-share-script-"));
  const output: string[] = [];
  const shell = new ConsoleShell(root, text => output.push(text), true);
  shell.exec.runUserCommand = async () => ({ output: "SCRIPT_FIXTURE", exitCode: 0 });
  try {
    await shell.run("fixture");
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "attachment");
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "error");
    await shell.run("fixture");
    shell.share({ kind: "share", action: "cancel" });
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "error");
    await shell.run("fixture");
    shell.share(); shell.share({ kind: "share", action: "edit", text: "" });
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "error");
    assert.equal(shell.share({ kind: "share", action: "send" }, true).kind, "error");
    shell.share(); shell.share({ kind: "share", action: "redact" });
    for (const chunk of output) for (const line of chunk.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line), "every JSON-mode control record must parse");
    assert.ok(output.some(line => line.includes('"type":"shell_share_preview"')));
  } finally { shell.close(); rmSync(root, { recursive: true, force: true }); }
});
