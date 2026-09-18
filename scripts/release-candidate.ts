// scripts/release-candidate.ts — run the production release sequence locally,
// against a specific commit, and emit evidence bound to that commit.
//
//   npm run release:candidate
//   npm run release:candidate -- --out rc.json --full-tests
//
// Why this exists. `.github/workflows/release.yml` only runs after a founder has
// already created a tag and published a GitHub release. Everything it checks is
// therefore checked too late to change the decision. This script runs the same
// sequence, in the same order, before the tag exists — so the tag can be created
// against evidence instead of hope.
//
// Three properties it does not compromise on:
//
//  1. COMMIT-BOUND. The sequence runs against a detached `git worktree` of a
//     specific commit, never against the dirty checkout you are sitting in. A
//     candidate produced from uncommitted edits proves nothing about what a tag
//     would resolve to, so a dirty tree is refused unless you pass --allow-dirty
//     (which marks the report commitBound:false rather than pretending).
//
//  2. THE TARBALL IS THE ARTIFACT. Every CLI proof runs the binary that `npm
//     install` placed on disk from the packed tarball — not `dist/` in a source
//     checkout, which contains files the package allowlist excludes. A committed
//     tarball is exactly the defect #83 introduced; a source-tree "smoke test"
//     is the same class of lie in a different wrapper.
//
//  3. UNKNOWN IS NOT PASS. Every step lands in the report as "pass", "fail", or
//     "not-run". A step that was skipped — the full test suite without
//     --full-tests, for instance — is reported as not-run and can never be read
//     as a green tick.
//
// No string is ever handed to a shell: every child process is spawned with an
// argument array, including the npm invocations (npm is reached through its own
// JS entrypoint under `node`, which also avoids the .cmd shell requirement on
// Windows).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type StepStatus = "pass" | "fail" | "not-run";

export interface StepResult {
  name: string;
  status: StepStatus;
  /** Why it is not-run, or what failed. Empty on a clean pass. */
  detail: string;
  durationMs: number;
}

export interface PackedFile {
  path: string;
  size: number;
}

export interface CandidateReport {
  package: string;
  version: string;
  proposedTag: string;
  commit: string;
  commitSubject: string;
  commitBound: boolean;
  generatedAt: string;
  tarball: { filename: string; sha256: string; bytes: number; unpackedBytes: number; entryCount: number } | null;
  manifest: PackedFile[];
  steps: StepResult[];
  ok: boolean;
}

// ── process helpers ─────────────────────────────────────────────────────────

/**
 * npm's own JS entrypoint, so npm can be run as `node <cli> ...` with a plain
 * argument array. Spawning `npm.cmd` would require shell:true on Windows, which
 * concatenates arguments back into a command string — the exact construction the
 * repository forbids.
 */
export function npmCliPath(): string {
  const fromEnv = process.env["npm_execpath"];
  if (fromEnv && fromEnv.endsWith(".js") && existsSync(fromEnv)) return fromEnv;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  throw new Error("could not locate npm's JS entrypoint; run this through `npm run release:candidate`");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 900_000): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    // No shell. Ever. Arguments stay arguments.
    shell: false,
  });
  if (result.error) return { code: null, stdout: result.stdout ?? "", stderr: String(result.error.message) };
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n").trim();
}

/**
 * The part of a node:test run that says what broke.
 *
 * The last N lines of a test run are the summary and, often, the tail of the
 * PASSING output — so a plain tail() of a failed suite can read as if it
 * succeeded. Prefer the failure block; fall back to the tail only when there
 * isn't one.
 */
function failureExcerpt(stdout: string, lines = 30): string {
  const marker = stdout.indexOf("failing tests:");
  if (marker >= 0) return tail(stdout.slice(marker), lines);
  const failed = stdout
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:✖|not ok\b)/.test(line) || /AssertionError|Error:/.test(line));
  return failed.length > 0 ? failed.slice(0, lines).join("\n") : tail(stdout, lines);
}

// ── the runner ──────────────────────────────────────────────────────────────

class Sequence {
  readonly steps: StepResult[] = [];
  private failed = false;

  /** Record a step. Once one fails, every later step is recorded as not-run. */
  step(name: string, body: () => string | undefined): boolean {
    if (this.failed) {
      this.steps.push({ name, status: "not-run", detail: "an earlier step failed", durationMs: 0 });
      return false;
    }
    const started = Date.now();
    try {
      const detail = body();
      this.steps.push({ name, status: "pass", detail: detail ?? "", durationMs: Date.now() - started });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.steps.push({ name, status: "fail", detail, durationMs: Date.now() - started });
      this.failed = true;
      return false;
    }
  }

