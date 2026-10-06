import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { releasePacket } from './npm-release-packet.mjs';

const sha = 'a'.repeat(40);
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'aether-npm-packet-'));
  const file = 'aether-agents-0.4.0.tgz';
  const metadata = { name: 'aether-agents', version: '0.4.0', filename: file };
  const update = (bytes) => {
    writeFileSync(join(root, file), bytes);
    metadata.integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    writeFileSync(join(root, 'pack-metadata.json'), JSON.stringify([metadata]));
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'aether-agents', version: '0.4.0' }));
  update(Buffer.from('tested package bytes'));
  try { run({ root, file, metadata, update }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('a rebuilt byte-identical package retains exact source/version bindings', () => fixture(({ root }) => {
  const tested = releasePacket(root, sha, 'v0.4.0');
  const rebuilt = releasePacket(root, sha, 'v0.4.0', tested.tarball_sha256);
  assert.equal(rebuilt.tested_digest_verified, true);
  assert.equal(rebuilt.source_sha, sha);
  assert.equal(rebuilt.npm_published, false);
  assert.equal(rebuilt.npm_provenance_asserted, false);
}));

test('repacking modified bytes cannot reuse the tested digest', () => fixture(({ root, update }) => {
  const digest = releasePacket(root, sha, 'v0.4.0').tarball_sha256;
  update(Buffer.from('different package bytes with valid new npm integrity'));
  assert.throws(() => releasePacket(root, sha, 'v0.4.0', digest), /differs from the tested tarball/);
}));

test('modified bytes cannot reuse stale npm integrity', () => fixture(({ root, file }) => {
  writeFileSync(join(root, file), 'tampered');
  assert.throws(() => releasePacket(root, sha, 'v0.4.0'), /integrity and actual bytes disagree/);
}));

test('metadata cannot redirect the verifier outside the workspace', () => fixture(({ root, metadata }) => {
  metadata.filename = '../aether-agents-0.4.0.tgz';
  writeFileSync(join(root, 'pack-metadata.json'), JSON.stringify([metadata]));
  assert.throws(() => releasePacket(root, sha, 'v0.4.0'), /unexpected tarball path/);
}));

test('tag, SHA and digest substitutions are rejected', () => fixture(({ root }) => {
  assert.throws(() => releasePacket(root, 'main', 'v0.4.0'), /exact Git SHA/);
  assert.throws(() => releasePacket(root, sha, 'v0.4.1'), /tag and version disagree/);
  assert.throws(() => releasePacket(root, sha, 'v0.4.0', ''), /digest is missing or malformed/);
}));

test('metadata for multiple tarballs is rejected', () => fixture(({ root, metadata }) => {
  writeFileSync(join(root, 'pack-metadata.json'), JSON.stringify([metadata, metadata]));
  assert.throws(() => releasePacket(root, sha, 'v0.4.0'), /one npm pack result/);
}));

test('symlink tarballs are rejected', () => fixture(({ root, file }) => {
  const path = join(root, file);
  rmSync(path);
  const target = join(root, 'other.tgz');
  writeFileSync(target, 'tested package bytes');
  symlinkSync(target, path);
  assert.throws(() => releasePacket(root, sha, 'v0.4.0'), /invalid tarball file/);
}));
