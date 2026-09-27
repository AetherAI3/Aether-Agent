"""The ``aether-agent`` launcher.

Aether Agent is a Node program. This launcher exists so a Python-first machine can install
and run it the same way it installs anything else, without a hand-rolled global npm
install and without a second copy of the agent's own interface to drift from it.

Two rules keep it honest:

1. Every argument that is not in the ``self`` namespace is forwarded to the real ``aether``
   CLI unchanged, and its exit code is this process's exit code. This launcher never
   reimplements, filters, or renames an agent command.
2. It installs the same agent the documented npm route installs -- the ``latest``
   dist-tag, unless you pin one -- into a private prefix that needs no administrator
   rights, unless an ``aether`` is already on PATH, in which case that one is used and
   nothing is installed behind your back.

Zero runtime dependencies: it shells out to ``node`` and ``npm``, which the agent requires
anyway.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import NPM_PACKAGE, __version__

# package.json declares "engines": { "node": ">=24" }, and the test script uses
# --test-isolation=none, which older Node rejects outright.
MIN_NODE_MAJOR = 24

REPO = "https://github.com/AetherAI3/aether-agent"
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")

SELF_COMMANDS = ("install", "doctor", "path", "uninstall")

NEXT_STEPS = f"""
Next steps:
  aether-agent auth login                            Sign in for hosted models
  aether-agent setup --local                         Or prepare a local Ollama route
  aether-agent code "fix the failing test"           Run the agent on this repository

Every command is forwarded to the `aether` CLI unchanged. Its own reference is
`aether-agent --help`; the launcher's is `aether-agent self --help`.

