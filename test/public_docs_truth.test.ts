import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CLI_COMMANDS, CLI_PARSE_OPTIONS } from "../src/commands/cli_registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const releaseTruth = readFileSync(join(root, "docs", "releases", "2026-08-22.md"), "utf8");

function repositoryFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...repositoryFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("retired product branding and URL stay out of the repository", () => {
  // Assemble retired identifiers so this guard does not contain the byte
  // sequence it rejects and can safely scan its own source.
  const retiredUrl = ["aethersystems.net", "terminal"].join("/");
  const retiredName = ["Aether", "Terminal"].join(" ");
  const retiredInitialism = new RegExp(`\\bA${"TS"}\\b`);

  for (const path of repositoryFiles(root)) {
    const text = readFileSync(path, "utf8");
    const name = relative(root, path).replaceAll("\\", "/");
    assert.equal(text.toLowerCase().includes(retiredUrl), false, `${name} contains the retired URL`);
    assert.equal(text.includes(retiredName), false, `${name} contains retired product branding`);
    assert.equal(retiredInitialism.test(text), false, `${name} contains the retired product initialism`);
  }
});

test("README has durable assets and canonical public repository URLs", () => {
  assert.doesNotMatch(readme, /github\.com\/user-attachments\/assets/i);
  assert.doesNotMatch(readme, /github\.com\/(?:DBarr3|Aether-AI-3)\/aether-agent/i);
  assert.doesNotMatch(readme, /github\.com\/AetherAI3\/aether-agent-cli/i);
  assert.match(readme, /git clone https:\/\/github\.com\/AetherAI3\/aether-agent\.git/);
  assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/aether-agents/);
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: unknown };
  assert.ok(Array.isArray(packageManifest.files));
  assert.ok(packageManifest.files.includes("assets/aether-agent-hero.png"));
  assert.ok(existsSync(join(root, "assets", "aether-agent-hero.png")));

  for (const match of readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]!;
    if (/^(?:https?:)?\/\//.test(target) || target.startsWith("#")) continue;
    const localPath = target.split("#", 1)[0]!;
    assert.ok(existsSync(join(root, localPath)), `README local link does not exist: ${target}`);
  }
});

interface ShellWord {
  value: string;
  quoted: boolean;
}

function shellWords(line: string): ShellWord[] {
  const words: ShellWord[] = [];
  let value = "";
  let quote = "";
  let quoted = false;
  const push = (): void => {
    if (value) words.push({ value, quoted });
    value = "";
    quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (!quote && char === "#" && !value) break;
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      quoted = true;
    } else if (quote && char === quote) {
      quote = "";
    } else if (!quote && /\s/.test(char)) {
      push();
    } else {
      value += char;
    }
  }
  push();
  return words;
}

function shellAetherInvocations(markdown: string): Array<{ words: ShellWord[]; offset: number }> {
  const invocations: Array<{ words: ShellWord[]; offset: number }> = [];
  const fences = /```(?:bash|sh|shell|powershell|pwsh|cmd)\s*\r?\n([\s\S]*?)```/gi;
  for (const fence of markdown.matchAll(fences)) {
    const body = fence[1]!;
    let lineOffset = fence.index!;
    for (const line of body.split(/\r?\n/)) {
      const words = shellWords(line.trimStart().replace(/^(?:\$|>)\s*/, ""));
      if (words[0]?.value === "aether") invocations.push({ words, offset: lineOffset });
      lineOffset += line.length + 1;
    }
  }
  return invocations;
}

