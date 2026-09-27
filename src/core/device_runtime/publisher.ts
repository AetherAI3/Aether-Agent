// Publisher — the outbound observation pump.
//
// Sampling and publishing are decoupled: the daemon samples on its own cadence
// and hands each frame to enqueue(); the publish loop drains the queue whenever
// the network is up. That separation is what lets the queue absorb an outage
// without losing the newest data:
//
//   * bounded queue, cap 40, DROP-OLDEST — under a sustained outage the freshest
//     frames survive and the stalest are shed, because the Cloud only ever cares
//     about recent load (staleness past 30s is the Cloud's call, not ours),
//   * publish cadence 12s ± 2s of jitter so a fleet of devices does not
//     synchronise into a thundering herd,
//   * exponential backoff 1s → 60s with jitter while offline,
//   * sequence numbers are assigned at SAMPLE time and only ever move forward,
//     so a reconnect resumes the monotonic series and never reuses a seq. A
//     frame the Cloud rejects (e.g. as stale) is dropped and the loop advances;
//     a network failure keeps the frame and backs off.
//
// The clock and the transport are injected, so the whole thing is tested with
// virtual time and no sockets.

import type { DeviceObservation } from "./contract.js";

export const QUEUE_CAP = 40;
export const BASE_INTERVAL_MS = 12_000;
export const INTERVAL_JITTER_MS = 2_000;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

/** How the transport wants the loop to treat one publish attempt. */
export type PublishOutcome = "ok" | "retry" | "reject";

export type PublishTransport = (obs: DeviceObservation) => Promise<PublishOutcome>;

export interface PublisherOptions {
  /** Uniform [0,1) source; injected so jitter is deterministic under test. */
  random?: () => number;
}

export interface DrainResult {
  sent: number;
  rejected: number;
  /** True when a retryable failure stopped the drain with frames still queued. */
  backedOff: boolean;
}

export class Publisher {
  private readonly queue: DeviceObservation[] = [];
  private failureStreak = 0;
  private readonly random: () => number;

  constructor(opts: PublisherOptions = {}) {
    this.random = opts.random ?? Math.random;
  }

  /** Queue a frame, dropping the OLDEST if the cap is exceeded. */
  enqueue(obs: DeviceObservation): void {
    this.queue.push(obs);
    while (this.queue.length > QUEUE_CAP) this.queue.shift();
  }

  queueDepth(): number {
    return this.queue.length;
  }

  /** True while the last attempt failed and frames remain — i.e. we are offline. */
  isBackedOff(): boolean {
    return this.failureStreak > 0;
  }

  /** The next publish cadence, 12s ± up to 2s of jitter. */
  nextIntervalMs(): number {
    const jitter = Math.round((this.random() * 2 - 1) * INTERVAL_JITTER_MS);
    return Math.max(1, BASE_INTERVAL_MS + jitter);
  }

  /**
   * Backoff for the current failure streak: exponential from 1s, capped at 60s,
   * with up to ±25% jitter. Zero streak means "no backoff, publish on cadence".
   */
  currentBackoffMs(): number {
    if (this.failureStreak <= 0) return 0;
    const exp = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.failureStreak - 1));
    const jitter = 1 + (this.random() * 2 - 1) * 0.25;
    return Math.max(MIN_BACKOFF_MS, Math.min(MAX_BACKOFF_MS, Math.round(exp * jitter)));
  }

  /**
   * Attempt to drain the queue in seq order. Sends oldest-first; a rejected
   * frame is dropped (the Cloud declined it — never re-sent), a retryable
   * failure stops the drain and arms backoff. On any success the failure streak
   * resets, so one good publish clears the backoff.
   */
  async drain(transport: PublishTransport): Promise<DrainResult> {
    let sent = 0;
    let rejected = 0;
    while (this.queue.length) {
      const head = this.queue[0]!;
      let outcome: PublishOutcome;
      try {
        outcome = await transport(head);
      } catch {
        outcome = "retry";
      }
      if (outcome === "ok") {
        this.queue.shift();
        this.failureStreak = 0;
        sent += 1;
        continue;
      }
      if (outcome === "reject") {
        this.queue.shift();
        this.failureStreak = 0;
        rejected += 1;
        continue;
      }
      // retry: keep the frame, arm/deepen backoff, stop the drain.
      this.failureStreak += 1;
      return { sent, rejected, backedOff: true };
    }
    return { sent, rejected, backedOff: false };
  }
}