Docs: {REPO}#readme
"""


def _print_error(message: str) -> None:
    print(message, file=sys.stderr)


#: What `self install` fetches when nothing is pinned. `latest` rather than this
#: package's own version on purpose: the agent ships maintenance releases from branches
#: that never reach main, so a launcher pinned to main's version would quietly install an
#: older agent than `npm install -g aether-agents@latest` gives. The two install routes
#: must land on the same agent; pin explicitly when you want a fixed one.
DEFAULT_NPM_TAG = "latest"


def _requested_version() -> str:
    """The npm version or dist-tag to install: `latest` unless pinned."""
    override = os.environ.get("AETHER_AGENT_NPM_VERSION", "").strip()
    if not override:
        return DEFAULT_NPM_TAG
    if not VERSION_PATTERN.match(override):
        _print_error(f"Invalid AETHER_AGENT_NPM_VERSION: {override}")
        raise SystemExit(2)
    return override


def install_root() -> Path:
    """Where the launcher keeps its private npm prefix.

    A prefix under the user's own data directory means installation never needs
    administrator rights and never fights a system-wide npm install.
    """
    override = os.environ.get("AETHER_AGENT_HOME", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
    return Path(base).expanduser().resolve() / "aether-agent"


def _managed_binary() -> Path:
    name = "aether.cmd" if sys.platform == "win32" else "aether"
    return install_root() / "node_modules" / ".bin" / name


def _require(tool: str) -> str:
    found = shutil.which(tool)
    if found is None:
        _print_error(
            f"{tool} is required to run Aether Agent. Install Node {MIN_NODE_MAJOR}+ "
            "(https://nodejs.org/), then re-run."
        )
        raise SystemExit(1)
    return found


def _node_major() -> int | None:
    if shutil.which("node") is None:
        return None
    probe = subprocess.run(
        ["node", "--version"], capture_output=True, text=True, check=False
    )
    if probe.returncode != 0:
        return None
    match = re.match(r"v(\d+)", probe.stdout.strip())
    return int(match.group(1)) if match else None


def _require_supported_node() -> None:
    _require("node")
    major = _node_major()
    if major is None:
        _print_error(
            "Could not read `node --version`. Check the Node installation on PATH."
        )
        raise SystemExit(1)
    if major < MIN_NODE_MAJOR:
        _print_error(
            f"Aether Agent requires Node {MIN_NODE_MAJOR} or newer; found major version {major}. "
            "Upgrade Node (https://nodejs.org/), then re-run."
        )
        raise SystemExit(1)


def resolve_binary() -> tuple[Path, str] | None:
    """The `aether` this launcher would run, and where it came from."""
    on_path = shutil.which("aether")
    if on_path:
        return Path(on_path), "PATH"
    managed = _managed_binary()
    if managed.exists():
        return managed, "launcher install"
    return None


def install(version: str | None = None) -> Path:
    """Install or update the npm CLI into the private prefix and return its binary."""
    _require_supported_node()
    _require("npm")
    target = install_root()
    target.mkdir(parents=True, exist_ok=True)
    wanted = version or _requested_version()
    print(f"Installing {NPM_PACKAGE}@{wanted} into {target} ...", flush=True)
    # --ignore-scripts matches the documented npm install line: the agent needs no
    # lifecycle scripts, and refusing them keeps installation from executing package code.
    command = [
        "npm",
        "install",
        "--prefix",
        str(target),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        f"{NPM_PACKAGE}@{wanted}",
    ]
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        _print_error("npm install failed. See the output above.")
        raise SystemExit(result.returncode or 1)
    binary = _managed_binary()
    if not binary.exists():
        _print_error(f"npm reported success but {binary} is missing.")
        raise SystemExit(1)
    return binary


def _installed_version(binary: Path) -> str | None:
    probe = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True, check=False
    )
    if probe.returncode != 0:
        return None
    return probe.stdout.strip().splitlines()[0] if probe.stdout.strip() else None


def _cmd_install(arguments: argparse.Namespace) -> int:
    binary = install(arguments.npm_version)
    print(f"\nInstalled: {binary}")
    print(NEXT_STEPS)
    return 0


def _cmd_doctor(_: argparse.Namespace) -> int:
    print(f"launcher       aether-agent {__version__} (PyPI)")
    print(f"python         {sys.version.split()[0]}")
    node = _node_major()
    if node is None:
        print(f"node           not found (need {MIN_NODE_MAJOR}+)")
    else:
        supported = (
            "ok" if node >= MIN_NODE_MAJOR else f"too old, need {MIN_NODE_MAJOR}+"
        )
        print(f"node           v{node} ({supported})")
    print(f"npm            {'found' if shutil.which('npm') else 'not found'}")
    print(f"install root   {install_root()}")
    print(f"installs       {NPM_PACKAGE}@{_requested_version()}")

    found = resolve_binary()
    if found is None:
        print("aether CLI     not installed (run `aether-agent self install`)")
        return 1
    binary, source = found
    version = _installed_version(binary) or "unknown"
    print(f"aether CLI     {version} from {source}")
    print(f"               {binary}")
    if source == "PATH":
        print(
            "\nAn `aether` on PATH takes precedence, so this launcher runs the CLI you "
            "already installed rather than a second copy."
        )
    return 0


def _cmd_path(_: argparse.Namespace) -> int:
    found = resolve_binary()
    if found is None:
        _print_error("No aether CLI found. Run `aether-agent self install`.")
        return 1
    print(found[0])
    return 0


def _cmd_uninstall(_: argparse.Namespace) -> int:
    """Remove only what this launcher installed. An `aether` on PATH is never touched."""
    target = install_root()
    if not target.exists():
        print(f"Nothing to remove: {target} does not exist.")
        return 0
    shutil.rmtree(target)
    print(f"Removed {target}")
    return 0


def _self_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aether-agent self",
        description="Manage the Aether Agent CLI this launcher runs.",
        epilog=f"Every other argument is forwarded to the `aether` CLI. Docs: {REPO}#readme",
    )
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command")

    installer = subparsers.add_parser("install", help="install or update the CLI")
    installer.add_argument(
        "--npm-version",
        default=None,
        help=f"npm version or dist-tag to install (default {DEFAULT_NPM_TAG})",
    )
    installer.set_defaults(handler=_cmd_install)

    subparsers.add_parser(
        "doctor", help="report the launcher's view of this machine"
    ).set_defaults(handler=_cmd_doctor)
    subparsers.add_parser(
        "path", help="print the aether binary that would run"
    ).set_defaults(handler=_cmd_path)
    subparsers.add_parser(
        "uninstall", help="remove the launcher's private install"
    ).set_defaults(handler=_cmd_uninstall)
    return parser


def _run_self(argv: list[str]) -> int:
    parser = _self_parser()
    arguments = parser.parse_args(argv)
    handler = getattr(arguments, "handler", None)
    if handler is None:
        parser.print_help()
        return 2
    result: int = handler(arguments)
    return result


def forward(argv: list[str]) -> int:
    """Run the real CLI with these arguments, installing it first if it is missing."""
    found = resolve_binary()
    if found is None:
        _require_supported_node()
        print(
            f"Aether Agent is not installed yet. Fetching {NPM_PACKAGE}@{_requested_version()}."
        )
        binary = install()
    else:
        binary = found[0]
    result = subprocess.run([str(binary), *argv], check=False)
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "self":
        return _run_self(arguments[1:])
    if not arguments:
        # No arguments starts the agent's own REPL, exactly as `aether` alone does.
        return forward([])
    return forward(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
