import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const MAX_REPLY = 16 * 1024;

function abortError() { return Object.assign(new Error("ATS memory writer lease cancelled."), { name: "AbortError" }); }

export async function startMemoryLease({ command, args = [], helper, directory, agentId, ownerScope, env = process.env, signal }) {
  if (typeof command !== "string" || !command || !Array.isArray(args) || typeof helper !== "string" || !helper
      || typeof directory !== "string" || !isAbsolute(directory) || typeof agentId !== "string" || !agentId
      || !ownerScope || typeof ownerScope.cloudOrigin !== "string" || typeof ownerScope.accountSubject !== "string") {
    throw new Error("Memory writer lease requires a Python command, initialized directory, agent and account scope.");
  }
  if (signal?.aborted) throw abortError();
  const leaseId = randomUUID();
  const child = spawn(command, [...args, "-I", helper], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errorOutput = "", settled = false, closed = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { if (output.length < MAX_REPLY + 1) output += chunk; });
  child.stderr.on("data", chunk => { if (errorOutput.length < MAX_REPLY + 1) errorOutput += chunk; });
  child.stdin.on("error", () => {});
  const stop = () => { try { child.kill("SIGKILL"); } catch {} };
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.write(JSON.stringify({ directory, agentId, ownerScope, leaseId }) + "\n");
  let receipt;
  try {
    receipt = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("Memory writer lease timed out.")); }, 10_000);
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const inspect = () => {
        const newline = output.indexOf("\n");
        if (newline < 0) { if (output.length > MAX_REPLY) finish(new Error("Memory writer lease returned too much data.")); return; }
        let value;
        try { value = JSON.parse(output.slice(0, newline)); } catch { finish(new Error("Memory writer lease returned an invalid receipt.")); return; }
        if (value.state === "error") finish(Object.assign(new Error(value.message || "Memory writer lease failed."), { code: value.code }));
        else finish(null, value);
      };
      child.stdout.on("data", inspect);
      child.on("error", error => finish(error));
      child.on("close", () => { closed = true; inspect(); if (!settled) {
        let failure; try { failure = JSON.parse(output.trim() || errorOutput.trim()); } catch {}
        finish(Object.assign(new Error(failure?.message || "Memory writer lease exited before acquisition."), { code: failure?.code }));
      } });
    });
  } catch (error) {
    stop(); signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw abortError();
    throw error;
  }
  if (!receipt || receipt.schema_version !== "aether.ats.memory-writer-lease/1" || receipt.state !== "leased"
      || receipt.lease_id !== leaseId || receipt.agent_id !== agentId || receipt.directory !== directory
      || receipt.lock_scope !== "ats_runtime_writer" || receipt.runtime_exclusivity_verified !== true
      || receipt.owner_scope?.cloud_origin !== ownerScope.cloudOrigin || receipt.owner_scope?.account_subject !== ownerScope.accountSubject) {
    stop(); signal?.removeEventListener("abort", onAbort);
    throw new Error("Memory writer lease receipt does not match this agent and account.");
  }
  let release;
  const close = () => release ??= new Promise((resolve, reject) => {
    signal?.removeEventListener("abort", onAbort);
    if (closed) { resolve(); return; }
    const timer = setTimeout(() => { stop(); reject(new Error("Memory writer lease did not release cleanly.")); }, 5000);
    child.once("close", code => { closed = true; clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Memory writer lease release failed.")); });
    child.stdin.end("release\n");
  });
  return Object.freeze({ receipt, close });
}
