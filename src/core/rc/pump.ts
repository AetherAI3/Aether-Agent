// pump.ts — the viewer host's delivery supervisor for one local coding run.
//
// host.ts owns the primitives (heartbeat, one bounded append, retry pacing);
// this module owns WHEN they run (#223). One pump is bound to one coding
// session: it heartbeats at the Cloud's interval so the broker keeps the
// session live, drains the durable outbox in bounded batches whenever events
// are queued, backs off on capped jittered delays when the broker is
// unreachable or rate limiting, and stops for good on any answer retrying
// cannot fix. At the end of the run it makes one final flush, bounded by a
// short deadline, and stops.
//
// WHAT IT MUST NEVER DO
//
// Change or delay the coding run. Every timer is unref'd, so a pump can never
// keep a finished process alive. Nothing here throws to a caller: a failure is
// a state (`status()`), not an exception. `kick()` returns immediately and the
// coding run never awaits delivery. `close()` resolves by its deadline whether
// or not the broker ever answers, and then aborts whatever is still in flight.
//
// WHY THE CLOCK IS INJECTED
//
// The properties that matter — five-second cadence, single-digit attempts in
// a ninety-second outage, no request after a terminal answer — are claims
// about time. Tests prove them on a virtual clock rather than by sleeping,
// which would measure the CI machine instead of the host.
//
// Outbound only, like everything in src/core/rc: the pump calls the broker's
// host routes and nothing calls it.

import {
  RcError,
  classifyRcError,
  flushOutbox,
  heartbeatHost,
  isTerminalRcCode,
  retryDelayMs,
  type FlushOutcome,
  type RcCode,
  type RcHostDeps,
} from "./host.js";
import { adoptOutbox, loadOutbox, type OutboxRecord } from "./outbox.js";

/** The Cloud's HEARTBEAT_INTERVAL_S (3 missed → reconnecting, 12 → offline). */
export const RC_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * The most a run's end waits on RC. Kept under the CLI's 2 s exit window
 * (main.ts `finish`), so RC can never be the reason a finished run lingers.
 */
export const RC_FINAL_FLUSH_DEADLINE_MS = 1_500;

/**
 * Appends per tick. 32 × RC_MAX_BATCH (32) covers a full 1 000-event outbox in
 * one tick after a reconnect, while still bounding the work any tick can do.
 */
const RC_MAX_BATCHES_PER_TICK = 32;

/** Cloud TERMINAL_STATES. A heartbeat that reports one ends this host. */
const TERMINAL_SESSION_STATES: ReadonlySet<string> = new Set(["revoked", "expired", "closed"]);

export interface RcTimer {
  unref?(): unknown;
}

export interface RcClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): RcTimer;
  clearTimeout(timer: RcTimer): void;
}

export const systemClock: RcClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** running: on cadence. backoff: waiting out a transient failure. stopped: for good. */
export type RcPumpState = "running" | "backoff" | "stopped";

/** The pump's RC state. Failures land here, never in the coding run. */
export interface RcPumpStatus {
  state: RcPumpState;
  /** Consecutive transient failures on the most-failing clock (heartbeat, delivery, local read). */
  attempt: number;
  /** Why the pump stopped; null while it runs, or when it was closed normally. */
  stop_code: RcCode | null;
  /** The most recent failure, transient or terminal; null after a success. */
  last_error: RcCode | null;
}

export interface RcHostPump {
  /** Events were queued: deliver now unless backing off. Returns immediately. */
  kick(): void;
  /** Resolves when no tick is in flight. For tests; a coding run never awaits it. */
  idle(): Promise<void>;
  /**
   * Stop every timer, make one final flush (one batch of at most RC_MAX_BATCH
   * events) bounded by `deadlineMs`, and abort the rest. Anything still queued
   * stays durable for the next run.
   */
  close(deadlineMs?: number): Promise<void>;
  status(): RcPumpStatus;
}

export interface RcHostPumpOptions {
  clock?: RcClock;
  rng?: () => number;
  heartbeatIntervalMs?: number;
}

