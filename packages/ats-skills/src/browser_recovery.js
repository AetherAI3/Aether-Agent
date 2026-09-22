import { constants, closeSync, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// This is a local cleanup journal, not a browser broker or an authority grant.
// Immutable numbered records use hard-link publication as a no-overwrite CAS.
// A killed writer cannot leave half a published JSON record or delete a newer one.
const LIMIT = 1024, BYTES = 8192, TIMEOUT = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const instant = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v));
const bounded = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(v);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code: `BROWSER_RECOVERY_${code}` });
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) throw fault('IDENTITY', 'Invalid browser recovery endpoint.');
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) throw fault('IDENTITY', 'Browser recovery requires HTTPS or numeric loopback without URL credentials.');
  return u.toString().replace(/\/+$/, '');
}
function live(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function privateFile(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw fault('STORAGE', 'Browser recovery storage must be private, owned, regular, and not a symbolic link.');
  return stat;
}
function syncDirectory(path) {
  // Windows does not expose a portable directory fsync; hard-link CAS remains
  // atomic, but power-loss durability on Windows requires platform qualification.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class BrowserSessionRecovery {
  #directory; #owner; #baseUrl; #now; #instance = randomUUID(); #pending;
  constructor({ directory, owner, baseUrl, now = Date.now }) {
    if (!isAbsolute(directory || '') || directory !== resolve(directory)) throw fault('STORAGE', 'Choose a canonical absolute browser recovery directory.');
    if (!closed(owner, ['origin', 'accountSubject', 'agentId', 'deviceId']) || !['accountSubject', 'agentId', 'deviceId'].every(k => bounded(owner[k]))) throw fault('IDENTITY', 'Browser recovery requires the verified account, agent and device identity.');
    const origin = endpoint(owner.origin);
    if (new URL(origin).origin !== origin) throw fault('IDENTITY', 'Browser recovery account origin must contain no path.');
    this.#directory = directory; this.#owner = Object.freeze({ ...owner, origin }); this.#baseUrl = endpoint(baseUrl); this.#now = now;
  }
  #time(previous) { return new Date(Math.max(this.#now(), Date.parse(previous?.updatedAt || '1970-01-01T00:00:00Z'))).toISOString(); }
  #storage() {
    if (!existsSync(this.#directory)) {
      let ancestor = dirname(this.#directory);
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      if (realpathSync(ancestor) !== ancestor) throw fault('STORAGE', 'Browser recovery storage cannot traverse a symbolic link.');
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    }
    if (realpathSync(this.#directory) !== this.#directory) throw fault('STORAGE', 'Browser recovery storage cannot traverse a symbolic link.');
    privateFile(this.#directory, true);
  }
  #read() {
    this.#storage();
    const files = [], dir = opendirSync(this.#directory);
    try {
      for (let item; (item = dir.readSync());) {
        if (files.length >= LIMIT * 2) throw fault('LIMIT', 'Browser recovery storage inventory is full.');
        if (!/^\d{6}\.json$/.test(item.name) && !/^\.receipt-[0-9a-f-]{36}\.tmp$/.test(item.name)) throw fault('STORAGE', 'Browser recovery directory contains unrelated files.');
        const path = join(this.#directory, item.name), stat = privateFile(path);
        if (stat.size > BYTES) throw fault('STORAGE', 'Browser recovery record exceeds its size limit.');
        files.push(item.name);
      }
    } finally { dir.closeSync(); }
    let previous = null;
    for (const [index, file] of files.filter(name => name.endsWith('.json')).sort().entries()) {
      if (file !== `${String(index + 1).padStart(6, '0')}.json` || index > LIMIT) throw fault('STORAGE', 'Browser recovery history is incomplete.');
      const fd = openSync(join(this.#directory, file), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let record;
      try {
        if (fstatSync(fd).size > BYTES) throw fault('STORAGE', 'Browser recovery record exceeds its size limit.');
        const bytes = Buffer.alloc(BYTES + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length > BYTES) throw fault('STORAGE', 'Browser recovery record exceeds its size limit.');
        try { record = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
        catch { throw fault('STORAGE', 'Browser recovery record is not valid JSON.'); }
      } finally { closeSync(fd); }
      this.#validate(record, previous);
      previous = record;
    }
    if (previous && previous.state !== 'closed' && previous.baseUrl !== this.#baseUrl) throw fault('IDENTITY', 'Browser recovery owner or endpoint does not match. Finish cleanup on its recorded runtime first.');
    return previous;
  }
  #validate(r, previous) {
    if (!closed(r, ['schema', 'generation', 'previous', 'owner', 'baseUrl', 'state', 'holder', 'requestedAt', 'updatedAt', 'policy', 'session', 'outcome']) || r.schema !== 1 || r.generation !== (previous?.generation || 0) + 1 || r.previous !== (previous ? digest(previous) : null)) throw fault('STORAGE', 'Invalid browser recovery history.');
    if (!closed(r.owner, ['origin', 'accountSubject', 'agentId', 'deviceId']) || Object.keys(this.#owner).some(k => r.owner[k] !== this.#owner[k]) || endpoint(r.baseUrl) !== r.baseUrl) throw fault('IDENTITY', 'Browser recovery owner or endpoint does not match.');
    // Endpoint changes retain the same journal and are legal only after exact
    // cleanup. A new directory must never be used to evade a pending receipt.
    if (previous && r.baseUrl !== previous.baseUrl && !(previous.state === 'closed' && r.state === 'opening')) throw fault('IDENTITY', 'Browser recovery endpoint changed before cleanup completed.');
    if (!['opening', 'owned', 'cleanup_required', 'closed'].includes(r.state) || !instant(r.requestedAt) || !instant(r.updatedAt) || Date.parse(r.updatedAt) < Date.parse(r.requestedAt) || (previous && Date.parse(r.updatedAt) < Date.parse(previous.updatedAt))) throw fault('STORAGE', 'Invalid browser recovery state or timestamps.');
    if (r.holder !== null && (!closed(r.holder, ['pid', 'instance']) || !Number.isSafeInteger(r.holder.pid) || r.holder.pid < 1 || !UUID.test(r.holder.instance))) throw fault('STORAGE', 'Invalid browser cleanup holder.');
    if (!closed(r.policy, ['authority', 'maxVisionSteps', 'maxAgeMs']) || r.policy.authority !== 'observation_only' || !Number.isSafeInteger(r.policy.maxVisionSteps) || r.policy.maxVisionSteps < 1 || r.policy.maxVisionSteps > 100 || !Number.isSafeInteger(r.policy.maxAgeMs) || r.policy.maxAgeMs < 1000 || r.policy.maxAgeMs > 300000) throw fault('STORAGE', 'Invalid browser recovery policy.');
    if (r.session !== null && (!closed(r.session, ['id', 'createdAt', 'expiresAt', 'maxVisionSteps']) || !UUID.test(r.session.id) || !instant(r.session.createdAt) || !instant(r.session.expiresAt) || Date.parse(r.session.expiresAt) <= Date.parse(r.session.createdAt) || !Number.isSafeInteger(r.session.maxVisionSteps) || r.session.maxVisionSteps < 1 || r.session.maxVisionSteps > r.policy.maxVisionSteps)) throw fault('STORAGE', 'Invalid browser recovery session.');
    if ((r.state === 'owned' && !r.session) || (r.state === 'opening' && r.session) || ![null, 'ended', 'already_ended', 'not_found', 'idle'].includes(r.outcome) || (r.state !== 'closed' && r.outcome !== null)) throw fault('STORAGE', 'Invalid browser recovery outcome.');
    if (r.outcome === 'idle') throw fault('UNKNOWN_CREATE', 'Legacy browser create outcome is unknown. Idle health was not cleanup evidence; retain this receipt for runtime reconciliation.');
  }
  #append(previous, changes) {
    const r = { ...previous, ...changes, schema: 1, generation: (previous?.generation || 0) + 1, previous: previous ? digest(previous) : null, owner: this.#owner, baseUrl: this.#baseUrl, updatedAt: this.#time(previous) };
    this.#validate(r, previous);
    if (r.generation > LIMIT + 1 || (r.generation > LIMIT - 2 && r.state !== 'closed')) throw fault('LIMIT', 'Browser recovery history is full; retain it for explicit local maintenance.');
    if (Buffer.byteLength(JSON.stringify(r)) > BYTES) throw fault('LIMIT', 'Browser recovery record exceeds its size limit.');
    const temp = join(this.#directory, `.receipt-${randomUUID()}.tmp`), target = join(this.#directory, `${String(r.generation).padStart(6, '0')}.json`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeFileSync(fd, JSON.stringify(r)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      linkSync(temp, target);
      syncDirectory(this.#directory);
    } catch (e) {
      if (e.code === 'EEXIST') throw fault('BUSY', 'Another browser controller changed the cleanup receipt. Retry after it finishes.');
      throw e;
    } finally { unlinkSync(temp); }
    return r;
  }
  #mine(record) { return record.holder?.pid === process.pid && record.holder.instance === this.#instance; }
  #claim(record) {
    // PID is solely a conservative local concurrency guard, never authority.
    // A reused PID can block cleanup; it cannot authorize or attach a session.
    if (record.holder && !this.#mine(record) && live(record.holder.pid)) throw fault('BUSY', 'Browser cleanup is owned by a running local controller.');
    // At the storage cap, reserve terminal closure and permit only idempotent
    // cleanup of this final receipt. begin() cannot allocate another session.
    if (record.generation >= LIMIT - 4) return record;
    return this.#append(record, { state: 'cleanup_required', holder: { pid: process.pid, instance: this.#instance }, outcome: null });
  }
  async status() {
    const r = this.#read();
    return { state: !r ? 'none' : r.state === 'owned' && this.#now() >= Date.parse(r.session.expiresAt) ? 'expired' : r.state, pending: !!r && r.state !== 'closed', sessionId: r?.session?.id || null, expiresAt: r?.session?.expiresAt || null, baseUrl: this.#baseUrl, outcome: r?.outcome || null };
  }
  async begin({ maxVisionSteps, maxAgeMs }) {
    const r = this.#read();
    if (r && r.state !== 'closed') throw fault('PENDING', 'Reconcile pending browser cleanup before opening another session.');
    // Reserve enough records to record the exact identity and finish cleanup.
    if ((r?.generation || 0) > LIMIT - 8) throw fault('LIMIT', 'Browser recovery history is full; retain it for explicit local maintenance.');
    this.#append(r, { state: 'opening', holder: { pid: process.pid, instance: this.#instance }, requestedAt: this.#time(r), policy: { authority: 'observation_only', maxVisionSteps, maxAgeMs }, session: null, outcome: null });
  }
  async record(session) {
    const r = this.#read();
    if (!r || r.state !== 'opening' || !this.#mine(r)) throw fault('BUSY', 'Browser creation no longer owns its cleanup receipt.');
    const identity = { id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, maxVisionSteps: session.maxVisionSteps };
    this.#append(r, { state: 'owned', session: identity });
  }
  async markCleanupRequired() {
    const r = this.#read();
    if (!r || r.state === 'closed') return;
    if (!this.#mine(r)) throw fault('BUSY', 'Browser creation no longer owns its cleanup receipt.');
    this.#append(r, { state: 'cleanup_required', holder: null });
  }
  reconcile(browser, { signal } = {}) {
    if (this.#pending) return this.#pending;
    this.#pending = this.#reconcile(browser, signal).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #reconcile(browser, signal) {
    if (endpoint(browser?.baseUrl) !== this.#baseUrl || typeof browser._post !== 'function' || typeof browser.health !== 'function') throw fault('IDENTITY', 'Browser cleanup client must use the recorded endpoint and pinned SDK.');
    let r = this.#read();
    if (!r || r.state === 'closed') return this.status();
    if (signal?.aborted) throw fault('CANCELLED', 'Browser cleanup cancelled; receipt retained.');
    try { r = this.#claim(r); }
    catch (error) {
      // A link can publish before a directory flush fails. Release only this
      // instance's exact, inactive claim; no SDK operation has started yet.
      try {
        const latest = this.#read();
        if (latest?.state === 'cleanup_required' && this.#mine(latest)) this.#append(latest, { holder: null });
      } catch { /* Persistent storage failure retains ownership and uncertainty. */ }
      throw error;
    }
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fault('TIMEOUT', 'Browser cleanup timed out; receipt retained.')), TIMEOUT);
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    try {
      let outcome;
      if (r.session) {
        try {
          // Pinned SDK 0.2.2 has no reattach API. Invoke only its existing exact-ID
          // end route, with controller credentials retained inside the SDK.
          const result = await Promise.race([browser._post('/browser/session/end', { session_id: r.session.id }, 'controller', { signal: controller.signal, timeoutMs: TIMEOUT }), aborted]);
          if (!closed(result, ['api_version', 'status', 'session_id', 'ended_at']) || result.api_version !== 'v1' || !['ended', 'already_ended'].includes(result.status) || result.session_id !== r.session.id || !instant(result.ended_at) || Date.parse(result.ended_at) > this.#now() + 5000 || Date.parse(result.ended_at) < Date.parse(r.session.createdAt)) throw fault('RESPONSE', 'Browser cleanup returned invalid or foreign evidence.');
          outcome = result.status;
        } catch (e) {
          if (e.code === 'SESSION_NOT_FOUND' && e.httpStatus === 404) outcome = 'not_found'; else throw e;
        }
      } else {
        // Idle health cannot fence an earlier request still in transit. SDK
        // 0.2.2 has no creation idempotency/lookup or runtime fencing receipt.
        // Preserve uncertainty until that owner can provide exact evidence.
        throw fault('UNKNOWN_CREATE', 'Browser create outcome is unknown. Inspect the recorded runtime and reconcile the interrupted request; retain this receipt. An idle health response cannot prove cleanup.');
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      this.#append(r, { state: 'closed', holder: null, outcome });
      return this.status();
    } catch (e) {
      // Publish once per attempt. Failed cleanup remains independently retryable.
      try { if (r.generation < LIMIT - 3) this.#append(r, { state: 'cleanup_required', holder: null }); } catch { /* The prior immutable claim is still retained. */ }
      throw e;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
