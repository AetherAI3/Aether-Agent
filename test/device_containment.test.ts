// Containment is where the device is allowed to kill things, so both of its
// guards are tested as adversarial cases rather than happy paths:
//
//   * the exe is hash-verified BEFORE it is spawned, so a swapped binary never
//     runs inside a job that carries someone else's authority; and
//   * the PID-reuse guard refuses to signal a recycled PID, because a kill
//     aimed at a dead task's number lands on whatever process inherited it.
//
// Every OS call is injected, so this file spawns nothing. The real Job Object
// is exercised separately by device_job_object_win32.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContainmentManager, type LaunchSpec, type WardenHandle } from "../src/core/device_runtime/containment.js";
import { getGroup, listGroups, registerGroup } from "../src/core/device_runtime/registry.js";
import { fakeExecutable, groupRegistration, withDeviceSandboxAsync } from "./device_sandbox.js";

/** A warden that records its ops instead of touching kernel32. */
function mockWarden(overrides: Partial<WardenHandle> = {}): { warden: WardenHandle; ops: string[] } {
  const ops: string[] = [];
  const warden: WardenHandle = {
    ping: async () => { ops.push("ping"); },
    create: async (name) => { ops.push(`create:${name}`); },
    assign: async (pid) => { ops.push(`assign:${pid}`); },
    list: async () => { ops.push("list"); return [4242, 4243]; },
    terminate: async () => { ops.push("terminate"); },
    close: async () => { ops.push("close"); },
    ...overrides,
  };
  return { warden, ops };
}

function spec(exe: { path: string; sha256: string }, overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    process_group_id: "grp-1",
    owner: "operator",
    project: "aether",
    workspace_id: "ws-1",
    task_id: "task-1",
    exe_path: exe.path,
    exe_sha256: exe.sha256,
    trusted_publisher: null,
    command_classes: ["emergency_terminate"],
    lease_epoch: 1,
    fence_token: "fence-1",
    expires_at: 9_000_000,
    policy_digest: `sha256:${"a".repeat(64)}`,
    args: ["--serve"],
    cwd: ".",
    ...overrides,
  };
}

test("launchManaged creates the job, spawns, assigns, and records the registration", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload-bytes");
    const { warden, ops } = mockWarden();
    const manager = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4242, child: {} as never }),
      processStartTimeMs: () => 1_700_000_000_000,
      resolveExe: (p) => p,
      now: () => 1_000,
    });

    const reg = await manager.launchManaged(spec(exe));

    // The job must exist BEFORE the task is spawned and the task must be
    // assigned immediately after, so descendants land inside the job.
    assert.deepEqual(ops, ["create:aether-dev-grp-1", "assign:4242"]);
    assert.equal(reg.process_group_id, "grp-1");
    assert.equal(reg.exe_path, exe.path);
    assert.equal(reg.exe_sha256, exe.sha256);
    assert.equal(reg.parent_pid, 4242);
    assert.equal(reg.parent_start_time_ms, 1_700_000_000_000);
    assert.equal(reg.job_object_name, "aether-dev-grp-1");
    assert.equal(reg.lease_epoch, 1);
    assert.equal(reg.fence_token, "fence-1");
    // The registration is durable, not just returned.
    assert.equal(getGroup("grp-1", { now: () => 1_000 })?.job_object_name, "aether-dev-grp-1");
  });
});

test("RED TEAM: a swapped binary is refused before anything is spawned", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "the approved bytes");
    const { warden, ops } = mockWarden();
    let spawned = 0;
    const manager = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => { spawned += 1; return { pid: 4242, child: {} as never }; },
      processStartTimeMs: () => 1,
      resolveExe: (p) => p,
    });

    // The caller claims a digest the file on disk does not have — the classic
    // "approved at review time, swapped before launch" race.
    await assert.rejects(
      manager.launchManaged(spec(exe, { exe_sha256: "b".repeat(64) })),
      /sha256 does not match/,
    );
    assert.equal(spawned, 0, "nothing may be spawned once the hash check fails");
    assert.deepEqual(ops, [], "the warden is not even consulted");
    assert.equal(listGroups({ now: () => 1 }).length, 0);
  });
});

test("RED TEAM: a non-absolute or missing exe never launches", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    const manager = new ContainmentManager({
      wardenFactory: async () => mockWarden().warden,
      spawnTask: () => ({ pid: 1, child: {} as never }),
      processStartTimeMs: () => 1,
      // A resolver that hands back a bare basename models a PATH lookup that
      // resolved to "whatever `node` means right now".
      resolveExe: () => "node.exe",
    });
    await assert.rejects(manager.launchManaged(spec(exe)), /not an existing absolute file/);
  });
});

test("a registry rejection tears the job down rather than leaving it running", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    const { warden, ops } = mockWarden();
    const manager = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4242, child: {} as never }),
      // A start time of 0 is fine, but an invalid lease is not — the registry
      // independently re-validates and refuses.
      processStartTimeMs: () => 1,
      resolveExe: (p) => p,
    });
    await assert.rejects(manager.launchManaged(spec(exe, { lease_epoch: -1 })), /refusing managed group registration/);
    // A running-but-unregistered job is the worst outcome: nothing knows it
    // exists, so nothing can ever kill it. It must be terminated on the way out.
    assert.ok(ops.includes("terminate"), `expected the job to be torn down, saw ${ops.join(",")}`);
    assert.ok(ops.includes("close"));
  });
});

