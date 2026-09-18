/** Local ATS preferences; no setting here grants execution or proves connectivity. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SETTINGS_SCHEMA = 'aether.ats.settings/1';
export const PERMISSION_MODES = Object.freeze(['plan', 'skip', 'danger']);
const APPROVAL_MODES = ['paper', 'approve', 'auto'];
const PROVIDERS = ['none', 'polygon', 'yfinance', 'custom'];
const MAX_BYTES = 64 * 1024;

function object(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name} contains an unsupported field.`);
  }
  return value;
}

function choice(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} is unsupported.`);
  return value;
}

export function cyclePermissionMode(mode) {
  const index = PERMISSION_MODES.indexOf(mode);
  if (index < 0) throw new Error('Unknown ATS UI permission mode.');
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length];
}

export function validateDataEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Data endpoint must be a bounded URL.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Data endpoint is not a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url.hostname || url.username || url.password || url.search || url.hash
      || !(['https:', 'wss:'].includes(url.protocol) || (local && ['http:', 'ws:'].includes(url.protocol)))) {
    throw new Error('Data endpoint requires HTTPS/WSS or local loopback, without credentials, query or fragment.');
  }
  return url.toString();
}

export function defaultSettings() {
  return {
    schema_version: SETTINGS_SCHEMA,
    permission_mode: 'plan',
    requested_execution_mode: 'paper',
    order_execution_mode: 'paper',
    execute_live: false,
    data_stream: {
      provider: 'none', endpoint: null, api_key_env: null,
      symbols: [], timeframe: 'M5', poll_interval_ms: 5000,
    },
  };
}

export function validateSettings(value) {
  const defaults = defaultSettings();
  object(value, 'Settings', Object.keys(defaults));
  const result = { ...defaults, ...value };
  if (result.schema_version !== SETTINGS_SCHEMA) throw new Error('Unsupported ATS settings schema.');
  choice(result.permission_mode, PERMISSION_MODES, 'ATS UI permission mode');
  choice(result.requested_execution_mode, APPROVAL_MODES, 'Requested native approval mode');
  // UI labels and the native approval request are independent preferences.
  // Neither is a substitute for the existing runtime's live execution arms.
  if (result.order_execution_mode !== 'paper' || result.execute_live !== false) {
    throw new Error('Local agent setup cannot arm live order execution.');
  }
  const raw = value.data_stream ?? {};
  object(raw, 'Data stream', Object.keys(defaults.data_stream));
  const data = { ...defaults.data_stream, ...raw };
  choice(data.provider, PROVIDERS, 'Data provider');
  if (data.endpoint !== null) data.endpoint = validateDataEndpoint(data.endpoint);
  if (data.api_key_env !== null && (typeof data.api_key_env !== 'string'
      || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(data.api_key_env))) {
    throw new Error('Data credentials must reference an environment variable name.');
  }
  if (!Array.isArray(data.symbols) || data.symbols.length > 100
      || data.symbols.some(symbol => typeof symbol !== 'string' || !/^[A-Z0-9][A-Z0-9.^:=_/-]{0,39}$/.test(symbol))) {
    throw new Error('Data symbols must be up to 100 bounded uppercase ticker names.');
  }
  data.symbols = [...new Set(data.symbols)];
  if (typeof data.timeframe !== 'string' || !/^(?:M(?:1|2|3|5|10|15|30)|H(?:1|2|4|6|8|12)|D1|W1)$/.test(data.timeframe)) {
    throw new Error('Unsupported data timeframe.');
  }
  if (!Number.isSafeInteger(data.poll_interval_ms) || data.poll_interval_ms < 1000 || data.poll_interval_ms > 300_000) {
    throw new Error('Data polling interval must be 1–300 seconds.');
  }
  if (data.provider === 'none' && (data.endpoint !== null || data.api_key_env !== null || data.symbols.length)) {
    throw new Error('An unconfigured data provider cannot include endpoint, credentials or symbols.');
  }
  if (data.provider === 'yfinance' && (data.endpoint !== null || data.api_key_env !== null)) {
    throw new Error('The native yfinance provider has no endpoint or credential setting.');
  }
  if (data.provider === 'polygon') {
    data.endpoint ??= 'https://api.polygon.io/';
    if (!data.api_key_env) throw new Error('Polygon requires an environment variable reference for its API key.');
    if (new URL(data.endpoint).protocol !== 'https:') throw new Error('Polygon requires an HTTPS endpoint.');
  }
  if (data.provider === 'custom' && !data.endpoint) throw new Error('A custom data adapter requires an endpoint.');
  result.data_stream = data;
  return result;
}

export function dataStreamStatus(settings) {
  const { data_stream: data } = validateSettings(settings);
  return {
    provider: data.provider,
    state: data.provider === 'none' ? 'unconfigured' : 'unverified',
    connected: false,
    observed_at: null,
    reason: data.provider === 'none' ? 'No data provider selected.' : 'A live provider probe is required.',
  };
}

/** A supplied runtime adapter must produce fresh sample evidence; settings alone cannot. */
export async function probeDataStream(settings, probe, { now = Date.now, timeoutMs = 3000, maxAgeMs = 60_000 } = {}) {
  const normalized = validateSettings(settings);
  const initial = dataStreamStatus(normalized);
  if (initial.state === 'unconfigured' || typeof probe !== 'function') return initial;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300_000) {
    throw new Error('Data probe timeout/freshness is out of bounds.');
  }
  const controller = new AbortController();
  let timer;
  try {
    const evidence = await Promise.race([
      Promise.resolve().then(() => probe(normalized.data_stream, { signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('probe timeout')); }, timeoutMs);
      }),
    ]);
    const captured = typeof evidence?.observed_at === 'string' ? Date.parse(evidence.observed_at) : NaN;
    const age = now() - captured;
    if (evidence?.ok !== true || !Number.isSafeInteger(evidence.sample_count) || evidence.sample_count < 1
        || !Number.isFinite(captured) || age < 0 || age > maxAgeMs) {
      return { ...initial, state: 'unavailable', reason: 'The probe returned no fresh data sample evidence.' };
    }
    return { ...initial, state: 'connected', connected: true, observed_at: evidence.observed_at, reason: null };
  } catch {
    // Adapter errors may contain provider URLs/credentials. Do not return them
    // into UI or persist them in an agent profile.
    return { ...initial, state: 'unavailable', reason: 'The data provider probe failed or timed out.' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function settingsPath(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) {
    throw new Error('ATS settings require an absolute local file path.');
  }
  return resolve(file);
}

async function refuseSymlinkAncestors(file) {
  const ancestors = [];
  let path = dirname(file);
  while (true) {
    ancestors.push(path);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  for (const ancestor of ancestors.reverse()) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error('ATS settings path cannot contain a symbolic link.');
      if (!info.isDirectory()) throw new Error('ATS settings ancestor must be a directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function safeExistingFile(file, { loading = false } = {}) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('ATS settings must be a regular, unlinked file.');
    if (stat.size > MAX_BYTES) throw new Error('ATS settings file exceeds 64 KiB.');
    if (loading && process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw new Error('ATS settings file must be private to its owner (0600).');
    }
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadSettings(file) {
  file = settingsPath(file);
  await refuseSymlinkAncestors(file);
  if (!(await safeExistingFile(file, { loading: true }))) return defaultSettings();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
        || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('ATS settings file is not a bounded private regular file.');
    }
    // Fixed buffer bounds reads even if a concurrent writer expands the file.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new Error('ATS settings file exceeds 64 KiB.');
    let parsed;
    try { parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('ATS settings file is not valid JSON.'); }
    return validateSettings(parsed);
  } finally { await handle.close(); }
}

export async function saveSettings(file, settings) {
  file = settingsPath(file);
  const normalized = validateSettings(settings);
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('ATS settings file exceeds 64 KiB.');
  const parent = dirname(file);
  await refuseSymlinkAncestors(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await refuseSymlinkAncestors(file);
  await safeExistingFile(file);
  const temporary = join(parent, `.${basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
