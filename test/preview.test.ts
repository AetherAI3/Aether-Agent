import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import {
  commandDigest, isLoopbackUrl, isOwnerPrivateMode, parsePreviewState, previewPaths, resolvePreviewCwd, sanitizePreviewText,
  validatePreviewCommand, PREVIEW_SCHEMA, type PreviewState,
} from "../src/core/preview_contract.js";
import { cmdPreview, PREVIEW_EXIT, previewControlRequest, resolvePreviewCommand } from "../src/commands/preview.js";

function tempProject(): string { return mkdtempSync(join(tmpdir(), "aether-preview-")); }
function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough(); let value = "";
  stream.on("data", (chunk) => { value += String(chunk); });
  return { stream, text: () => value };
}
function context(cwd: string, yes = true): AppContext {
  return {
    cfg: {} as AppContext["cfg"], api: {} as AppContext["api"], tokens: {} as AppContext["tokens"],
    flags: { cwd, yes, json: false, audit: false }, confirm: async () => yes,
  };
}

/** Windows file symlinks require Developer Mode or an elevated token. Probe
 * that host capability so the Linux job still exercises every no-follow race
 * while an unprivileged Windows checkout does not fail before product code is
 * reached. Junction tests remain unconditional on Windows. */
function supportsFileSymlinks(root: string): boolean {
  const target = join(root, ".aether-file-link-target");
  const link = join(root, ".aether-file-link-probe");
  writeFileSync(target, "probe");
  try {
    symlinkSync(target, link);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    if (existsSync(link)) unlinkSync(link);
    if (existsSync(target)) unlinkSync(target);
  }
}

test("preview contract accepts loopback only and strips hostile terminal controls", () => {
  for (const url of ["http://127.0.0.1:3000", "https://localhost:5173/x", "http://[::1]:8080"]) assert.equal(isLoopbackUrl(url), true);
  for (const url of ["http://0.0.0.0:3000", "http://192.168.1.2:3000", "file:///tmp/x", "http://user:pw@localhost:1", "http://localhost:1\nX"]) assert.equal(isLoopbackUrl(url), false);
  assert.equal(sanitizePreviewText("ok\u001b]0;owned\u0007\u001b[31m red\u001b[0m\u0000\n"), "ok red\n");
  assert.equal(sanitizePreviewText("token=preview-secret-value\n"), "token=[REDACTED]\n");
});

test("preview command validation confines cwd and rejects hostile argv", () => {
  const root = tempProject(); const outside = tempProject(); mkdirSync(join(root, "app"));
  const command = validatePreviewCommand({ executable: "npm", args: ["run", "dev"], cwd: "app", readyUrl: "http://localhost:3000", timeoutMs: 1000 }, root);
  assert.equal(command.cwd, join(root, "app"));
  assert.equal(commandDigest(command), commandDigest({ ...command }));
  for (const hostilePath of ["..", "..\\", "../", "%2e%2e", "%2e%2e%2foutside", "/tmp"]) {
    assert.throws(() => resolvePreviewCwd(root, hostilePath), /inside the project|existing directory/, hostilePath);
  }
  symlinkSync(outside, join(root, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolvePreviewCwd(root, "linked-outside"), /escapes the project through a link/);
  assert.throws(() => validatePreviewCommand({ executable: "npm\ncalc", args: [], cwd: ".", timeoutMs: 1000 }, root), /control/);
  assert.throws(() => validatePreviewCommand({ executable: "npm", args: ["x\n--evil"], cwd: ".", timeoutMs: 1000 }, root), /controls/);
  for (const args of [
    ["run", "dev", "--host=0.0.0.0"], ["--host", "0.0.0.0:5173"], ["--hostname=[::]:3000"],
    ["--bind", "::"], ["--listen=0.0.0.0:8080"], ["-H[::]:9000"], ["--host"], ["--host=0"],
  ]) assert.throws(() => validatePreviewCommand({ executable: "npm", args, cwd: ".", timeoutMs: 1000 }, root), /wildcard/, args.join(" "));
  assert.doesNotThrow(() => validatePreviewCommand({ executable: "npm", args: ["run", "dev", "--host", "127.0.0.1"], cwd: ".", timeoutMs: 1000 }, root));
  assert.doesNotThrow(() => validatePreviewCommand({ executable: "npm", args: ["-h"], cwd: ".", timeoutMs: 1000 }, root));
});

test("preview state parsing rejects malformed identity, bounds, time, and hostile fields", () => {
  const root = tempProject();
  const valid: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: randomUUID(), projectRoot: root, commandDigest: "a".repeat(64),
    phase: "ready", supervisorPid: 10, childPid: 11, controlPort: 3210,
    startedAt: new Date().toISOString(), url: "http://127.0.0.1:3210",
  };
  assert.deepEqual(parsePreviewState(valid), valid);
  for (const mutation of [
    { instanceId: "not-an-id" }, { projectRoot: "relative" }, { commandDigest: "abc" },
    { supervisorPid: 0 }, { childPid: -1 }, { childPid: 0 }, { controlPort: 0 }, { controlPort: 65536 },
    { startedAt: "yesterday" }, { startedAt: new Date(Date.now() + 600_000).toISOString() },
    { error: "bad\u001b[31m" }, { error: "unexpected" }, { url: undefined }, { extra: true },
  ]) assert.equal(parsePreviewState({ ...valid, ...mutation }), null, JSON.stringify(mutation));
  assert.ok(parsePreviewState({ ...valid, phase: "failed", childPid: 0 }));
  assert.equal(parsePreviewState({ ...valid, phase: "starting" }), null, "starting state retained a ready URL");
});

