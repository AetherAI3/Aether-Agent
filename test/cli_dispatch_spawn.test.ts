import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Spawn-level proof that the dispatch table is the real front door. main()
// runs at module load, so the only honest way to assert "this command actually
// executed, with these flags" is to run the built CLI and read what came back.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runCli(
  args: string[],
  cfgDir: string,
  cwd?: string,
): Promise<{ exit: number | string; out: string; err: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [join(root, "dist", "src", "main.js"), ...args], {
        ...(cwd ? { cwd } : {}),
        env: {
          ...process.env,
          // Closed port → instant ECONNREFUSED for anything that reaches out.
          AETHER_BASE_URL: "http://127.0.0.1:9",
          AETHER_CONFIG_DIR: cfgDir,
          AETHER_NO_ANIM: "1",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exit: "SPAWN_BLOCKED", out: "", err: String(err) });
      return;
    }
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => (out += String(d)));
    child.stderr!.on("data", (d: Buffer) => (err += String(d)));
    const to = setTimeout(() => {
      child.kill();
      resolve({ exit: "TIMEOUT", out, err });
    }, 60000);
    child.on("exit", (c) => {
      clearTimeout(to);
      resolve({ exit: c ?? -1, out, err });
    });
  });
}

async function withCli(
  t: { skip: (m: string) => void },
  args: string[],
  body: (r: { exit: number | string; out: string; err: string }) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aether-dispatch-"));
  try {
    const r = await runCli(args, dir);
    if (r.exit === "SPAWN_BLOCKED") {
      t.skip("sandbox blocks child process spawning");
      return;
    }
    body(r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a dispatch-table command runs the command, not chat", async (t) => {
  await withCli(t, ["doctor", "--json"], (r) => {
    const report = JSON.parse(r.out);
    assert.equal(report.mode, "fast");
    assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  });
});

test("settings and Voice dispatch without falling through to a hosted chat", async (t) => {
  await withCli(t, ["settings", "list", "Voice", "--json"], (r) => {
    assert.equal(r.exit, 0);
    const report = JSON.parse(r.out) as { protocol: string; command: string; data: { settings: unknown[] } };
    assert.equal(report.protocol, "aether.settings/1");
    assert.equal(report.command, "list");
    assert.ok(report.data.settings.length > 0);
    assert.doesNotMatch(r.err, /ECONNREFUSED|chat/i);
  });

  await withCli(t, ["voice", "status", "--json"], (r) => {
    assert.equal(r.exit, 0);
    const report = JSON.parse(r.out) as { command: string; state: string; runtime: string };
    assert.equal(report.command, "voice.status");
    assert.equal(report.state, "off");
    assert.equal(report.runtime, "unavailable");
    assert.doesNotMatch(r.err, /ECONNREFUSED|chat/i);
  });
});

test("--live reaches the command and produces the live report", async (t) => {
  // Regression pin. Before the flag table included --live,
  // `--live` was captured as an undeclared global and stripped from the argv
  // doctor was handed: the end-to-end proof silently degraded to the fast
  // configured-only report while still exiting 0. Unknown rendered as verified.
  await withCli(t, ["doctor", "--live", "--no-ui", "--json"], (r) => {
    const report = JSON.parse(r.out);
    assert.equal(report.mode, "live");
  });
});

test("a misspelled doctor option fails before running the fast report", async (t) => {
  await withCli(t, ["doctor", "--lve", "--json"], (r) => {
    assert.equal(r.exit, 2);
    assert.match(r.err, /Unknown option '--lve'/);
    assert.equal(r.out, "");
  });
});

test("unknown options fail even when --version would otherwise exit successfully", async (t) => {
  await withCli(t, ["--version", "--not-a-real-flag"], (r) => {
    assert.equal(r.exit, 2);
    assert.match(r.err, /Unknown option '--not-a-real-flag'/);
    assert.equal(r.out, "");
  });
});

test("bare positionals and options after -- remain accepted", async (t) => {
  await withCli(t, ["--version", "bare prompt", "--", "--not-a-real-flag"], (r) => {
    assert.equal(r.exit, 0);
    assert.match(r.out, /^\d+\.\d+\.\d+/);
    assert.equal(r.err, "");
  });
});

test("a flag-shaped value of a declared string option stays a value", async (t) => {
  await withCli(t, ["doctor", "--fix", "--only=--lve"], (r) => {
    assert.equal(r.exit, 2);
    assert.match(r.out, /unknown repair --lve/);
    assert.doesNotMatch(r.err, /Unknown option/);
  });
});

test("a declared boolean flag reaches the command it belongs to", async (t) => {
  await withCli(t, ["doctor", "--deep"], (r) => {
    assert.match(r.out, /--deep is the read-only report/);
  });
});

test("a repeatable flag's value reaches the command intact", async (t) => {
  await withCli(t, ["doctor", "--fix", "--only", "state.temp", "--only", "no-such-repair"], (r) => {
    assert.equal(r.exit, 2);
    assert.match(r.out, /unknown repair no-such-repair/);
    assert.equal(r.out.includes("state.temp"), true);
  });
});

test("a hostile flag value stays one argv element and reaches no shell", async (t) => {
  const hostile = '"; rm -rf / #';
  await withCli(t, ["doctor", "--fix", "--only", hostile], (r) => {
    assert.equal(r.exit, 2);
    // Echoed back verbatim as one unknown repair id — not split, not expanded.
    assert.ok(r.out.includes(`unknown repair ${hostile}`), r.out);
  });
});

test("a flag-shaped --only value stays a value", async (t) => {
  // The parsed value is handed to doctor as data, so there is no second parse
  // for "--fix" to be promoted by. Asserted on the report the command produced
  // rather than on prose: fix mode would have printed a repair plan instead.
  await withCli(t, ["doctor", "--only=--fix", "--json"], (r) => {
    const report = JSON.parse(r.out);
    assert.equal(report.mode, "fast");
  });
});

test("a near-miss for a table command still hits the typo guard, not chat", async (t) => {
  await withCli(t, ["doctr"], (r) => {
    assert.equal(r.exit, 2);
    assert.match(r.err, /did you mean: aether doctor\?/);
  });
});

/**
 * The mutating path, asserted on disk.
 *
 * `aether doctor --fix` has never reached `cmdDoctor` at all — `--fix` and
 * `--yes` were both swallowed before the command saw them — so declaring them
 * makes a never-exercised repair path reachable in a user's hands for the
 * first time. What stands between a printed plan and four real mutations is
 * the `--yes` check, and until now the only evidence it holds was a printed
 * sentence. These assert the file.
 *
 * `state.temp` is the repair used: it unlinks `.*.tmp` files under
 * `./aether-output` older than an hour, resolved from the child's own cwd, so
 * the whole test lives inside a throwaway directory.
 */
async function withStaleTemp(
  t: { skip: (m: string) => void },
  args: string[],
  body: (r: { exit: number | string; out: string }, tempExists: () => boolean) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aether-fix-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "aether-fix-cfg-"));
  try {
    const outputDir = join(dir, "aether-output");
    mkdirSync(outputDir);
    const temp = join(outputDir, ".abandoned.tmp");
    writeFileSync(temp, "an interrupted write");
    const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(temp, twoHoursAgo, twoHoursAgo);
    const r = await runCli(args, cfgDir, dir);
    if (r.exit === "SPAWN_BLOCKED") {
      t.skip("sandbox blocks child process spawning");
      return;
    }
    body(r, () => existsSync(temp));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
}

test("--fix without --yes changes nothing on disk", async (t) => {
  await withStaleTemp(t, ["doctor", "--fix"], (r, tempExists) => {
    assert.match(r.out, /state.temp/);
    assert.equal(tempExists(), true, "the abandoned temp file was deleted without --yes");
  });
});

test("--yes without --fix changes nothing on disk", async (t) => {
  await withStaleTemp(t, ["doctor", "--yes"], (_r, tempExists) => {
    assert.equal(tempExists(), true, "a repair ran with no --fix");
  });
});

test("--fix --yes does apply the plan — so the two refusals above are not vacuous", async (t) => {
  await withStaleTemp(t, ["doctor", "--fix", "--yes"], (r, tempExists) => {
    assert.match(r.out, /applied {2}state.temp/);
    assert.equal(tempExists(), false, "the repair did not actually run");
  });
});
