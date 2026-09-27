import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { COMMAND_MANIFEST, renderManifestHelp } from "../src/commands/command_manifest.js";
import { MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from "../src/main.js";
import { renderCommandReference } from "../scripts/generate-docs.js";
import { stripAnsi } from "../src/ui/theme.js";

const root = process.cwd();
const posixInstaller = readFileSync(join(root, "install.sh"), "utf8");
const windowsInstaller = readFileSync(join(root, "install.ps1"), "utf8");

test("unsupported Node versions fail with one copy/paste recovery path", () => {
  assert.equal(MINIMUM_NODE_MAJOR, 24);
  assert.equal(unsupportedNodeMessage("24.0.0"), null);
  assert.equal(unsupportedNodeMessage("v26.1.0"), null);
  for (const version of ["23.9.0", "v20.0.0", "", "not-a-version"]) {
    const message = unsupportedNodeMessage(version);
    assert.ok(message);
    assert.match(message, /requires Node\.js >= 24/);
    assert.match(message, /reopen your terminal.*aether --version/s);
    assert.match(message, /nodejs\.org\/en\/download/);
  }
});

test("normal help and generated docs expose first-run truth without gated surfaces", () => {
  const help = stripAnsi(renderManifestHelp("shell"));
  assert.match(help, /aether auth login -> aether auth status -> aether models/);
  assert.match(help, /aether agent "explain this repository"/);
  assert.match(help, /aether setup --local/);
  assert.doesNotMatch(help, /--swarm\b/);
  assert.doesNotMatch(help, /aether device\b/);

  const generated = renderCommandReference(COMMAND_MANIFEST);
  assert.doesNotMatch(generated, /--swarm\b/);
  assert.doesNotMatch(generated, /`aether device\b/);
  assert.match(generated, /Availability is evaluated at runtime/);
});

test("installers keep safe npm execution and exact real first-run commands", () => {
  for (const text of [posixInstaller, windowsInstaller]) {
    assert.match(text, /npm install -g [^\n]*aether-agents@[^\n]*--ignore-scripts/);
    assert.doesNotMatch(text, /curl[^\n]*\|\s*(?:ba)?sh/);
    assert.doesNotMatch(text, /full model fleet|fully offline/i);
    for (const command of [
      "aether --version",
      "aether auth login",
      "aether auth status",
      "aether models",
      "aether setup --local",
      "aether local pull qwen2.5-coder:7b --yes",
      "aether agent --local",
      "aether doctor --live",
    ]) assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(posixInstaller, /export PATH=/);
  assert.match(windowsInstaller, /per-user prefix/);
  assert.doesNotMatch(windowsInstaller, /APPDATA\\`npm/);
});

test("install.sh passes POSIX shell syntax validation where sh is available", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell validation runs on the Linux CI job");
  const result = spawnSync("sh", ["-n", join(root, "install.sh")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("install.ps1 passes the PowerShell parser where PowerShell is available", (t) => {
  const candidates = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  const executable = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return !probe.error && probe.status === 0;
  });
  if (!executable) return t.skip("PowerShell is not installed on this runner");
  const command = [
    "$tokens = $null",
    "$errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseFile($env:AETHER_INSTALLER_UNDER_TEST, [ref]$tokens, [ref]$errors) > $null",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
  ].join("; ");
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, AETHER_INSTALLER_UNDER_TEST: resolve(root, "install.ps1") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function writeExecutable(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
  chmodSync(path, 0o755);
}

interface InstallerRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runPosixInstaller(nodeVersion: string, npmBody: string): InstallerRun {
  const sandbox = mkdtempSync(join(tmpdir(), "aether-installer-first-run-"));
  const bin = join(sandbox, "bin");
  mkdirSync(bin);
  try {
    writeExecutable(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' '${nodeVersion}'\n`);
    writeExecutable(join(bin, "npm"), `#!/bin/sh\n${npmBody}\n`);
    const result = spawnSync("sh", [join(root, "install.sh")], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        AETHER_VERSION: "latest",
        FAKE_BIN: bin,
        NO_COLOR: "1",
        PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("install.sh rejects old Node before npm and explains a missing PATH entry", (t) => {
  if (process.platform === "win32") return t.skip("POSIX installer behavior runs on the Linux CI job");
  const oldNode = runPosixInstaller("v23.9.0", "exit 99");
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.stdout + oldNode.stderr, /Node\.js >= 24 required.*v23\.9\.0/s);
  assert.doesNotMatch(oldNode.stdout + oldNode.stderr, /npm v/);

  const missingPath = runPosixInstaller("v24.18.0", [
    'if [ "$1" = "-v" ]; then printf "%s\\n" "11.0.0"; exit 0; fi',
    'if [ "$1" = "install" ]; then exit 0; fi',
    'if [ "$1" = "config" ]; then printf "%s\\n" "$HOME/.local"; exit 0; fi',
    "exit 1",
  ].join("\n"));
  assert.equal(missingPath.status, 1);
  assert.match(missingPath.stdout + missingPath.stderr, /command not found on PATH/);
  assert.match(missingPath.stdout + missingPath.stderr, /export PATH=.*\.local\/bin/);
  assert.match(missingPath.stdout + missingPath.stderr, /aether --version/);
});

test("install.sh success prints the hosted and local paths it actually installed", (t) => {
  if (process.platform === "win32") return t.skip("POSIX installer behavior runs on the Linux CI job");
  const result = runPosixInstaller("v24.18.0", [
    'if [ "$1" = "-v" ]; then printf "%s\\n" "11.0.0"; exit 0; fi',
    'if [ "$1" = "install" ]; then',
    "  printf '%s\\n' '#!/bin/sh' 'printf \"%s\\n\" \"0.3.0\"' > \"$FAKE_BIN/aether\"",
    '  chmod 755 "$FAKE_BIN/aether"',
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout + result.stderr;
  assert.match(output, /Aether Agent 0\.3\.0 installed/);
  assert.match(output, /aether auth login/);
  assert.match(output, /aether auth status/);
  assert.match(output, /aether models/);
  assert.match(output, /aether setup --local/);
  assert.match(output, /aether agent --local/);
});