test("malformed persisted state fails closed without replacement or launch", async () => {
  const root = tempProject(); const paths = previewPaths(root);
  const malformed = JSON.stringify({ schema: PREVIEW_SCHEMA, instanceId: "bad", childPid: -1 });
  writeFileSync(paths.statePath, malformed, { mode: 0o600 });
  const out = sink(); const err = sink();
  const code = await cmdPreview(context(root), ["start"], {
    command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: "1000", noOpen: true,
    out: out.stream, err: err.stream,
  });
  assert.equal(code, PREVIEW_EXIT.unsafe);
  assert.match(err.text(), /schema validation/);
  assert.equal(readFileSync(paths.statePath, "utf8"), malformed);
});

test("project declaration is explicit, bounded, and cannot be a symlink", (t) => {
  const root = tempProject(); mkdirSync(join(root, ".aether"));
  assert.throws(() => resolvePreviewCommand(root, {}), /preview.json is absent/);
  writeFileSync(join(root, ".aether", "declared.json"), JSON.stringify({ version: 1, command: "npm", args: ["run", "dev"] }));
  if (!supportsFileSymlinks(root)) {
    t.skip("file symlink creation is unavailable on this Windows host (EPERM)");
    return;
  }
  symlinkSync(join(root, ".aether", "declared.json"), join(root, ".aether", "preview.json"));
  assert.throws(() => resolvePreviewCommand(root, {}), /unsafe/);
});

