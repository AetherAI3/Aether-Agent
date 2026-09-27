// Release coherence — the repository must describe exactly one release.
//
// The defect this file exists to make impossible:
//
//   On 2026-08-20 the repository described FIVE different releases at once.
//   package.json said 0.2.0. package-lock.json still said 0.1.0 (the #81 bump
//   never touched it). RELEASE_NOTES.md's top entry described a 0.2.0 whose
//   feature list was written before #72 added `aether skills` and
//   `aether capabilities`. The npm registry served 0.1.0. And a packed
//   aether-agents-0.2.0.tgz sat committed in the repo root from #83 until #90
//   deleted it. Nothing was lying on purpose; the four statements simply drifted
//   apart because nothing compared them.
//
// Two gates, both asserting file contents on disk rather than prose:
//
//   A. VERSION IDENTITY — every place that names the release names the same one.
//   B. FEATURE REACHABILITY — for every feature the release notes claim, the
//      code that implements it is inside the packed tarball's file list, and the
//      command that exposes it is in the CLI registry. This is the user-visible
//      objective stated as an assertion: the package users install contains the
//      features the repository says it contains.
//
// Gate B is the load-bearing one. verify-production.ts checks that the package
// contains its entrypoints and nothing forbidden; it has no idea what the
// release notes promised, so a feature dropped from the allowlist passes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackReport } from "../scripts/verify-production.js";
import { ALL_CLI_COMMANDS } from "../src/commands/cli_registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

const pkg = JSON.parse(read("package.json")) as { name: string; version: string };
const VERSION = pkg.version;
let cachedPackReport: ReturnType<typeof createPackReport> | undefined;

function currentPackReport(): ReturnType<typeof createPackReport> {
  cachedPackReport ??= createPackReport(root);
  return cachedPackReport;
}

type PacketRows = Map<string, string[]>;

const ORIGINAL_BASE_LABEL = "Original PR branch base";
const ORIGINAL_BASE_VALUE = "`85a75645e8b94e8542bcf6ee0f384037a2915a5e` (`origin/main`, after #106; historical)";
const RECONCILED_BASE_LABEL = "Publication code base";
const RECONCILED_BASE_VALUE = "`127145725b63c2800bc904ca8908b790238d7fce` (`origin/main`, after #109; #109 changed only the CodeQL workflow)";
const HOSTED_UBUNTU_LABEL = "GitHub-hosted Ubuntu value";
const HOSTED_WINDOWS_LABEL = "GitHub-hosted Windows value";
const LOCAL_WINDOWS_LABEL = "Current local Windows default-checkout measurement";
const LOCAL_LINUX_LABEL = "Current local Linux/LF checkout measurement";
const EXPECTED_UBUNTU_UNPACKED = 3_688_966;
const EXPECTED_HOSTED_WINDOWS_UNPACKED = 3_690_927;
const EXPECTED_LOCAL_WINDOWS_UNPACKED = 3_690_927;
const EXPECTED_LINUX_PACKED = 835_957;
const EXPECTED_WINDOWS_PACKED = 836_234;
const V032_PACKET = {
  "Package": "`aether-agents`",
  "Proposed tag": "`v0.3.2`",
  "Release line base": "`c4a16242ad117a499f91e3b531baa80f1a3ff0bd` (`v0.3.1`)",
  "Candidate branch": "`fix/reconcile-v031-into-main`",
  "Archive evidence": "No release archive exists. The current local Windows `npm pack --dry-run --json --ignore-scripts` reported `aether-agents-0.3.2.tgz`, 1,387,500 packed bytes, 4,461,548 unpacked bytes, `shasum` `3e22664fe2bc647efe87a72a4d4fb95cb5566e83`, and integrity `sha512-AKvvYi40h64DvOylTk3qDKbs6k+MLP5kt3tUBtoQUDLcu+nTOiEnPxYDbmcmelynROKZjPVnsKxzlOCFJfodow==`; dry-run metadata is not a release checksum or provenance attestation.",
  "Package manifest": "The same current local dry run reported 673 entries. Hosted exact-head package evidence remains required before release.",
  "Provenance evidence": "Pending the trusted-publishing workflow — no v0.3.2 provenance attestation exists yet.",
} as const;

