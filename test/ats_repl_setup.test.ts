import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("coding REPL slash setup never queues wizard answers and restores the prompt on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-repl-setup-"));
  const imports = Object.fromEntries(["commands/chat", "core/config", "core/auth", "core/transport"].map(path => [path, new URL(`../src/${path}.js`, import.meta.url).href]));
  const driver = `
    import { cmdChat } from ${JSON.stringify(imports["commands/chat"])};
    import { DEFAULT_CONFIG } from ${JSON.stringify(imports["core/config"])};
    import { StaticTokenStore } from ${JSON.stringify(imports["core/auth"])};
    import { ApiClient } from ${JSON.stringify(imports["core/transport"])};
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    Object.defineProperty(process.stdout, 'isTTY', {value:true});
    process.stdin.setRawMode = () => process.stdin;
    const paths = [];
    globalThis.fetch = async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (!path.endsWith('/models')) throw new Error('Unexpected coding or create request');
      return new Response(JSON.stringify({models:[], orchestrators:[], default:'', tier:'free'}));
    };
    const tokens = new StaticTokenStore('aek_offline_fixture');
    const code = await cmdChat({cfg:{...DEFAULT_CONFIG,baseUrl:'https://fixture.test/cloud',backend:'cloud'}, tokens,
      api:new ApiClient('https://fixture.test/cloud', tokens), flags:{json:false,audit:false,yes:false,cwd:process.env.AETHER_CONFIG_DIR},confirm:async()=>false}, '');
    process.stdout.write('FIXTURE_RESULT:'+JSON.stringify({code,paths})+'\\n');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AETHER_CONFIG_DIR: root, AETHER_NO_HISTORY: "1", NO_COLOR: "1", TERM: "xterm" } });
  let output = "", errors = "";
  const sent = new Set<string>();
  const replies: Array<[string, string]> = [
    ["Type a prompt,", "/agent-create ATS Atlas\r"],
    ["Memory drive/folder", join(root, "memory") + "\r"],
    ["Memory size in GiB", "5\r"],
    ["Strategy folder", join(root, "strategies") + "\r"],
    ["Data provider:", "\x03"],
    ["Setup canceled.", "/exit\r"],
  ];
  child.stdout.on("data", chunk => {
    output += String(chunk);
    for (const [prompt, response] of replies) if (output.includes(prompt) && !sent.has(prompt)) {
      sent.add(prompt); child.stdin.write(response);
    }
  });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0, output + errors);
    const match = /FIXTURE_RESULT:(.*)/.exec(output);
    assert.ok(match, output + errors);
    const result = JSON.parse(match[1]!);
    assert.equal(result.code, 0);
    assert.ok(result.paths.every((path: string) => path.endsWith("/models")), JSON.stringify(result.paths));
    assert.doesNotMatch(output, /Queued|Running:/);
    assert.equal(sent.size, replies.length);
  } finally { clearTimeout(deadline); child.kill(); await rm(root, { recursive: true, force: true }); }
});
