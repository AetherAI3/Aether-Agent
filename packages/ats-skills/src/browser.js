/** The ATS browser observer owns one session and never grants trading authority. */
const isLoopback = (host) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
export function validateBrowserUrl(value, base) {
  const url = new URL(value);
  const loopback = isLoopback(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Browser connection requires HTTPS or local loopback without URL credentials.");
  }
  if (base && url.hostname !== new URL(base).hostname && !(loopback && isLoopback(new URL(base).hostname))) {
    throw new Error("Browser viewer must use the configured browser host.");
  }
  return url.toString();
}

export class AtsBrowserObserver {
  #session = null;
  #opening = false;
  #closed = false;
  #pending = null;
  #lastSequence = -1;
  #lastCaptured = -1;

  constructor({ browser, baseUrl, maxVisionSteps = 100, maxAgeMs = 15_000, now = Date.now }) {
    if (!Number.isInteger(maxVisionSteps) || maxVisionSteps < 1 || maxVisionSteps > 100) {
      throw new Error("Browser vision budget must be an integer from 1 to 100.");
    }
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 300_000) {
      throw new Error("Browser observation freshness must be 1–300 seconds.");
    }
    this.browser = browser;
    this.baseUrl = validateBrowserUrl(baseUrl);
    this.maxVisionSteps = maxVisionSteps;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.state = "disconnected";
    this.latest = null;
    this.viewUrl = null;
    this.viewerState = "unavailable";
  }

  async open() {
    if (this.#closed || this.#opening || this.#session) throw new Error("This browser observer has already been opened.");
    this.#opening = true;
    this.state = "connecting";
    try {
      const health = await this.browser.health();
      if (health.api_version !== "v1" || health.status !== "ok" || health.browser_ready !== true || !(health.slots_available > 0)) {
        throw new Error("The browser runtime is not ready or its session is already in use.");
      }
      if (this.#closed) throw new Error("Browser opening cancelled.");
      const session = await this.browser.createSession({ maxVisionSteps: this.maxVisionSteps });
      this.#session = session;
      if (this.#closed) {
        await session.end();
        this.#session = null;
        throw new Error("Browser opening cancelled.");
      }
      if (typeof session.id !== "string" || !session.id || !Number.isInteger(session.maxVisionSteps) || session.maxVisionSteps > this.maxVisionSteps || session.maxVisionSteps < 1) {
        throw new Error("Browser session answered with an invalid identity or vision budget.");
      }
      // The current browser server intentionally returns a loopback-only
      // viewer. With a remote API that address belongs to the server, not
      // this terminal's machine; observation works but automatic open cannot.
      const viewer = new URL(validateBrowserUrl(session.viewUrl));
      if (isLoopback(viewer.hostname) && !isLoopback(new URL(this.baseUrl).hostname)) {
        this.viewUrl = null;
        this.viewerState = "remote_loopback";
      } else {
        this.viewUrl = validateBrowserUrl(session.viewUrl, this.baseUrl);
        this.viewerState = "available";
      }
      this.state = "connected";
      return { sessionId: session.id, viewUrl: this.viewUrl, state: this.state };
    } catch (error) {
      // Creation may have succeeded before response validation failed. Release
      // that exact session; a malformed reply must not strand the browser slot.
      if (this.#session) {
        try { await this.#session.end(); this.#session = null; }
        catch { this.state = "cleanup_required"; throw new Error("Browser setup failed and its session could not be closed.", { cause: error }); }
      }
      this.state = this.#closed ? "closed" : "unavailable";
      throw error;
    } finally { this.#opening = false; }
  }

  status() {
    const ageMs = this.latest ? Math.max(0, this.now() - this.#lastCaptured) : null;
    const stale = this.state === "observing" && ageMs > this.maxAgeMs;
    return { state: stale ? "stale" : this.state, sessionId: this.#session?.id ?? null, viewUrl: this.viewUrl, viewerState: this.viewerState, ageMs,
      visionStepsRemaining: this.latest?.vision_steps_remaining ?? null };
  }

  async snapshot({ signal } = {}) {
    if (signal?.aborted) throw new Error("Browser observation cancelled.");
    if (this.#pending) return this.#pending;
    if (this.#closed || !this.#session || !["connected", "observing", "stale"].includes(this.state)) {
      throw new Error("Browser observation is unavailable. Open a new session explicitly.");
    }
    const session = this.#session;
    this.#pending = (async () => {
      try {
        const result = await session.snapshot({ signal });
        if (signal?.aborted) throw new Error("Browser observation cancelled.");
        if (this.#closed || session !== this.#session) throw new Error("Browser observation arrived after the session closed.");
        const captured = Date.parse(result.captured_at);
        const valid = result.api_version === "v1" && result.status === "snapshot" && result.session_id === session.id
          && Number.isInteger(result.sequence) && result.sequence > this.#lastSequence
          && Number.isFinite(captured) && captured >= this.#lastCaptured && captured <= this.now() + 5000
          && this.now() - captured <= this.maxAgeMs
          && Number.isInteger(result.vision_steps_used) && result.vision_steps_used >= 1
          && Number.isInteger(result.vision_steps_remaining) && result.vision_steps_remaining >= 0
          && result.vision_steps_used + result.vision_steps_remaining === session.maxVisionSteps
          && (!this.latest || result.vision_steps_used > this.latest.vision_steps_used);
        if (!valid) throw new Error("Browser returned stale or invalid observation evidence.");
        this.#lastSequence = result.sequence;
        this.#lastCaptured = captured;
        this.latest = result;
        this.state = result.vision_steps_remaining === 0 ? "budget_exhausted" : "observing";
        return result;
      } catch (error) {
        if (!this.#closed) this.state = error?.code === "VISION_BUDGET_EXHAUSTED" ? "budget_exhausted" : "unavailable";
        throw error;
      } finally { this.#pending = null; }
    })();
    return this.#pending;
  }

  async close() {
    this.#closed = true;
    this.state = "closed";
    this.latest = null;
    this.viewUrl = null;
    this.viewerState = "unavailable";
    const session = this.#session;
    if (!session) return;
    try {
      await session.end();
      this.#session = null;
    } catch (error) {
      this.state = "cleanup_required";
      throw error;
    }
  }
}

/** No timers survive the consumer: iteration sleeps only between requested observations. */
export async function* observeBrowser(observer, { intervalMs = 5000, signal } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60_000) {
    throw new Error("Browser observation interval must be 1–60 seconds.");
  }
  while (!signal?.aborted) {
    let capture;
    try { capture = await observer.snapshot({ signal }); }
    catch (error) { if (signal?.aborted) return; throw error; }
    if (signal?.aborted) return;
    yield capture;
    if (observer.status().state === "budget_exhausted") return;
    await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, intervalMs);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
