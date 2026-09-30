import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalSession,
  type DetachableAgentSource,
  type ReplayableAgentSource,
} from "../src/ui/terminal_session.js";
import { StringSink } from "../src/ui/sink.js";
import type { AgentEvent } from "../src/core/agent_events.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/core/voice.js";

/** Fake source with the same atomic buffered-replay seam required from embeds. */
class FakeSource implements ReplayableAgentSource {
  private handlers = new Set<(e: AgentEvent) => void>();
  private history: AgentEvent[] = [];
  readonly subscribeAfterCalls: number[] = [];
  maxListeners = 0;
  closes = 0;
  get listenerCount(): number { return this.handlers.size; }
  on(h: (e: AgentEvent) => void): () => void {
    this.handlers.add(h);
    this.maxListeners = Math.max(this.maxListeners, this.handlers.size);
    return () => this.handlers.delete(h);
  }
  subscribeAfter(lastSequence: number, h: (e: AgentEvent) => void): () => void {
    this.subscribeAfterCalls.push(lastSequence);
    const replay = this.history.filter((event) =>
      typeof event.seq === "number" && event.seq > lastSequence
    );
    const detach = this.on(h);
    for (const event of replay) h(event);
    return detach;
  }
  close(): void { this.closes++; }
  push(e: AgentEvent): void {
    this.history.push(e);
    for (const h of [...this.handlers]) h(e);
  }
  dropBufferedSequence(sequence: number): void {
    this.history = this.history.filter((event) => event.seq !== sequence);
  }
}

