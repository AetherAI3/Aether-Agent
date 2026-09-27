import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDevice, DEVICE_EXIT, deviceHealthState, resolveEnrollBaseUrl } from "../src/commands/device.js";
import { findDispatchedCliCommand } from "../src/commands/cli_registry.js";
import { checkpointDir } from "../src/core/device_runtime/paths.js";
import { loadEnrollment, saveEnrollment } from "../src/core/device_runtime/identity.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { deviceRuntimeEnabled } from "../src/core/device_runtime/enablement.js";
import type { AppContext } from "../src/core/context.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";

const NOOP_FLAGS: CommandFlags = {
  bool: () => false,
  str: () => undefined,
  list: () => [],
};

function flagsWith(values: Record<string, string>): CommandFlags {
  return { bool: () => false, str: (name) => values[name], list: () => [] };
}

function fakeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    cfg: { ...DEFAULT_CONFIG },
    api: { postJson: async () => ({}) } as unknown as AppContext["api"],
    tokens: {
      get: async () => "sess-token",
      set: async () => {},
      clear: async () => {},
    },
    flags: { json: true, audit: false, yes: false, cwd: process.cwd() } as AppContext["flags"],
    confirm: async () => false,
    ...overrides,
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    (process.stdout.write as unknown) = original;
  }
}

