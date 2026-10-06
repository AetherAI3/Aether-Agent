// RC host pump (#223) — heartbeat and outbox delivery for the lifetime of one
// local coding session, on a VIRTUAL clock.
//
// Nothing here sleeps. A ninety-second outage is ninety virtual seconds: what
// has to be shown is the SHAPE of the host's behaviour — a heartbeat every
// five seconds, a bounded number of attempts on capped jittered backoff during
// an outage, a duplicate-safe replay on reconnect, a stop on terminal answers,
// and a bounded final flush — and a simulated clock measures exactly that,
// where a real one would measure the CI machine's load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiClient } from "../src/core/transport.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { ToolExecutor, ToolResult } from "../src/core/tool_executor.js";
import {
  RC_FINAL_FLUSH_DEADLINE_MS,
  RC_HEARTBEAT_INTERVAL_MS,
  startHostPump,
  type RcClock,
  type RcTimer,
} from "../src/core/rc/pump.js";
import { flushOutbox, type RcHostDeps } from "../src/core/rc/host.js";
import {
  RC_MAX_OUTBOX_EVENTS,
  createOutbox,
  enqueueEvent,
  loadOutbox,
  saveOutbox,
  type OutboxRecord,
} from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import { subagentStartedEvent } from "../src/core/rc/producers.js";
import { publishSubagentEvents } from "../src/core/rc/subagents.js";
import { hostLoop } from "../src/commands/code.js";
import { projectRefFor } from "../src/commands/rc.js";
import { openRcCodingObserver } from "../src/commands/rc_observation.js";

const SESSION = "rs_" + "9".repeat(32);
const DEVICE = "dev-pump";

// ── a virtual clock ─────────────────────────────────────────────────────────

interface VirtualTimer extends RcTimer {
  at: number;
  fn: () => void;
  cleared: boolean;
  unrefd: boolean;
}

class VirtualClock implements RcClock {
  t = 0;
  private timers: VirtualTimer[] = [];
  created = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): RcTimer {
    this.created += 1;
    const timer: VirtualTimer = {
      at: this.t + Math.max(0, ms),
      fn,
      cleared: false,
      unrefd: false,
      unref() {
        timer.unrefd = true;
        return timer;
      },
    };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: RcTimer): void {
    (timer as VirtualTimer).cleared = true;
    this.timers = this.timers.filter((candidate) => candidate !== timer);
  }

  live(): VirtualTimer[] {
    return this.timers.filter((timer) => !timer.cleared);
  }

  /** Run every timer due within `ms`, in order, settling the pump after each. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      // Settle first: work already in flight schedules its next timer only
      // when it completes, and that timer may be due inside this window.
      await settle();
      const due = this.live().filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      this.timers = this.timers.filter((candidate) => candidate !== due);
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ── a broker that remembers ─────────────────────────────────────────────────

class FakeBroker {
  /** host_event_id -> [seq, digest]. The Cloud dedupes on the id. */
  readonly stored = new Map<string, { seq: number; digest: string }>();
  seq = 0;
  state: "live" | "revoked" | "expired" = "live";
  outage = false;
  /** Store the next append, then lose the answer: a receipt the host never sees. */
  loseNextAnswer = false;
  /** Store the next append, then acknowledge all but its last event. */
  partialNextAnswer = false;
  /** Rate limit the events route only; heartbeats still succeed. */
  refuseEvents = false;
  rateLimitHeartbeats = 0;
  hang = false;
  duplicates = 0;
  readonly log: Array<{ at: number; route: string }> = [];

  constructor(private readonly clock: VirtualClock) {}

  api(): ApiClient {
    return {
      postJson: async (path: string, body: unknown) => {
        const route = path.endsWith("/host/heartbeat") ? "heartbeat" : path.endsWith("/host/events") ? "events" : path;
        this.log.push({ at: this.clock.now(), route });
        if (this.hang) return new Promise(() => {});
        if (this.outage) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
        if (route === "heartbeat") {
          if (this.rateLimitHeartbeats > 0) {
            this.rateLimitHeartbeats -= 1;
            throw Object.assign(new Error("HTTP 429"), { status: 429 });
          }
          return { session_id: SESSION, state: this.state };
        }
        if (route === "events") {
          if (this.refuseEvents) throw Object.assign(new Error("HTTP 429"), { status: 429 });
          if (this.state !== "live") throw Object.assign(new Error("HTTP 409"), { status: 409, detail: "session not appendable" });
          const events = (body as { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }).events;
          const receipts = events.map((event) => {
            const digest = payloadDigest(event.payload);
            const prior = this.stored.get(event.host_event_id);
            if (prior) {
              this.duplicates += 1;
              return { host_event_id: event.host_event_id, seq: prior.seq, payload_digest: digest, duplicate: true };
            }
            this.seq += 1;
            this.stored.set(event.host_event_id, { seq: this.seq, digest });
            return { host_event_id: event.host_event_id, seq: this.seq, payload_digest: digest };
          });
          if (this.loseNextAnswer) {
            this.loseNextAnswer = false;
            throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
          }
          if (this.partialNextAnswer) {
            this.partialNextAnswer = false;
            return { session_id: SESSION, receipts: receipts.slice(0, -1) };
          }
          return { session_id: SESSION, receipts };
        }
        throw Object.assign(new Error("HTTP 404"), { status: 404 });
      },
    } as unknown as ApiClient;
  }

  count(route: string, from = 0, to = Number.POSITIVE_INFINITY): number {
    return this.log.filter((entry) => entry.route === route && entry.at >= from && entry.at < to).length;
  }
}

