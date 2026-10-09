import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repl } from "../src/commands/chat.js";
import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { historyPath } from "../src/core/history_store.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

async function withComposer(lfSubmits: boolean, run: (h: {
  key: (text: string) => void;
  output: () => string;
  until: (text: string) => Promise<void>;
  modelCalls: () => number;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aether-composer-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const oldErrWrite = process.stderr.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
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
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stderr.write;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("/agent/chat/stream")) { modelCalls++; throw new Error("editing must not request a model"); }
      return Response.json({ models: [] });
    }) as typeof fetch;
    pending = repl(ctx, { noSkills: true });
    await until("\x1b[?2004h");
    await run({ key, output: () => output, until, modelCalls: () => modelCalls });
    key("/exit\r");
    assert.equal(await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("TTY exit timed out")), 2_000))]), 0);
    pending = null;
    assert.equal(modelCalls, 0);
  } finally {
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
