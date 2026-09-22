/** Bound the pinned SDK's entire response, including streaming bodies. */
export function createBrowserFetch({ fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxResponseBytes = 18 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Browser transport requires fetch.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Browser transport timeout must be 1–120000 milliseconds.");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024) throw new Error("Browser response limit must be 1–33554432 bytes.");
  return async (url, options = {}) => {
    const controller = new AbortController();
    let reader, response;
    const abort = () => controller.abort(new Error("Browser request cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Browser request timed out.")), timeoutMs);
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    // A raced promise remains handled even when a nonconforming injected fetch
    // ignores abort; cleanup never waits on an unbounded stream.cancel().
    const onAbort = () => rejectAborted(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    try {
      const pending = Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" }));
      pending.then(response => { if (controller.signal.aborted) void response?.body?.cancel().catch(() => {}); }, () => {});
      response = await Promise.race([pending, aborted]);
      if (response.redirected) throw new Error("Browser redirects are not allowed.");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw new Error("Browser response exceeded its size limit.");
      const chunks = []; let bytes = 0;
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) throw new Error("Browser response exceeded its size limit.");
          chunks.push(value);
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const body = Buffer.concat(chunks, bytes);
      // Return a fully buffered Response so the old SDK's later text() cannot
      // extend the network request beyond our deadline or memory bound.
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      try { reader?.releaseLock(); } catch {}
    }
  };
}
