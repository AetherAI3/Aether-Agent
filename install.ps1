# Aether Agent installer - Windows (PowerShell).
#
#   Download, inspect, then run this file with: .\install.ps1
#
# Installs the `aether` CLI globally via npm, then shows next steps.
# Requires Node.js >= 24 and npm on the PATH.

param(
  [switch]$SkipNodeCheck = $false,
  [string]$Version = $(if ($env:AETHER_VERSION) { $env:AETHER_VERSION } else { "latest" })
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^[0-9A-Za-z.+-]+$') {
  throw "Invalid Version: use latest, a dist-tag, or a semver."
}

# Color helpers
$cyan  = 11  # BrightCyan
$green = 10  # BrightGreen
$dim   = 8   # DarkGray

$red_error  = 12
$green_ok   = 10

function Write-Header($msg) { Write-Host $msg -ForegroundColor $cyan }
function Write-Success($msg) { Write-Host "  [ok] " -NoNewline -ForegroundColor $green_ok; Write-Host $msg -ForegroundColor $dim }
function Write-ErrorMsg($msg) { Write-Host "  [error] " -NoNewline -ForegroundColor $red_error; Write-Host $msg }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor $dim }
function Write-Step($msg) { Write-Host "$msg... " -NoNewline -ForegroundColor $dim }

# Banner
Write-Host ""
Write-Header "Aether Agent - Terminal Coding Agent Installer"
Write-Info "npm release $Version | aethersystems.net"
Write-Host ""

# Check Node.js
if (-not $SkipNodeCheck) {
  Write-Step "Checking Node.js"
  $nodePath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodePath) {
    Write-Host ""
    Write-ErrorMsg "Node.js not found. Aether Agent needs Node.js >= 24."
    Write-Host ""
    Write-Info "Install it from https://nodejs.org"
    Write-Info "  winget install OpenJS.NodeJS.LTS"
    Write-Info "  or download from https://nodejs.org/en/download"
    exit 1
  }
  $nodeVersion = (node -v) -replace '^v', ''
  $nodeMajor = [int]($nodeVersion.Split('.')[0])
  Write-Success "Node.js v${nodeVersion}"

  if ($nodeMajor -lt 24) {
    Write-ErrorMsg "Node.js >= 24 required (found v${nodeVersion}). Please upgrade."
    Write-Info "https://nodejs.org/en/download"
    exit 1
  }
}

# Check npm
Write-Step "Checking npm"
$npmPath = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmPath) {
  Write-Host ""
  Write-ErrorMsg "npm not found (it ships with Node.js). Reinstall Node from https://nodejs.org."
  exit 1
}
$npmVersion = npm -v 2>$null
Write-Success "npm v${npmVersion}"

# Check if already installed
$alreadyInstalled = $false
$aetherPath = Get-Command aether -ErrorAction SilentlyContinue
if ($aetherPath) {
  $alreadyInstalled = $true
  Write-Info "aether-agent already installed - will install $Version."
}

# Install
Write-Host ""
if ($alreadyInstalled) {
  Write-Step "Updating aether-agent"
} else {
  Write-Step "Installing aether-agent"
}

# Run npm directly so its native exit status cannot be hidden by a pipeline.
# --ignore-scripts is safe because the package has no install-time lifecycle.
& npm install -g "aether-agents@$Version" --ignore-scripts

if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
  Write-ErrorMsg "Install failed. Check your network and npm permissions."
  Write-Host ""
  if ($Version -ne "latest") {
    Write-Info "If npm reports 'No matching version found', $Version is not published."
    Write-Info "Published versions: npm view aether-agents versions"
  }
  $userPrefix = Join-Path $env:LOCALAPPDATA "npm"
  Write-Info "For EACCES or permission errors, use a per-user prefix:"
  Write-Info ('  npm install -g "aether-agents@{0}" --ignore-scripts --prefix "{1}"' -f $Version, $userPrefix)
  Write-Info ("Then add $userPrefix to your user PATH and reopen PowerShell.")
  exit 1
}

$aetherPath = Get-Command aether -ErrorAction SilentlyContinue
# Verify
if (-not $aetherPath) {
  $npmPrefix = (npm config get prefix 2>$null | Select-Object -First 1)
  Write-ErrorMsg "aether command not found on PATH after install."
  Write-Info "npm global prefix: $npmPrefix"
  Write-Info "Add that directory to your user PATH, reopen PowerShell, then run:"
  Write-Info "  aether --version"
  exit 1
}

$aetherVersion = "unknown"
try { $aetherVersion = (aether --version 2>$null) } catch {}
Write-Success "Aether Agent ${aetherVersion} installed!"

# Next steps
Write-Host ""
Write-Header "Ready - hosted first run"
Write-Host '  aether --version'
Write-Host '  aether auth login'
Write-Host '  aether auth status'
Write-Host '  aether models'
Write-Host '  aether agent "explain this repository"'
Write-Host '  aether doctor'
Write-Host '  aether doctor --live'
Write-Info "No browser: aether auth login --no-browser"
Write-Host ""
Write-Header "Optional local Ollama path"
Write-Host '  aether setup --local'
Write-Host '  aether local pull qwen2.5-coder:7b --yes'
Write-Host '  aether agent --local "explain this repository"'
Write-Info "Ollama must be installed and running before the local steps."
Write-Host ""
