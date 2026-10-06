import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BYTES = 5_000_000;
const WORKSPACE_LINKS = new Map([
  ['node_modules/aether-ats-skills', 'packages/ats-skills'],
  ['node_modules/aether-rc-qr', 'packages/qrcode-terminal'],
]);

function singleReport(raw) {
  assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024, 'pack metadata is too large');
  const reports = JSON.parse(raw);
  assert.ok(Array.isArray(reports) && reports.length === 1, 'one npm pack result is required');
  return reports[0];
}

function npmPack(root, args) {
  const cli = process.env.npm_execpath;
  return execFileSync(cli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
    cli ? [cli, 'pack', '--json', '--ignore-scripts', ...args] : ['pack', '--json', '--ignore-scripts', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024, shell: !cli && process.platform === 'win32' });
}

// Only the two reviewed local workspace links may be followed. Every other
// component, including the final file, must be an ordinary directory/file.
function publicSource(root, path) {
  const parts = path.split('/');
  let expected = root;
  for (let i = 0; i < parts.length; i++) {
    expected = join(expected, parts[i]);
    const info = lstatSync(expected);
    if (info.isSymbolicLink()) {
      const target = WORKSPACE_LINKS.get(parts.slice(0, i + 1).join('/'));
      assert.ok(target && i < parts.length - 1, 'unexpected package symlink');
      expected = join(root, target);
      assert.equal(realpathSync(join(root, ...parts.slice(0, i + 1))), expected, 'workspace link leaves reviewed source');
      assert.equal(realpathSync(expected), expected, 'workspace target must not contain symlinks');
      assert.ok(lstatSync(expected).isDirectory());
    } else {
      assert.ok(i === parts.length - 1 ? info.isFile() : info.isDirectory(), 'invalid package file type');
    }
  }
  assert.equal(realpathSync(join(root, path)), expected, 'package source changed');
  return expected;
}

export function stagePackInputs(root, staging, report) {
  root = realpathSync(root);
  assert.ok(lstatSync(staging).isDirectory() && !lstatSync(staging).isSymbolicLink());
  assert.ok(Array.isArray(report.files) && report.files.length > 0 && report.files.length <= 2000, 'invalid package file list');
  assert.equal(report.entryCount, report.files.length, 'package entry count disagrees');
  const seen = new Set();
  let total = 0;
  // Validate the complete inventory before copying any bytes.
  const inputs = report.files.map(file => {
    assert.ok(typeof file.path === 'string' && file.path.length <= 1024
      && file.path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), 'unsafe package path');
    assert.ok(!file.path.split('/').some(part => /^\.(?:npmrc|git|env(?:\..*)?)$/.test(part)), 'private package path');
    assert.ok(!seen.has(file.path), 'duplicate package path');
    seen.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_BYTES, 'invalid package file size');
    assert.ok(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, 'invalid package file mode');
    total += file.size;
    assert.ok(total <= MAX_BYTES, 'package is too large');
    const source = publicSource(root, file.path);
    assert.equal(lstatSync(source).size, file.size, 'package source size changed');
    return { source, path: file.path, size: file.size, mode: file.mode & 0o111 ? 0o755 : 0o644 };
  });
  assert.equal(total, report.unpackedSize, 'package byte count disagrees');
  for (const input of inputs) {
    const bytes = readFileSync(input.source);
    assert.equal(bytes.length, input.size, 'package source size changed');
    const destination = join(staging, input.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(destination, input.mode);
  }
  return inputs;
}

export async function packReproducibly(root) {
  root = realpathSync(root);
  const manifestPath = join(root, 'package.json');
  const info = lstatSync(manifestPath);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024, 'invalid package manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { validateManifest, validatePack } = await import(pathToFileURL(join(root, 'dist/scripts/verify-production.js')).href);
  const before = singleReport(npmPack(root, ['--dry-run']));
  assert.deepEqual([...validateManifest(manifest, process.env.RELEASE_TAG), ...validatePack(before, manifest)], [], 'production package policy failed');
  assert.equal(before.name, manifest.name);
  assert.equal(before.version, manifest.version);
  const filename = `${manifest.name}-${manifest.version}.tgz`;
  assert.equal(before.filename, filename);
  const tempRoot = realpathSync(tmpdir());
  const temp = mkdtempSync(join(tempRoot, 'aether-public-pack-'));
  chmodSync(temp, 0o700);
  try {
    const staging = join(temp, 'source');
    const output = join(temp, 'output');
    mkdirSync(staging, { mode: 0o700 });
    mkdirSync(output, { mode: 0o700 });
    const inputs = stagePackInputs(root, staging, before);
    const packed = singleReport(npmPack(staging, ['--pack-destination', output]));
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    assert.equal(packed.filename, filename);
    assert.deepEqual(validatePack(packed, manifest), []);
    assert.equal(packed.unpackedSize, before.unpackedSize);
    assert.equal(packed.entryCount, before.entryCount);
    const inventory = files => files.map(file => ({ path: file.path, size: file.size, mode: file.mode })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(inventory(packed.files), inventory(inputs), 'staged package inventory changed');
    const tarball = join(output, filename);
    const packedInfo = lstatSync(tarball);
    assert.ok(packedInfo.isFile() && packedInfo.size > 0 && packedInfo.size <= 10 * 1024 * 1024, 'invalid staged tarball');
    const bytes = readFileSync(tarball);
    assert.equal(bytes.length, packed.size);
    writeFileSync(join(root, filename), bytes, { flag: 'wx', mode: 0o600 });
    return packed;
  } finally {
    assert.equal(dirname(temp), tempRoot);
    assert.ok(lstatSync(temp).isDirectory() && !lstatSync(temp).isSymbolicLink());
    rmSync(temp, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2);
  console.log(JSON.stringify([await packReproducibly(process.cwd())], null, 2));
}
