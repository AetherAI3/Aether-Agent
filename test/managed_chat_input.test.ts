import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { managedChatInput } from "../src/ui/managed_chat_input.js";

for (const splitAt of [0, 1, 2, 3]) {
  test(`managed input isolates back-tab split at byte ${splitAt} while preserving Tab and UTF-8`, () => {
    const source = Object.assign(new PassThrough(), { isRaw: true, setRawMode(raw: boolean) { this.isRaw = raw; } });
    const owned = managedChatInput(source);
    const chunks: Buffer[] = []; let cycles = 0;
    owned.input.on("data", chunk => chunks.push(chunk));
    owned.keys.on("keypress", () => { cycles++; });
    source.write("draft\t");
    source.write(Buffer.from("\x1b[Z").subarray(0, splitAt));
    source.write(Buffer.from("\x1b[Z").subarray(splitAt));
    const utf8 = Buffer.from("élève"); source.write(utf8.subarray(0, 1)); source.write(utf8.subarray(1));
    assert.equal(Buffer.concat(chunks).toString(), "draft\télève");
    assert.equal(cycles, 1);
    owned.dispose(); owned.dispose();
    assert.equal(source.listenerCount("data"), 0);
    assert.equal(source.listenerCount("end"), 0);
    assert.equal(source.isRaw, true);
    source.destroy();
  });
}

test("a pasted back-tab is data and cannot change the requested mode", () => {
  const source = new PassThrough();
  const owned = managedChatInput(source);
  const chunks: Buffer[] = []; let cycles = 0;
  owned.input.on("data", chunk => chunks.push(chunk));
  owned.keys.on("keypress", () => { cycles++; });
  for (const byte of Buffer.from("\x1b[200~strategy\x1b[Ztext\x1b[201~")) source.write(Buffer.from([byte]));
  assert.equal(cycles, 0);
  assert.equal(Buffer.concat(chunks).toString(), "\x1b[200~strategy\x1b[Ztext\x1b[201~");
  source.write("\x1b[Z"); assert.equal(cycles, 1);
  owned.dispose(); assert.equal(source.isPaused(), true); source.destroy();
});