function parsePacketRows(packet: string): PacketRows {
  const rows: PacketRows = new Map();
  for (const line of packet.split(/\r?\n/)) {
    const match = /^\| ([^|]+?) \| ([^|]+?) \|$/.exec(line);
    if (!match) continue;
    const label = match[1]!;
    const values = rows.get(label) ?? [];
    values.push(match[2]!);
    rows.set(label, values);
  }
  return rows;
}

function onlyPacketRow(rows: PacketRows, label: string): string {
  const values = rows.get(label) ?? [];
  assert.equal(values.length, 1, `the operator packet must contain exactly one ${label} row`);
  return values[0]!;
}

function assertV030PacketProvenance(packet: string): PacketRows {
  const rows = parsePacketRows(packet);
  const baseLabels = [...rows.keys()].filter((label) => /base/i.test(label)).sort();
  assert.deepEqual(
    baseLabels,
    [ORIGINAL_BASE_LABEL, RECONCILED_BASE_LABEL].sort(),
    "the operator packet must contain only the historical and reconciled base rows",
  );
  assert.equal(onlyPacketRow(rows, ORIGINAL_BASE_LABEL), ORIGINAL_BASE_VALUE);
  assert.equal(onlyPacketRow(rows, RECONCILED_BASE_LABEL), RECONCILED_BASE_VALUE);

  const measurementLabels = [...rows.keys()]
    .filter((label) => /GitHub-hosted/.test(label) || /^Current local .* measurement$/.test(label))
    .sort();
  assert.deepEqual(
    measurementLabels,
    [HOSTED_UBUNTU_LABEL, HOSTED_WINDOWS_LABEL, LOCAL_WINDOWS_LABEL, LOCAL_LINUX_LABEL].sort(),
    "the operator packet must contain exactly two hosted measurements and two local measurements",
  );
  assert.equal(
    onlyPacketRow(rows, HOSTED_UBUNTU_LABEL),
    `${EXPECTED_UBUNTU_UNPACKED.toLocaleString("en-US")} unpacked bytes — exact-head CI run \`33160594500\` passed`,
  );
  assert.equal(
    onlyPacketRow(rows, HOSTED_WINDOWS_LABEL),
    `${EXPECTED_HOSTED_WINDOWS_UNPACKED.toLocaleString("en-US")} unpacked bytes — exact-head CI run \`33160594500\` passed`,
  );
  assert.equal(
    onlyPacketRow(rows, LOCAL_WINDOWS_LABEL),
    `${EXPECTED_LOCAL_WINDOWS_UNPACKED.toLocaleString("en-US")} unpacked bytes / ${EXPECTED_WINDOWS_PACKED.toLocaleString("en-US")} predicted packed bytes`,
  );
  assert.equal(
    onlyPacketRow(rows, LOCAL_LINUX_LABEL),
    `${EXPECTED_UBUNTU_UNPACKED.toLocaleString("en-US")} unpacked bytes / ${EXPECTED_LINUX_PACKED.toLocaleString("en-US")} predicted packed bytes`,
  );

  const normalized = packet.replace(/\s+/g, " ");
  assert.ok(
    normalized.includes(
      "Exact-head CI run `33160594500` confirmed the full suite and both hosted package measurements at `127145725b63c2800bc904ca8908b790238d7fce`:",
    ),
    "the operator packet must bind hosted package values to exact-head CI",
  );
  assert.ok(
    normalized.includes(
      "Exact-head CI confirmed their 3,688,966 and 3,690,927 unpacked-byte results on the corresponding hosted platforms;",
    ),
    "the packaged-manifest prose must bind hosted values to exact-head CI",
  );
  return rows;
}

// ── Gate A: one release, named consistently ─────────────────────────────────

