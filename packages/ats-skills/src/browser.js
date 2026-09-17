import { inflateSync } from "node:zlib";

/** The ATS browser observer owns one session and never grants trading authority. */
const isLoopback = host => ["127.0.0.1", "[::1]"].includes(host);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeText = value => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
const isText = (value, max) => typeof value === "string" && value.length <= max;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) ? Date.parse(value) : NaN;
const closed = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function freeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function validateBrowserUrl(value, base) {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("Browser connection URL is invalid.");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) {
    throw new Error("Browser connection requires HTTPS or numeric local loopback without URL credentials, query, or fragment.");
  }
  if (base && url.hostname !== new URL(base).hostname) throw new Error("Browser viewer must use the configured browser host.");
  return url.toString();
}

function viewerUrl(value) {
  // Native v0.x noVNC is unauthenticated and must stay on the browser host.
  // Do not accept remote viewers or credential-bearing noVNC query arguments.
  const url = new URL(validateBrowserUrl(value));
  if (!isLoopback(url.hostname) || !url.port) throw new Error("Browser viewer must use numeric local loopback with an explicit port.");
  return url.toString();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, number) => {
  let crc = number;
  for (let i = 0; i < 8; i++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

/** Decode only the bounded, noninterlaced 8-bit PNG shape emitted by Chromium. */
function pngEvidence(encoded, viewport) {
  if (!isText(encoded, 14_000_000) || encoded.length < 92 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid browser PNG.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Invalid browser PNG.");
  let offset = 8, header, ended = false, sawData = false, dataEnded = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("Invalid browser PNG.");
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) throw new Error("Invalid browser PNG.");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error("Invalid browser PNG.");
    const data = bytes.subarray(offset + 8, end - 4);
    if (!header) {
      if (type !== "IHDR" || size !== 13) throw new Error("Invalid browser PNG.");
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), channels: ({ 0: 1, 2: 3, 4: 2, 6: 4 })[data[9]] };
      if (!header.channels || data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0
          || header.width !== Math.round(viewport.width * viewport.device_scale_factor)
          || header.height !== Math.round(viewport.height * viewport.device_scale_factor)) throw new Error("Invalid browser PNG dimensions or encoding.");
    } else if (type === "IHDR") throw new Error("Invalid browser PNG.");
    else if (type === "IDAT") {
      if (dataEnded) throw new Error("Invalid browser PNG.");
      sawData = true; compressed.push(data);
    } else if (type === "IEND") {
      if (size !== 0 || !sawData || end !== bytes.length) throw new Error("Invalid browser PNG.");
      ended = true;
    } else {
      if (sawData) dataEnded = true;
      if (type[0] === type[0].toUpperCase() && type !== "PLTE") throw new Error("Unsupported browser PNG chunk.");
    }
    offset = end;
  }
  if (!header || !ended) throw new Error("Invalid browser PNG.");
  const rowBytes = header.width * header.channels + 1, expected = rowBytes * header.height;
  // A screenshot is evidence, never permission to allocate unbounded decoded data.
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 128 * 1024 * 1024) throw new Error("Browser PNG exceeds the decoded image limit.");
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (inflated.length !== expected) throw new Error("Invalid browser PNG raster.");
  for (let row = 0; row < header.height; row++) if (inflated[row * rowBytes] > 4) throw new Error("Invalid browser PNG filter.");
  return { screenshotBytes: bytes.length, width: header.width, height: header.height };
}