function plan(record: OutboxRecord, n: number, label = "s"): void {
  for (let i = 0; i < n; i++) {
    enqueueEvent(record, "plan", { projection_version: "1", title: `${label}${i}`, status: "running" });
  }
}

function fixture(events = 0): { record: OutboxRecord; deps: (api: ApiClient) => RcHostDeps; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "aether-rc-pump-"));
  const path = join(root, "outbox.json");
  const record = createOutbox({
    session_id: SESSION, project_ref: projectRefFor(root), device_id: DEVICE, epoch: 1, project_root: root,
  });
  plan(record, events);
  saveOutbox(path, record);
  return { record, path, root, deps: (api) => ({ api, outboxPath: path, projectRoot: root }) };
}

// ── heartbeat ───────────────────────────────────────────────────────────────

test("the host heartbeats every five seconds and every timer it creates is unref'd", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await clock.advance(30_000, () => pump.idle());
  assert.equal(RC_HEARTBEAT_INTERVAL_MS, 5_000, "the Cloud's HEARTBEAT_INTERVAL_S is 5.0");
  // t = 0, 5, 10, ... 30: seven beats, never a burst.
  assert.equal(broker.count("heartbeat"), 7);
  const beats = broker.log.filter((entry) => entry.route === "heartbeat").map((entry) => entry.at);
  for (let i = 1; i < beats.length; i++) assert.equal(beats[i]! - beats[i - 1]!, 5_000);
  assert.ok(clock.created > 0);
  assert.ok(clock.live().every((timer) => timer.unrefd), "a pump timer must never keep the process alive");
  await pump.close(0);
  assert.equal(clock.live().length, 0, "close clears every timer");
});

test("queued events drain in bounded batches as soon as they are kicked", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path, root } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  plan(record, 70);
  saveOutbox(path, record);
  pump.kick();
  await pump.idle();
  // 70 events at most 32 per append: three appends, all receipted.
  assert.equal(broker.count("events"), 3);
  assert.equal(record.events.length, 0);
  assert.equal(loadOutbox(path, root).cursor, 70);
  await pump.close(0);
});

// ── the ninety-second outage ────────────────────────────────────────────────

