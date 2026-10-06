import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stagePackInputs } from './npm-pack-reproducible.mjs';

function fixture(run) {
  const temp = mkdtempSync(join(tmpdir(), 'aether-pack-test-'));
  const source = join(temp, 'source'), staging = join(temp, 'staging');
  mkdirSync(source); mkdirSync(staging);
  const bytes = Buffer.from('public package content\n');
  writeFileSync(join(source, 'README.md'), bytes, { mode: 0o600 });
  const report = { entryCount: 1, unpackedSize: bytes.length, files: [{ path: 'README.md', size: bytes.length, mode: 0o600 }] };
  try { return run({ temp, source, staging, report }); }
  finally { rmSync(temp, { recursive: true }); }
}

test('actual npm packages are byte-identical under private and ordinary input modes', { skip: process.platform === 'win32' }, () => fixture(({ temp, source, staging }) => {
  const manifest = { name: 'aether-pack-mode-test', version: '1.0.0', bin: { cli: 'cli.js' }, files: ['README.md', 'cli.js'] };
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'cli.js'), '#!/usr/bin/env node\n');
  const npmCli = process.env.npm_execpath;
  const pack = (cwd, args) => JSON.parse(execFileSync(npmCli ? process.execPath : 'npm',
    npmCli ? [npmCli, 'pack', '--json', '--ignore-scripts', ...args] : ['pack', '--json', '--ignore-scripts', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }))[0];
  const results = [];
  for (const mode of [0o600, 0o644]) {
    for (const path of ['README.md', 'package.json', 'cli.js']) chmodSync(join(source, path), mode);
    const destination = join(staging, String(mode)); mkdirSync(destination);
    stagePackInputs(source, destination, pack(source, ['--dry-run']));
    const output = join(temp, `output-${mode}`); mkdirSync(output);
    const result = pack(destination, ['--pack-destination', output]);
    results.push(readFileSync(join(output, result.filename)));
    for (const path of ['README.md', 'package.json', 'cli.js']) assert.equal(lstatSync(join(source, path)).mode & 0o777, mode);
    assert.equal(lstatSync(join(destination, 'cli.js')).mode & 0o777, 0o755);
  }
  assert.deepEqual(results[0], results[1]);
}));

for (const path of ['../outside', '/absolute', 'dist/../secret', 'dist\\secret', '.npmrc', '.env.production', '.git/config']) {
  test(`unsafe or private input ${path} is rejected before copying`, () => fixture(({ source, staging, report }) => {
    report.files.push({ path, size: 0, mode: 0o600 }); report.entryCount++;
    assert.throws(() => stagePackInputs(source, staging, report), /unsafe package path|private package path/);
    assert.deepEqual(readdirSync(staging), []);
  }));
}

test('file and directory symlinks cannot redirect staging to private data', { skip: process.platform === 'win32' }, () => fixture(({ temp, source, staging, report }) => {
  const privateFile = join(temp, 'private'); writeFileSync(privateFile, 'private');
  symlinkSync(privateFile, join(source, 'alias.md'));
  report.files = [{ path: 'alias.md', size: 7, mode: 0o600 }]; report.unpackedSize = 7;
  assert.throws(() => stagePackInputs(source, staging, report), /unexpected package symlink/);
  symlinkSync(temp, join(source, 'nested'));
  report.files[0].path = 'nested/private';
  assert.throws(() => stagePackInputs(source, staging, report), /unexpected package symlink/);
  assert.deepEqual(readdirSync(staging), []);
}));

test('reviewed workspace links are copied as regular public files', { skip: process.platform === 'win32' }, () => fixture(({ source, staging, report }) => {
  mkdirSync(join(source, 'packages/ats-skills'), { recursive: true }); mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, 'packages/ats-skills/README.md'), 'public');
  symlinkSync('../packages/ats-skills', join(source, 'node_modules/aether-ats-skills'));
  report.files = [{ path: 'node_modules/aether-ats-skills/README.md', size: 6, mode: 0o600 }]; report.unpackedSize = 6;
  stagePackInputs(source, staging, report);
  assert.ok(lstatSync(join(staging, report.files[0].path)).isFile());
  assert.equal(readFileSync(join(staging, report.files[0].path), 'utf8'), 'public');
}));

test('a reviewed workspace name cannot be retargeted to another directory', { skip: process.platform === 'win32' }, () => fixture(({ source, staging, report }) => {
  mkdirSync(join(source, 'node_modules'));
  symlinkSync('..', join(source, 'node_modules/aether-ats-skills'));
  report.files[0].path = 'node_modules/aether-ats-skills/README.md';
  assert.throws(() => stagePackInputs(source, staging, report), /workspace link leaves reviewed source/);
}));

test('duplicate entries, special modes and mismatched byte counts are rejected', () => fixture(({ source, staging, report }) => {
  assert.throws(() => stagePackInputs(source, staging, { ...report, entryCount: 2, files: [...report.files, report.files[0]] }), /duplicate/);
  assert.throws(() => stagePackInputs(source, staging, { ...report, files: [{ ...report.files[0], mode: 0o4600 }] }), /file mode/);
  assert.throws(() => stagePackInputs(source, staging, { ...report, unpackedSize: 0 }), /byte count/);
  assert.throws(() => stagePackInputs(source, staging, { ...report, files: [{ ...report.files[0], size: 0 }] }), /source size/);
  assert.throws(() => stagePackInputs(source, staging, { ...report, files: [{ ...report.files[0], size: 5_000_001 }] }), /file size/);
  assert.deepEqual(readdirSync(staging), []);
}));