function withConfigDir<T>(body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-cmd2-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  return body().finally(() => {
    if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prior;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("device is wired into the dispatch table", () => {
  const dispatched = findDispatchedCliCommand("device");
  assert.ok(dispatched, "aether device must resolve to a dispatched command");
});

test("device status reports unenrolled + not running as JSON", async () => {
  await withConfigDir(async () => {
    const { code, out } = await capture(() => cmdDevice(fakeCtx(), ["status"], NOOP_FLAGS));
    assert.equal(code, DEVICE_EXIT.ok);
    const summary = JSON.parse(out) as { enrolled: boolean; running: boolean; enabled: boolean };
    assert.equal(summary.enrolled, false);
    assert.equal(summary.running, false);
    assert.equal(summary.enabled, false);
  });
});

test("device groups reports an empty list", async () => {
  await withConfigDir(async () => {
    const { out } = await capture(() => cmdDevice(fakeCtx(), ["groups"], NOOP_FLAGS));
    assert.deepEqual(JSON.parse(out), { groups: [] });
  });
});

test("device last reports unenrolled without leaking secrets", async () => {
  await withConfigDir(async () => {
    const { out } = await capture(() => cmdDevice(fakeCtx(), ["last"], NOOP_FLAGS));
    assert.deepEqual(JSON.parse(out), { enrolled: false });
  });
});

test("device enroll saves the enrollment record", async () => {
  await withConfigDir(async () => {
    const ctx = fakeCtx({
      api: {
        postJson: async () => ({
          device_id: "dev-99",
          device_token: "dtok",
          device_command_key: "dkey",
          display_name: "host",
        }),
      } as unknown as AppContext["api"],
    });
    const { code, out } = await capture(() => cmdDevice(ctx, ["enroll"], NOOP_FLAGS));
    assert.equal(code, DEVICE_EXIT.ok);
    assert.match(out, /dev-99/);
    const record = loadEnrollment();
    assert.equal(record?.device_id, "dev-99");
    assert.equal(record?.device_command_key, "dkey");
  });
});

test("device enroll refuses without a session token", async () => {
  await withConfigDir(async () => {
    const ctx = fakeCtx({
      tokens: { get: async () => null, set: async () => {}, clear: async () => {} },
    });
    const code = await capture(() => cmdDevice(ctx, ["enroll"], NOOP_FLAGS));
    assert.equal(code.code, DEVICE_EXIT.notEnrolled);
  });
});

test("device start refuses when the runtime is disabled", async () => {
  await withConfigDir(async () => {
    const prior = process.env["AETHER_DEVICE_RUNTIME"];
    delete process.env["AETHER_DEVICE_RUNTIME"];
    try {
      const code = await capture(() => cmdDevice(fakeCtx(), ["start"], NOOP_FLAGS));
      assert.equal(code.code, DEVICE_EXIT.disabled);
    } finally {
      if (prior !== undefined) process.env["AETHER_DEVICE_RUNTIME"] = prior;
    }
  });
});

test("an unknown subcommand returns a usage error", async () => {
  const code = await capture(() => cmdDevice(fakeCtx(), ["frobnicate"], NOOP_FLAGS));
  assert.equal(code.code, DEVICE_EXIT.usage);
});

// ── --base-url on enroll ────────────────────────────────────────────────────

test("device owns the --base-url flag in the dispatch table", () => {
  const dispatched = findDispatchedCliCommand("device");
  assert.ok(dispatched, "aether device must be dispatched");
  assert.equal(dispatched.flags?.["base-url"]?.type, "string", "--base-url must be a declared string flag");
});

test("resolveEnrollBaseUrl: the flag wins, config is the fallback", () => {
  assert.deepEqual(resolveEnrollBaseUrl("https://config.example.test", "https://flag.example.test"), {
    ok: true,
    url: "https://flag.example.test",
  });
  assert.deepEqual(resolveEnrollBaseUrl("https://config.example.test", undefined), {
    ok: true,
    url: "https://config.example.test",
  });
  // Loopback http is allowed (local dev backend); remote http is not.
  assert.equal(resolveEnrollBaseUrl("https://c.test", "http://127.0.0.1:8787").ok, true);
});

test("resolveEnrollBaseUrl REFUSES a URL that would put the device bearer in cleartext", () => {
  for (const unsafe of ["http://cloud.example.com", "ftp://host/x", "not a url", "  "]) {
    const res = resolveEnrollBaseUrl("https://config.example.test", unsafe);
    assert.equal(res.ok, false, `${unsafe} must be refused`);
  }
  // And with neither a flag nor config there is nothing to enroll against.
  assert.equal(resolveEnrollBaseUrl("", undefined).ok, false);
});

test("device enroll --base-url persists the override into the enrollment record", async () => {
  await withConfigDir(async () => {
    const ctx = fakeCtx({
      cfg: { ...DEFAULT_CONFIG, baseUrl: "https://config.example.test" },
      api: {
        postJson: async () => ({ device_id: "dev-flag", device_token: "t", device_command_key: "k" }),
      } as unknown as AppContext["api"],
    });
    const { code } = await capture(() =>
      cmdDevice(ctx, ["enroll"], flagsWith({ "base-url": "https://laptop-cloud.example.test/cloud" })),
    );
    assert.equal(code, DEVICE_EXIT.ok);
    assert.equal(loadEnrollment()?.base_url, "https://laptop-cloud.example.test/cloud");
  });
});

test("device enroll without --base-url still uses config, unchanged", async () => {
  await withConfigDir(async () => {
    const ctx = fakeCtx({
      cfg: { ...DEFAULT_CONFIG, baseUrl: "https://config.example.test" },
      api: {
        postJson: async () => ({ device_id: "dev-cfg", device_token: "t", device_command_key: "k" }),
      } as unknown as AppContext["api"],
    });
    await capture(() => cmdDevice(ctx, ["enroll"], NOOP_FLAGS));
    assert.equal(loadEnrollment()?.base_url, "https://config.example.test");
  });
});

test("device enroll refuses an unsafe --base-url and writes NO enrollment", async () => {
  await withConfigDir(async () => {
    let posted = false;
    const ctx = fakeCtx({
      api: {
        postJson: async () => {
          posted = true;
          return { device_id: "d", device_token: "t", device_command_key: "k" };
        },
      } as unknown as AppContext["api"],
    });
    const { code } = await capture(() =>
      cmdDevice(ctx, ["enroll"], flagsWith({ "base-url": "http://cloud.example.com" })),
    );
    assert.equal(code, DEVICE_EXIT.usage);
    assert.equal(posted, false, "an unsafe base URL must be refused before any request is made");
    assert.equal(loadEnrollment(), null);
  });
});

// ── The persistent opt-in ───────────────────────────────────────────────────

test("device enable / disable flips the persistent default-off switch", async () => {
  await withConfigDir(async () => {
    const prior = process.env["AETHER_DEVICE_RUNTIME"];
    delete process.env["AETHER_DEVICE_RUNTIME"];
    try {
      const ctx = fakeCtx();
      // Default: off, and start refuses.
      assert.equal(deviceRuntimeEnabled(loadConfig()), false);
      assert.equal((await capture(() => cmdDevice(ctx, ["start"], NOOP_FLAGS))).code, DEVICE_EXIT.disabled);

      await capture(() => cmdDevice(ctx, ["enable"], NOOP_FLAGS));
      assert.equal(deviceRuntimeEnabled(loadConfig()), true, "enable must persist to config");
      assert.equal(ctx.cfg.deviceRuntime?.enabled, true, "the live context must see it too");

      await capture(() => cmdDevice(ctx, ["disable"], NOOP_FLAGS));
      assert.equal(deviceRuntimeEnabled(loadConfig()), false, "disable must persist to config");
      // And a fresh context reading only config refuses to start again.
      assert.equal((await capture(() => cmdDevice(fakeCtx(), ["start"], NOOP_FLAGS))).code, DEVICE_EXIT.disabled);
    } finally {
      if (prior !== undefined) process.env["AETHER_DEVICE_RUNTIME"] = prior;
    }
  });
});

test("disable reports honestly when the env override still wins", async () => {
  await withConfigDir(async () => {
    const prior = process.env["AETHER_DEVICE_RUNTIME"];
    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    try {
      const { out } = await capture(() => cmdDevice(fakeCtx(), ["disable"], NOOP_FLAGS));
      const summary = JSON.parse(out) as { enabled: boolean; env_override: boolean };
      assert.equal(summary.enabled, false);
      assert.equal(summary.env_override, true, "the env override must be surfaced, not silently overridden");
    } finally {
      if (prior === undefined) delete process.env["AETHER_DEVICE_RUNTIME"];
      else process.env["AETHER_DEVICE_RUNTIME"] = prior;
    }
  });
});

// ── Health state ────────────────────────────────────────────────────────────

test("deviceHealthState collapses the axes, most-blocking first", () => {
  const base = { enabled: true, enrolled: true, running: true, stale: false, online: true };
  assert.equal(deviceHealthState({ ...base, enabled: false }), "disabled");
  assert.equal(deviceHealthState({ ...base, enabled: false, enrolled: false }), "disabled");
  assert.equal(deviceHealthState({ ...base, enrolled: false }), "unenrolled");
  assert.equal(deviceHealthState({ ...base, running: false }), "eligible");
  assert.equal(deviceHealthState({ ...base, stale: true }), "stale");
  assert.equal(deviceHealthState({ ...base, online: false }), "offline");
  assert.equal(deviceHealthState(base), "healthy");
});

test("device status --json carries a state field and no secret", async () => {
  await withConfigDir(async () => {
    const { out } = await capture(() => cmdDevice(fakeCtx(), ["status"], NOOP_FLAGS));
    const summary = JSON.parse(out) as Record<string, unknown>;
    assert.equal(summary["state"], "disabled", "a default-off device reports disabled");
    // Nothing resembling a credential is in the status payload.
    assert.equal(Object.keys(summary).some((k) => /token|key|secret/i.test(k)), false);
  });
});

test("device last reports the checkpoint surface without leaking its contents", async () => {
  await withConfigDir(async () => {
    const record = {
      device_id: "dev-cp",
      device_token: "tok-secret-value",
      device_command_key: "key-secret-value",
      display_name: "host",
      base_url: "https://api.example.test",
      enrolled_at: 0,
    };
    saveEnrollment(record);
    mkdirSync(checkpointDir(), { recursive: true });
    writeFileSync(
      join(checkpointDir(), "cp-1.json"),
      JSON.stringify({ id: "cp-1", kind: "drain_checkpoint", handoff_id: "ho-9", change_digest: "sha256:" + "a".repeat(64), at: 5 }),
    );
    const { out } = await capture(() => cmdDevice(fakeCtx(), ["last"], NOOP_FLAGS));
    const summary = JSON.parse(out) as { last_checkpoint: { id: string; kind: string; handoff_id: string } | null };
    assert.equal(summary.last_checkpoint?.id, "cp-1");
    assert.equal(summary.last_checkpoint?.handoff_id, "ho-9");
    assert.equal(out.includes(record.device_token), false, "the device token must never be printed");
    assert.equal(out.includes(record.device_command_key), false, "the command key must never be printed");
  });
});
