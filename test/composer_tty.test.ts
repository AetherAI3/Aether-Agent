import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repl } from "../src/commands/chat.js";
import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { appendHistory, historyPath } from "../src/core/history_store.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

async function withComposer(lfSubmits: boolean, run: (h: {
  key: (text: string) => void;
  output: () => string;
  until: (text: string) => Promise<void>;
  modelCalls: () => number;
  resize: (cols: number, rows: number) => void;
}) => Promise<void>, options: { history?: string[]; noHistory?: boolean } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aether-composer-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const oldErrWrite = process.stderr.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const oldNoHistory = process.env["AETHER_NO_HISTORY"];
  let output = "";
  let modelCalls = 0;
  let pending: Promise<number> | null = null;
  const tokens = { get: async () => "fixture-token" } as unknown as TokenStore;
  const ctx = {
    cfg: { ...DEFAULT_CONFIG, baseUrl: "https://stub.test", backend: "cloud", lfSubmits },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://stub.test", tokens), confirm: async () => false,
  } as AppContext;
  const key = (text: string): void => { process.stdin.emit("data", Buffer.from(text)); };
  const until = async (text: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!output.includes(text)) {
      if (Date.now() > deadline) throw new Error(`composer did not show ${JSON.stringify(text)}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    for (const entry of options.history ?? []) appendHistory(entry, historyPath(root));
    if (options.noHistory) process.env["AETHER_NO_HISTORY"] = "1";
    else delete process.env["AETHER_NO_HISTORY"];
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
    process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stderr.write;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("/agent/chat/stream")) { modelCalls++; throw new Error("editing must not request a model"); }
      return Response.json({ models: [] });
    }) as typeof fetch;
    pending = repl(ctx, { noSkills: true });
    await until("\x1b[?2004h");
    await run({ key, output: () => output, until, modelCalls: () => modelCalls,
      resize: (cols, height) => {
        Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: height, configurable: true });
        process.stdout.emit("resize");
      },
    });
    key("\x15/exit\r\r");
    assert.equal(await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("TTY exit timed out")), 2_000))]), 0);
    pending = null;
    assert.equal(modelCalls, 0);
  } finally {
    if (oldNoHistory === undefined) delete process.env["AETHER_NO_HISTORY"];
    else process.env["AETHER_NO_HISTORY"] = oldNoHistory;
    if (pending) {
      key("\x03\x03\x04");
      await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1_000))]);
    }
    globalThis.fetch = oldFetch;
    process.stdout.write = oldWrite;
    process.stderr.write = oldErrWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    if (columns) Object.defineProperty(process.stdout, "columns", columns); else delete (process.stdout as unknown as { columns?: number }).columns;
    if (rows) Object.defineProperty(process.stdout, "rows", rows); else delete (process.stdout as unknown as { rows?: number }).rows;
    rmSync(historyPath(root), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("raw composer inserts LF, shows a line hint, and submits only on CR", async () => {
  await withComposer(false, async ({ key, output, until, modelCalls }) => {
    key("/btw first\nsecond");
    assert.match(output(), /⏎.*\[2L\]/);
    assert.doesNotMatch(output(), /Noted:/);
    assert.equal(modelCalls(), 0);
    key("\r");
    await until("Noted:");
    assert.match(output(), /Noted: "first\nsecond"/);
    key("\x1f"); // a sent draft is outside the undo scope
    assert.doesNotMatch(output().slice(output().lastIndexOf("\r\x1b[2K")), /first|second/);
    key("\x1b[200~pasted\nlines\x1b[201~");
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /\[2L\]/);
    key("\x1f"); // one undo removes the entire bracketed paste
    assert.doesNotMatch(output().slice(output().lastIndexOf("\r\x1b[2K")), /pasted|lines/);
    key("draft");
    key("\x15"); // kill to start
    key("\x19"); // yank
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /draft/);
    key("\x1f"); // undo yank
    assert.doesNotMatch(output().slice(output().lastIndexOf("\r\x1b[2K")), /draft/);
  });
});

test("LF-as-submit setting retains legacy raw TTY behavior", async () => {
  await withComposer(true, async ({ key, until, output }) => {
    key("/btw compatibility\n");
    await until("Noted:");
    assert.match(output(), /Noted: "compatibility"/);
  });
});

test("slash picker inserts text on Enter; only a later Enter runs the command", async () => {
  await withComposer(false, async ({ key, output, until, modelCalls, resize }) => {
    resize(160, 24);
    key("/clear");
    assert.match(output(), /> \/clear/);
    const beforeAccept = output().length;
    key("\r");
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /\/clear /);
    assert.doesNotMatch(output().slice(beforeAccept), /\x1b\[2J\x1b\[H/);
    assert.equal(modelCalls(), 0);
    key("\r");
    await until("\x1b[2J\x1b[H");
    key("/no-such-command");
    assert.match(output(), /No matching commands/);
    const beforeDismiss = output().length;
    key("\r"); // no selection: dismiss and keep literal slash text
    assert.doesNotMatch(output().slice(beforeDismiss), /unknown command/);
    key("\r");
    await until("unknown command: /no-such-command");
  });
});

test("picker selection, Escape, history, paste and resize retain their input owners", async () => {
  await withComposer(false, async ({ key, output, resize, until }) => {
    key("/btw remembered\r");
    await until("Noted:");
    key("/mo");
    assert.match(output(), /> \/model/);
    key("\x1b[B"); // picker owns Down, not history
    key("\t"); // Tab cycles the picker
    resize(18, 4);
    assert.match(output().slice(-500), /\/model/);
    key("\x1b"); // restore the empty draft from before '/mo'
    assert.doesNotMatch(output().slice(output().lastIndexOf("\r\x1b[2K")), /\/mo/);
    resize(160, 24);
    key("\x1b[A"); // history owns Up after dismissal
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /\/btw remembered/);
    key("\x15");
    key("\x1b[200~/clear\x1b[201~");
    const pasted = output().slice(-500);
    assert.doesNotMatch(pasted, /> \/clear/);
    key("\r"); // bracketed paste is literal input, without a picker
    await until("\x1b[2J\x1b[H");
    key("/mo");
    resize(18, 2); // too short: picker yields to the literal composer
    key("\r");
    await until("unknown command: /mo");
  });
});

test("Ctrl+R searches workspace prompts, restores drafts, and switches cleanly with the slash picker", async () => {
  await withComposer(false, async ({ key, output, modelCalls, resize }) => {
    resize(160, 24);
    key("draft");
    key("\x1b[D\x1b[D"); // caret after dra
    key("\x12");
    assert.match(output().slice(-500), /Ctrl\+R.*newest/);
    key("match");
    assert.match(output().slice(-500), /1\/2\n> match newer/);
    key("\x12");
    assert.match(output().slice(-500), /2\/2\n> match older/);
    key("\x1b");
    key("X");
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /draXft/);

    key("\x12match\r"); // acceptance edits the composer, not the model
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /match newer/);
    assert.equal(modelCalls(), 0);
    key("\x1f"); // only the accepted edit is undone, not older draft edits
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /draXft/);

    key("\x05\x15/mo");
    assert.match(output().slice(-500), /> \/model/);
    key("\x12"); // search takes ownership from picker
    assert.match(output().slice(-500), /Ctrl\+R/);
    key("\x1b"); // restore /mo and picker selection
    assert.match(output().slice(-500), /> \/model/);
    key("\x12/btw\r"); // accept a slash prompt without executing it
    assert.match(output().slice(output().lastIndexOf("\r\x1b[2K")), /\/btw archived/);
    key("\t"); // picker can be opened again on accepted slash text
    assert.match(output().slice(-500), /> \/btw/);
    key("\x1b");
    assert.equal(modelCalls(), 0);
  }, { history: ["match older", "/btw archived", "match newer"] });
});

test("Ctrl+R honors AETHER_NO_HISTORY and keeps disabled entries unseen", async () => {
  await withComposer(false, async ({ key, output, modelCalls }) => {
    key("\x12");
    assert.match(output().slice(-500), /history disabled/);
    assert.doesNotMatch(output().slice(-500), /stored secret/);
    key("\x1b");
    assert.equal(modelCalls(), 0);
  }, { history: ["stored secret"], noHistory: true });
});