test("the lockfile names the same version as the manifest, in both places", () => {
  // package-lock.json carries the version twice: at the root and under
  // packages[""]. #81 bumped package.json and neither of these, so `npm ci`
  // installed a tree that disagreed with the manifest it was built from.
  const lock = JSON.parse(read("package-lock.json")) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string }>;
  };
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, VERSION, "package-lock.json root version drifted from package.json");
  assert.equal(lock.packages[""]?.version, VERSION, 'package-lock.json packages[""] version drifted');
});

test("RELEASE_NOTES.md leads with the version the package declares", () => {
  const notes = read("RELEASE_NOTES.md");
  const firstHeading = notes.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  assert.ok(firstHeading, "RELEASE_NOTES.md has no heading");
  assert.ok(
    firstHeading.includes(`v${VERSION}`),
    `RELEASE_NOTES.md leads with ${JSON.stringify(firstHeading)}, which does not name v${VERSION}`,
  );
});

test("the dated release log has an entry for this version, and the index links it", () => {
  const index = read("docs", "releases", "README.md");
  const rows = index
    .split(/\r?\n/)
    .filter((line) => /^- \[\d{4}-\d{2}-\d{2}\]\(/.test(line));
  assert.ok(rows.length > 0, "docs/releases/README.md has no index rows");

  const head = rows[0]!;
  assert.ok(head.includes(`v${VERSION}`), `the newest index row does not name v${VERSION}: ${head}`);

  const file = /\((\d{4}-\d{2}-\d{2}\.md)\)/.exec(head)?.[1];
  assert.ok(file, `the newest index row links no dated file: ${head}`);
  const path = join(root, "docs", "releases", file);
  assert.ok(existsSync(path), `docs/releases/${file} is linked from the index but does not exist`);
  assert.ok(
    readFileSync(path, "utf8").includes(`v${VERSION}`),
    `docs/releases/${file} does not name v${VERSION}`,
  );

  // Every row in the index must link a file that exists — a dead link in the
  // release log is how a release becomes unauditable later.
  for (const row of rows) {
    const linked = /\((\d{4}-\d{2}-\d{2}\.md)\)/.exec(row)?.[1];
    assert.ok(linked, `index row links no dated file: ${row}`);
    assert.ok(existsSync(join(root, "docs", "releases", linked)), `missing docs/releases/${linked}`);
  }
});

test("the current operator packet identifies the candidate and v0.3.0 retains its historical provenance", () => {
  const path = join(root, "docs", "releases", `OPERATOR-PACKET-v${VERSION}.md`);
  assert.ok(existsSync(path), `no docs/releases/OPERATOR-PACKET-v${VERSION}.md`);
  const current = readFileSync(path, "utf8");
  assert.ok(current.includes(`v${VERSION}`), "the operator packet does not name the proposed tag");
  const currentRows = parsePacketRows(current);
  for (const [label, expected] of Object.entries(V032_PACKET)) {
    assert.equal(onlyPacketRow(currentRows, label), expected, `the current packet has the wrong ${label}`);
  }
  assert.doesNotMatch(current, /aether-agents-0\.3\.0\.tgz|6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d/);
  const packet = read("docs", "releases", "OPERATOR-PACKET-v0.3.0.md");
  assertV030PacketProvenance(packet);
  assert.match(packet, /\| Qualified final-candidate archive \| `aether-agents-0\.3\.0\.tgz` — 835,957 bytes packed \/ 3,688,966 unpacked \/ 618 entries at `1271457\.\.\.`;/);
  assert.match(packet, /\| Qualified final-candidate archive sha256 \| `6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d` \|/);
  assert.match(packet, /\| Qualified pre-merge archive \| `aether-agents-0\.3\.0\.tgz` — 835,957 bytes packed \/ 3,688,966 unpacked \/ 618 entries at `3cf44bb\.\.\.`;/);
  assert.match(packet, /\| Qualified pre-merge archive sha256 \| `6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d` — historical only/);
  assert.match(packet, /\| Historical archive \| `aether-agents-0\.3\.0\.tgz` — 739,977 bytes packed \/ 3,022,168 unpacked \/ 575 entries \|/);
  assert.match(packet, /\| Historical archive sha256 \| `70a48aca8baa8b63f551980256eafa42531cd22fc5ca1146829d31f8b4bd2e4d` \|/);
  assert.doesNotMatch(packet, /fb96ee44[^\n]*(?:ancestor of #96|ancestor of current `main`)/);
});

test("the operator packet fails closed on contradictory release-evidence mutations", () => {
  const packet = read("docs", "releases", "OPERATOR-PACKET-v0.3.0.md");
  const mutations = [
    [
      "duplicate reconciled base",
      packet.replace(
        `| ${RECONCILED_BASE_LABEL} | ${RECONCILED_BASE_VALUE} |`,
        `| ${RECONCILED_BASE_LABEL} | \`deadbeef\` (contradictory) |\n| ${RECONCILED_BASE_LABEL} | ${RECONCILED_BASE_VALUE} |`,
      ),
    ],
    [
      "duplicate hosted measurement",
      packet.replace(
        `| ${HOSTED_UBUNTU_LABEL} | 3,688,966 unpacked bytes — exact-head CI run \`33160594500\` passed |`,
        `| ${HOSTED_UBUNTU_LABEL} | 1 unpacked byte — contradictory |\n| ${HOSTED_UBUNTU_LABEL} | 3,688,966 unpacked bytes — exact-head CI run \`33160594500\` passed |`,
      ),
    ],
    [
      "stale local packed size",
      packet.replace("3,688,966 unpacked bytes / 835,957 predicted packed bytes", "3,688,966 unpacked bytes / 835,956 predicted packed bytes"),
    ],
    [
      "stale local unpacked size",
      packet.replace("3,688,966 unpacked bytes / 835,957 predicted packed bytes", "3,688,965 unpacked bytes / 835,957 predicted packed bytes"),
    ],
    [
      "stale hosted-provenance prose",
      packet.replace(
        /Exact-head CI run `33160594500` confirmed the full suite and both hosted package\r?\nmeasurements at `127145725b63c2800bc904ca8908b790238d7fce`:/,
        "Hosted values were confirmed without an exact head.",
      ),
    ],
  ] as const;

  for (const [name, mutant] of mutations) {
    assert.notEqual(mutant, packet, `${name} mutation did not alter the packet fixture`);
    assert.throws(() => assertV030PacketProvenance(mutant), name);
  }
});

test(
  "the v0.3.0 operator packet's final-candidate manifest keeps matching the package membership",
  { timeout: 120_000 },
  () => {
    const packet = read("docs", "releases", "OPERATOR-PACKET-v0.3.0.md");
    assertV030PacketProvenance(packet);
    const packed = currentPackReport();
    const header = /\| Current exact-head dry run \| ([\d,]+) entries \/ ([\d,]+) workflows \|/.exec(packet);
    assert.ok(header, "the operator packet has no parseable current dry-run summary");
    const headerEntries = Number.parseInt(header[1]!.replaceAll(",", ""), 10);
    assert.equal(Number.parseInt(header[2]!, 10), 4, "the current dry run records the wrong workflow count");
    const manifest = /### Current dry-run packaged file manifest\s+The exact-head candidate dry runs reported ([\d,]+) entries on clean Linux\/LF and\s+Windows\/default checkouts\./.exec(packet);
    assert.ok(manifest, "the operator packet has no parseable current dry-run manifest summary");
    const manifestEntries = Number.parseInt(manifest[1]!.replaceAll(",", ""), 10);

    // Fixed byte totals and the tarball digest belong to the recorded
    // publication-base candidate. They must not chase a later post-publication
    // README edit into an unpublished 0.3.0 payload. Package membership remains
    // the portable invariant that every future source head must preserve.
    assert.equal(headerEntries, packed.entryCount, "the packet header entry count does not match npm pack");
    assert.equal(manifestEntries, packed.entryCount, "the packet manifest entry count does not match npm pack");

    const paths = packed.files.map((file) => file.path.replaceAll("\\", "/"));
    const count = (predicate: (path: string) => boolean): number => paths.filter(predicate).length;
    const groups = [
      ["`COMMANDS.md`, `LICENSE`, `NOTICE.md`, `README.md`, `package.json`", count((path) => !path.includes("/"))],
      ["`assets/**`", count((path) => path.startsWith("assets/"))],
      ["`docs/generated/**`, `docs/model-catalogue/**`", count((path) => path.startsWith("docs/"))],
      ["`dist/src/core/**`", count((path) => path.startsWith("dist/src/core/"))],
      ["`dist/src/ui/**`", count((path) => path.startsWith("dist/src/ui/"))],
      ["`dist/src/commands/**`", count((path) => path.startsWith("dist/src/commands/"))],
      ["`dist/src/skills/**` (six built-in skills)", count((path) => path.startsWith("dist/src/skills/"))],
      ["`dist/src/generated/**`", count((path) => path.startsWith("dist/src/generated/"))],
      [
        "`dist/src/{index,main,types,version}.*`",
        count((path) => /^dist\/src\/(?:index|main|types|version)\./.test(path)),
      ],
    ] as const;
    assert.equal(
      groups.reduce((total, [, entries]) => total + entries, 0),
      packed.entryCount,
      "the independently derived package groups do not cover the full npm manifest",
    );
    for (const [label, entries] of groups) {
      assert.ok(
        packet.includes(`| ${label} | ${entries} |`),
        `the packet has a stale package group count for ${label}`,
      );
    }

    const extensionCounts = {
      js: count((path) => path.endsWith(".js") && !path.endsWith(".js.map")),
      dts: count((path) => path.endsWith(".d.ts")),
      map: count((path) => path.endsWith(".js.map")),
      json: count((path) => path.endsWith(".json")),
      md: count((path) => path.endsWith(".md")),
      html: count((path) => path.endsWith(".html")),
      png: count((path) => path.endsWith(".png")),
      extensionless: count((path) => !/\.[^/]+$/.test(path)),
    };
    const normalizedPacket = packet.replace(/\s+/g, " ");
    assert.ok(
      normalizedPacket.includes(
        `By extension: ${extensionCounts.js} \`.js\`, ${extensionCounts.dts} \`.d.ts\`, `
        + `${extensionCounts.map} \`.js.map\`, ${extensionCounts.json} \`.json\`, `
        + `${extensionCounts.md} \`.md\`, ${extensionCounts.html} \`.html\`, `
        + `${extensionCounts.png} \`.png\`, `
        + `${extensionCounts.extensionless} extensionless.`,
      ),
      "the packet has a stale extension manifest",
    );

    const historical = /### Historical candidate archive[\s\S]*?"packedFiles":575,"packedBytes":3022168,"workflows":3[\s\S]*?sha256:70a48aca8baa8b63f551980256eafa42531cd22fc5ca1146829d31f8b4bd2e4d/.exec(packet);
    assert.ok(historical, "the historical archive facts are not kept together under their own heading");
  },
);

// ── Gate B: the package contains what the notes promise ─────────────────────

/**
 * Every claim the current release notes make, mapped to the evidence that would
 * be missing if the claim were false for an installed user.
 *
 * `command` must appear in the CLI registry (so `aether --help` names it);
 * `packaged` paths must all appear in the packed tarball's file list.
 *
 * Adding a headline feature to the notes without adding a row here is the drift
 * this gate cannot catch by itself; the row is the contract.
 */
const FEATURE_MANIFEST: Array<{ claim: string; command?: string; packaged: string[] }> = [
  {
    claim: "managed localhost previews — `aether preview`",
    command: "preview",
    packaged: [
      "dist/src/commands/preview.js",
      "dist/src/core/preview_contract.js",
      "dist/src/core/preview_supervisor.js",
    ],
  },
  {
    claim: "the review → commit → pull request rail — `aether review`",
    command: "review",
    packaged: [
      "dist/src/commands/review.js",
      "dist/src/core/review_state.js",
      "dist/src/core/review_actions.js",
      "dist/src/core/verification_record.js",
      "dist/src/core/diff_counts.js",
    ],
  },
  {
    claim: "publishing the head branch and opening the pull request — `aether ship`",
    command: "ship",
    packaged: [
      "dist/src/commands/ship.js",
      "dist/src/core/publish.js",
      "dist/src/core/ship_record.js",
    ],
  },
  {
    claim: "the project session library — `aether sessions`",
    command: "sessions",
    packaged: [
      "dist/src/commands/sessions.js",
      "dist/src/core/session_index.js",
      "dist/src/ui/continuity.js",
    ],
  },
  {
    claim: "skills and AGENTS.md are composed into real runs, and their policy is enforced",
    packaged: ["dist/src/core/skills/run_session.js"],
  },
  {
    claim: "win32 URLs open through rundll32, so the device-approval page appears",
    packaged: ["dist/src/core/opener.js"],
  },
  {
    claim: "the token store refuses planted links and writes atomically",
    packaged: ["dist/src/core/auth.js"],
  },
  {
    claim: "portable handoffs — `aether resume export` / `aether agent --resume`",
    command: "resume",
    packaged: ["dist/src/core/handoff.js", "dist/src/commands/resume.js"],
  },
  {
    claim: "agent skills runtime — `aether skills`",
    command: "skills",
    packaged: [
      "dist/src/commands/skills.js",
      "dist/src/core/skills/skill_schema.js",
      "dist/src/core/skills/skill_trust.js",
      "dist/src/core/skills/skill_session.js",
    ],
  },
  {
    claim: "built-in skills ship inside the package, not as a separate download",
    packaged: [
      "dist/src/skills/builtin/review-pr/SKILL.md",
      "dist/src/skills/builtin/fix-ci/SKILL.md",
      "dist/src/skills/builtin/ship/SKILL.md",
    ],
  },
  {
    claim: "capability contract — `aether capabilities`",
    command: "capabilities",
    packaged: ["dist/src/commands/capabilities.js", "dist/src/generated/agent_capabilities.js"],
  },
  {
    claim: "redacted support bundle — `aether support-bundle`",
    command: "support-bundle",
    packaged: ["dist/src/commands/support_bundle.js", "dist/src/core/support_bundle.js"],
  },
  {
    claim: "the offline path ships in the package (`aether agent --local`)",
    packaged: ["dist/src/core/brain_ollama.js", "dist/src/core/ollama.js"],
  },
  {
    claim: "async tool execution with process-tree teardown",
    packaged: ["dist/src/core/tool_executor.js"],
  },
];

test("every CLI command the release notes promise is in the CLI registry", () => {
  // Read the registry STRUCTURALLY, by importing it, not by regex over its
  // source. #98 replaced "reachability asserted by a regex over main.ts" with a
  // real dispatch table for exactly this reason, and it immediately split the
  // commands across two arrays — CLI_COMMANDS and DISPATCH_COMMANDS — which a
  // source regex keyed on one of them would have silently stopped covering.
  const registered = new Set(ALL_CLI_COMMANDS.map((command) => command.name));
  for (const feature of FEATURE_MANIFEST) {
    if (!feature.command) continue;
    assert.ok(
      registered.has(feature.command),
      `${feature.claim}: the CLI registry declares no "${feature.command}" command`,
    );
  }
});

test(
  "every feature the release notes promise is present in the packed tarball",
  { timeout: 120_000 },
  () => {
    // The source checkout's dist/ is NOT the package: the files allowlist is
    // dist/src plus four docs, so dist/scripts and dist/test exist on disk and
    // ship to nobody. Ask npm what would actually be packed.
    const packed = currentPackReport();
    const paths = new Set(packed.files.map((file) => file.path.replaceAll("\\", "/")));

    assert.equal(packed.version, VERSION, "npm pack reports a version the manifest does not");
    assert.equal(packed.name, pkg.name);

    const missing: string[] = [];
    for (const feature of FEATURE_MANIFEST) {
      for (const path of feature.packaged) {
        if (!paths.has(path)) missing.push(`${path}  (${feature.claim})`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `the release notes promise features whose code is not in the tarball:\n  ${missing.join("\n  ")}`,
    );

    // Guard the guard: if npm ever changed the shape of its file list, every
    // lookup above would miss and the assertion would still read as coverage.
    assert.ok(paths.has("package.json"), "the packed file list does not look like a file list");
    assert.ok(paths.size > 50, `only ${paths.size} packed paths — the pack report is not what this gate assumes`);
  },
);

// ── Gate C: the package promises nothing the notes are silent about ─────────
//
// Gate B runs notes -> package: a claim with no code behind it fails. That is
// only one direction, and it is not the direction that actually keeps happening.
//
// The other direction is a user-visible command that ships with NO claim
// anywhere in the notes. It happened while this very lane's PR was open: #98
// landed on main after the v0.3.0 notes were written, and the notes said nothing
// about it. It will happen again for every lane that lands between the note
// being written and the tag being cut. A release that silently ships a command
// nobody announced is the same defect as a note that promises one nobody built,
// arriving from the side nothing was watching.
//
// The rule: every user-visible command is either announced by SOME release note,
// or named here with a reason. An explicit list is fine. Silence is not.

/**
 * Commands that ship without a release note, each with the reason it is
 * acceptable. Entries are enforced in both directions — a stale entry fails,
 * and an entry that IS announced fails — so this cannot rot into a permanent
 * bypass that quietly absorbs the next unannounced command.
 *
 * Every entry must also be named in the operator packet, so the founder cutting
 * the tag reads the full unannounced set before creating it.
 */
const SHIPPED_WITHOUT_A_NOTE: Record<string, string> = {
  help: "predates the release log; the CLI has never shipped without it",
  chat: "predates the release log",
  run: "predates the release log",
  agents: "predates the release log",
  github: "predates the release log",
  vault: "the June 2026 entry announces the vault surface, not the command token",
  workflow: "the June 2026 entry announces workflows, not the command token",
  memory: "the June 2026 entry announces the memory bridge, not the command token",
  image: "the June 2026 entry announces media generation, not the command token",
  video: "the June 2026 entry announces media generation, not the command token",
  output: "the 2026-08-14 entry announces the durable media output history, not the command token",
  audit: "the June 2026 entry announces the audit trail, not the command token",
  receipt: "the June 2026 entry announces audit receipts, not the command token",
  mcp: "the June 2026 entry announces the MCP manager, not the command token",
  config: "predates the release log",
};

/**
 * A command is announced only where the notes name the form a user actually
 * types: `aether <name>`.
 *
 * This used to also accept the name inside bare backticks, and that made the
 * gate vacuous in exactly the case it was built for. When #102 landed
 * `aether review` and `aether ship`, both were already "announced" — because
 * the notes mention the built-in SKILLS named `review-pr` and `ship`. A gate
 * that reports coverage it does not have is worse than no gate, so the bare
 * backtick form is gone: a skill, a flag, or a hyphenated neighbour that merely
 * contains the command's letters no longer speaks for the command.
 */
function announcedInNotes(notes: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("aether " + escaped + "\\b").test(notes);
}

test("no user-visible command ships without either a release note or a named exemption", () => {
  const notes = read("RELEASE_NOTES.md");

  // Hidden commands are exempt by rule: `login` and `logout` are legacy
  // shortcuts deliberately kept out of `aether --help`, so there is no surface
  // to announce. The exemption is narrow — it follows the registry's own
  // `hidden` flag, not a list somebody maintains here.
  const visible = ALL_CLI_COMMANDS.filter((command) => !command.hidden);
  assert.ok(visible.length > 0, "the registry exposes no visible commands — this gate is not reading it");

  const unannounced = visible
    .filter((command) => !announcedInNotes(notes, command.name))
    .filter((command) => !(command.name in SHIPPED_WITHOUT_A_NOTE))
    .map((command) => `${command.name} — ${command.summary}`);

  assert.deepEqual(
    unannounced,
    [],
    "these commands ship to users with no claim in RELEASE_NOTES.md and no named exemption:\n  " +
      `${unannounced.join("\n  ")}\n` +
      "Announce them in the current release entry, or add them to SHIPPED_WITHOUT_A_NOTE with a reason.",
  );
});

test("the announcement matcher does not accept a lookalike as an announcement", () => {
  // Guard the guard. Every assertion in this section is only as good as this
  // function, and its previous form said yes to all three of these.
  assert.equal(announcedInNotes("the built-in `review-pr` skill", "review"), false);
  assert.equal(announcedInNotes("six ship built in: `ship`, `fix-ci`", "ship"), false);
  assert.equal(announcedInNotes("pass `--skills` to narrow the run", "skills"), false);
  // ...and still says yes to a real announcement.
  assert.equal(announcedInNotes("run `aether review --files x` to pick", "review"), true);
  assert.equal(announcedInNotes("aether ship publishes HEAD", "ship"), true);
});

test("the unannounced-command list cannot rot into a permanent bypass", () => {
  const notes = read("RELEASE_NOTES.md");
  const registered = new Map(ALL_CLI_COMMANDS.map((command) => [command.name, command]));

  for (const [name, reason] of Object.entries(SHIPPED_WITHOUT_A_NOTE)) {
    // A stale entry is worse than no entry: it holds an exemption open for a
    // command that no longer exists, and the next command to take that name
    // inherits the silence.
    assert.ok(registered.has(name), `SHIPPED_WITHOUT_A_NOTE names "${name}", which is not a registered command`);
    assert.equal(registered.get(name)?.hidden ?? false, false, `"${name}" is hidden and needs no exemption`);
    assert.ok(reason.trim().length > 10, `"${name}" is exempted without a real reason`);
    assert.equal(
      announcedInNotes(notes, name),
      false,
      `"${name}" IS announced in RELEASE_NOTES.md — remove it from SHIPPED_WITHOUT_A_NOTE ` +
        "so the list keeps meaning what it says",
    );
  }
});

test("the operator packet names every command that ships unannounced", () => {
  // The founder creating the tag is the person who needs to know what goes out
  // without a note. Keeping the list only in a test file would tell the release
  // engineer and nobody else.
  const packet = read("docs", "releases", `OPERATOR-PACKET-v${VERSION}.md`);
  const missing = Object.keys(SHIPPED_WITHOUT_A_NOTE).filter(
    (name) => !new RegExp("`aether " + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`").test(packet),
  );
  assert.deepEqual(missing, [], `the operator packet does not name these unannounced commands: ${missing.join(", ")}`);
});

test("release documents never state that this version is installable from npm", () => {
  // This lane cannot prove registry availability, and an unpublished version is
  // unknown, not available — never "supported" or "shipped". Any sentence
  // promising that `npm i -g aether-agents` yields the CURRENT version must not
  // exist until a publish has actually been observed on the registry.
  //
  // The claim is matched against a NORMALIZED document — blockquote markers
  // stripped and whitespace collapsed — because both files wrap prose across
  // lines and inside `>` quotes, so a line-anchored regex would miss the exact
  // sentence it exists to catch. The window after the install command is bounded
  // so the collapsed document cannot make the match vacuously greedy.
  const escaped = VERSION.replaceAll(".", "\\.");
  const claim = new RegExp(
    `npm\\s+i(?:nstall)?\\s+-g\\s+["']?aether-agents.{0,160}?\\b(?:gives you|gives|installs|resolves to|is now|upgrades you to)\\b.{0,40}?${escaped}`,
    "i",
  );
  const normalize = (text: string): string => text.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");
  for (const file of ["README.md", "RELEASE_NOTES.md"]) {
    assert.equal(
      claim.test(normalize(read(file))),
      false,
      `${file} claims npm serves ${VERSION} without registry proof`,
    );
  }

  // Guard the guard: the same pattern must fire on a sentence that DOES make the
  // claim, or the four assertions above prove only that the regex is broken.
  assert.equal(
    claim.test(normalize(`> A plain \`npm i -g aether-agents --ignore-scripts\`\n> now installs ${VERSION}.`)),
    true,
    "the availability tripwire does not match a claim it is supposed to catch",
  );
});
