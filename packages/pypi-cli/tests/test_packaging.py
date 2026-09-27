"""One release, two ecosystems: the launcher must never claim a version the agent is not.

package.json is the source of truth; `node packages/sync-version.mjs` copies it here.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import aether_agent
from aether_agent import cli

PACKAGE = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE.parents[1]


def _pyproject_field(name: str) -> str:
    text = (PACKAGE / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(rf'^{name} = "([^"]+)"', text, re.MULTILINE)
    assert match is not None, f"{name} missing from pyproject.toml"
    return match.group(1)


class TestPackaging(unittest.TestCase):
    def setUp(self) -> None:
        self.npm = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))

    def test_the_launcher_version_tracks_the_npm_package(self) -> None:
        self.assertEqual(
            _pyproject_field("version"),
            self.npm["version"],
            "run `node packages/sync-version.mjs` and commit the result",
        )

    def test_the_module_version_matches_the_distribution_version(self) -> None:
        self.assertEqual(aether_agent.__version__, _pyproject_field("version"))

    def test_the_launcher_installs_the_package_the_repository_publishes(self) -> None:
        self.assertEqual(aether_agent.NPM_PACKAGE, self.npm["name"])

    def test_the_node_floor_matches_the_npm_engines_field(self) -> None:
        engines = self.npm["engines"]["node"]
        self.assertEqual(engines, f">={cli.MIN_NODE_MAJOR}")

    def test_the_binary_name_is_one_the_npm_package_provides(self) -> None:
        self.assertIn("aether", self.npm["bin"])

    def test_the_package_declares_no_runtime_dependencies(self) -> None:
        self.assertIn(
            "dependencies = []",
            (PACKAGE / "pyproject.toml").read_text(encoding="utf-8"),
        )

    def test_the_launcher_ships_the_licence_and_notice_it_claims(self) -> None:
        self.assertTrue((PACKAGE / "LICENSE").is_file())
        self.assertTrue((PACKAGE / "NOTICE.md").is_file())


if __name__ == "__main__":
    unittest.main()