function observationEvidence(result) {
  if (!closed(result, ["api_version", "status", "session_id", "url", "title", "readable_text", "accessibility", "screenshot_base64", "viewport", "sequence", "captured_at", "vision_steps_used", "vision_steps_remaining"])
      || !isText(result.url, 2048) || !result.url || !isText(result.title, 512) || !isText(result.readable_text, 65_536)
      || !closed(result.viewport, ["width", "height", "device_scale_factor"])
      || !integer(result.viewport.width, 1, 4096) || !integer(result.viewport.height, 1, 4096)
      || !Number.isFinite(result.viewport.device_scale_factor) || result.viewport.device_scale_factor < 0.25 || result.viewport.device_scale_factor > 4
      || !closed(result.accessibility, ["nodes", "truncated"]) || !Array.isArray(result.accessibility.nodes)
      || result.accessibility.nodes.length > 500 || typeof result.accessibility.truncated !== "boolean") throw new Error("Invalid browser visual observation.");
  for (const node of result.accessibility.nodes) {
    if (!closed(node, ["role", "name", "value", "focused", "disabled"]) || !isText(node.role, 128) || !node.role
        || !isText(node.name, 1024) || !isText(node.value, 4096) || typeof node.focused !== "boolean" || typeof node.disabled !== "boolean") throw new Error("Invalid browser accessibility observation.");
  }
  const page = new URL(result.url);
  if (page.username || page.password || !["https:", "http:"].includes(page.protocol) && result.url !== "about:blank") throw new Error("Invalid browser page URL.");
  return freeze({ sequence: result.sequence, capturedAt: result.captured_at, origin: page.origin === "null" ? "about:blank" : page.origin,
    title: safeText(result.title), ...pngEvidence(result.screenshot_base64, result.viewport) });
}

export class AtsBrowserObserver {
  #session = null;
  #opening = null;
  #closing = null;
  #ending = null;
  #closed = false;
  #lifetime = new AbortController();
  #pending = null;
  #lastSequence = -1;
  #lastCaptured = -1;
  #latest = null;
  #observation = null;
  #expires = null;
  #externalAbort = null;
  #externalSignal = null;

  constructor({ browser, baseUrl, maxVisionSteps = 100, maxAgeMs = 15_000, now = Date.now }) {
    if (!integer(maxVisionSteps, 1, 100)) throw new Error("Browser vision budget must be an integer from 1 to 100.");
    if (!integer(maxAgeMs, 1000, 300_000)) throw new Error("Browser observation freshness must be 1–300 seconds.");
    this.browser = browser;
    this.baseUrl = validateBrowserUrl(baseUrl);
    this.maxVisionSteps = maxVisionSteps;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.state = "disconnected";
    this.viewUrl = null;
    this.viewerState = "unavailable";
  }

