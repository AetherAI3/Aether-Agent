#!/usr/bin/env node
// Copy only the Apache-licensed adapter distribution, never the paid ATS runtime.
import { readFile, writeFile, readdir, mkdir, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'packages', 'ats-skills');
const receiptPath = join(root, 'packages', 'ats-skills-source.json');
const digest = data => createHash('sha256').update(data).digest('hex');
const files = async (dir, prefix = '') => {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Adapter source cannot contain symbolic links.');
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), path));
    else if (entry.isFile()) result.push(path.replaceAll('\\', '/'));
    else throw new Error('Adapter source must contain regular files only.');
  }
  return result.sort();
};

if (process.argv[2] === '--check') {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.repository !== 'AetherAI3/ATSv2' || !/^[0-9a-f]{40}$/.test(receipt.revision)) throw new Error('Missing canonical ATS source revision.');
  const actual = await files(target);
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(receipt.files).sort())) throw new Error('Vendored ATS file inventory changed.');
  for (const path of actual) {
    if (digest(await readFile(join(target, path))) !== receipt.files[path]) throw new Error(`ATS source digest changed: ${path}`);
  }
  console.log(`ATS adapter verified: ${actual.length} files at ${receipt.revision}`);
} else {
  const sourceArg = process.argv[2];
  const revision = process.argv[3];
  if (!sourceArg || !/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('Usage: node scripts/sync-ats-skills.mjs <ATS package path> <canonical commit SHA> | --check');
  const source = resolve(sourceArg);
  if ((await lstat(source)).isSymbolicLink() || source === target) throw new Error('Choose the canonical ATS adapter source.');
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'aether-ats-skills' || pkg.version !== '0.1.0' || pkg.license !== 'Apache-2.0'
      || pkg.dependencies?.['aether-browser'] !== '0.2.2' || pkg.dependencies?.['aether-context'] !== '0.3.1') throw new Error('Unexpected ATS adapter contract.');
  const selected = [];
  for (const path of ['package.json', 'README.md', 'LICENSE', 'SETTINGS.md']) selected.push(path);
  for (const dir of ['src', 'python', 'bin']) selected.push(...(await files(join(source, dir))).map(path => `${dir}/${path}`));
  const contents = new Map();
  for (const path of selected.sort()) {
    const stat = await lstat(join(source, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Adapter source is not a regular file: ${path}`);
    contents.set(path, await readFile(join(source, path)));
  }
  await rm(target, { recursive: true, force: true });
  const hashes = {};
  for (const [path, content] of contents) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content);
    hashes[path] = digest(content);
  }
  await writeFile(receiptPath, JSON.stringify({ schema_version: 'aether.ats.vendor/1', repository: 'AetherAI3/ATSv2',
    path: 'electron-app-v2/packages/aether-ats-skills', revision, files: hashes }, null, 2) + '\n');
  console.log(`Copied ${contents.size} ATS adapter files. Run npm install --ignore-scripts and verify the packed clean install.`);
}