  skip(name: string, why: string): void {
    this.steps.push({ name, status: "not-run", detail: why, durationMs: 0 });
  }

  get ok(): boolean {
    return !this.failed && this.steps.every((s) => s.status !== "fail");
  }
}

export interface CandidateOptions {
  /** Proceed against a dirty tree; the report is then marked commitBound:false. */
  allowDirty?: boolean;
  /** Run the whole `npm test` suite (release.yml does; it is slow off CI). */
  fullTests?: boolean;
  /** Where scratch worktrees, packs and install prefixes go. */
  scratchRoot?: string;
}

export function runReleaseCandidate(repoRoot: string, options: CandidateOptions = {}): CandidateReport {
  const seq = new Sequence();
  const npmCli = npmCliPath();
  const npm = (args: string[], cwd: string, timeoutMs?: number): RunResult =>
    run(process.execPath, [npmCli, ...args], cwd, timeoutMs);

  const manifestPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string; version: string };
  const version = pkg.version;
  const proposedTag = `v${version}`;

  let commit = "";
  let commitSubject = "";
  let commitBound = true;

  seq.step("commit-identity", () => {
    const head = run("git", ["rev-parse", "HEAD"], repoRoot);
    if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${tail(head.stderr)}`);
    commit = head.stdout.trim();
    const subject = run("git", ["log", "-1", "--format=%s", commit], repoRoot);
    commitSubject = subject.code === 0 ? subject.stdout.trim() : "";
    const status = run("git", ["status", "--porcelain"], repoRoot);
    if (status.code !== 0) throw new Error(`git status failed: ${tail(status.stderr)}`);
    const dirty = status.stdout.trim();
    if (dirty) {
      commitBound = false;
      if (!options.allowDirty) {
        throw new Error(
          `working tree is dirty, so this candidate would not be bound to ${commit.slice(0, 8)}:\n${tail(dirty, 20)}`,
        );
      }
      return `PROCEEDING AGAINST A DIRTY TREE (--allow-dirty): evidence is NOT bound to ${commit.slice(0, 8)}`;
    }
    return `${commit} — ${commitSubject}`;
  });

  const scratchRoot = options.scratchRoot ?? tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "aether-rc-"));
  const stage = join(scratch, "src");
  const packDir = join(scratch, "pack");
  const prefix = join(scratch, "prefix");
  let worktreeAdded = false;

  let tarball: CandidateReport["tarball"] = null;
  let manifest: PackedFile[] = [];

  const report = (): CandidateReport => ({
    package: pkg.name,
    version,
    proposedTag,
    commit,
    commitSubject,
    commitBound,
    generatedAt: new Date().toISOString(),
    tarball,
    manifest,
    steps: seq.steps,
    ok: seq.ok && commitBound,
  });

  try {
    // 1. Stage the commit. release.yml checks out the tag into a clean tree;
    //    a detached worktree is the same thing without needing the tag to exist.
    seq.step("stage-commit", () => {
      if (options.allowDirty && !commitBound) {
        cpSyncTree(repoRoot, stage);
        return "copied the dirty working tree (--allow-dirty)";
      }
      const added = run("git", ["worktree", "add", "--detach", stage, commit], repoRoot);
      if (added.code !== 0) throw new Error(`git worktree add failed: ${tail(added.stderr || added.stdout)}`);
      worktreeAdded = true;
      return stage;
    });

    // 2..4 mirror release.yml: ci --ignore-scripts, audit, then the suite.
    seq.step("npm-ci-ignore-scripts", () => {
      const r = npm(["ci", "--ignore-scripts"], stage);
      if (r.code !== 0) throw new Error(`npm ci failed: ${tail(r.stderr || r.stdout)}`);
      return tail(r.stdout, 2);
    });

    seq.step("npm-audit-high", () => {
      const r = npm(["audit", "--audit-level=high"], stage);
      if (r.code !== 0) throw new Error(`npm audit --audit-level=high failed: ${tail(r.stdout || r.stderr)}`);
      return tail(r.stdout, 3);
    });

    seq.step("typecheck", () => {
      const r = npm(["run", "typecheck"], stage);
      if (r.code !== 0) throw new Error(`typecheck failed: ${tail(r.stderr || r.stdout)}`);
      return "tsc --noEmit exit 0";
    });

    seq.step("build", () => {
      const r = npm(["run", "build"], stage);
      if (r.code !== 0) throw new Error(`build failed: ${tail(r.stderr || r.stdout)}`);
      return tail(r.stdout, 2);
    });

    if (options.fullTests) {
      seq.step("npm-test", () => {
        const r = npm(["test"], stage, 3_600_000);
        if (r.code !== 0) throw new Error(`npm test failed: ${failureExcerpt(r.stdout || r.stderr)}`);
        return tail(r.stdout, 6);
      });
      seq.skip("release-tests", "covered by the full npm test run");
    } else {
      // The whole suite is release.yml's gate and stays so. Here we run only the
      // release-owned files, and say plainly that the rest was NOT run.
      seq.step("release-tests", () => {
        const files = RELEASE_TEST_FILES.map((name) => join(stage, "dist", "test", name)).filter((p) => existsSync(p));
        if (files.length !== RELEASE_TEST_FILES.length) {
          const missing = RELEASE_TEST_FILES.filter((n) => !existsSync(join(stage, "dist", "test", n)));
          throw new Error(`compiled release tests missing: ${missing.join(", ")}`);
        }
        const r = run(process.execPath, ["--test", ...files], stage, 600_000);
        if (r.code !== 0) throw new Error(`release tests failed: ${failureExcerpt(r.stdout || r.stderr)}`);
        return `${RELEASE_TEST_FILES.length} release test files, exit 0`;
      });
      seq.skip(
        "npm-test",
        "NOT RUN here — the full suite is release.yml's gate. This report says nothing about it.",
      );
    }

    // 5. The production policy gate, bound to the tag we intend to create.
    seq.step("verify-production", () => {
      const r = npm(["run", "verify:production", "--", "--tag", proposedTag], stage);
      if (r.code !== 0) throw new Error(`verify:production failed: ${tail(r.stdout || r.stderr, 30)}`);
      // verify:production builds first, so its own JSON verdict is the LAST
      // line; a 2-line tail would report the build's output as the result.
      return tail(r.stdout, 1);
    });

    // 6. Pack, and take the digest of the exact bytes.
    seq.step("pack", () => {
      mkdirSync(packDir, { recursive: true });
      const r = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], stage);
      if (r.code !== 0) throw new Error(`npm pack failed: ${tail(r.stderr || r.stdout)}`);
      const parsed = JSON.parse(extractJson(r.stdout)) as Array<{
        filename: string;
        size: number;
        unpackedSize: number;
        entryCount: number;
        files: PackedFile[];
      }>;
      const packed = parsed[0];
      if (!packed?.filename) throw new Error("npm pack produced no filename");
      const file = join(packDir, packed.filename);
      const bytes = readFileSync(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      tarball = {
        filename: packed.filename,
        sha256,
        bytes: bytes.byteLength,
        unpackedBytes: packed.unpackedSize,
        entryCount: packed.entryCount,
      };
      manifest = packed.files.map((f) => ({ path: f.path.replaceAll("\\", "/"), size: f.size }));
      return `${packed.filename} sha256:${sha256}`;
    });

    // 7. Install THAT tarball into a clean prefix. Everything after this point
    //    exercises the installed package, not the source checkout.
    seq.step("install-tarball", () => {
      if (!tarball) throw new Error("no tarball to install");
      const file = join(packDir, tarball.filename);
      const r = npm(["install", "--global", "--prefix", prefix, file, "--ignore-scripts"], stage);
      if (r.code !== 0) throw new Error(`global install failed: ${tail(r.stderr || r.stdout)}`);
      const installed = installedPackageDir(prefix, pkg.name);
      if (!existsSync(installed)) throw new Error(`install left no package at ${installed}`);
      return installed;
    });

    // Prefer the bin shim npm actually put on PATH — that is the entrypoint a
    // user runs. Windows global installs produce aether.cmd, which would need a
    // shell to invoke, so there we run the package's own main.js under node:
    // same file the shim would reach, without building a command string.
    const cli = (args: string[], cwd: string): RunResult => {
      const shim = join(prefix, "bin", "aether");
      if (process.platform !== "win32" && existsSync(shim)) return run(shim, args, cwd, 180_000);
      const entry = join(installedPackageDir(prefix, pkg.name), "dist", "src", "main.js");
      return run(process.execPath, [entry, ...args], cwd, 180_000);
    };

    seq.step("installed --version", () => {
      const r = cli(["--version"], scratch);
      if (r.code !== 0) throw new Error(`--version exited ${String(r.code)}: ${tail(r.stderr)}`);
      const reported = r.stdout.trim();
      if (reported !== version) throw new Error(`installed CLI reported ${reported}, expected ${version}`);
      return reported;
    });

    seq.step("installed --help", () => {
      const r = cli(["--help"], scratch);
      if (r.code !== 0) throw new Error(`--help exited ${String(r.code)}: ${tail(r.stderr)}`);
      for (const command of HELP_MUST_LIST) {
        if (!r.stdout.includes(command)) throw new Error(`--help does not list the ${command} command`);
      }
      return `${r.stdout.split(/\r?\n/).length} lines, lists ${HELP_MUST_LIST.join(", ")}`;
    });

    seq.step("installed skills list", () => {
      const r = cli(["skills", "list"], scratch);
      if (r.code !== 0) throw new Error(`skills list exited ${String(r.code)}: ${tail(r.stderr || r.stdout)}`);
      if (!r.stdout.trim()) throw new Error("skills list printed nothing");
      return tail(r.stdout, 4);
    });

    seq.step("installed capabilities", () => {
      const r = cli(["capabilities"], scratch);
      if (r.code !== 0) throw new Error(`capabilities exited ${String(r.code)}: ${tail(r.stderr || r.stdout)}`);
      if (!r.stdout.trim()) throw new Error("capabilities printed nothing");
      return tail(r.stdout, 4);
    });

    // 8. The handoff demo, driven against the INSTALLED package. The demo
    //    harness is not shipped (the allowlist is dist/src plus reviewed public docs), so
    //    the harness is copied beside the installed package and resolves the CLI
    //    and its imports from the package's own dist/src — the tarball's code,
    //    not the checkout's.
    seq.step("installed demo:handoff", () => {
      const source = join(stage, "dist", "scripts", "handoff-demo.js");
      if (!existsSync(source)) throw new Error(`built handoff demo missing at ${source}`);
      const installed = installedPackageDir(prefix, pkg.name);
      const target = join(installed, "dist", "scripts", "handoff-demo.js");
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
      const r = run(process.execPath, [target], scratch, 600_000);
      if (r.code !== 0) throw new Error(`handoff demo exited ${String(r.code)}: ${tail(r.stdout || r.stderr, 30)}`);
      return tail(r.stdout, 6);
    });
  } finally {
    // Cleanup must never replace the verdict. A locked file in a Windows global
    // prefix is a housekeeping problem; throwing here would discard a completed
    // report and read as a failed release candidate.
    try {
      if (worktreeAdded) run("git", ["worktree", "remove", "--force", stage], repoRoot);
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // leave the scratch directory behind rather than lose the evidence
    }
  }

  return report();
}

/** npm's platform-specific global package directory under an explicit prefix. */
export function installedPackageDir(
  prefix: string,
  packageName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? join(prefix, "node_modules", packageName)
    : join(prefix, "lib", "node_modules", packageName);
}

/**
 * The JSON array from `npm pack --json`.
 *
 * npm writes notices to stderr, but a warning line on stdout containing a
 * bracket would derail a first-bracket-to-last-bracket slice, so anchor on the
 * first line that BEGINS a JSON array instead.
 */
function extractJson(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith("["));
  if (start < 0) throw new Error("npm pack did not emit a JSON array");
  const text = lines.slice(start).join("\n");
  const end = text.lastIndexOf("]");
  if (end < 0) throw new Error("npm pack emitted an unterminated JSON array");
  return text.slice(0, end + 1);
}

function cpSyncTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(src),
  });
}

/**
 * Release-owned test files, by compiled name. These run in the default (fast)
 * mode; the rest of the suite is release.yml's job and is reported not-run.
 */
export const RELEASE_TEST_FILES = [
  "version.test.js",
  "release_coherence.test.js",
  "release_canaries.test.js",
  "production_hardening.test.js",
];

/** Commands `aether --help` must name, because the release notes promise them. */
export const HELP_MUST_LIST = ["skills", "capabilities", "resume", "agent", "doctor"];

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const out = outAt >= 0 ? argv[outAt + 1] : undefined;
  if (outAt >= 0 && !out) throw new Error("--out requires a path");
  const result = runReleaseCandidate(process.cwd(), {
    allowDirty: argv.includes("--allow-dirty"),
    fullTests: argv.includes("--full-tests"),
    ...(process.env["AETHER_RC_SCRATCH"] ? { scratchRoot: process.env["AETHER_RC_SCRATCH"] } : {}),
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  for (const step of result.steps) {
    process.stderr.write(`${step.status.toUpperCase().padEnd(8)} ${step.name}${step.detail ? ` — ${step.detail.split("\n")[0]}` : ""}\n`);
  }
  process.stderr.write(result.ok ? "\nRELEASE CANDIDATE OK\n" : "\nRELEASE CANDIDATE NOT OK\n");
  process.exit(result.ok ? 0 : 1);
}
