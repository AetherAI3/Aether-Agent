import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { childEnv } from "./child_env.js";

// Standard-library Linux PTY bridge. stdin is a JSON control pipe, never the
// command's terminal. The child gets its own controlling terminal/session.
const BRIDGE = String.raw`
import os, sys, pty, fcntl, termios, struct, signal, select, json, base64, time
def emit(value):
 print(json.dumps(value), flush=True)
pid, master = pty.fork()
if pid == 0:
 fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', int(sys.argv[3]), int(sys.argv[4]), 0, 0))
 os.chdir(sys.argv[1])
 os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-c', sys.argv[2]])
def resize(rows, cols):
 fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(int(sys.argv[3]), int(sys.argv[4]))
emit({'type':'ready', 'pid':pid})
stopping = False
deadline = 0
groups = {pid}
buffer = b''
def stop(*args):
 global stopping, deadline
 if not stopping:
  stopping = True
  deadline = time.monotonic() + .2
  try:
   foreground = os.tcgetpgrp(master)
   if foreground > 0 and foreground != os.getpgrp(): groups.add(foreground)
  except OSError: pass
  for group in groups:
   try: os.killpg(group, signal.SIGTERM)
   except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
try:
 while True:
  if stopping and time.monotonic() >= deadline:
   for group in groups:
    try: os.killpg(group, signal.SIGKILL)
    except ProcessLookupError: pass
  ready, _, _ = select.select([master, 0], [], [], .05)
  if 0 in ready:
   chunk = os.read(0, 65536)
   if not chunk: stop()
   buffer += chunk
   if len(buffer) > 1048576: raise RuntimeError('control frame too large')
   while b'\n' in buffer:
    line, buffer = buffer.split(b'\n', 1)
    frame = json.loads(line)
    if frame['type'] == 'input': os.write(master, base64.b64decode(frame['data']))
    elif frame['type'] == 'resize': resize(frame['rows'], frame['cols'])
    elif frame['type'] == 'stop': stop()
  if master in ready:
   try: data = os.read(master, 65536)
   except OSError: data = b''
   if data: emit({'type':'output','data':base64.b64encode(data).decode()})
  ended, status = os.waitpid(pid, os.WNOHANG)
  if ended:
   # Drain final output before reporting exit, then reap remaining group members.
   while select.select([master], [], [], 0)[0]:
    try: data = os.read(master, 65536)
    except OSError: break
    if not data: break
    emit({'type':'output','data':base64.b64encode(data).decode()})
   for group in groups:
    try: os.killpg(group, signal.SIGKILL)
    except ProcessLookupError: pass
   emit({'type':'exit','code':os.waitstatus_to_exitcode(status)})
   break
finally:
 stop()
 for group in groups:
  try: os.killpg(group, signal.SIGKILL)
  except ProcessLookupError: pass
 os.close(master)
`;

export class TerminalPty {
  readonly id = randomUUID();
  readonly finished: Promise<number>;
  state: "starting" | "running" | "exited" = "starting";
  private readonly child: ChildProcessWithoutNullStreams;
  private resolveFinished!: (code: number) => void;
  private listeners = new Set<(data: Buffer) => void>();
  private replay = Buffer.alloc(0);
  private exitListeners = new Set<() => void>();
  private error = "";
  constructor(readonly cwd: string, readonly command: string, rows = 24, cols = 80, python = "python3") {
    if (process.platform !== "linux") throw new Error("Interactive PTY requires Linux and Python 3; use !command for bounded capture on this platform.");
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    this.child = spawn(python, ["-u", "-c", BRIDGE, cwd, command, String(rows), String(cols)], {
      env: childEnv({ inject: { TERM: process.env["TERM"] || "xterm-256color" } }), stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", () => {});
    let pending = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      if (pending.length > 2 * 1024 * 1024) { this.stop(); return; }
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try {
          const frame = JSON.parse(line) as { type: string; data?: string; code?: number };
          if (frame.type === "ready") this.state = "running";
          if (frame.type === "output" && typeof frame.data === "string") {
            const data = Buffer.from(frame.data, "base64");
            this.replay = Buffer.concat([this.replay, data]).subarray(-8192);
            for (const listener of this.listeners) listener(data);
          }
          if (frame.type === "exit") this.finish(frame.code ?? 1);
        } catch { this.stop(); }
      }
    });
    this.child.stderr.on("data", (data: Buffer) => { this.error = (this.error + data.toString()).slice(-4096); });
    this.child.on("error", error => { this.error = error.message; this.finish(127); });
    this.child.on("close", code => this.finish(code || 1));
  }
  private finish(code: number): void {
    if (this.state === "exited") return;
    this.state = "exited";
    this.resolveFinished(code);
    for (const listener of this.exitListeners) listener();
  }
  diagnostic(): string { return this.error; }
  observe(listener: (data: Buffer) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private send(frame: object): void { if (this.state !== "exited" && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(frame) + "\n"); }
  input(data: Buffer): void { this.send({ type: "input", data: data.toString("base64") }); }
  resize(rows: number, cols: number): void {
    this.send({ type: "resize", rows: Math.max(1, Math.min(1000, rows || 24)), cols: Math.max(1, Math.min(1000, cols || 80)) });
  }
  stop(): void { this.send({ type: "stop" }); this.child.kill("SIGTERM"); }
  /** One stdin owner while attached. Ctrl+] detaches; Ctrl+C goes to the PTY. */
  async attach(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<"detached" | "exited"> {
    if (!input.isTTY || !output.isTTY) throw new Error("PTY attachment needs a real TTY; use !command in pipes/CI.");
    if (this.listeners.size) throw new Error("terminal already attached");
    if (this.state === "exited") return "exited";
    const wasRaw = input.isRaw;
    output.write(`\n[terminal ${this.id} | Ctrl+] detach | Ctrl+C interrupt]\n\x1b[?2004l`);
    input.setRawMode(true);
    output.write(this.replay);
    return new Promise(resolve => {
      const paint = (data: Buffer): void => { output.write(data); };
      const resize = (): void => this.resize(output.rows, output.columns);
      const done = (state: "detached" | "exited"): void => {
        input.off("data", read); input.off("end", ended); output.off("resize", resize);
        this.listeners.delete(paint); this.exitListeners.delete(exited);
        input.setRawMode(Boolean(wasRaw));
        output.write("\x1b[?1049l\x1b[0m\x1b[?25h\x1b[?2004h\n");
        resolve(state);
      };
      const read = (data: Buffer): void => {
        const detach = data.indexOf(29);
        if (detach >= 0) { if (detach) this.input(data.subarray(0, detach)); done("detached"); }
        else this.input(data);
      };
      const exited = (): void => done("exited");
      const ended = (): void => { this.stop(); done("detached"); };
      this.listeners.add(paint); this.exitListeners.add(exited);
      input.on("data", read); input.once("end", ended); output.on("resize", resize); resize();
    });
  }
}
