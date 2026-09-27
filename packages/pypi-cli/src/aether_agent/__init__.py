"""pip/pipx installer and launcher for the Aether Agent CLI.

Aether Agent itself is a Node program published to npm as ``aether-agents``. This package
is the Python front door to it: ``pipx install aether-agent`` gets you the same ``aether``
CLI without hand-rolling an npm global install, and every command you type is forwarded to
that CLI unchanged.

The version here tracks main's npm package version, so the two halves of the repository
release together. It is not the version installed: the launcher fetches the npm `latest`
dist-tag unless you pin one, so `pipx install aether-agent` and
`npm install -g aether-agents@latest` land on the same agent.
"""

from __future__ import annotations

__version__ = "0.3.2"

#: The npm package this launcher installs and runs.
NPM_PACKAGE = "aether-agents"

__all__ = ["NPM_PACKAGE", "__version__"]
