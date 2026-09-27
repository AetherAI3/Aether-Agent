#!/bin/sh
# Aether Agent installer — macOS / Linux / WSL.
#
#   Download, inspect, then run this file with: sh install.sh
#
# Installs the `aether` CLI globally via npm, then shows next steps.
# Respects NO_COLOR (https://no-color.org) and non-TTY output.

set -eu

# Pin a specific PUBLISHED release with AETHER_VERSION=<version>, e.g. 0.1.0.
# The default follows npm's latest dist-tag, while the quoted package spec
# prevents shell interpretation. A version that is not on the registry yet
# cannot be installed this way — build from source instead (see README).
AETHER_VERSION="${AETHER_VERSION:-latest}"
case "$AETHER_VERSION" in
  ""|*[!0-9A-Za-z.+-]*)
    printf '%s\n' "Invalid AETHER_VERSION: use latest, a dist-tag, or a semver."
    exit 1
    ;;
esac

# ── ANSI color helpers ──
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold="$(printf '\033[1m')";   n="$(printf '\033[0m')"
  cyan="$(printf '\033[38;5;44m')"
  ice="$(printf '\033[38;5;117m')"
  green="$(printf '\033[32m')"
  red="$(printf '\033[31m')"
  dim="$(printf '\033[90m')"
else
  bold=""; n=""; cyan=""; ice=""; green=""; red=""; dim=""
fi

check="✓"
cross="✗"
arrow="→"

# ── Print helpers ──
header()  { printf '%s\n' "${cyan}${bold}$*${n}"; }
success() { printf '%s\n' "  ${green}${check}${n} $*"; }
error()   { printf '%s\n' "  ${red}${cross}${n} $*"; }
info()    { printf '%s\n' "  ${dim}$*${n}"; }
step()    { printf '%s' "${dim}$*${n}... "; }

# ── Cloud glyph ──
cloud() {
  printf '%s\n' "${ice}                            ▄▄███▄▄   ${n}"
  printf '%s\n' "${ice}                           ▄█████████▄ ${n}"
  printf '%s\n' "${ice}                           ███▄███▄███ ${n}"
  printf '%s\n' "${ice}                           ▀████▄████▀ ${n}"
  printf '%s\n' "${ice}                             ▀ ▀ ▀ ▀   ${n}"
}

# ── Banner ──
echo ""
cloud
echo ""
echo "${cyan}┌──────────────────────────────────────────────────────────────┐${n}"
echo "${cyan}│${n}                                                              ${cyan}│${n}"
echo "${cyan}│${n}  ${ice}☁${n}  ${bold}Aether Agent${n} — Terminal Coding Agent Installer              ${cyan}│${n}"
echo "${cyan}│${n}     ${dim}npm release ${AETHER_VERSION}  ·  aethersystems.net${n}                    ${cyan}│${n}"
echo "${cyan}│${n}                                                              ${cyan}│${n}"
echo "${cyan}└──────────────────────────────────────────────────────────────┘${n}"
echo ""

# ── Check Node.js ──
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  error "Node.js not found. Aether Agent needs Node.js >= 24."
  echo ""
  info "Install it from https://nodejs.org or your package manager."
  info "  macOS:  brew install node"
  info "  Linux/other: https://nodejs.org/en/download"
  exit 1
fi

NODE_V=$(node -v 2>/dev/null | sed 's/^v//')
NODE_MAJ=$(echo "$NODE_V" | cut -d. -f1)
case "$NODE_MAJ" in
  ""|*[!0-9]*)
    echo ""
    error "Could not read the Node.js version (received: ${NODE_V:-empty})."
    info "Repair Node.js, reopen your terminal, then run: node --version"
    exit 1
    ;;
esac
success "Node.js v${NODE_V}"

if [ "$NODE_MAJ" -lt 24 ]; then
  error "Node.js >= 24 required (found v${NODE_V}). Please upgrade."
  info "https://nodejs.org/en/download"
  exit 1
fi

# ── Check npm ──
step "Checking npm"
if ! command -v npm >/dev/null 2>&1; then
  echo ""
  error "npm not found (it ships with Node.js). Reinstall Node from https://nodejs.org."
  exit 1
fi
NPM_V=$(npm -v 2>/dev/null)
success "npm v${NPM_V}"

# ── Check if already installed ──
ALREADY=""
if command -v aether >/dev/null 2>&1; then
  AETH_V=$(aether --version 2>/dev/null || echo "unknown")
  ALREADY="yes"
  info "aether-agent ${AETH_V} already installed — will install ${AETHER_VERSION}."
fi

# ── Install ──
echo ""
if [ -n "$ALREADY" ]; then
  step "Updating aether-agent"
else
  step "Installing aether-agent"
fi

# Keep npm attached directly so POSIX sh receives its real exit status. The
# package has no runtime dependencies; --ignore-scripts makes that contract
# fail-safe if the registry graph ever drifts.
if ! npm install -g "aether-agents@${AETHER_VERSION}" --ignore-scripts; then
  error "Install failed. Check your network and npm permissions."
  echo ""
  if [ "$AETHER_VERSION" != "latest" ]; then
    info "If you see 'No matching version found', ${AETHER_VERSION} is not on the"
    info "registry yet. Published versions: npm view aether-agents versions"
    info "To run an unpublished version, build from source — see the README."
    echo ""
  fi
  info "If you see EACCES errors, try one of:"
  info "  npm install -g aether-agents@${AETHER_VERSION} --ignore-scripts --prefix \"${HOME}/.local\""
  info "  export PATH=\"${HOME}/.local/bin:\$PATH\""
  info "Persist that PATH in your shell profile, or install Node with a version manager."
  exit 1
fi

# ── Verify ──
if ! command -v aether >/dev/null 2>&1; then
  NPM_PREFIX=$(npm config get prefix 2>/dev/null || true)
  AETHER_BIN="${NPM_PREFIX}/bin"
  error "aether command not found on PATH after install."
  info "npm global prefix: ${NPM_PREFIX}"
  info "Add it for this shell, then retry:"
  info "  export PATH=\"${AETHER_BIN}:\$PATH\""
  info "  aether --version"
  echo ""
  info "For nvm users: nvm use --delete-prefix v24 --silent"
  exit 1
fi

AETH_V=$(aether --version 2>/dev/null || echo "unknown")
success "Aether Agent ${AETH_V} installed!"

# ── Next steps ──
echo ""
header "Ready — hosted first run"
printf '%s\n' \
  "  aether --version" \
  "  aether auth login" \
  "  aether auth status" \
  "  aether models" \
  "  aether agent \"explain this repository\"" \
  "  aether doctor" \
  "  aether doctor --live"
info "No browser: aether auth login --no-browser"
echo ""
header "Optional local Ollama path"
printf '%s\n' \
  "  aether setup --local" \
  "  aether local pull qwen2.5-coder:7b --yes" \
  "  aether agent --local \"explain this repository\""
info "Ollama must be installed and running before the local steps."
echo ""