  get latest() { return this.#latest; }

  async #endSession() {
    if (this.#ending) return this.#ending;
    if (!this.#session) return;
    const session = this.#session;
    this.#ending = Promise.resolve().then(() => session.end()).then(() => { if (this.#session === session) this.#session = null; });
    try { await this.#ending; } finally { this.#ending = null; }
  }

  open({ signal } = {}) {
    if (this.#closed || this.#opening || this.#session) return Promise.reject(new Error("This browser observer has already been opened."));
    if (signal?.aborted) return Promise.reject(new Error("Browser opening cancelled."));
    this.#externalSignal = signal;
    this.#externalAbort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener("abort", this.#externalAbort, { once: true });
    this.state = "connecting";
    this.#opening = (async () => {
      try {
        const health = await this.browser.health({ signal: this.#lifetime.signal });
        if (health?.api_version !== "v1" || health.status !== "ok" || health.browser_ready !== true || health.session_active !== false || health.slots_available !== 1) throw new Error("The browser runtime is not ready or its session is already in use.");
        if (this.#closed) throw new Error("Browser opening cancelled.");
        // Do not abort creation after admission: receive the identity and then
        // release that exact session if cancelled. The transport bounds this wait.
        const session = await this.browser.createSession({ maxVisionSteps: this.maxVisionSteps });
        this.#session = session;
        if (this.#closed) throw new Error("Browser opening cancelled.");
        const created = utc(session.createdAt), expires = utc(session.expiresAt);
        if (!UUID.test(session.id) || !integer(session.maxVisionSteps, 1, this.maxVisionSteps)
            || !Number.isFinite(created) || !Number.isFinite(expires) || created > this.now() + 5000 || expires <= created || expires <= this.now()) throw new Error("Browser session answered with an invalid identity, expiry, or vision budget.");
        const viewer = viewerUrl(session.viewUrl);
        this.#expires = expires;
        if (!isLoopback(new URL(this.baseUrl).hostname)) {
          this.viewUrl = null; this.viewerState = "remote_loopback";
        } else {
          this.viewUrl = viewer; this.viewerState = "available";
        }
        this.state = "connected";
        return { sessionId: session.id, viewUrl: this.viewUrl, state: this.state };
      } catch (error) {
        try { await this.#endSession(); }
        catch { this.state = "cleanup_required"; throw new Error("Browser setup failed and its session could not be closed.", { cause: error }); }
        this.state = this.#closed ? "closed" : "unavailable";
        this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
        throw error;
      } finally { this.#opening = null; }
    })();
    return this.#opening;
  }

  status() {
    const ageMs = this.#latest ? Math.max(0, this.now() - this.#lastCaptured) : null;
    const active = ["connected", "observing", "stale"].includes(this.state);
    const expired = active && this.#expires !== null && this.now() >= this.#expires;
    const stale = this.state === "observing" && ageMs > this.maxAgeMs;
    return { state: expired ? "expired" : stale ? "stale" : this.state, sessionId: this.#session?.id ?? null,
      viewUrl: this.viewUrl, viewerState: this.viewerState, ageMs, expiresAt: this.#expires === null ? null : new Date(this.#expires).toISOString(),
      visionStepsRemaining: this.state === "unavailable" || this.state === "cleanup_required" ? null : this.#latest?.vision_steps_remaining ?? this.#session?.maxVisionSteps ?? null, observation: this.#observation };
  }

  async snapshot({ signal } = {}) {
    if (signal?.aborted) throw new Error("Browser observation cancelled.");
    if (this.#pending) {
      const result = await this.#pending;
      if (signal?.aborted) throw new Error("Browser observation cancelled.");
      return result;
    }
    if (this.#closed || !this.#session || !["connected", "observing", "stale"].includes(this.status().state)) throw new Error("Browser observation is unavailable. Open a new session explicitly.");
    const session = this.#session;
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    this.#pending = (async () => {
      try {
        const result = await session.snapshot({ signal: combined });
        if (this.#closed || session !== this.#session) throw new Error("Browser observation arrived after the session closed.");
        if (combined.aborted) throw new Error("Browser observation cancelled.");
        const captured = utc(result?.captured_at);
        const valid = result?.api_version === "v1" && result.status === "snapshot" && result.session_id === session.id
          && integer(result.sequence, 1, Number.MAX_SAFE_INTEGER) && result.sequence > this.#lastSequence
          && Number.isFinite(captured) && captured >= this.#lastCaptured && captured <= this.now() + 5000
          && this.now() - captured <= this.maxAgeMs && captured < this.#expires && this.now() < this.#expires
          && integer(result.vision_steps_used, 1, 100) && integer(result.vision_steps_remaining, 0, 99)
          && result.vision_steps_used + result.vision_steps_remaining === session.maxVisionSteps
          && (!this.#latest || result.vision_steps_used > this.#latest.vision_steps_used);
        if (!valid) throw new Error("Browser returned stale or invalid observation evidence.");
        const observation = observationEvidence(result);
        this.#lastSequence = result.sequence;
        this.#lastCaptured = captured;
        this.#latest = freeze(structuredClone(result));
        this.#observation = observation;
        this.state = result.vision_steps_remaining === 0 ? "budget_exhausted" : "observing";
        return this.#latest;
      } catch (error) {
        if (!this.#closed) {
          this.state = error?.code === "VISION_BUDGET_EXHAUSTED" ? "budget_exhausted" : error?.code === "SESSION_EXPIRED" ? "expired" : "unavailable";
          this.#latest = null; this.#observation = null;
        }
        throw error;
      } finally { this.#pending = null; }
    })();
    return this.#pending;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#lifetime.abort();
    this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
    this.state = "closed";
    this.#latest = null; this.#observation = null;
    this.viewUrl = null; this.viewerState = "unavailable";
    this.#closing = (async () => {
      if (this.#opening) { try { await this.#opening; } catch {} }
      try { await this.#endSession(); this.state = "closed"; }
      catch (error) { this.state = "cleanup_required"; throw error; }
      finally { this.#closing = null; }
    })();
    return this.#closing;
  }
}

/** No timers survive the consumer: iteration sleeps only between requested observations. */
export async function* observeBrowser(observer, { intervalMs = 5000, signal } = {}) {
  if (!integer(intervalMs, 1000, 60_000)) throw new Error("Browser observation interval must be 1–60 seconds.");
  while (!signal?.aborted) {
    let capture;
    try { capture = await observer.snapshot({ signal }); }
    catch (error) { if (signal?.aborted) return; throw error; }
    if (signal?.aborted) return;
    yield capture;
    if (observer.status().state === "budget_exhausted") return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, intervalMs);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