/**
 * Bind a host lifetime to `record`, which the caller keeps enqueueing into.
 *
 * The durable file is the ownership authority on every tick: if `rc off`
 * wrote its tombstone, another session replaced this one, or the file can no
 * longer be read, the pump stops before making any request.
 */
export function startHostPump(
  deps: RcHostDeps,
  record: OutboxRecord,
  options: RcHostPumpOptions = {},
): RcHostPump {
  const clock = options.clock ?? systemClock;
  const rng = options.rng ?? Math.random;
  const interval = options.heartbeatIntervalMs ?? RC_HEARTBEAT_INTERVAL_MS;
  const controller = new AbortController();
  // A request slower than the cadence is a missed beat anyway; never let one
  // hold the next tick hostage for the default ten seconds.
  const live: RcHostDeps = { ...deps, requestTimeoutMs: interval, signal: controller.signal };

  let state: RcPumpState = "running";
  let stopCode: RcCode | null = null;
  let lastError: RcCode | null = null;
  let timer: RcTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let closing: Promise<void> | null = null;

  // Two clocks, deliberately independent: delivery backing off (a rate-limited
  // or refusing events route) must never silence the heartbeat, or a host the
  // broker can hear is marked offline. Delivery only runs on a session a
  // heartbeat has proved live and ours, so a down broker costs one probe per
  // backoff step, not two.
  let beatHealthy = false;
  let beatAttempt = 0;
  let beatDueAt = clock.now();
  let sendAttempt = 0;
  let sendDueAt = clock.now();
  // The outbox file could not be READ (a lock, an access error). Not damage:
  // hold everything and look again on the backoff curve.
  let localAttempt = 0;
  let localDueAt = clock.now();

  const after = (ms: number, fn: () => void): RcTimer => {
    const handle = clock.setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return handle;
  };

  const clearTimer = (): void => {
    if (timer) clock.clearTimeout(timer);
    timer = null;
  };

  /** Read through a call: `close()` or a terminal answer may stop the host across an await. */
  const stopped = (): boolean => state === "stopped";

  const stop = (code: RcCode | null): void => {
    if (state !== "stopped") {
      state = "stopped";
      stopCode = code;
    }
    clearTimer();
  };

  /**
   * Terminal for this host: the session is gone, not ours, or refuses the
   * bytes. Local state codes are NOT — a write or read that failed once on a
   * locked file is retried on the backoff curve. Damaged state is detected by
   * the tick's own read, which stops the host for good.
   */
  const terminal = (code: RcCode): boolean =>
    isTerminalRcCode(code) && code !== "RC_STATE_UNREADABLE" && code !== "RC_STATE_UNWRITABLE";

  /** Schedule the next tick at whichever clock is due first. */
  const settle = (): void => {
    if (state === "stopped") return;
    state = beatAttempt > 0 || sendAttempt > 0 || localAttempt > 0 ? "backoff" : "running";
    if (state === "running") lastError = null;
    const now = clock.now();
    let next = localAttempt > 0 ? localDueAt : beatDueAt;
    if (localAttempt === 0 && beatHealthy && record.events.length > 0) next = Math.min(next, sendDueAt);
    clearTimer();
    timer = after(next - now, () => { timer = null; run(); });
  };

  const beat = async (): Promise<boolean> => {
    let sessionState: string;
    try {
      sessionState = await heartbeatHost(live, record.session_id, record.device_id);
    } catch (error) {
      const code = error instanceof RcError ? error.code : classifyRcError(error).code;
      lastError = code;
      if (terminal(code)) stop(code);
      if (stopped()) return false;
      beatHealthy = false;
      beatAttempt += 1;
      beatDueAt = clock.now() + retryDelayMs(beatAttempt, rng);
      return false;
    }
    if (stopped()) return false;
    if (TERMINAL_SESSION_STATES.has(sessionState)) {
      stop("RC_SESSION_TERMINAL");
      return false;
    }
    beatHealthy = true;
    beatAttempt = 0;
    beatDueAt = clock.now() + interval;
    return true;
  };

  const tick = async (): Promise<void> => {
    const current = loadOutbox(deps.outboxPath, deps.projectRoot);
    if (current.recovery) {
      // Unparseable or incompatible bytes are damage: stop for good. A read
      // that failed proves nothing about the record; look again later.
      if (current.recovery.reason !== "unreadable") return stop("RC_STATE_UNREADABLE");
      lastError = "RC_STATE_UNREADABLE";
      localAttempt += 1;
      localDueAt = clock.now() + retryDelayMs(localAttempt, rng);
      return;
    }
    localAttempt = 0;
    if (current.revoke_pending || current.session_id !== record.session_id) return stop("RC_SESSION_TERMINAL");
    // The pump is the delivery owner for this outbox: whatever any writer
    // queued (the coding observer, /orchestra) is what this tick delivers.
    adoptOutbox(record, current);

    if (clock.now() >= beatDueAt && !(await beat())) return;

    let batches = 0;
    while (beatHealthy && record.events.length > 0 && clock.now() >= sendDueAt && batches < RC_MAX_BATCHES_PER_TICK) {
      // A long drain keeps the heartbeat on cadence between batches.
      if (clock.now() >= beatDueAt && !(await beat())) return;
      if (stopped()) return;
      let outcome: FlushOutcome;
      try {
        outcome = await flushOutbox(live, record);
      } catch {
        // flushOutbox throws only when a receipt could not be made durable.
        outcome = { ok: false, code: "RC_STATE_UNWRITABLE", detail: "local RC state could not be written" };
      }
      batches += 1;
      if (stopped()) return;
      if (!outcome.ok) {
        lastError = outcome.code;
        if (terminal(outcome.code)) return stop(outcome.code);
        sendAttempt += 1;
        sendDueAt = clock.now() + retryDelayMs(sendAttempt, rng);
        return;
      }
      sendAttempt = 0;
      sendDueAt = clock.now();
    }
  };

  const run = (): void => {
    if (state === "stopped") return;
    if (inFlight) {
      rerun = true;
      return;
    }
    clearTimer();
    inFlight = tick()
      .catch(() => {
        // Nothing in a tick is expected to throw; if something does, it is an
        // RC failure, paced like an outage rather than retried hot.
        lastError = "RC_BROKER_UNREACHABLE";
        sendAttempt += 1;
        sendDueAt = clock.now() + retryDelayMs(sendAttempt, rng);
      })
      .finally(() => {
        inFlight = null;
        settle();
        const again = rerun && state === "running";
        rerun = false;
        if (again) run();
      });
  };

  /**
   * Wait for `work`, but never longer than `ms`. This one timer is NOT
   * unref'd: the run is awaiting close(), and an unref'd deadline could let
   * the event loop drain mid-await and end the process before the run reports
   * its exit code. It is bounded by `ms` and cleared as soon as `work` settles.
   */
  const bounded = (work: Promise<unknown>, ms: number): Promise<void> => {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const handle = clock.setTimeout(resolve, ms);
      void work.then(() => undefined, () => undefined).then(() => {
        clock.clearTimeout(handle);
        resolve();
      });
    });
  };

  run();

  return {
    kick(): void {
      if (state === "running") run();
    },

    async idle(): Promise<void> {
      while (inFlight) await inFlight;
    },

    close(deadlineMs: number = RC_FINAL_FLUSH_DEADLINE_MS): Promise<void> {
      if (closing) return closing;
      // A terminal answer already ended delivery; only a live or backing-off
      // host gets the final attempt.
      const flushAtEnd = state !== "stopped";
      stop(null);
      closing = (async () => {
        const until = clock.now() + Math.max(0, deadlineMs);
        const remaining = (): number => Math.max(0, until - clock.now());
        if (inFlight) await bounded(inFlight, remaining());
        if (flushAtEnd && !inFlight && record.events.length > 0 && remaining() > 0) {
          const final: RcHostDeps = { ...live, requestTimeoutMs: remaining() };
          await bounded(flushOutbox(final, record), remaining());
        }
      })()
        .catch(() => undefined)
        .finally(() => controller.abort());
      return closing;
    },

    status(): RcPumpStatus {
      const attempt = Math.max(beatAttempt, sendAttempt, localAttempt);
      return { state, attempt, stop_code: stopCode, last_error: lastError };
    },
  };
}
