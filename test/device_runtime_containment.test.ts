import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContainmentManager,
  type LaunchSpec,
  type WardenHandle,
} from "../src/core/device_runtime/containment.js";

class MockWarden implements WardenHandle {
  calls: string[] = [];
  members: number[] = [];
  failTerminate = false;
  async ping(): Promise<void> {}
  async create(name: string): Promise<void> {
    this.calls.push(`create:${name}`);
  }
  async assign(pid: number): Promise<void> {
    this.calls.push(`assign:${pid}`);
  }
  async list(): Promise<number[]> {
    return this.members;
  }
  async terminate(): Promise<void> {
    if (this.failTerminate) throw new Error("terminate failed");
    this.calls.push("terminate");
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
}

function sandbox(): { dir: string; exe: string; sha: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-cont-"));
  const exe = join(dir, "task.bin");
  writeFileSync(exe, "#!fake executable\n");
  const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  return {
    dir,
    exe: realpathSync(exe),
    sha,
    restore: () => {
      if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
      else process.env["AETHER_CONFIG_DIR"] = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spec(exe: string, sha: string): LaunchSpec {
  return {
    owner: "op",
    project: "proj",
    workspace_id: "ws",
    task_id: "task",
    exe_path: exe,
    exe_sha256: sha,
    trusted_publisher: null,
    command_classes: ["emergency_terminate"],
    lease_epoch: 1,
    fence_token: "fence-1",
    expires_at: Date.now() + 60_000,
    policy_digest: "sha256:" + "0".repeat(64),
    args: [],
    cwd: process.cwd(),
  };
}

test("launchManaged verifies the exe hash, creates the job, and assigns the task", async () => {
  const box = sandbox();
  try {
    const warden = new MockWarden();
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => 999,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      now: () => 1000,
      uuid: () => "grp-fixed",
    });
    const reg = await mgr.launchManaged({ ...spec(box.exe, box.sha), device_id: "dev-owner" });
    assert.equal(reg.process_group_id, "grp-fixed");
    assert.equal(reg.device_id, "dev-owner", "a registration names the device it belongs to");
    assert.equal(reg.exe_sha256, box.sha);
    assert.equal(reg.parent_pid, 4321);
    assert.equal(reg.parent_start_time_ms, 999);
    assert.deepEqual(warden.calls, ["create:aether-dev-grp-fixed", "assign:4321"]);
  } finally {
    box.restore();
  }
});

test("launchManaged refuses an exe whose sha does not match (basename spoof)", async () => {
  const box = sandbox();
  try {
    const mgr = new ContainmentManager({
      wardenFactory: async () => new MockWarden(),
      spawnTask: () => ({ pid: 1, child: {} as never }),
      processStartTimeMs: () => 1,
      hashFileSha256: () => "f".repeat(64), // real file hashes to something else
      resolveExe: (p) => p,
    });
    await assert.rejects(() => mgr.launchManaged(spec(box.exe, box.sha)), /sha256 does not match/);
  } finally {
    box.restore();
  }
});

test("terminateManaged terminates the job when the pid/start_time still match", async () => {
  const box = sandbox();
  try {
    const warden = new MockWarden();
    warden.members = [4321, 4322];
    let startTime = 999;
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => startTime,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      uuid: () => "grp-1",
    });
    await mgr.launchManaged(spec(box.exe, box.sha));
    startTime = 999; // unchanged -> verified
    const res = await mgr.terminateManaged("grp-1");
    assert.equal(res.status, "terminated");
    assert.equal(res.via, "job-object");
    assert.deepEqual(res.members, [4321, 4322]);
    assert.ok(warden.calls.includes("terminate"));
  } finally {
    box.restore();
  }
});

test("terminateManaged BLOCKS the kill when the PID has been recycled", async () => {
  const box = sandbox();
  try {
    const warden = new MockWarden();
    let startTime = 999;
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => startTime,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      uuid: () => "grp-1",
    });
    await mgr.launchManaged(spec(box.exe, box.sha));
    startTime = 123456; // the PID now belongs to a different process
    const res = await mgr.terminateManaged("grp-1");
    assert.equal(res.status, "pid-reuse-blocked");
    assert.equal(warden.calls.includes("terminate"), false, "a recycled PID must not be signalled");
  } finally {
    box.restore();
  }
});

test("terminateManaged reports unknown for an unregistered group", async () => {
  const box = sandbox();
  try {
    const mgr = new ContainmentManager({ wardenFactory: async () => new MockWarden() });
    const res = await mgr.terminateManaged("nope");
    assert.equal(res.status, "unknown");
  } finally {
    box.restore();
  }
});

test("an UNREGISTERED target is never signalled — no job, no tree kill", async () => {
  const box = sandbox();
  try {
    const killed: number[] = [];
    const mgr = new ContainmentManager({
      wardenFactory: async () => new MockWarden(),
      treeKill: (pid) => killed.push(pid),
    });
    // The names an operator actually worries about. None of them was ever
    // registered, so none of them is reachable from this API at all.
    for (const impostor of ["chrome.exe", "Code.exe", "ChatGPT", "svchost.exe", "explorer.exe"]) {
      const res = await mgr.terminateManaged(impostor);
      assert.equal(res.status, "unknown", `${impostor} must be unknown, not a target`);
      assert.equal(res.via, "none");
    }
    assert.deepEqual(killed, [], "nothing outside the managed registry may be signalled");
  } finally {
    box.restore();
  }
});