test("a 90-second outage backs off, loses nothing, then replays duplicate-safely and advances only on full receipts", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path, root } = fixture(3);
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  assert.equal(record.cursor, 3, "the first three are receipted while the broker is healthy");

  // The broker stores two events, then the answer is lost on the way back.
  broker.loseNextAnswer = true;
  plan(record, 2, "lost");
  saveOutbox(path, record);
  pump.kick();
  await pump.idle();
  assert.equal(broker.stored.size, 5, "the broker did store them");
  assert.equal(record.cursor, 3, "an unseen receipt never advances the cursor");
  assert.equal(record.events.length, 2, "and never costs the events");

  // Ninety seconds of outage, with the run still producing.
  const outageStart = clock.now();
  broker.outage = true;
  for (let second = 0; second < 90; second += 10) {
    plan(record, 4, `o${second}-`);
    saveOutbox(path, record);
    pump.kick();
    await clock.advance(10_000, () => pump.idle());
  }
  const outageEnd = clock.now();
  const attempts = broker.log.filter((entry) => entry.at >= outageStart && entry.at < outageEnd).length;
  // Exponential backoff from 1s, capped at 60s: single digits, not a hot loop.
  assert.ok(attempts <= 12, `${attempts} requests in a 90s outage is a busy loop`);
  const gaps = broker.log.filter((entry) => entry.at >= outageStart && entry.at < outageEnd)
    .map((entry) => entry.at).map((at, i, all) => (i === 0 ? 0 : at - all[i - 1]!));
  assert.ok(gaps.every((gap) => gap <= 60_000), "backoff is capped at 60s");
  assert.equal(record.events.length, 2 + 36, "an outage costs no events");
  assert.equal(loadOutbox(path, root).events.length, 38, "and they are durable");

  // Reconnect.
  broker.outage = false;
  await clock.advance(60_000, () => pump.idle());
  assert.equal(record.events.length, 0, "everything queued was delivered");
  assert.equal(broker.duplicates, 2, "the lost-answer pair was replayed and deduped by host_event_id");
  assert.equal(broker.stored.size, 3 + 2 + 36, "nothing was stored twice");
  assert.equal(record.cursor, broker.seq);
  assert.equal(loadOutbox(path, root).cursor, broker.seq, "the cursor is durable");
  // Healthy again: back to the five-second cadence.
  const before = broker.count("heartbeat");
  await clock.advance(20_000, () => pump.idle());
  assert.equal(broker.count("heartbeat") - before, 4);
  await pump.close(0);
});

test("a partial receipt never advances the cursor; the retry after backoff completes it duplicate-safely", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path, root } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  broker.partialNextAnswer = true;
  plan(record, 3);
  saveOutbox(path, record);
  pump.kick();
  await pump.idle();
  assert.equal(pump.status().state, "backoff");
  assert.equal(pump.status().last_error, "RC_RECEIPTS_UNPROVEN");
  assert.equal(loadOutbox(path, root).cursor, 0, "two of three receipts prove nothing");
  assert.equal(loadOutbox(path, root).events.length, 3);
  await clock.advance(5_000, () => pump.idle());
  assert.equal(loadOutbox(path, root).events.length, 0);
  assert.equal(loadOutbox(path, root).cursor, 3);
  assert.equal(broker.duplicates, 3, "the replay was deduped by host_event_id");
  assert.equal(broker.stored.size, 3);
  await pump.close(0);
});

test("a full queue during an outage stays bounded: oldest dropped, counted, never grown", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  broker.outage = true;
  const { record, deps, path } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  plan(record, RC_MAX_OUTBOX_EVENTS + 50);
  saveOutbox(path, record);
  pump.kick();
  await clock.advance(30_000, () => pump.idle());
  assert.equal(record.events.length, RC_MAX_OUTBOX_EVENTS);
  assert.equal(record.dropped, 50);
  assert.ok(broker.log.length <= 8);
  await pump.close(0);
});

test("a rate limit backs off on the capped jittered curve but does not stop the host", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  broker.rateLimitHeartbeats = 2;
  const { record, deps } = fixture(1);
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  assert.equal(pump.status().state, "backoff");
  assert.equal(pump.status().last_error, "RC_RATE_LIMITED");
  await clock.advance(10_000, () => pump.idle());
  assert.equal(pump.status().state, "running");
  assert.equal(record.events.length, 0);
  await pump.close(0);
});

test("delivery backing off never silences the heartbeat", async () => {
  // The broker hears the host but refuses its events (a rate limit on the
  // events route alone). Coupling the two would stretch heartbeat gaps along
  // the delivery backoff to 60 s, and the Cloud marks a host offline after 12
  // missed beats — a host it can hear, shown to viewers as gone.
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path, root } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  broker.refuseEvents = true;
  plan(record, 3);
  saveOutbox(path, record);
  pump.kick();
  await clock.advance(60_000, () => pump.idle());
  const beats = broker.log.filter((entry) => entry.route === "heartbeat").map((entry) => entry.at);
  assert.equal(beats.length, 13, "t = 0, 5, ... 60: every beat on cadence");
  for (let i = 1; i < beats.length; i++) assert.equal(beats[i]! - beats[i - 1]!, 5_000);
  assert.ok(broker.count("events") <= 7, `${broker.count("events")} appends in 60 s: delivery still backs off`);
  assert.equal(pump.status().state, "backoff");

  broker.refuseEvents = false;
  await clock.advance(60_000, () => pump.idle());
  assert.equal(loadOutbox(path, root).events.length, 0, "and delivery resumes once the route accepts again");
  await pump.close(0);
});