test("terminateManaged kills through the Job Object and drops the registration", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    const { warden, ops } = mockWarden();
    const manager = new ContainmentManager({
      wardenFactory: async () => warden,
      spawnTask: () => ({ pid: 4242, child: {} as never }),
      processStartTimeMs: () => 1_700_000_000_000,
      resolveExe: (p) => p,
      now: () => 1_000,
    });
    await manager.launchManaged(spec(exe));

    const result = await manager.terminateManaged("grp-1");
    assert.equal(result.status, "terminated");
    assert.equal(result.via, "job-object");
    // Membership is enumerated before the kill so the receipt can name what died.
    assert.deepEqual(result.members, [4242, 4243]);
    assert.ok(ops.indexOf("list") < ops.indexOf("terminate"));
    assert.equal(getGroup("grp-1", { now: () => 1_000 }), undefined);
  });
});

test("RED TEAM: a recycled PID blocks the kill entirely", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    // The group was registered against pid 4242 started at T. The OS has since
    // recycled 4242 onto an unrelated process with a different start time.
    registerGroup(groupRegistration(exe, { parent_pid: 4242, parent_start_time_ms: 1_700_000_000_000 }));

    const { warden, ops } = mockWarden();
    const manager = new ContainmentManager({
      processStartTimeMs: () => 1_800_000_000_000, // a DIFFERENT process now
      resolveExe: (p) => p,
      now: () => 1_000,
    });
    manager.attachWarden("grp-1", warden);

    const result = await manager.terminateManaged("grp-1");
    assert.equal(result.status, "pid-reuse-blocked");
    assert.equal(result.via, "none");
    // Nothing was signalled — not the job, not the tree. An innocent process
    // that merely inherited a number must never be killed.
    assert.deepEqual(ops, [], `expected no OS calls, saw ${ops.join(",")}`);
    assert.deepEqual(result.members, []);
  });
});

test("terminating an unknown or expired group is a no-op, not a broad kill", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    registerGroup(groupRegistration(exe, { process_group_id: "grp-old", expires_at: 500 }));
    const manager = new ContainmentManager({ processStartTimeMs: () => 1, resolveExe: (p) => p, now: () => 9_999 });

    assert.deepEqual(await manager.terminateManaged("grp-never-existed"), {
      status: "unknown", via: "none", members: [], group_id: "grp-never-existed",
    });
    // An expired lease is equally unknown — authority does not outlive its lease.
    assert.equal((await manager.terminateManaged("grp-old")).status, "unknown");
  });
});

test("the tree-kill fallback runs only inside a verified managed boundary", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    registerGroup(groupRegistration(exe, { parent_pid: 4242, parent_start_time_ms: 1_700_000_000_000 }));

    // Case 1: the job terminate itself fails, but (pid, start_time) still
    // matches — the fallback is permitted.
    const failing = mockWarden({ terminate: async () => { throw new Error("job handle is gone"); } });
    const verified = new ContainmentManager({ processStartTimeMs: () => 1_700_000_000_000, resolveExe: (p) => p, now: () => 1_000 });
    verified.attachWarden("grp-1", failing.warden);
    const fell = await verified.terminateManaged("grp-1");
    assert.equal(fell.status, "terminated");
    assert.equal(fell.via, "tree-kill-fallback");

    // Case 2: no live warden and the parent cannot be verified alive (start time
    // unknown). KILL_ON_JOB_CLOSE already reaped the orphan, so signalling a
    // bare PID here would be an unverified kill. It must NOT happen.
    registerGroup(groupRegistration(exe, { process_group_id: "grp-2", parent_pid: 4243, parent_start_time_ms: 1_700_000_000_000 }));
    const unverified = new ContainmentManager({ processStartTimeMs: () => null, resolveExe: (p) => p, now: () => 1_000 });
    const gone = await unverified.terminateManaged("grp-2");
    assert.equal(gone.status, "terminated");
    assert.equal(gone.via, "none", "an unverifiable parent must not be tree-killed by PID");
  });
});

test("shutdown closes every live warden so no job outlives the daemon", async () => {
  await withDeviceSandboxAsync(async (dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    const a = mockWarden();
    const b = mockWarden();
    const manager = new ContainmentManager({ resolveExe: (p) => p, processStartTimeMs: () => 1, now: () => 1 });
    manager.attachWarden("grp-a", a.warden);
    manager.attachWarden("grp-b", b.warden);
    await manager.shutdown();
    // Closing the warden closes the job handle, and KILL_ON_JOB_CLOSE does the
    // rest — that is the guarantee a managed group cannot survive its owner.
    assert.ok(a.ops.includes("close"));
    assert.ok(b.ops.includes("close"));
    assert.equal(exe.sha256.length, 64);
  });
});
