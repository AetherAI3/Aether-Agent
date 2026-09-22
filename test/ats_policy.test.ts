import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  ATS_POLICY_SHA256,
  atsPolicyReceiptPath,
  requireAtsPolicyAcceptance,
} from "../src/commands/ats_policy.js";

const account = { cloudOrigin: "https://example.test", accountSubject: "11111111-1111-4111-8111-111111111111" };

function terminal(answer: string): { input: PassThrough & { isTTY: true }; out: Writable; rendered: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: true as const });
  let text = "";
  let answered = false;
  const out = new Writable({ write(chunk, _encoding, done) {
    text += String(chunk);
    if (!answered && text.includes("Choice [2]:")) { answered = true; setImmediate(() => input.write(answer + "\r")); }
    done();
  } });
  return { input, out, rendered: () => text };
}

test("published ATS policy digest matches the consent gate", async () => {
  const checkoutText = await readFile("ATS_ACCEPTABLE_USE_POLICY.md", "utf8");
  // Git may materialize Markdown with CRLF on Windows. Consent binds the
  // canonical LF policy text, not the checkout's platform-specific encoding.
  const canonical = checkoutText.replace(/\r\n/g, "\n");
  assert.equal(createHash("sha256").update(canonical).digest("hex"), ATS_POLICY_SHA256);
  const windowsCheckout = canonical.replace(/\n/g, "\r\n");
  assert.equal(createHash("sha256").update(windowsCheckout.replace(/\r\n/g, "\n")).digest("hex"), ATS_POLICY_SHA256);
});

test("choice 2 rejects without writing a consent receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-ats-policy-"));
  const io = terminal("2");
  try {
    assert.equal(await requireAtsPolicyAcceptance({ root, account, input: io.input, out: io.out }), false);
    await assert.rejects(readFile(atsPolicyReceiptPath(root, account)), { code: "ENOENT" });
    assert.match(io.rendered(), /does not connect a broker or grant this agent trading authority/i);
  } finally { io.input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("choice 1 writes a pseudonymous, non-authorizing receipt and current receipt avoids reprompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-ats-policy-"));
  const first = terminal("1");
  try {
    assert.equal(await requireAtsPolicyAcceptance({ root, account, input: first.input, out: first.out }), true);
    const receipt = JSON.parse(await readFile(atsPolicyReceiptPath(root, account), "utf8"));
    assert.equal(receipt.policy_sha256, ATS_POLICY_SHA256);
    assert.equal(receipt.decision, "accepted");
    assert.equal(receipt.grants_trading_authority, false);
    assert.equal(receipt.account_subject, undefined);
    assert.equal(receipt.cloud_origin, undefined);
    const second = terminal("2");
    assert.equal(await requireAtsPolicyAcceptance({ root, account, input: second.input, out: second.out }), true);
    assert.equal(second.rendered(), "");
    second.input.destroy();
  } finally { first.input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("non-interactive setup cannot manufacture policy consent", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-ats-policy-"));
  const input = Object.assign(new PassThrough(), { isTTY: false });
  try {
    await assert.rejects(requireAtsPolicyAcceptance({ root, account, input }), /interactive terminal/);
    await assert.rejects(readFile(atsPolicyReceiptPath(root, account)), { code: "ENOENT" });
  } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
});