test("a local state file that cannot be read for a moment is retried; damaged state stops the host", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  // Reading the path now fails (EISDIR) — an I/O condition, not damage.
  renameSync(path, `${path}.held`);
  mkdirSync(path);
  await clock.advance(5_000, () => pump.idle());
  assert.equal(pump.status().state, "backoff", "an unreadable moment is not a reason to stop");
  assert.equal(pump.status().last_error, "RC_STATE_UNREADABLE");
  rmdirSync(path);
  renameSync(`${path}.held`, path);
  const before = broker.count("heartbeat");
  await clock.advance(10_000, () => pump.idle());
  assert.equal(pump.status().state, "running");
  assert.ok(broker.count("heartbeat") > before, "the heartbeat resumed");

  writeFileSync(path, "{ not json", "utf8");
  await clock.advance(10_000, () => pump.idle());
  assert.equal(pump.status().state, "stopped", "unparseable bytes are damage");
  assert.equal(pump.status().stop_code, "RC_STATE_UNREADABLE");
});

test("a receipt that cannot be written for a moment is retried and replayed, never a reason to stop", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, path, root } = fixture(2);
  let failNext = true;
  const deps: RcHostDeps = {
    api: broker.api(),
    outboxPath: path,
    projectRoot: root,
    persist: (target, value) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      saveOutbox(target, value);
    },
  };
  const pump = startHostPump(deps, record, { clock, rng: () => 0.5 });
  await pump.idle();
  assert.equal(pump.status().state, "backoff");
  assert.equal(pump.status().last_error, "RC_STATE_UNWRITABLE");
  assert.equal(loadOutbox(path, root).events.length, 2, "an unrecorded receipt costs no events");
  await clock.advance(5_000, () => pump.idle());
  assert.equal(pump.status().state, "running");
  assert.equal(loadOutbox(path, root).events.length, 0);
  assert.equal(loadOutbox(path, root).cursor, 2);
  assert.equal(broker.duplicates, 2, "the replay was deduped by host_event_id");
  await pump.close(0);
});

// ── host termination ────────────────────────────────────────────────────────

test("a revoked or expired session stops the host: no further request, no live timer", async () => {
  for (const terminal of ["revoked", "expired"] as const) {
    const clock = new VirtualClock();
    const broker = new FakeBroker(clock);
    const { record, deps } = fixture(2);
    const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
    await clock.advance(10_000, () => pump.idle());
    broker.state = terminal;
    await clock.advance(5_000, () => pump.idle());
    assert.equal(pump.status().state, "stopped", `${terminal} must stop the host`);
    assert.equal(pump.status().stop_code, "RC_SESSION_TERMINAL");
    const requests = broker.log.length;
    plan(record, 3);
    pump.kick();
    await clock.advance(300_000, () => pump.idle());
    assert.equal(broker.log.length, requests, "a stopped host sends nothing, kicked or not");
    assert.equal(clock.live().length, 0);
  }
});

test("a session the Cloud no longer has, or another host owns, stops the host", async () => {
  const clock = new VirtualClock();
  const api = {
    postJson: async () => {
      throw Object.assign(new Error("HTTP 404"), { status: 404, body: { detail: "session not found" } });
    },
  } as unknown as ApiClient;
  const { record, deps } = fixture(1);
  const pump = startHostPump(deps(api), record, { clock });
  await pump.idle();
  assert.equal(pump.status().state, "stopped");
  assert.equal(pump.status().stop_code, "RC_SESSION_NOT_FOUND");
  assert.equal(record.events.length, 1, "terminal is not a reason to discard durable events");
});

test("a local revoke stops the host before any request is made", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path, root } = fixture(1);
  const tombstone = loadOutbox(path, root);
  tombstone.revoke_pending = true;
  tombstone.events = [];
  saveOutbox(path, tombstone);
  const pump = startHostPump(deps(broker.api()), record, { clock });
  await pump.idle();
  assert.equal(pump.status().state, "stopped");
  assert.equal(broker.log.length, 0);
});

// ── shutdown ────────────────────────────────────────────────────────────────

