from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import re
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "grounds_agent.py"
SPEC = importlib.util.spec_from_file_location("grounds_preflight_agent", SCRIPT)
assert SPEC and SPEC.loader
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)
UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
WRITES = (("preflight", "observe"), ("preflight", "assess"), ("devrun", "prepare"), ("devrun", "admit"))


class PreflightHelperTests(unittest.TestCase):
    def test_preflight_and_admission_writes_are_attributed_and_replayable(self) -> None:
        identity = {"GROUNDS_AGENT_ID": "preflight-author", "GROUNDS_AGENT_NAME": "预检作者"}
        with mock.patch.dict(os.environ, identity, clear=True):
            for command in WRITES:
                with self.subTest(command=command):
                    prepared, operation, attributed = agent.prepare_command(list(command))
                    self.assertTrue(attributed)
                    self.assertRegex(operation or "", UUID7)
                    self.assertIn("--agent-id", prepared)
                    self.assertIn("--agent-name", prepared)
                    replay, repeated, attributed_again = agent.prepare_command(prepared)
                    self.assertEqual(replay, prepared)
                    self.assertEqual(repeated, operation)
                    self.assertTrue(attributed_again)

    def test_preflight_writes_without_identity_fail_before_invocation(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            for command in WRITES:
                with self.subTest(command=command), self.assertRaises(agent.AdapterError):
                    agent.prepare_command(list(command))

    def test_preflight_show_never_creates_an_operation(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(agent, "new_uuid7", side_effect=AssertionError("unexpected write")):
            prepared, operation, attributed = agent.prepare_command(["preflight", "show", "observation-id"])
            self.assertEqual(prepared, ["preflight", "show", "observation-id", "--json"])
            self.assertIsNone(operation)
            self.assertFalse(attributed)

    def test_preflight_and_devrun_help_do_not_inject_config_or_write_parameters(self) -> None:
        commands = (*WRITES, ("preflight", "show"), ("devrun", "start"), ("devrun", "plan"))
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/unavailable/config"}, clear=True), mock.patch.object(agent, "new_uuid7", side_effect=AssertionError("unexpected write")):
            for command in commands:
                with self.subTest(command=command):
                    self.assertEqual(agent.prepare_command([*command, "--help"]), ([*command, "--help", "--json"], None, False))

    def test_disabled_or_malformed_help_does_not_bypass_write_identity(self) -> None:
        invalid = (("--help=false",), ("--help", "--help"), ("--help=bad",), ("--help", "--refresh"))
        with mock.patch.dict(os.environ, {}, clear=True):
            for flags in invalid:
                with self.subTest(flags=flags), self.assertRaises(agent.AdapterError):
                    agent.prepare_command(["preflight", "observe", *flags])


if __name__ == "__main__":
    unittest.main()