test("the committed release record keeps a self-consistent npm availability entry", () => {
  const registryVersion = /registry served exactly one\s+version of\s+`[^`]+`[^`\n]*`([^`]+)`/i.exec(
    releaseTruth,
  )?.[1];
  const latestVersion = /dist-tags\.latest`? resolved to\s*\r?\n?`([^`]+)`/i.exec(releaseTruth)?.[1];
  assert.ok(registryVersion && latestVersion, "committed release truth has no parseable npm availability record");
  assert.equal(registryVersion, latestVersion, "committed registry version and latest dist-tag disagree");
});

test("README states npm and source versions in a way publishing cannot falsify", () => {
  // README.md ships inside the tarball and becomes the npmjs.com landing page, so any literal
  // dist-tag version it prints is true only until the next publish. The npm cell must therefore
  // resolve its value when the page is read, not when the commit was written.
  const sourceVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const tick = String.fromCharCode(96);

  const npmCell = new RegExp(`^\\| npm ${tick}latest${tick} \\|([^|]*)\\|`, "m").exec(readme)?.[1];
  assert.ok(npmCell, "README has no npm `latest` install row");
  assert.doesNotMatch(npmCell, /\d+\.\d+\.\d+/, "the npm `latest` cell pins a version that publishing invalidates");
  assert.match(npmCell, /img\.shields\.io\/npm\/v\/aether-agents/, "the npm `latest` cell must resolve the live dist-tag");
  assert.doesNotMatch(readme, /future published/i, "README asserts an unpublished state that publishing invalidates");

  assert.ok(readme.includes(`| ${tick}main${tick} source build | **${sourceVersion}** |`));

  const sourceStart = readme.indexOf("<!-- SOURCE-0.3-WORKFLOWS:START -->");
  const sourceEnd = readme.indexOf("<!-- SOURCE-0.3-WORKFLOWS:END -->");
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart, "README source-only scope markers are missing");
  const sourceScope = readme.slice(sourceStart, sourceEnd);
  assert.match(sourceScope, new RegExp(`Requires ${sourceVersion.replaceAll(".", "\\.")} or newer`));
});

test("README fenced shell examples use registered commands and flags", () => {
  const registered = new Set<string>();
  for (const command of ALL_CLI_COMMANDS) {
    registered.add(command.name);
    for (const alias of command.aliases ?? []) registered.add(alias);
  }
  const shortFlags = new Set(
    Object.values(CLI_PARSE_OPTIONS).flatMap((flag) => (flag.short ? [flag.short] : [])),
  );
  const sourceStart = readme.indexOf("<!-- SOURCE-0.3-WORKFLOWS:START -->");
  const sourceEnd = readme.indexOf("<!-- SOURCE-0.3-WORKFLOWS:END -->");
  const sourceOnlyCommands = new Set(["review", "ship", "sessions", "skills", "capabilities", "support-bundle"]);
  const sourceOnlyFlags = new Set(["local", "test-cmd", "resume", "live", "fix", "dry-run"]);
  const publishedExamples = new Set(["auth", "chat", "models"]);

  for (const invocation of shellAetherInvocations(readme)) {
    const inSourceScope = invocation.offset > sourceStart && invocation.offset < sourceEnd;
    let command: string | undefined;
    for (const word of invocation.words.slice(1)) {
      const long = !word.quoted ? /^--([a-z][a-z0-9-]*)(?:=.*)?$/.exec(word.value) : null;
      const short = !word.quoted ? /^-([A-Za-z])$/.exec(word.value) : null;
      if (long) {
        assert.ok(CLI_PARSE_OPTIONS[long[1]!], `README uses an unregistered flag: ${word.value}`);
        if (sourceOnlyFlags.has(long[1]!)) assert.ok(inSourceScope, `${word.value} is advertised to npm 0.1.0 users`);
      } else if (short) {
        assert.ok(shortFlags.has(short[1]!), `README uses an unregistered short flag: ${word.value}`);
      } else if (!command && !word.quoted) {
        command = word.value;
        assert.ok(registered.has(command), `README names an unregistered command: ${command}`);
        if (sourceOnlyCommands.has(command)) assert.ok(inSourceScope, `${command} is advertised to npm 0.1.0 users`);
        if (!inSourceScope) assert.ok(publishedExamples.has(command), `${command} is outside the source-only scope`);
      }
    }
  }
});