test("close stops the timers and makes exactly one bounded final flush", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps, path } = fixture();
  const pump = startHostPump(deps(broker.api()), record, { clock, rng: () => 0.5 });
  await pump.idle();
  plan(record, 2);
  saveOutbox(path, record);
  // Not kicked: the final flush is what must deliver these.
  const requests = broker.log.length;
  await pump.close();
  assert.equal(broker.count("events"), 1);
  assert.equal(broker.log.length, requests + 1, "one final append and nothing else");
  assert.equal(record.events.length, 0);
  assert.equal(clock.live().length, 0);
  await clock.advance(60_000, () => pump.idle());
  assert.equal(broker.log.length, requests + 1);
});

test("close never waits past its deadline on a broker that hangs", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { record, deps } = fixture(1);
  broker.hang = true;
  const pump = startHostPump(deps(broker.api()), record, { clock });
  let closed = false;
  const closing = pump.close(RC_FINAL_FLUSH_DEADLINE_MS).then(() => { closed = true; });
  await turns();
  assert.equal(closed, false);
  await clock.advance(RC_FINAL_FLUSH_DEADLINE_MS, turns);
  await closing;
  assert.equal(closed, true);
  assert.ok(RC_FINAL_FLUSH_DEADLINE_MS <= 2_000, "the final flush must fit inside the CLI's exit window");
});

// ── the coding run ──────────────────────────────────────────────────────────

const task: TaskCommand = { type: "task", text: "t", cwd: ".", poolGb: 5 };
const exec = { executeAsync: async (): Promise<ToolResult> => ({ output: "", exitCode: 0 }) } as unknown as ToolExecutor;

function brain(events: readonly BrainEvent[]): Brain {
  return {
    async *run() { yield* events; },
    sendToolResult() {},
    control() {},
    close() {},
  };
}

test("a coding run binds one host lifetime: heartbeat, delivery, and a real-clock close that cannot delay exit", async () => {
  const { path, root } = fixture();
  const hungUpload = { postJson: () => new Promise(() => {}) } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, hungUpload, path);
  assert.ok(observer);
  const run = hostLoop(brain([
    { type: "stage", name: "build", face: "" },
    { type: "done", ok: true, result: "", remaining: 0, reason: "" },
  ]), exec, (event) => observer.feed(event), task);
  // A ref'd guard timer keeps the test alive while the pump's own timers are
  // all unref'd, and is cleared so it never outlives the test.
  let guard: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => { guard = setTimeout(() => resolve("late"), 1_000); });
  try {
    assert.equal(await Promise.race([run, late]), 0, "a hung broker never delays the coding run");
    const started = Date.now();
    assert.notEqual(await Promise.race([observer.close(50).then(() => "closed"), late]), "late");
    assert.ok(Date.now() - started < 1_000, "close is bounded by its deadline");
  } finally {
    clearTimeout(guard);
  }
  assert.equal(loadOutbox(path, root).events.length, 2, "undelivered events stay durable for the next run");
});

test("the next run resumes durable delivery when the session is still ours", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  const { path, root } = fixture(4);
  const observer = openRcCodingObserver(root, broker.api(), path, { clock, rng: () => 0.5 });
  assert.ok(observer);
  await observer.drain();
  assert.equal(broker.count("heartbeat"), 1, "ownership is proven by a heartbeat first");
  assert.equal(broker.stored.size, 4);
  assert.equal(loadOutbox(path, root).events.length, 0);
  await observer.close(0);
});

// ── one outbox, several writers ─────────────────────────────────────────────
//
// The pump owns delivery during a run, but it is not the only writer: /orchestra
// (publishSubagentEvents) queues into the same file from the same process. A
// writer that saves a stale in-memory copy erases whatever the other queued.

test("another writer's queued events survive the coding observer's saves while the broker is offline", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  broker.outage = true;
  const { path, root } = fixture();
  const observer = openRcCodingObserver(root, broker.api(), path, { clock, rng: () => 0.5 });
  assert.ok(observer);
  observer.feed({ type: "stage", name: "build", face: "" });
  await observer.drain();
  assert.equal(
    await publishSubagentEvents(broker.api(), root, path, [subagentStartedEvent("worker-a", "running")]),
    1,
  );
  observer.feed({ type: "stage", name: "review", face: "" });
  await observer.drain();
  assert.deepEqual(
    loadOutbox(path, root).events.map((event) => event.event_type),
    ["plan", "subagent", "plan"],
    "no writer may save over another writer's queued event",
  );

  // The pump is the delivery owner: it delivers what the other writer queued
  // without being kicked for it.
  broker.outage = false;
  await clock.advance(60_000, () => observer.drain());
  assert.equal(loadOutbox(path, root).events.length, 0);
  assert.equal(broker.stored.size, 3, "all three, each stored once");
  await observer.close(0);
});