test("a STALE (expired) registration is not a kill licence", async () => {
  const box = sandbox();
  try {
    const killed: number[] = [];
    let clock = 0;
    const mgr = new ContainmentManager({
      wardenFactory: async () => new MockWarden(),
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => 999,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      now: () => clock,
      uuid: () => "grp-stale",
      treeKill: (pid) => killed.push(pid),
    });
    await mgr.launchManaged({ ...spec(box.exe, box.sha), expires_at: 5_000 });
    clock = 10_000; // past expiry
    const res = await mgr.terminateManaged("grp-stale");
    assert.equal(res.status, "unknown", "an expired registration must not resolve");
    assert.deepEqual(killed, [], "an expired registration must not authorise a kill");
  } finally {
    box.restore();
  }
});

test("a FORGED registration with no verifiable parent identity is never PID-signalled", async () => {
  const box = sandbox();
  try {
    const killed: number[] = [];
    // A registration whose start-time probe failed at launch records 0. Later,
    // any PID could be sitting on that number — so the tree-kill fallback,
    // which signals by PID, must refuse it.
    const mgr = new ContainmentManager({
      wardenFactory: async () => new MockWarden(),
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => null,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      uuid: () => "grp-forged",
      treeKill: (pid) => killed.push(pid),
    });
    const reg = await mgr.launchManaged(spec(box.exe, box.sha));
    assert.equal(reg.parent_start_time_ms, 0, "an unprobeable parent records no start time");
    await mgr.shutdown(); // drop the warden, as a daemon restart would
    const res = await mgr.terminateManaged("grp-forged");
    assert.deepEqual(killed, [], "an unverifiable parent must never be signalled by PID");
    assert.equal(res.via, "none");
  } finally {
    box.restore();
  }
});

test("the taskkill-tree fallback fires only inside the managed boundary", async () => {
  const box = sandbox();
  try {
    const killed: number[] = [];
    const warden = new MockWarden();
    warden.failTerminate = true; // force the fallback path
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => 999,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      uuid: () => "grp-fb",
      treeKill: (pid) => killed.push(pid),
    });
    await mgr.launchManaged(spec(box.exe, box.sha));
    const res = await mgr.terminateManaged("grp-fb");
    assert.equal(res.via, "tree-kill-fallback");
    // It signalled the REGISTERED parent pid and nothing else.
    assert.deepEqual(killed, [4321]);
  } finally {
    box.restore();
  }
});

test("descendants are reachable only through the job — the fallback never enumerates them", async () => {
  const box = sandbox();
  try {
    const killed: number[] = [];
    const warden = new MockWarden();
    warden.members = [4321, 5555, 6666]; // task + two escaped-looking children
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => 999,
      hashFileSha256: () => box.sha,
      resolveExe: (p) => p,
      uuid: () => "grp-kids",
      treeKill: (pid) => killed.push(pid),
    });
    await mgr.launchManaged(spec(box.exe, box.sha));
    const res = await mgr.terminateManaged("grp-kids");
    assert.equal(res.via, "job-object");
    // The children died because they are IN the job, not because anything here
    // walked a process tree and signalled them individually.
    assert.deepEqual(res.members, [4321, 5555, 6666]);
    assert.deepEqual(killed, []);
  } finally {
    box.restore();
  }
});

test("a launch whose registration is refused leaves no running-but-unregistered job", async () => {
  const box = sandbox();
  try {
    const warden = new MockWarden();
    const mgr = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4321, child: {} as never }),
      processStartTimeMs: () => 999,
      // launchManaged's own check passes, but the registry rehashes and rejects.
      hashFileSha256: (p) => (p === box.exe ? box.sha : "0".repeat(64)),
      resolveExe: (p) => p,
      uuid: () => "grp-bad",
    });
    await assert.rejects(
      () => mgr.launchManaged({ ...spec(box.exe, box.sha), lease_epoch: -1 }),
      /refusing managed group registration/,
    );
    assert.ok(warden.calls.includes("close"), "the warden must be torn down on a refused registration");
  } finally {
    box.restore();
  }
});

// ── Real Windows Job Object integration ─────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test(
  "win32: a real Job Object terminates the task and its child",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const box = sandbox();
    try {
      const exe = realpathSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"));
      const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
      const mgr = new ContainmentManager();
      // The outer cmd runs a short ping, then a long one — so the long child is
      // spawned well AFTER the job assignment and is therefore inside the job.
      const reg = await mgr.launchManaged({
        ...spec(exe, sha),
        exe_path: exe,
        exe_sha256: sha,
        args: ["/c", "ping -n 2 127.0.0.1 >NUL & ping -n 30 127.0.0.1 >NUL"],
      });
      await delay(2000);
      const res = await mgr.terminateManaged(reg.process_group_id);
      assert.equal(res.status, "terminated");
      assert.ok(res.members.length >= 1, "the job should have listed at least the task process");

      // Poll until the parent (and thus its job) is gone.
      const deadline = Date.now() + 12_000;
      while (pidAlive(reg.parent_pid) && Date.now() < deadline) await delay(200);
      assert.equal(pidAlive(reg.parent_pid), false, "the terminated task PID is still alive");
      for (const pid of res.members) {
        assert.equal(pidAlive(pid), false, `job member ${pid} survived TerminateJobObject`);
      }
    } finally {
      box.restore();
    }
  },
);
