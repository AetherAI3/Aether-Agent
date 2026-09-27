"""The launcher's contract: forward everything, install one known version, own nothing else."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest import mock

from aether_agent import NPM_PACKAGE, cli

AETHER = Path("/bin/aether")
MANAGED = Path("/managed/aether")


def _completed(
    returncode: int = 0, stdout: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=""
    )


class TestInstallRoot(unittest.TestCase):
    def test_honours_an_explicit_home(self) -> None:
        with mock.patch.dict(
            "os.environ", {"AETHER_AGENT_HOME": "/tmp/somewhere"}, clear=False
        ):
            self.assertEqual(cli.install_root(), Path("/tmp/somewhere").resolve())

    def test_falls_back_to_a_per_user_directory_needing_no_admin_rights(self) -> None:
        with mock.patch.dict("os.environ", {"AETHER_AGENT_HOME": ""}, clear=False):
            root = cli.install_root()
        self.assertEqual(root.name, "aether-agent")
        self.assertTrue(root.is_absolute())


class TestRequestedVersion(unittest.TestCase):
    def test_defaults_to_the_npm_latest_dist_tag(self) -> None:
        # Not this package's version: the agent ships maintenance releases from branches
        # that never reach main, so pinning to main's version would install an older agent
        # than the documented `npm install -g aether-agents@latest` route.
        with mock.patch.dict(
            "os.environ", {"AETHER_AGENT_NPM_VERSION": ""}, clear=False
        ):
            self.assertEqual(cli._requested_version(), "latest")

    def test_accepts_an_explicit_override(self) -> None:
        with mock.patch.dict(
            "os.environ", {"AETHER_AGENT_NPM_VERSION": "0.2.1"}, clear=False
        ):
            self.assertEqual(cli._requested_version(), "0.2.1")

    def test_refuses_a_version_that_could_carry_shell_or_flag_syntax(self) -> None:
        for bad in (
            "--registry=http://evil",
            "0.1.0; rm -rf /",
            "$(id)",
            "&& npm login",
        ):
            with (
                self.subTest(bad=bad),
                mock.patch.dict(
                    "os.environ", {"AETHER_AGENT_NPM_VERSION": bad}, clear=False
                ),
                self.assertRaises(SystemExit) as caught,
            ):
                cli._requested_version()
            self.assertEqual(caught.exception.code, 2)


class TestResolution(unittest.TestCase):
    def test_prefers_an_aether_already_on_path(self) -> None:
        with mock.patch.object(
            cli.shutil, "which", return_value="/usr/local/bin/aether"
        ):
            found = cli.resolve_binary()
        assert found is not None
        self.assertEqual(found[1], "PATH")

    def test_falls_back_to_the_launcher_install(self) -> None:
        with (
            mock.patch.object(cli.shutil, "which", return_value=None),
            mock.patch.object(cli.Path, "exists", return_value=True),
        ):
            found = cli.resolve_binary()
        assert found is not None
        self.assertEqual(found[1], "launcher install")

    def test_reports_nothing_when_neither_exists(self) -> None:
        with (
            mock.patch.object(cli.shutil, "which", return_value=None),
            mock.patch.object(cli.Path, "exists", return_value=False),
        ):
            self.assertIsNone(cli.resolve_binary())


class TestForwarding(unittest.TestCase):
    def test_passes_every_argument_through_untouched(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=(AETHER, "PATH")),
            mock.patch.object(cli.subprocess, "run", return_value=_completed()) as run,
        ):
            cli.main(["code", "--test-cmd", "npm test", "fix the failing test"])
        self.assertEqual(
            run.call_args.args[0],
            [str(AETHER), "code", "--test-cmd", "npm test", "fix the failing test"],
        )

    def test_returns_the_agent_exit_code(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=(AETHER, "PATH")),
            mock.patch.object(
                cli.subprocess, "run", return_value=_completed(returncode=7)
            ),
        ):
            self.assertEqual(cli.main(["audit"]), 7)

    def test_no_arguments_starts_the_agents_own_repl(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=(AETHER, "PATH")),
            mock.patch.object(cli.subprocess, "run", return_value=_completed()) as run,
        ):
            cli.main([])
        self.assertEqual(run.call_args.args[0], [str(AETHER)])

    def test_installs_on_first_use_then_forwards(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=None),
            mock.patch.object(cli, "_require_supported_node"),
            mock.patch.object(cli, "install", return_value=MANAGED) as install,
            mock.patch.object(cli.subprocess, "run", return_value=_completed()) as run,
        ):
            cli.main(["models"])
        install.assert_called_once_with()
        self.assertEqual(run.call_args.args[0], [str(MANAGED), "models"])

    def test_agent_commands_are_never_shadowed_by_the_launcher(self) -> None:
        # `aether doctor` is a real agent command. Only the `self` namespace is the
        # launcher's, so doctor, auth, sessions and the rest must reach the agent.
        for command in ("doctor", "auth", "sessions", "config", "install", "help"):
            with (
                self.subTest(command=command),
                mock.patch.object(cli, "resolve_binary", return_value=(AETHER, "PATH")),
                mock.patch.object(
                    cli.subprocess, "run", return_value=_completed()
                ) as run,
            ):
                cli.main([command])
            self.assertEqual(run.call_args.args[0], [str(AETHER), command])


class TestSelfNamespace(unittest.TestCase):
    def test_install_targets_the_same_agent_as_the_npm_route(self) -> None:
        with (
            mock.patch.object(cli, "_require_supported_node"),
            mock.patch.object(cli, "_require", return_value="npm"),
            mock.patch.object(cli.Path, "mkdir"),
            mock.patch.object(cli.Path, "exists", return_value=True),
            mock.patch.object(cli.subprocess, "run", return_value=_completed()) as run,
            mock.patch.dict(
                "os.environ", {"AETHER_AGENT_NPM_VERSION": ""}, clear=False
            ),
        ):
            cli.main(["self", "install"])
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["npm", "install"])
        self.assertIn("--ignore-scripts", command)
        self.assertEqual(command[-1], f"{NPM_PACKAGE}@{cli.DEFAULT_NPM_TAG}")

    def test_install_accepts_an_explicit_npm_version(self) -> None:
        with (
            mock.patch.object(cli, "_require_supported_node"),
            mock.patch.object(cli, "_require", return_value="npm"),
            mock.patch.object(cli.Path, "mkdir"),
            mock.patch.object(cli.Path, "exists", return_value=True),
            mock.patch.object(cli.subprocess, "run", return_value=_completed()) as run,
        ):
            cli.main(["self", "install", "--npm-version", "0.2.0"])
        self.assertEqual(run.call_args.args[0][-1], f"{NPM_PACKAGE}@0.2.0")

    def test_install_fails_loudly_when_npm_fails(self) -> None:
        with (
            mock.patch.object(cli, "_require_supported_node"),
            mock.patch.object(cli, "_require", return_value="npm"),
            mock.patch.object(cli.Path, "mkdir"),
            mock.patch.object(
                cli.subprocess, "run", return_value=_completed(returncode=1)
            ),
            self.assertRaises(SystemExit) as caught,
        ):
            cli.main(["self", "install"])
        self.assertEqual(caught.exception.code, 1)

    def test_doctor_reports_a_missing_cli_as_a_failure(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=None),
            mock.patch.object(cli, "_node_major", return_value=24),
            mock.patch.object(cli.shutil, "which", return_value="npm"),
        ):
            self.assertEqual(cli.main(["self", "doctor"]), 1)

    def test_doctor_passes_once_the_cli_is_present(self) -> None:
        with (
            mock.patch.object(cli, "resolve_binary", return_value=(AETHER, "PATH")),
            mock.patch.object(cli, "_node_major", return_value=24),
            mock.patch.object(cli, "_installed_version", return_value="0.3.0"),
            mock.patch.object(cli.shutil, "which", return_value="npm"),
        ):
            self.assertEqual(cli.main(["self", "doctor"]), 0)

    def test_uninstall_removes_only_the_launchers_own_directory(self) -> None:
        with (
            mock.patch.object(
                cli, "install_root", return_value=Path("/managed/aether-agent")
            ),
            mock.patch.object(cli.Path, "exists", return_value=True),
            mock.patch.object(cli.shutil, "rmtree") as rmtree,
        ):
            self.assertEqual(cli.main(["self", "uninstall"]), 0)
        rmtree.assert_called_once_with(Path("/managed/aether-agent"))

    def test_bare_self_prints_help_rather_than_guessing(self) -> None:
        self.assertEqual(cli.main(["self"]), 2)


class TestNodeRequirement(unittest.TestCase):
    def test_refuses_a_node_older_than_the_agent_supports(self) -> None:
        with (
            mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(cli, "_node_major", return_value=20),
            self.assertRaises(SystemExit) as caught,
        ):
            cli._require_supported_node()
        self.assertEqual(caught.exception.code, 1)

    def test_accepts_the_supported_node(self) -> None:
        with (
            mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"),
            mock.patch.object(cli, "_node_major", return_value=cli.MIN_NODE_MAJOR),
        ):
            cli._require_supported_node()


if __name__ == "__main__":
    unittest.main()