test("a receipt that lands after another writer queued an event does not erase that event", async () => {
  const { path, root } = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let appends = 0;
  const api = {
    postJson: async (route: string, body: { events?: Array<{ host_event_id: string; payload: Record<string, unknown> }> }) => {
      if (route.endsWith("/host/heartbeat")) return { session_id: SESSION, state: "live" };
      appends += 1;
      if (appends > 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      await held;
      return {
        session_id: SESSION,
        receipts: body.events!.map((event, index) => ({
          host_event_id: event.host_event_id, seq: index + 1, payload_digest: payloadDigest(event.payload),
        })),
      };
    },
  } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, api, path);
  assert.ok(observer);
  observer.feed({ type: "stage", name: "build", face: "" });
  for (let i = 0; i < 20 && appends === 0; i++) await turns(1);
  assert.equal(appends, 1, "the coding run's append is in flight");

  // Meanwhile /orchestra queues a worker (its own upload attempt fails).
  await publishSubagentEvents(api, root, path, [subagentStartedEvent("worker-b", "running")]);
  release();
  await observer.drain();

  const saved = loadOutbox(path, root);
  assert.equal(saved.cursor, 1, "the receipted plan event is acknowledged");
  assert.deepEqual(saved.events.map((event) => event.event_type), ["subagent"], "and the worker is still queued");
  await observer.close(0);
});

test("two writers flushing overlapping batches at once never wedge the cursor", async () => {
  // A naive merge wedges: a resend the broker dedupes comes back with a seq at
  // or below a cursor another writer already advanced, and is refused forever.
  // Receipts are checked against the cursor at SEND time and only the file's
  // oldest-first prefix is ever sent, so overlap is just a deduped resend.
  const { path, root } = fixture(3);
  const stored = new Map<string, number>();
  let seq = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let appends = 0;
  const api = {
    postJson: async (_route: string, body: { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }) => {
      appends += 1;
      const receipts = body.events.map((event) => {
        if (!stored.has(event.host_event_id)) stored.set(event.host_event_id, ++seq);
        return { host_event_id: event.host_event_id, seq: stored.get(event.host_event_id)!, payload_digest: payloadDigest(event.payload) };
      });
      if (appends === 1) await gate; // the first writer's answer arrives last
      return { session_id: SESSION, receipts };
    },
  } as unknown as ApiClient;
  const deps: RcHostDeps = { api, outboxPath: path, projectRoot: root };

  const first = flushOutbox(deps, loadOutbox(path, root));
  for (let i = 0; i < 20 && appends === 0; i++) await turns(1);
  const queued = loadOutbox(path, root);
  plan(queued, 1, "late");
  saveOutbox(path, queued);
  const second = await flushOutbox(deps, loadOutbox(path, root));
  assert.equal(second.ok, true);
  release();
  const late = await first;
  assert.equal(late.ok, true, "the overlapping answer is a deduped resend, not a stale one");
  assert.equal(loadOutbox(path, root).cursor, 4);
  assert.equal(loadOutbox(path, root).events.length, 0);

  // And the next event still lands: nothing wedged.
  const next = loadOutbox(path, root);
  plan(next, 1, "after");
  saveOutbox(path, next);
  assert.equal((await flushOutbox(deps, loadOutbox(path, root))).ok, true);
  assert.equal(loadOutbox(path, root).cursor, 5);
});

test("the next run does not deliver into a session that expired, and keeps the events", async () => {
  const clock = new VirtualClock();
  const broker = new FakeBroker(clock);
  broker.state = "expired";
  const { path, root } = fixture(4);
  const observer = openRcCodingObserver(root, broker.api(), path, { clock, rng: () => 0.5 });
  assert.ok(observer);
  await observer.drain();
  assert.equal(broker.count("events"), 0);
  observer.feed({ type: "stage", name: "build", face: "" });
  await observer.drain();
  assert.equal(broker.count("events"), 0, "a stopped host publishes nothing more");
  assert.equal(loadOutbox(path, root).events.length, 4);
  await observer.close(0);
});
