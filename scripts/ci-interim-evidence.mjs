import { createHash } from 'node:crypto';
import { createReadStream, existsSync, appendFileSync, statSync } from 'node:fs';

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const files = [];
for (const path of process.argv.slice(2)) {
  files.push(existsSync(path)
    ? { path, bytes: statSync(path).size, sha256: await sha256(path) }
    : { path, missing: true });
}

const report = {
  schema: 'aether.ci-interim-evidence/v1',
  job: process.env.AETHER_EVIDENCE_JOB || 'unknown',
  expected_sha: process.env.AETHER_EXPECTED_SHA || 'unknown',
  upload_outcomes: process.env.AETHER_UPLOAD_OUTCOMES || 'unknown',
  files,
};
console.log(JSON.stringify(report));

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = files.map((file) => file.missing
    ? `| \`${file.path}\` | missing | — |`
    : `| \`${file.path}\` | ${file.bytes} | \`${file.sha256}\` |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '### Interim CI evidence',
    '',
    `Exact head: \`${report.expected_sha}\` · Job: \`${report.job}\``,
    '',
    `Artifact uploads: \`${report.upload_outcomes}\``,
    '',
    '| File | Bytes | SHA-256 |',
    '| --- | ---: | --- |',
    ...rows,
    '',
    'Download this run’s logs for test output. This summary does not replace required Actions artifacts.',
    '',
  ].join('\n'));
}
