import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SECRET = /(?:token|secret|password|authorization|cookie|api.?key|credential)/i;
const queues = new Map();

function pathOf(file) {
  if (typeof file !== "string" || !isAbsolute(file) || resolve(file) !== file || file.includes("\0")) throw new Error("ATS journal requires a canonical absolute path.");
  return file;
}

async function refuseLinks(file) {
  let current = file;
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("ATS journal cannot follow a symbolic link."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

function text(value, name, limit) {
  if (typeof value !== "string" || !value.length || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function safeDetails(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 24) throw new Error("ATS journal details must be a small object.");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ID.test(key) || SECRET.test(key)) throw new Error("ATS journal details cannot contain credentials or unsupported keys.");
    if (typeof item === "string") result[key] = text(item, "ATS journal detail", 1024);
    else if (typeof item === "number" && Number.isFinite(item) || typeof item === "boolean" || item === null) result[key] = item;
    else throw new Error("ATS journal detail values must be bounded scalars.");
  }
  return result;
}

function validateRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) || row.schema_version !== "aether.ats.journal/1"
      || typeof row.event_id !== "string" || !/^[0-9a-f-]{36}$/.test(row.event_id)
      || !ID.test(row.agent_id) || !ID.test(row.type) || !["info", "warning", "error"].includes(row.level)
      || !Number.isFinite(Date.parse(row.recorded_at))) throw new Error("ATS journal contains an invalid record.");
  text(row.summary, "ATS journal summary", 500);
  safeDetails(row.details);
  return row;
}

export async function appendJournalEvent(file, event, { now = () => new Date() } = {}) {
  file = pathOf(file);
  const previous = queues.get(file) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await refuseLinks(file);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const row = validateRow({
      schema_version: "aether.ats.journal/1", event_id: randomUUID(),
      recorded_at: now().toISOString(), agent_id: text(event?.agentId, "ATS journal agent ID", 128),
      type: text(event?.type, "ATS journal event type", 128), level: event?.level ?? "info",
      summary: text(event?.summary, "ATS journal summary", 500), details: safeDetails(event?.details),
    });
    const line = JSON.stringify(row) + "\n";
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("ATS journal event exceeds 16 KiB.");
    const handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(line) > MAX_FILE_BYTES) throw new Error("ATS journal reached its 4 MiB limit; export and rotate it explicitly.");
      await handle.writeFile(line); await handle.sync();
    } finally { await handle.close(); }
    return row;
  });
  queues.set(file, task);
  try { return await task; } finally { if (queues.get(file) === task) queues.delete(file); }
}

export async function readJournal(file, { limit = 100 } = {}) {
  file = pathOf(file);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("ATS journal limit must be 1–500.");
  await refuseLinks(file);
  let content;
  try { content = await readFile(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (content.length > MAX_FILE_BYTES) throw new Error("ATS journal exceeds its 4 MiB read limit.");
  const lines = content.toString("utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).map((line, index) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`ATS journal line ${lines.length - Math.min(lines.length, limit) + index + 1} exceeds its limit.`);
    try { return validateRow(JSON.parse(line)); } catch { throw new Error(`ATS journal line ${lines.length - Math.min(lines.length, limit) + index + 1} is invalid.`); }
  });
}

export function formatJournal(rows, { json = false } = {}) {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error("ATS journal dump is invalid.");
  const checked = rows.map(validateRow);
  if (json) return JSON.stringify({ schema_version: "aether.ats.journal-dump/1", entries: checked }, null, 2) + "\n";
  if (!checked.length) return "ATS journal · no local events\n";
  return `ATS journal · ${checked.length} local event${checked.length === 1 ? "" : "s"}\n` + checked.map(row => {
    const details = Object.keys(row.details).length ? ` · ${JSON.stringify(row.details)}` : "";
    return `${row.recorded_at} · ${row.level} · ${row.type} · ${row.summary}${details}`;
  }).join("\n") + "\n";
}