/** Truthful legacy seam: detachable, but it cannot replay across a remount. */
class LegacySource implements DetachableAgentSource {
  private handlers = new Set<(e: AgentEvent) => void>();
  get listenerCount(): number { return this.handlers.size; }
  on(h: (e: AgentEvent) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  close(): void {}
  push(e: AgentEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createTerminalSession renders a log event into the sink", () => {
  const sink = new StringSink({ isTTY: true, colorEnabled: true });
  const source = new FakeSource();
  const session = createTerminalSession({ source, sink, mode: "api", now: () => 0 });

  source.push({ type: "log", line: "did a thing", seq: 1 });
  assert.ok(sink.buffer.includes("did a thing"), "log line must reach the sink");

  session.dispose();
});

test("createTerminalSession renders a tool event with name + arg hint", () => {
  const sink = new StringSink({ isTTY: true, colorEnabled: true });
  const source = new FakeSource();
  const session = createTerminalSession({ source, sink, mode: "api", now: () => 0 });

  source.push({ type: "tool", name: "write_file", args: "src/x.ts", seq: 1 });
  assert.ok(sink.buffer.includes("write_file"), "tool name must render");
  assert.ok(sink.buffer.includes("src/x.ts"), "tool arg hint must render");

  session.dispose();
});

test("dispose() is idempotent and stops further rendering", () => {
  const sink = new StringSink({ isTTY: true, colorEnabled: true });
  const source = new FakeSource();
  const session = createTerminalSession({ source, sink, mode: "api", now: () => 0 });

  session.dispose();
  session.dispose(); // must not throw
  const lenAfterDispose = sink.buffer.length;
  source.push({ type: "log", line: "late event" });
  assert.equal(sink.buffer.length, lenAfterDispose, "no rendering after dispose");
});

test("embedded heartbeat events animate the status and stop painting on dispose", async () => {
  const sink = new StringSink({ isTTY: true });
  const source = new FakeSource();
  const session = createTerminalSession({
    source,
    sink,
    heartbeatTimeoutMs: 500,
    meaningfulProgressTimeoutMs: 1_000,
  });

  source.push({ type: "heartbeat", seq: 1 });
  assert.match(sink.buffer, /♥1/, "a source heartbeat advances the visible beat count");
  await delay(50);
  assert.match(sink.buffer, /•/, "a source heartbeat paints the animated pulse envelope");

  session.dispose();
  const afterDispose = sink.buffer.length;
  await delay(250);
  assert.equal(sink.buffer.length, afterDispose, "pending pulse frames do not paint after disposal");
});

test("embedded silence shows a waiting state and meaningful progress restores its stage", async () => {
  const sink = new StringSink({ isTTY: true });
  const source = new FakeSource();
  const session = createTerminalSession({
    source,
    sink,
    heartbeatTimeoutMs: 15,
    meaningfulProgressTimeoutMs: 500,
  });

  source.push({ type: "stage", stage: "Executing", seq: 1 });
  await delay(40);
  assert.match(sink.buffer, /○.*Waiting for response/, "soft stall is visible to the operator");

  source.push({ type: "heartbeat", seq: 2 });
  assert.match(sink.buffer, /♥1/, "connection recovery resumes the heartbeat animation");
  source.push({ type: "stage", stage: "Finishing", seq: 3 });
  const latestStatus = sink.buffer.slice(sink.buffer.lastIndexOf("\r\x1b[2K"));
  assert.match(latestStatus, /Finishing/, "meaningful progress restores the current stage");
  assert.doesNotMatch(latestStatus, /Waiting for response/);

  session.dispose();
});

test("an embed can inject Voice ports without capture starting implicitly", () => {
  const sink = new StringSink({ isTTY: true, colorEnabled: true });
  const source = new FakeSource();
  let permissions = 0;
  let captureDisposals = 0;
  let playbackDisposals = 0;
  const session = createTerminalSession({
    source,
    sink,
    voice: {
      settings: { ...DEFAULT_VOICE_SETTINGS, enabled: true },
      capture: {
        id: "fake-capture",
        async requestPermission() { permissions += 1; },
        async start() {},
        async stop() { return { bytes: new Uint8Array(), mime: "audio/wav", durationSeconds: 0 }; },
        abort() {},
        onPartial() { return () => {}; },
        onLost() { return () => {}; },
        dispose() { captureDisposals += 1; },
      },
      transport: {
        async transcribe() { return ""; },
        async synthesize() { return { bytes: new Uint8Array(), mime: "audio/wav", model: "fake" }; },
      },
      playback: {
        id: "fake-playback",
        async play() {},
        stop() {},
        dispose() { playbackDisposals += 1; },
      },
      bridge: { send() {} },
    },
  });

  assert.ok(session.voice, "complete host ports expose the shared Voice controller");
  assert.equal(permissions, 0, "mount must not request microphone permission");
  session.dispose();
  session.dispose();
  assert.equal(captureDisposals, 1);
  assert.equal(playbackDisposals, 1);
});

test("TerminalSession exposes one stable lifecycle outcome and detaches on the first terminal event", () => {
  const sink = new StringSink({ isTTY: false });
  const source = new FakeSource();
  const outcomes: string[] = [];
  const session = createTerminalSession({
    source,
    sink,
    prompt: "ship it",
    turnId: "turn-embed-1",
    requireSequence: true,
    onOutcome: (outcome) => outcomes.push(`${outcome.turnId}:${outcome.state}`),
    now: () => 10,
  });

  assert.equal(session.state, "connecting");
  assert.equal(session.turnId, "turn-embed-1");
  assert.equal(session.correlationId, "turn-embed-1");
  source.push({ type: "stage", stage: "execute", seq: 1 });
  assert.equal(session.state, "streaming");
  source.push({ type: "tool", name: "read_file", seq: 2 });
  assert.equal(session.state, "waiting_for_tool");
  source.push({ type: "done", seq: 3 });
  source.push({ type: "error", message: "late failure", seq: 4 });

  assert.equal(session.state, "succeeded");
  assert.equal(session.outcome?.exitCode, 0);
  assert.deepEqual(outcomes, ["turn-embed-1:succeeded"]);
  assert.equal(source.listenerCount, 0, "terminal delivery detaches the sole subscription");
  assert.equal(occurrences(sink.buffer, "turn completed · turn-embed-1"), 1);
  assert.doesNotMatch(sink.buffer, /late failure/);
  session.dispose();
});

test("TerminalSession renders an explicit source failure as one typed outcome line", () => {
  const sink = new StringSink({ isTTY: false });
  const source = new FakeSource();
  const session = createTerminalSession({
    source,
    sink,
    turnId: "turn-single-error",
  });

  source.push({ type: "error", message: "bounded source failure", seq: 1 });

  assert.equal(session.state, "failed");
  assert.equal(occurrences(sink.buffer, "bounded source failure"), 1);
  assert.equal(occurrences(sink.buffer, "· turn-single-error"), 1);
  assert.equal(source.listenerCount, 0);
  session.dispose();
});

test("alternating cosmetic stage/token frames cannot postpone the typed timed_out outcome", async () => {
  const sink = new StringSink({ isTTY: false });
  const source = new FakeSource();
  const outcomes: string[] = [];
  let signalOutcome: (() => void) | undefined;
  const terminalOutcome = new Promise<void>((resolve) => { signalOutcome = resolve; });
  const session = createTerminalSession({
    source,
    sink,
    prompt: "bounded turn",
    heartbeatTimeoutMs: 50,
    meaningfulProgressTimeoutMs: 22,
    requireSequence: false,
    onOutcome: (outcome) => {
      outcomes.push(outcome.state);
      signalOutcome?.();
    },
  });
  source.push({ type: "stage", stage: "prepare" });
  source.push({ type: "token", used: 1, cap: 10 });
  let alternate = false;
  const cosmetic = setInterval(() => {
    alternate = !alternate;
    source.push({ type: "heartbeat" });
    source.push({ type: "stage", stage: alternate ? "prepare" : "execute" });
    source.push({ type: "token", used: 1, cap: alternate ? 10 : 11 });
    source.push({ type: "log", line: "" });
  }, 3);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      terminalOutcome,
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("terminal session did not finalize within its hard bound")), 1_000);
      }),
    ]);
  } catch (error) {
    session.dispose();
    throw error;
  } finally {
    clearInterval(cosmetic);
    if (guard) clearTimeout(guard);
  }

  assert.equal(session.state, "timed_out");
  assert.equal(session.outcome?.retryable, true);
  assert.deepEqual(outcomes, ["timed_out"]);
  assert.equal(source.listenerCount, 0);
  assert.equal(occurrences(sink.buffer, "turn timed out"), 0, "custom timeout detail remains the terminal message");
  assert.equal(occurrences(sink.buffer, "no meaningful progress"), 1, "the lifecycle owns one typed outcome line");
  session.dispose();
});