test("preview state directory rejects a planted junction/symlink", () => {
  const root = tempProject(); const outside = tempProject();
  symlinkSync(outside, join(root, ".aether"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => previewPaths(root), /symlink|junction/);
});

test("preview mode policy rejects insecure Unix bits and accepts owner-private modes", () => {
  assert.equal(isOwnerPrivateMode(0o40700, "directory"), true);
  assert.equal(isOwnerPrivateMode(0o40777, "directory"), false);
  assert.equal(isOwnerPrivateMode(0o100600, "file"), true);
  assert.equal(isOwnerPrivateMode(0o100644, "file"), false);
  if (process.platform === "win32") return;
  const root = tempProject(); mkdirSync(join(root, ".aether")); mkdirSync(join(root, ".aether", "preview"), { mode: 0o777 });
  const statePath = join(root, ".aether", "preview", "state.json");
  const logPath = join(root, ".aether", "preview", "preview.log");
  writeFileSync(statePath, "{}", { mode: 0o666 }); writeFileSync(logPath, "", { mode: 0o666 });
  chmodSync(join(root, ".aether", "preview"), 0o777); chmodSync(statePath, 0o666); chmodSync(logPath, 0o666);
  assert.throws(() => previewPaths(root), /permissions must be 0700/);
  chmodSync(join(root, ".aether", "preview"), 0o700);
  assert.throws(() => previewPaths(root), /permissions must be 0600/);
  chmodSync(statePath, 0o600); chmodSync(logPath, 0o600);
  previewPaths(root);
  assert.equal(statSync(join(root, ".aether", "preview")).mode & 0o777, 0o700);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("control client tolerates a slow response and cleans its one-use request", { timeout: 10_000 }, async () => {
  const root = tempProject(); const paths = previewPaths(root);
  const state: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: randomUUID(), projectRoot: root, commandDigest: "b".repeat(64),
    phase: "ready", supervisorPid: process.pid, childPid: process.pid, controlPort: 1,
    startedAt: new Date().toISOString(), url: "http://127.0.0.1:1",
  };
  const slow = createServer((_req, res) => setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(state));
  }, 1_200));
  await new Promise<void>((resolvePromise) => slow.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = slow.address(); assert.ok(address && typeof address !== "string"); state.controlPort = address.port;
  const before = Date.now();
  const result = await previewControlRequest(state, paths.statePath, "GET", "/status");
  assert.equal(result.kind, "ok"); assert.ok(Date.now() - before >= 1_000);
  assert.deepEqual(readdirSync(paths.dir).filter((name) => name.startsWith("control-")), []);
  await new Promise<void>((resolvePromise) => slow.close(() => resolvePromise()));
});

