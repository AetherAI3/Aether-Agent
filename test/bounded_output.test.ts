import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedOutput } from "../src/core/bounded_output.js";

function verify(capture: BoundedOutput, source: string, budget: number): void {
  const rendered = capture.render();
  assert.ok(Buffer.byteLength(rendered) <= budget);
  assert.ok(capture.retainedBytes <= capture.capacityBytes);
  const match = /\n…\[(\d+) UTF-8 bytes elided\]…\n/.exec(rendered);
  if (!match) { assert.equal(rendered, source); return; }
  const head = rendered.slice(0, match.index);
  const tail = rendered.slice(match.index + match[0].length);
  assert.ok(source.startsWith(head));
  assert.ok(source.endsWith(tail));
  assert.equal(Number(match[1]), Buffer.byteLength(source) - Buffer.byteLength(head + tail));
  assert.doesNotMatch(head + tail, /\ufffd|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
}

test("bounded output preserves short text and code points split at the internal head boundary", () => {
  const capture = new BoundedOutput(128);
  const source = "a".repeat(15) + "😀€界";
  capture.append(source);
  verify(capture, source, 128);
  assert.equal(capture.render(), source);
});

test("one chunk beyond 64 MiB retains the genuine head and tail in fixed owned buffers", () => {
  const capture = new BoundedOutput();
  const source = "HEAD_247" + "x".repeat(65 * 1024 * 1024) + "FINAL SUMMARY: 1 failed";
  capture.append(source);
  verify(capture, source, 8000);
  assert.match(capture.render(), /^HEAD_247/);
  assert.ok(capture.render().endsWith("FINAL SUMMARY: 1 failed"));
  assert.equal(capture.capacityBytes, 7920);
  assert.equal(capture.retainedBytes, 7920);
});

test("rolling tail wraps correctly across many chunks and repeated renders", () => {
  const capture = new BoundedOutput(256);
  let source = "";
  for (let index = 0; index < 1500; index++) {
    const chunk = `${index}:` + "€😀界z".repeat(index % 11);
    capture.append(chunk);
    source += chunk;
    verify(capture, source, 256);
  }
});

test("UTF-8 head and tail cuts omit complete partial boundary bytes accurately", () => {
  for (const point of ["é", "€", "😀"]) {
    for (let offset = 0; offset < 8; offset++) {
      const capture = new BoundedOutput(128);
      const source = "x".repeat(offset) + point.repeat(100) + "FINAL";
      for (const character of source) capture.append(character);
      verify(capture, source, 128);
      assert.ok(capture.render().endsWith("FINAL"));
    }
  }
});

test("byte count describes normalized decoded UTF-8, including actual replacement characters", () => {
  const capture = new BoundedOutput(128);
  const source = "\ufffd".repeat(100);
  capture.append(source);
  const rendered = capture.render();
  const match = /\[(\d+) UTF-8 bytes elided\]/.exec(rendered)!;
  const retained = rendered.replace(/\n…\[\d+ UTF-8 bytes elided\]…\n/, "");
  assert.equal(Number(match[1]), Buffer.byteLength(source) - Buffer.byteLength(retained));
});
