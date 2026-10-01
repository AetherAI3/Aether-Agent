import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TerminalPty } from "../src/core/terminal_pty.js";
import { ShellSession } from "../src/core/shell_session.js";
import { ToolExecutor } from "../src/core/tool_executor.js";

const supported = process.platform === "linux";
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("PTY fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test("real Linux PTY reads input, reports initial dimensions, resizes and streams progress", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-pty-"));
  const terminal = new TerminalPty(root, "stty size; printf READY; read line; printf 'GOT:%s\\n' \"$line\"; stty size; printf PROGRESS; sleep .05; printf FINAL", 31, 91);
  let text = "";
  terminal.observe(data => { text += data.toString(); });
  try {
    await until(() => text.includes("READY"));
    assert.match(text, /31 91/);
    terminal.resize(42, 102);
    terminal.input(Buffer.from("hello world\n"));
    assert.equal(await terminal.finished, 0, terminal.diagnostic());
    assert.match(text, /GOT:hello world/);
    assert.match(text, /42 102/);
    assert.match(text, /PROGRESS.*FINAL/s);
  } finally { terminal.stop(); await terminal.finished; rmSync(root, { recursive: true, force: true }); }
});
test("PTY Ctrl+C reaches foreground command; explicit stop reaps its child", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-pty-stop-"));
  const terminal = new TerminalPty(root, "printf READY; sleep 30");
  let output = ""; terminal.observe(data => { output += data.toString(); });
  try {
    await until(() => output.includes("READY"));
    terminal.input(Buffer.from([3]));
    assert.notEqual(await terminal.finished, 0);
    const stop = new TerminalPty(root, "sleep 30 & echo $! > child.pid; printf READY; wait");
    let ready = false; stop.observe(data => { ready ||= data.includes(Buffer.from("READY")); });
    await until(() => ready);
    const pid = Number(readFileSync(join(root, "child.pid"), "utf8"));
    stop.stop(); await stop.finished;
    // A reaped/dead process cannot continue running the user's command.
    const proc = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    assert.ok(!proc.stdout.trim() || proc.stdout.trim().startsWith("Z"), proc.stdout);
  } finally { terminal.stop(); await terminal.finished; rmSync(root, { recursive: true, force: true }); }
});
test("PTY launch failure settles; commands never replay after exit", { skip: !supported }, async () => {
  const bad = new TerminalPty(process.cwd(), "true", 24, 80, "/missing/aether-python");
  assert.equal(await bad.finished, 127);
  assert.match(bad.diagnostic(), /ENOENT/);
  bad.input(Buffer.from("touch should-not-run\n")); bad.stop();
  assert.equal(bad.state, "exited");
});
test("PTY child crash drains output and allows a fresh session", { skip: !supported }, async () => {
  const crashed = new TerminalPty(process.cwd(), "printf BEFORE_CRASH; kill -KILL $$");
  let output = ""; crashed.observe(data => { output += data.toString(); });
  assert.equal(await crashed.finished, -9);
  assert.match(output, /BEFORE_CRASH/);
  assert.equal(crashed.state, "exited");
  const next = new TerminalPty(process.cwd(), "true");
  assert.equal(await next.finished, 0);
});
test("interactive user reservation blocks model/user tools and excludes edits from automatic commits", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-pty-owner-"));
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"]]) spawnSync("git", args, { cwd: root });
  writeFileSync(join(root, "base"), "base"); spawnSync("git", ["add", "."], { cwd: root }); spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  const session = new ShellSession(root);
  const exec = new ToolExecutor(root, undefined, { mode: "coding", shellSession: session });
  try {
    await exec.executeAsync("write_file", { path: "agent", content: "owned" });
    const release = await exec.beginUserTerminal();
    assert.equal((await exec.executeAsync("run_shell", { command: "touch forbidden" })).exitCode, 1);
    assert.equal((await exec.runUserShell("touch forbidden")).exitCode, 1);
    assert.equal(exec.execute("write_file", { path: "forbidden", content: "no" }).exitCode, 1);
    const terminal = new TerminalPty(root, "printf user > user-file");
    assert.equal(await terminal.finished, 0);
    release(); release();
    assert.equal((await exec.executeAsync("git_commit", { message: "only agent" })).exitCode, 0);
    assert.equal(spawnSync("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), "agent");
  } finally { session.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real outer Linux TTY detaches, reattaches, restores raw mode and forwards resize", { skip: !supported }, async () => {
  const driver = `import { TerminalPty } from './dist/src/core/terminal_pty.js';
process.stdin.setRawMode(true);
const t = new TerminalPty(process.cwd(), 'printf CHILD_READY; read a; printf CHILD_DONE');
const first = await t.attach(process.stdin, process.stdout);
process.stdout.write('DETACHED:' + first + ':RAW:' + process.stdin.isRaw + '\\n');
const second = await t.attach(process.stdin, process.stdout);
process.stdout.write('FINISHED:' + second + ':RAW:' + process.stdin.isRaw + '\\n');
await t.finished; process.stdin.setRawMode(false); process.stdin.pause();`;
  const outer = String.raw`import os, pty, subprocess, select, sys, time
m,s=pty.openpty()
p=subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]],stdin=s,stdout=s,stderr=s)
os.close(s)
data=b''; detached=False; sent=False; deadline=time.monotonic()+10
while time.monotonic()<deadline:
 if select.select([m],[],[],.05)[0]:
  try: chunk=os.read(m,65536)
  except OSError: break
  data+=chunk
 if b'CHILD_READY' in data and not detached:
  os.write(m,b'\x1d'); detached=True
 if b'DETACHED:detached:RAW:true' in data and not sent:
  time.sleep(.05); os.write(m,b'hello\n'); sent=True
 if p.poll() is not None: break
if p.poll() is None: p.kill()
p.wait(); os.close(m)
sys.stdout.buffer.write(data)
sys.exit(p.returncode)`;
  const result = spawnSync("python3", ["-c", outer, process.execPath, driver], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /DETACHED:detached:RAW:true/);
  assert.match(result.stdout, /FINISHED:exited:RAW:true/);
  assert.match(result.stdout, /CHILD_DONE/);
});

for (const crash of [false, true]) test(`real coding console returns to model chat after ${crash ? "detached crash with a preserved draft" : "PTY input"}`, { skip: !supported }, async () => {
  const driver = `import { repl } from './dist/src/commands/chat.js';
import { ApiClient } from './dist/src/core/transport.js';
import { DEFAULT_CONFIG } from './dist/src/core/config.js';
let calls=0; globalThis.fetch=async()=>{ calls++; return new Response('data: {"type":"delta","text":"MODEL_REPLY"}\\n\\ndata: {"type":"done","uvt":0,"cents":0}\\n\\n',{headers:{'content-type':'text/event-stream'}}); };
const tokens={get:async()=> 'fixture'};
const ctx={cfg:{...DEFAULT_CONFIG,backend:'cloud',baseUrl:'https://stub.test'},flags:{cwd:process.cwd(),json:false,yes:false},tokens,api:new ApiClient('https://stub.test',tokens),confirm:async()=>false};
await repl(ctx,{noSkills:true}); process.stdout.write('CALLS:'+calls+'\\n');`;
  const outer = String.raw`import os, pty, subprocess, select, sys, time
m,s=pty.openpty()
p=subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]],stdin=s,stdout=s,stderr=s,env=dict(os.environ,AETHER_NO_HISTORY='1',AETHER_NO_ANIM='1'))
os.close(s); data=b''; stage=0; deadline=time.monotonic()+15
while time.monotonic()<deadline:
 if select.select([m],[],[],.05)[0]:
  try: data+=os.read(m,65536)
  except OSError: break
 if stage==0 and b'\x1b[?2004h' in data:
  command=b'/terminal printf CHILD_READY; sleep .4; kill -KILL $$\r' if sys.argv[3]=='crash' else b'/terminal printf CHILD_READY; read a; printf CHILD_DONE\r'
  os.write(m,command); stage=1
 elif stage==1 and b'CHILD_READY' in data and b'Ctrl+] detach' in data:
  time.sleep(.05)
  if sys.argv[3]=='crash':
   os.write(m,b'\x1d'); time.sleep(.1); os.write(m,b'normal chat')
  else: os.write(m,b'fixture input\n')
  stage=2
 elif stage==2 and (b'exited -9' if sys.argv[3]=='crash' else b'exited 0') in data:
  time.sleep(.05); os.write(m,b'\r' if sys.argv[3]=='crash' else b'normal chat\r'); stage=3
 elif stage==3 and b'MODEL_REPLY' in data:
  time.sleep(.05); os.write(m,b'/exit\r'); stage=4
 if p.poll() is not None: break
if p.poll() is None: p.kill()
p.wait(); os.close(m); sys.stdout.buffer.write(data); sys.exit(p.returncode)`;
  const result = spawnSync("python3", ["-c", outer, process.execPath, driver, crash ? "crash" : "normal"], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  if (!crash) assert.match(result.stdout, /CHILD_DONE/);
  assert.match(result.stdout, /MODEL_REPLY/);
  assert.match(result.stdout, /CALLS:1/);
});