test("recoverable remount rehydrates once, preserves editor composition, and applies only unseen seq ids", () => {
  const source = new FakeSource();
  const oldSink = new StringSink({ isTTY: false });
  const first = createTerminalSession({
    source,
    sink: oldSink,
    prompt: "resume me",
    turnId: "turn-resume",
    requireSequence: true,
    now: () => 100,
  });
  source.push({ type: "log", line: "first line", seq: 1 });
  first.setInputState({
    buffer: "draft 世界",
    cursor: 8,
    composition: { text: "界", start: 7, end: 8 },
  });
  const checkpoint = first.snapshot();
  first.dispose();
  const oldLength = oldSink.buffer.length;
  assert.equal(source.listenerCount, 0);

  // This event lands after the old subscription is detached and before the
  // replacement exists. Buffered subscribeAfter() must recover it atomically.
  source.push({ type: "log", line: "second line", seq: 2 });

  const newSink = new StringSink({ isTTY: false });
  const resumed = createTerminalSession({ source, sink: newSink, snapshot: checkpoint, now: () => 200 });
  assert.equal(source.listenerCount, 1, "remount creates exactly one live subscription");
  assert.equal(source.maxListeners, 1, "old and new subscriptions never overlap");
  assert.equal(occurrences(newSink.buffer, "first line"), 1, "snapshot is rendered exactly once");
  assert.equal(occurrences(newSink.buffer, "second line"), 1, "refresh-gap event is replayed exactly once");
  assert.deepEqual(source.subscribeAfterCalls, [0, 1], "remount resumes from the snapshot high-water mark");

  source.push({ type: "log", line: "first line", seq: 1 }); // replay
  source.push({ type: "done", seq: 3 });
  const finalSnapshot = resumed.snapshot();

  assert.equal(oldSink.buffer.length, oldLength, "disposed mount never repaints");
  assert.equal(occurrences(newSink.buffer, "first line"), 1, "replayed seq is ignored");
  assert.equal(occurrences(newSink.buffer, "second line"), 1);
  assert.deepEqual(finalSnapshot.input, checkpoint.input);
  assert.equal(finalSnapshot.lastSequence, 3);
  assert.equal(finalSnapshot.turn.turnId, checkpoint.turn.turnId);
  assert.equal(finalSnapshot.turn.startedAt, checkpoint.turn.startedAt);
  assert.equal(finalSnapshot.turn.state, "succeeded");

  // Returned snapshots are defensive clones.
  (finalSnapshot.input as { buffer: string }).buffer = "mutated";
  assert.equal(resumed.snapshot().input.buffer, "draft 世界");
  resumed.dispose();
});

test("active remount refuses a legacy source unless loss-detecting fallback is explicit", () => {
  const source = new LegacySource();
  const first = createTerminalSession({
    source,
    sink: new StringSink({ isTTY: false }),
    prompt: "legacy transport",
  });
  source.push({ type: "log", line: "first", seq: 1 });
  const checkpoint = first.snapshot();
  first.dispose();

  source.push({ type: "log", line: "lost while unmounted", seq: 2 });
  const rejectedSink = new StringSink({ isTTY: false });
  assert.throws(
    () => createTerminalSession({ source, sink: rejectedSink, snapshot: checkpoint }),
    /requires source\.subscribeAfter/i,
  );
  assert.equal(source.listenerCount, 0);
  assert.equal(rejectedSink.buffer, "", "unsupported resume fails before renderer writes");

  const legacySink = new StringSink({ isTTY: false });
  const resumed = createTerminalSession({
    source,
    sink: legacySink,
    snapshot: checkpoint,
    resumeMode: "legacy-gap-detect",
  });
  source.push({ type: "done", seq: 3 });
  assert.equal(resumed.state, "failed");
  assert.match(legacySink.buffer, /sequence gap.*expected 2.*received 3/i);
  assert.equal(occurrences(legacySink.buffer, "sequence gap"), 1);
  assert.equal(source.listenerCount, 0);
  resumed.dispose();
});

