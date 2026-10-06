import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function boundedJson(path) {
  const info = lstatSync(path);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024, 'invalid JSON input file');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function releasePacket(root, sourceSha, releaseTag, expectedDigest) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'source must be an exact Git SHA');
  const manifest = boundedJson(join(root, 'package.json'));
  assert.equal(manifest.name, 'aether-agents');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(releaseTag, `v${manifest.version}`, 'tag and version disagree');
  const metadata = boundedJson(join(root, 'pack-metadata.json'));
  assert.ok(Array.isArray(metadata) && metadata.length === 1, 'one npm pack result is required');
  const pack = metadata[0];
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  const filename = `${manifest.name}-${manifest.version}.tgz`;
  assert.equal(pack.filename, filename, 'unexpected tarball path');
  const tarball = join(root, filename);
  const info = lstatSync(tarball);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 10 * 1024 * 1024, 'invalid tarball file');
  const bytes = readFileSync(tarball);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(pack.integrity, integrity, 'npm integrity and actual bytes disagree');
  if (expectedDigest !== undefined) {
    assert.match(expectedDigest, /^[0-9a-f]{64}$/, 'tested digest is missing or malformed');
    assert.equal(sha256, expectedDigest, 'cloud rebuild differs from the tested tarball');
  }
  return {
    schema: 'aether.npm-release-packet/v1', source_sha: sourceSha, release_tag: releaseTag,
    package: manifest.name, version: manifest.version, tarball: filename,
    tarball_sha256: sha256, npm_integrity: integrity, node_version: process.versions.node,
    tested_digest_verified: expectedDigest !== undefined,
    npm_published: false, npm_provenance_asserted: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const mode = process.argv[2];
  assert.ok(mode === 'create' || mode === 'verify');
  const source = process.env.AETHER_RELEASE_SOURCE_SHA;
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source);
  const expected = mode === 'verify' ? process.env.AETHER_EXPECTED_TARBALL_SHA256 : undefined;
  if (mode === 'verify') assert.ok(expected, 'tested tarball digest is required');
  const packet = releasePacket(process.cwd(), source, process.env.RELEASE_TAG, expected);
  assert.match(packet.node_version, /^24\.\d+\.\d+$/, 'release toolchain must use Node 24');
  writeFileSync('npm-release-packet.json', JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `source_sha=${packet.source_sha}\ntarball_sha256=${packet.tarball_sha256}\nnode_version=${packet.node_version}\n`);
  }
  console.log(JSON.stringify(packet));
}