test("managed preview detects its URL, reports headless honestly, sanitizes logs, and stops descendants", { timeout: 45_000 }, async (t) => {
  const root = tempProject();
  const canCreateFileSymlink = supportsFileSymlinks(root);
  const heartbeat = join(root, "heartbeat.txt");
  const secret = "preview-secret-value-12345";
  const envSecret = "preview-env-secret-67890";
  const script = join(root, "server.mjs");
  writeFileSync(script, `
    import { createServer } from "node:http";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    if (process.argv[2] === "beat") {
      setInterval(()=>writeFileSync(process.argv[3],String(Date.now())),80);
    } else {
      const beat = spawn(process.execPath,[process.argv[1],"beat",process.argv[3]],{stdio:"ignore"});
      const s=createServer((q,r)=>{if(q.url==="/emit"){console.log("Authorization: Bearer "+process.argv[5]);console.log("https://user:"+process.env.AETHER_PREVIEW_TEST_TOKEN+"@localhost/private");}r.end("ok")});
      s.listen(0,"127.0.0.1",()=>{const a=s.address();console.log("\\u001b]0;hostile\\u0007ready http://127.0.0.1:"+a.port);console.log("grand "+beat.pid);console.log("token="+process.argv[5])});
      setInterval(()=>{},1000);
    }
  `);
  const previewArgs = [script, "serve", heartbeat, "--api-key", secret];
  const out = sink(); const err = sink();
  const previousEnvSecret = process.env["AETHER_PREVIEW_TEST_TOKEN"];
  process.env["AETHER_PREVIEW_TEST_TOKEN"] = envSecret;
  let start: number;
  try {
    start = await cmdPreview(context(root), ["start"], { command: process.execPath, args: previewArgs, timeoutMs: "8000", noOpen: true, out: out.stream, err: err.stream });
  } finally {
    if (previousEnvSecret === undefined) delete process.env["AETHER_PREVIEW_TEST_TOKEN"];
    else process.env["AETHER_PREVIEW_TEST_TOKEN"] = previousEnvSecret;
  }
  assert.equal(start, PREVIEW_EXIT.ok, err.text());
  assert.match(out.text(), /^http:\/\/127\.0\.0\.1:\d+/m);
  assert.match(out.text(), /Browser not opened/);
  assert.doesNotMatch(out.text(), /Opened in/);
  assert.doesNotMatch(err.text(), new RegExp(secret));

  const paths = previewPaths(root);
  const stateText = readFileSync(paths.statePath, "utf8");
  assert.doesNotMatch(stateText, /"token"/);
  assert.doesNotMatch(stateText, new RegExp(secret));
  assert.deepEqual(readdirSync(paths.dir).filter((name) => name.startsWith("launch-") || name.startsWith("control-")), []);
  const state = JSON.parse(stateText) as PreviewState;
  t.after(async () => {
    try {
      if (existsSync(paths.statePath) && !lstatSync(paths.statePath).isSymbolicLink()) {
        await cmdPreview(context(root), ["stop"], { out: sink().stream, err: sink().stream });
      }
    } catch { /* the assertion failure remains authoritative */ }
  });
  assert.equal(parsePreviewState({ ...state, token: secret }), null, "legacy or injected bearer state was accepted");
  const csrf = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, { method: "POST" });
  assert.equal(csrf.status, 403, "a browser-simple request reached preview control without the custom header");
  const forged = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, {
    method: "POST", headers: { "x-aether-preview-control": "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(forged.status, 403, "a control id without an owner-private request file was accepted");

  const abandoned: string[] = [];
  for (let i = 0; i < 300; i += 1) {
    const id = randomUUID();
    const path = join(paths.dir, `control-${id}.json`);
    writeFileSync(path, JSON.stringify({
      schema: PREVIEW_SCHEMA, requestId: id, instanceId: "abandoned", method: "GET", path: "/status",
    }), { mode: 0o600 });
    abandoned.push(path);
  }
  const crowdedOut = sink(); const crowdedErr = sink();
  assert.equal(await cmdPreview(context(root), ["status"], { out: crowdedOut.stream, err: crowdedErr.stream }), PREVIEW_EXIT.ok);
  assert.match(crowdedOut.text(), /^ready  pid=\d+  http:\/\//);
  for (const path of abandoned) unlinkSync(path);

  const blackhole = createServer(() => { /* accept the request but never answer */ });
  await new Promise<void>((resolvePromise) => blackhole.listen(0, "127.0.0.1", () => resolvePromise()));
  const blackholeAddress = blackhole.address(); assert.ok(blackholeAddress && typeof blackholeAddress !== "string");
  const unreachableState = { ...state, controlPort: blackholeAddress.port };
  writeFileSync(paths.statePath, JSON.stringify(unreachableState));
  const duplicateOut = sink(); const duplicateErr = sink();
  assert.equal(await cmdPreview(context(root), ["start"], {
    command: process.execPath, args: previewArgs, timeoutMs: "8000", noOpen: true,
    out: duplicateOut.stream, err: duplicateErr.stream,
  }), PREVIEW_EXIT.controlFailed);
  assert.match(duplicateErr.text(), /State was preserved and no duplicate was started/);
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), unreachableState);
  assert.deepEqual(readdirSync(paths.dir).filter((name) => name.startsWith("control-")), [], "aborted client left its one-use request behind");
  assert.doesNotThrow(() => process.kill(state.childPid, 0), "transient challenge failure stopped the original child");
  blackhole.closeAllConnections();
  await new Promise<void>((resolvePromise) => blackhole.close(() => resolvePromise()));
  writeFileSync(paths.statePath, stateText);
  const recoveredOut = sink(); const recoveredErr = sink();
  assert.equal(await cmdPreview(context(root), ["status"], { out: recoveredOut.stream, err: recoveredErr.stream }), PREVIEW_EXIT.ok);
  assert.match(recoveredOut.text(), new RegExp(`pid=${state.childPid}\\b`), "recovery attached to a duplicate child");

  const blockedId = "11111111-1111-4111-8111-111111111111";
  const controlPath = join(paths.dir, `control-${blockedId}.json`);
  writeFileSync(controlPath, JSON.stringify({
    schema: PREVIEW_SCHEMA, requestId: blockedId, instanceId: "wrong-instance", method: "POST", path: "/stop",
  }), { mode: 0o600 });
  const invalid = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, {
    method: "POST", headers: { "x-aether-preview-control": blockedId },
  });
  assert.equal(invalid.status, 403);
  assert.equal(existsSync(controlPath), true, "supervisor consumed a request before validating ownership");
  const concurrentOut = sink(); const concurrentErr = sink();
  assert.equal(await cmdPreview(context(root), ["status"], { out: concurrentOut.stream, err: concurrentErr.stream }), PREVIEW_EXIT.ok);
  assert.match(concurrentOut.text(), /^ready  pid=\d+  http:\/\//);
  assert.equal(existsSync(paths.statePath), true, "an abandoned request made live state look stale");
  assert.equal(existsSync(controlPath), true, "another caller deleted a request it did not own");
  assert.doesNotThrow(() => process.kill(state.childPid, 0), "an abandoned request orphaned or stopped the managed preview");
  unlinkSync(controlPath);

  const statusOut = sink();
  assert.equal(await cmdPreview(context(root), ["status"], { out: statusOut.stream, err: err.stream }), 0);
  assert.match(statusOut.text(), /^ready  pid=\d+  http:\/\//);
  const failedOpenOut = sink(); const failedOpenErr = sink();
  assert.equal(await cmdPreview(context(root), ["open"], {
    out: failedOpenOut.stream, err: failedOpenErr.stream,
    open: () => ({ status: "spawn-error", detail: "launcher missing" }),
  }), PREVIEW_EXIT.controlFailed);
  assert.match(failedOpenOut.text(), /^http:\/\//);
  assert.match(failedOpenErr.text(), /Browser was not opened.*launcher missing/);
  assert.doesNotMatch(failedOpenOut.text(), /Opened|launch requested/);
  const attachOut = sink();
  assert.equal(await cmdPreview(context(root), ["start"], {
    command: process.execPath, args: previewArgs, timeoutMs: "8000", noOpen: true,
    out: attachOut.stream, err: err.stream,
  }), 0);
  assert.match(attachOut.text(), /Attached to declared preview/);
  assert.equal(await cmdPreview(context(root), ["start"], {
    command: process.execPath, args: [...previewArgs, "different"], timeoutMs: "8000", noOpen: true,
    out: attachOut.stream, err: err.stream,
  }), PREVIEW_EXIT.controlFailed);
  assert.match(err.text(), /different declared preview/);
  const logs = sink();
  assert.equal(await cmdPreview(context(root), ["logs"], { out: logs.stream, err: err.stream }), 0);
  assert.match(logs.text(), /ready http:\/\//);
  assert.doesNotMatch(logs.text(), /\u001b|hostile/);
  assert.doesNotMatch(logs.text(), new RegExp(secret));
  assert.match(logs.text(), /token=\[REDACTED\]/);

  await t.test("refuses file-symlink replacement races", { skip: !canCreateFileSymlink }, async () => {
    const outsideLog = join(root, "outside-log.txt"); writeFileSync(outsideLog, "SAFE");
    const ownedLog = join(paths.dir, "owned-preview.log");
    renameSync(paths.logPath, ownedLog);
    symlinkSync(outsideLog, paths.logPath);
    await fetch(`${state.url}/emit`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(readFileSync(outsideLog, "utf8"), "SAFE", "child output followed a replaced log symlink");
    const racedLogs = sink();
    assert.equal(await cmdPreview(context(root), ["logs"], { out: racedLogs.stream, err: err.stream }), PREVIEW_EXIT.unsafe);
    unlinkSync(paths.logPath); renameSync(ownedLog, paths.logPath);
    const redactedLogs = sink();
    assert.equal(await cmdPreview(context(root), ["logs"], { out: redactedLogs.stream, err: err.stream }), PREVIEW_EXIT.ok);
    assert.doesNotMatch(redactedLogs.text(), new RegExp(`${secret}|${envSecret}`));
    assert.match(redactedLogs.text(), /Authorization: \[REDACTED\] \[REDACTED\]/);
    assert.match(redactedLogs.text(), /https:\/\/\[REDACTED\]@localhost/);
    const outsideState = join(root, "outside-state.txt"); writeFileSync(outsideState, "SAFE");
    const ownedState = join(paths.dir, "owned-state.json");
    renameSync(paths.statePath, ownedState); symlinkSync(outsideState, paths.statePath);
    const racedStart = sink();
    assert.equal(await cmdPreview(context(root), ["start"], {
      command: process.execPath, args: previewArgs, timeoutMs: "8000", noOpen: true,
      out: racedStart.stream, err: err.stream,
    }), PREVIEW_EXIT.unsafe);
    assert.equal(readFileSync(outsideState, "utf8"), "SAFE");
    assert.doesNotThrow(() => process.kill(state.childPid, 0), "state replacement stopped the original preview");
    unlinkSync(paths.statePath); renameSync(ownedState, paths.statePath);
  });

  const statusCalls = Array.from({ length: 12 }, () => {
    const statusSink = sink();
    return cmdPreview(context(root), ["status"], { out: statusSink.stream, err: statusSink.stream });
  });
  const stopCall = cmdPreview(context(root), ["stop"], { out: out.stream, err: err.stream });
  const [stopCode, ...statusCodes] = await Promise.all([stopCall, ...statusCalls]);
  assert.equal(stopCode, PREVIEW_EXIT.ok, err.text());
  const expectedConcurrentCodes: number[] = [PREVIEW_EXIT.ok, PREVIEW_EXIT.notRunning, PREVIEW_EXIT.controlFailed];
  assert.ok(statusCodes.every((code) => expectedConcurrentCodes.includes(code)));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const first = statSync(heartbeat).mtimeMs;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  assert.equal(statSync(heartbeat).mtimeMs, first, "grandchild heartbeat survived preview stop");
});

test("port hijack and early exit never become ready", { timeout: 15_000 }, async (t) => {
  const root = tempProject();
  const hijacker = createServer((_q, res) => res.end("other process"));
  await new Promise<void>((resolvePromise) => hijacker.listen(0, "127.0.0.1", () => resolvePromise()));
  t.after(() => { try { hijacker.closeAllConnections(); hijacker.close(); } catch { /* already closed */ } });
  const address = hijacker.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const script = join(root, "collision.mjs");
  writeFileSync(script, `import{createServer}from"node:http";console.log(${JSON.stringify(url)});const s=createServer();s.on("error",()=>process.exit(19));s.listen(${address.port},"127.0.0.1");`);
  const out = sink(); const err = sink();
  const code = await cmdPreview(context(root), ["start"], { command: process.execPath, args: [script], readyUrl: url, timeoutMs: "3000", noOpen: true, out: out.stream, err: err.stream });
  assert.equal(code, PREVIEW_EXIT.launchFailed);
  assert.match(err.text(), /already reachable before the preview child started/);
  await new Promise<void>((resolvePromise) => hijacker.close(() => resolvePromise()));
});

test("an occupied explicit ready URL cannot authenticate a long-lived nonbinding child", { timeout: 15_000 }, async (t) => {
  const root = tempProject();
  const hijacker = createServer((_q, res) => res.end("unrelated listener"));
  await new Promise<void>((resolvePromise) => hijacker.listen(0, "127.0.0.1", () => resolvePromise()));
  t.after(() => { try { hijacker.closeAllConnections(); hijacker.close(); } catch { /* already closed */ } });
  const address = hijacker.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const script = join(root, "nonbinding.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);", "utf8");
  const out = sink(); const err = sink();

  const code = await cmdPreview(context(root), ["start"], {
    command: process.execPath, args: [script], readyUrl: url, timeoutMs: "3000",
    noOpen: true, out: out.stream, err: err.stream,
  });

  assert.equal(code, PREVIEW_EXIT.launchFailed);
  assert.match(err.text(), /already reachable before the preview child started/i);
  const state = JSON.parse(readFileSync(previewPaths(root).statePath, "utf8")) as PreviewState;
  assert.equal(state.phase, "failed");
  assert.equal(state.childPid, 0, "the nonbinding child should never have been spawned");
  await new Promise<void>((resolvePromise) => hijacker.close(() => resolvePromise()));
});

test("launch failure is explicit and stale state never causes a PID signal", { timeout: 10_000 }, async () => {
  const root = tempProject(); const out = sink(); const err = sink();
  const failed = await cmdPreview(context(root), ["start"], { command: join(root, "absent-executable"), timeoutMs: "2000", noOpen: true, out: out.stream, err: err.stream });
  assert.equal(failed, PREVIEW_EXIT.launchFailed);
  assert.match(err.text(), /launch failed|exited before readiness/i);

  const paths = previewPaths(root);
  const failedLaunch = JSON.parse(readFileSync(paths.statePath, "utf8")) as PreviewState;
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(failedLaunch.supervisorPid, 0); }
    catch { break; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const stale: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: randomUUID(), projectRoot: root, commandDigest: "a".repeat(64),
    phase: "ready", supervisorPid: process.pid, childPid: process.pid, controlPort: 9,
    startedAt: new Date().toISOString(), url: "http://127.0.0.1:9",
  };
  writeFileSync(paths.statePath, JSON.stringify(stale), { mode: 0o600 });
  const stop = await cmdPreview(context(root), ["stop"], { out: out.stream, err: err.stream });
  assert.equal(stop, PREVIEW_EXIT.controlFailed);
  assert.match(err.text(), /state was preserved and no process was signalled/i);
  assert.equal(existsSync(paths.statePath), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("a stop that lands before readiness is a confirmed stop, not a failed launch", { timeout: 30_000 }, async (t) => {
  // The supervisor recorded the exit it had just caused as "dev command exited
  // before readiness (exit 1)" and left that failed state behind, so `preview
  // stop` reported unconfirmed cleanup and the next status republished a failure.
  const root = tempProject();
  const script = join(root, "slow.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);", "utf8"); // never prints a ready URL
  const paths = previewPaths(root);
  const startErr = sink();
  // Once its supervisor is gone the start waits out its own deadline, so keep
  // that short; the stop lands well inside it.
  const starting = cmdPreview(context(root), ["start"], {
    command: process.execPath, args: [script], timeoutMs: "5000", noOpen: true, out: sink().stream, err: startErr.stream,
  });
  t.after(async () => {
    await starting;
    if (existsSync(paths.statePath)) await cmdPreview(context(root), ["stop"], { out: sink().stream, err: sink().stream });
  });
  const phase = (): string | null => {
    try { return (JSON.parse(readFileSync(paths.statePath, "utf8")) as PreviewState).phase; } catch { return null; }
  };
  for (let i = 0; i < 400 && phase() !== "starting"; i += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(phase(), "starting");

  const out = sink(); const err = sink();
  const stopped = await cmdPreview(context(root), ["stop"], { out: out.stream, err: err.stream });
  assert.equal(stopped, PREVIEW_EXIT.ok, err.text());
  assert.match(out.text(), /Preview stopped/);
  assert.equal(existsSync(paths.statePath), false, "the supervisor removed its state once the child was gone");
  await starting;
  assert.doesNotMatch(startErr.text(), /exited before readiness/, "the requested stop was not recorded as the child failing");
});

test("only a terminal failed state with dead recorded processes permits identity-bound replacement", { timeout: 15_000 }, async () => {
  const root = tempProject(); const out = sink(); const err = sink();
  const paths = previewPaths(root);
  const failedId = randomUUID();
  const failed: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: failedId, projectRoot: root, commandDigest: "b".repeat(64),
    phase: "failed", supervisorPid: 2_147_483_646, childPid: 0, controlPort: 9,
    startedAt: new Date().toISOString(), error: "child exited before readiness",
  };
  writeFileSync(paths.statePath, JSON.stringify(failed), { mode: 0o600 });

  const code = await cmdPreview(context(root), ["start"], {
    command: join(root, "absent-replacement"), timeoutMs: "2000", noOpen: true,
    out: out.stream, err: err.stream,
  });
  assert.equal(code, PREVIEW_EXIT.launchFailed);
  assert.match(err.text(), /both recorded processes were confirmed absent/);
  let replacement = JSON.parse(readFileSync(paths.statePath, "utf8")) as PreviewState;
  assert.notEqual(replacement.instanceId, failedId, "the proven-stale record still blocked replacement");
  for (let i = 0; i < 20 && replacement.phase === "starting"; i += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    replacement = JSON.parse(readFileSync(paths.statePath, "utf8")) as PreviewState;
  }
  assert.equal(replacement.phase, "failed");
});
