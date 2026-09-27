// The one test in this lane that touches the real kernel.
//
// Everything else mocks the warden, which proves the guards but proves nothing
// about whether a Windows Job Object actually contains and kills a process
// tree. This does: it spawns the real PowerShell warden, creates a real job,
// puts a real `cmd.exe` in it that spawns a real child `ping`, and asserts BOTH
// pids are gone after TerminateJobObject.
//
// The child matters more than the parent. Killing a parent is easy and proves
// little; the containment claim is that everything the task spawns is inside
// the job and dies with it. A tree-walking killer would race a process that
// forks after the walk started — the Job Object cannot, because membership is
// inherited at creation time by the kernel.
//
// Skipped off win32, where there is no Job Object to test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { spawnPowerShellWarden } from "../src/core/device_runtime/containment.js";

const isWindows = process.platform === "win32";

/** True while a process with this pid exists, via tasklist (no handle needed). */
function pidAlive(pid: number): boolean {
  const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return (res.stdout ?? "").includes(`"${pid}"`);
}

/** Poll until `check` holds or the deadline passes. Returns whether it held. */
async function waitFor(check: () => boolean, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

/** Poll job membership until it reaches `want` members or the deadline passes. */
async function pollMembership(
  warden: { list: () => Promise<number[]> },
  want: number,
  deadlineMs: number,
): Promise<number[]> {
  const until = Date.now() + deadlineMs;
  let pids = await warden.list();
  while (Date.now() < until && pids.length < want) {
    await new Promise((r) => setTimeout(r, 200));
    pids = await warden.list();
  }
  return pids;
}

test(
  "a real Job Object contains a spawned tree and TerminateJobObject kills every member",
  { skip: isWindows ? false : "Job Objects are a Windows kernel feature" },
  async () => {
    const started = Date.now();
    const warden = await spawnPowerShellWarden();
    let parent: ChildProcess | undefined;
    try {
      await warden.create(`aether-test-${process.pid}-${Date.now()}`);

      // A shell that outlives its own child: `ping -n 30` runs ~29s, so if the
      // job does NOT kill them both, the assertions below fail on a live pid
      // rather than passing because everything happened to exit on its own.
      parent = spawn("cmd.exe", ["/c", "ping -n 30 127.0.0.1 > NUL"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const parentPid = parent.pid;
      assert.ok(parentPid !== undefined, "cmd.exe must have started");

      await warden.assign(parentPid);

      // The kernel reports membership, which is the ONLY definition of
      // membership this system uses — never a name, never a PID heuristic.
      const members = await warden.list();
      assert.ok(members.includes(parentPid), `job membership ${members.join(",")} must include the assigned parent`);

      // Wait for `ping` to appear as a child INSIDE the job. It is spawned by
      // cmd.exe after the assignment, so its membership is inherited from its
      // parent by the kernel rather than granted by us — which is exactly the
      // property that makes this immune to the fork-during-tree-walk race.
      const grew = await pollMembership(warden, 2, 8_000);
      assert.ok(grew.length >= 2, `expected the child to be inherited into the job, saw ${grew.join(",")}`);
      const childPid = grew.find((p) => p !== parentPid);
      assert.ok(childPid !== undefined, "a child pid must have joined the job");

      assert.ok(pidAlive(parentPid), "the parent should be running before the kill");
      assert.ok(pidAlive(childPid), "the child should be running before the kill");

      await warden.terminate();

      assert.ok(await waitFor(() => !pidAlive(parentPid), 8_000), `parent pid ${parentPid} survived TerminateJobObject`);
      assert.ok(await waitFor(() => !pidAlive(childPid), 8_000), `child pid ${childPid} survived TerminateJobObject`);

      // The whole containment cycle has to be fast enough to sit in an
      // emergency path — a kill that takes a minute is not a kill.
      assert.ok(Date.now() - started < 20_000, `containment cycle took ${Date.now() - started}ms`);
    } finally {
      await warden.close().catch(() => {});
      try {
        parent?.kill();
      } catch {
        // already gone — that is the expected case
      }
    }
  },
);

test(
  "closing the warden reaps the job through KILL_ON_JOB_CLOSE",
  { skip: isWindows ? false : "Job Objects are a Windows kernel feature" },
  async () => {
    const warden = await spawnPowerShellWarden();
    let orphan: ChildProcess | undefined;
    try {
      await warden.create(`aether-test-orphan-${process.pid}-${Date.now()}`);
      orphan = spawn("cmd.exe", ["/c", "ping -n 30 127.0.0.1 > NUL"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      assert.ok(orphan.pid !== undefined);
      await warden.assign(orphan.pid);
      assert.ok(pidAlive(orphan.pid));

      // No terminate call at all — just drop the warden. The last handle to the
      // job closes, and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE means the OS reaps
      // the members. This is what guarantees a managed group cannot outlive the
      // daemon that owns it, including after a crash.
      await warden.close();

      assert.ok(
        await waitFor(() => !pidAlive(orphan!.pid!), 10_000),
        `pid ${orphan.pid} outlived its warden — KILL_ON_JOB_CLOSE is not in effect`,
      );
    } finally {
      try {
        orphan?.kill();
      } catch {
        // already reaped
      }
    }
  },
);