test("atomic remount fails visibly when retained replay itself has a sequence gap", () => {
  const source = new FakeSource();
  const first = createTerminalSession({ source, sink: new StringSink({ isTTY: false }) });
  source.push({ type: "log", line: "one", seq: 1 });
  const checkpoint = first.snapshot();
  first.dispose();

  source.push({ type: "log", line: "evicted", seq: 2 });
  source.dropBufferedSequence(2);
  source.push({ type: "log", line: "three", seq: 3 });
  const sink = new StringSink({ isTTY: false });
  const resumed = createTerminalSession({ source, sink, snapshot: checkpoint });

  assert.equal(resumed.state, "failed");
  assert.match(sink.buffer, /sequence gap.*expected 2.*received 3/i);
  assert.equal(occurrences(sink.buffer, "sequence gap"), 1);
  assert.equal(source.listenerCount, 0);
  resumed.dispose();
});

test("recoverable remount preserves the original meaningful-progress deadline", async () => {
  const source = new FakeSource();
  const first = createTerminalSession({
    source,
    sink: new StringSink({ isTTY: false }),
    prompt: "do not refresh forever",
    meaningfulProgressTimeoutMs: 50,
    now: () => 100,
  });
  const checkpoint = first.snapshot();
  first.dispose();

  const resumed = createTerminalSession({
    source,
    sink: new StringSink({ isTTY: false }),
    snapshot: checkpoint,
    meaningfulProgressTimeoutMs: 50,
    now: () => 175,
  });
  await delay(10);

  assert.equal(resumed.state, "timed_out", "elapsed unmounted time cannot grant a fresh timeout window");
  assert.equal(source.listenerCount, 0);
  resumed.dispose();
});

for (const sequenceCase of [
  { name: "gap", event: { type: "log", line: "unsafe gap", seq: 2 } as AgentEvent, pattern: /sequence gap.*expected 1.*received 2/i },
  { name: "missing", event: { type: "log", line: "missing" } as AgentEvent, pattern: /sequence missing/i },
  { name: "invalid", event: { type: "log", line: "invalid", seq: 0 } as AgentEvent, pattern: /invalid sequence/i },
]) {
  test(`resumable embed fails visibly and closed on a ${sequenceCase.name} sequence`, () => {
    const source = new FakeSource();
    const sink = new StringSink({ isTTY: false });
    const session = createTerminalSession({ source, sink, requireSequence: true });
    source.push(sequenceCase.event);
    assert.equal(session.state, "failed");
    assert.match(sink.buffer, sequenceCase.pattern);
    assert.equal(source.listenerCount, 0);
    assert.equal(occurrences(sink.buffer, "· " + session.turnId), 1, "one typed terminal outcome");
    session.dispose();
  });
}

test("transport EOF before a terminal frame immediately finalizes incomplete", () => {
  const source = new FakeSource();
  const sink = new StringSink({ isTTY: false });
  const session = createTerminalSession({ source, sink, prompt: "do not imply success" });
  source.push({ type: "closed", reason: "stream EOF before done" });
  source.push({ type: "done", seq: 1 });
  assert.equal(session.state, "incomplete");
  assert.equal(session.outcome?.exitCode, 1);
  assert.equal(session.outcome?.retryable, true);
  assert.match(sink.buffer, /stream EOF before done/i);
  assert.equal(source.listenerCount, 0);
  session.dispose();
});

test("100 embed mount/dispose cycles leave no subscriptions, source closes, or process listeners", () => {
  const source = new FakeSource();
  const baseline = {
    exit: process.listenerCount("exit"),
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  for (let i = 0; i < 100; i++) {
    const session = createTerminalSession({ source, sink: new StringSink({ isTTY: false }) });
    assert.equal(source.listenerCount, 1);
    session.dispose();
    session.dispose();
    assert.equal(source.listenerCount, 0);
  }
  assert.equal(source.maxListeners, 1);
  assert.equal(source.closes, 0, "host-owned source remains open across UI remounts");
  assert.deepEqual(
    {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    },
    baseline,
  );
});
