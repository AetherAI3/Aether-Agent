import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../strategies", import.meta.url));
const ID = /^[a-z0-9_]+\/[a-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_STRATEGIES = 100;
export const NANO_LIBRARY_REVISION = "76c91e4b926c0aa8416cbb6b8724031d8141a8d9";
export const STARTER_STRATEGIES = Object.freeze([
  "momentum/rsi_oversold_reversal",
  "mean_reversion/zscore_reversion",
  "trend/donchian_breakout",
  "volatility/bb_squeeze_breakout",
  "risk/stale_data_halt",
  "risk/daily_loss_limit",
]);

let verified;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function plain(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} is invalid.`);
  return value;
}

async function verifyLibrary() {
  if (verified) return verified;
  verified = (async () => {
    const manifestBytes = await readFile(join(ROOT, "manifest.json"));
    const catalogBytes = await readFile(join(ROOT, "catalog.json"));
    const manifest = plain(JSON.parse(manifestBytes), "Nano strategy manifest");
    const catalog = plain(JSON.parse(catalogBytes), "Nano strategy catalog");
    if (manifest.schema_version !== "aether.ats.nano-library/1" || manifest.repository !== "AetherAI3/Nano"
        || manifest.revision !== NANO_LIBRARY_REVISION || manifest.nano_version !== "1.0.12"
        || manifest.catalog_schema !== 1 || !Number.isSafeInteger(manifest.strategy_count)
        || manifest.strategy_count < 1 || manifest.strategy_count > MAX_STRATEGIES
        || manifest.strategy_count !== catalog.strategyCount || !Array.isArray(catalog.strategies)
        || catalog.strategies.length !== manifest.strategy_count || catalog.type !== "NanoStrategyCatalog"
        || catalog.schemaVersion !== 1) throw new Error("Bundled Nano strategy manifest is incompatible.");
    const hashes = plain(manifest.files, "Nano strategy file inventory");
    if (hashes["catalog.json"] !== sha256(catalogBytes)) throw new Error("Bundled Nano strategy catalog digest does not match its manifest.");
    const strategies = new Map();
    for (const raw of catalog.strategies) {
      const item = plain(raw, "Nano strategy metadata");
      if (typeof item.id !== "string" || !ID.test(item.id) || item.id !== `${item.category}/${item.slug}`
          || typeof item.name !== "string" || typeof item.irMaturity !== "string"
          || !Array.isArray(item.requiredHostSignals) || strategies.has(item.id)) throw new Error("Bundled Nano strategy metadata is invalid.");
      const source = `library/${item.id}.nano`;
      const ir = `library/${item.id}_ir.json`;
      if (!SHA256.test(String(hashes[source] ?? "")) || !SHA256.test(String(hashes[ir] ?? ""))) {
        throw new Error(`Bundled Nano strategy ${item.id} is missing paired digest custody.`);
      }
      strategies.set(item.id, Object.freeze({ ...item, source_asset: source, ir_asset: ir }));
    }
    for (const id of STARTER_STRATEGIES) if (!strategies.has(id)) throw new Error("Bundled Nano starter strategy is missing.");
    return Object.freeze({ manifest, strategies });
  })();
  return verified;
}

async function refuseLinks(path) {
  let current = resolve(path);
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Strategy installation cannot follow a symbolic link.");
      if (current === path && !info.isDirectory()) throw new Error("Strategy destination must be a directory.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function listBundledStrategies({ category } = {}) {
  const { manifest, strategies } = await verifyLibrary();
  if (category !== undefined && (typeof category !== "string" || !/^[a-z0-9_]+$/.test(category))) throw new Error("Invalid Nano strategy category.");
  return {
    schema_version: "aether.ats.nano-library-list/1",
    repository: manifest.repository,
    revision: manifest.revision,
    nano_version: manifest.nano_version,
    strategies: [...strategies.values()].filter(item => !category || item.category === category).map(item => ({
      id: item.id, name: item.name, category: item.category, ir_maturity: item.irMaturity,
      required_host_signals: [...item.requiredHostSignals], starter: STARTER_STRATEGIES.includes(item.id),
    })),
    performance_claimed: false,
    execution_enabled: false,
  };
}

/** Copy reviewed source only. Canonical IR remains package evidence, not an execution grant. */
export async function installBundledStrategies({ directory, selection = "starter", ids } = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) {
    throw new Error("Choose a canonical absolute strategy directory.");
  }
  const { manifest, strategies } = await verifyLibrary();
  let selected;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_STRATEGIES || ids.some(id => typeof id !== "string" || !ID.test(id))) {
      throw new Error("Choose 1–100 exact bundled strategy IDs.");
    }
    selected = [...new Set(ids)];
  } else if (selection === "starter") selected = [...STARTER_STRATEGIES];
  else if (selection === "all") selected = [...strategies.keys()];
  else throw new Error("Strategy selection must be starter, all, or exact IDs.");
  for (const id of selected) if (!strategies.has(id)) throw new Error(`Unknown bundled strategy: ${id}`);
  await refuseLinks(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await refuseLinks(directory);
  const targets = selected.map(id => ({ id, target: join(directory, `${id.replace("/", "--")}.nano`) }));
  for (const { target } of targets) {
    try { await access(target, constants.F_OK); throw new Error(`Strategy already exists: ${target}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const created = [];
  const staged = [];
  try {
    for (const { id, target } of targets) {
      const item = strategies.get(id);
      const content = await readFile(join(ROOT, item.source_asset));
      if (sha256(content) !== manifest.files[item.source_asset]) throw new Error(`Bundled Nano strategy digest failed: ${id}`);
      const temporary = join(directory, `.${id.replace("/", "--")}.${randomUUID()}.tmp`);
      staged.push(temporary);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await link(temporary, target);
      created.push(target);
      await unlink(temporary);
      staged.pop();
    }
  } catch (error) {
    await Promise.allSettled([...staged, ...created].map(path => unlink(path)));
    throw error;
  }
  return {
    schema_version: "aether.ats.nano-library-install/1",
    repository: manifest.repository, revision: manifest.revision, nano_version: manifest.nano_version,
    directory, installed: targets.map(({ id, target }) => ({ id, file: target })),
    execution_enabled: false, permission_granted: false,
  };
}
