from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import select
import signal
import sys
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "grounds_agent.py"
SPEC = importlib.util.spec_from_file_location("grounds_agent", SCRIPT)
assert SPEC and SPEC.loader
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def retired_auth_login_commands(text: str) -> list[str]:
    # GitHub CLI authentication is supported. Bare/helper-dispatched auth login
    # and explicit Grounds auth login still name the retired Grounds family.
    pattern = re.compile(r"\b(?:(?P<host>gh)[ \t]+)?auth[ \t]+login\b")
    return [match.group(0) for match in pattern.finditer(text) if match.group("host") is None]


class GroundsAgentTests(unittest.TestCase):
    def test_editor_url_is_streamed_while_service_is_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "grounds"
            binary.write_text("#!" + sys.executable + "\nimport time\nprint('editor-session-url', flush=True)\ntime.sleep(60)\n")
            binary.chmod(0o700)
            environment = dict(os.environ, GROUNDS_BIN=str(binary))
            process = subprocess.Popen([sys.executable, str(SCRIPT), "invoke", "--cwd", directory, "--", "workspace", "edit", "draft"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment, start_new_session=True)
            try:
                ready, _, _ = select.select([process.stdout], [], [], 15)
                self.assertTrue(ready, "helper buffered editor output")
                self.assertEqual(process.stdout.readline().strip(), "editor-session-url")
                self.assertIsNone(process.poll(), "service should still be running")
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=10)

    def test_unified_session_classification_preserves_static_exports(self) -> None:
        self.assertTrue(agent.is_foreground_contract_session(["contract", "render", "--workspace", "draft"]))
        self.assertTrue(agent.is_foreground_contract_session(["workspace", "edit", "draft"]))
        for output in (["--output", "/tmp/out"], ["--output=/tmp/out"]):
            self.assertFalse(agent.is_foreground_contract_session(["contract", "render", "--workspace", "draft", *output]))

    def test_unified_url_is_streamed_while_service_is_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "grounds"
            binary.write_text("#!" + sys.executable + "\nimport time\nprint('unified-session-url', flush=True)\ntime.sleep(60)\n")
            binary.chmod(0o700)
            environment = dict(os.environ, GROUNDS_BIN=str(binary))
            process = subprocess.Popen([sys.executable, str(SCRIPT), "invoke", "--cwd", directory, "--", "contract", "render", "--workspace", "draft"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment, start_new_session=True)
            try:
                ready, _, _ = select.select([process.stdout], [], [], 15)
                self.assertTrue(ready, "helper buffered unified session output")
                self.assertEqual(process.stdout.readline().strip(), "unified-session-url")
                self.assertIsNone(process.poll())
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=10)

    def test_local_json_commands_do_not_preflight_or_require_identity(self) -> None:
        envelope = {"format": "patchledger.cli/v1", "ok": True, "operation_id": "01900000-0000-7000-8000-000000000001", "data": {}, "warnings": []}
        completed = subprocess.CompletedProcess([], 0, json.dumps(envelope), "")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(agent, "grounds_binary", return_value="grounds"), mock.patch.object(agent, "preflight", side_effect=AssertionError("offline preflight")), mock.patch.object(agent.subprocess, "run", return_value=completed) as run:
            for action in ("read", "save", "resolve", "migrate"):
                result, code = agent.invoke(["workspace", action, "draft"], Path("/tmp"), 0)
                self.assertEqual(code, 0)
                self.assertTrue(result["ok"])
                self.assertNotIn("--agent-id", run.call_args.args[0])


    def test_draft_alias_keeps_configured_identity_without_database_preflight(self) -> None:
        envelope = {"format": "patchledger.cli/v1", "ok": True, "data": {}}
        completed = subprocess.CompletedProcess([], 0, json.dumps(envelope), "")
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/configured/config.yaml"}, clear=True), mock.patch.object(agent, "grounds_binary", return_value="grounds"), mock.patch.object(agent, "preflight", side_effect=AssertionError("offline preflight")), mock.patch.object(agent.subprocess, "run", return_value=completed) as run:
            for action in ("new", "read", "save", "bind"):
                result, code = agent.invoke(["draft", action, "example"], Path("/tmp"), 0)
                self.assertEqual(code, 0)
                argv = run.call_args.args[0]
                self.assertIn("/configured/config.yaml", argv)
                self.assertNotIn("--agent-id", argv)

    def test_env_help_never_injects_write_or_config_parameters(self) -> None:
        run_id = "01a12b5f-5692-74b7-8990-02765f975d70"
        commands = [["env"], *[["env", a] for a in ("up", "list", "cancel", "logs")], ["env", "down", run_id], ["env", "run", run_id]]
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/nonexistent/config"}, clear=True), mock.patch.object(agent, "new_uuid7", side_effect=AssertionError("generated write identity")):
            for command in commands:
                for flag in ("--help", "--help=true"):
                    with self.subTest(command=command, flag=flag):
                        self.assertEqual(agent.prepare_command([*command, flag]), ([*command, flag, "--json"], None, False))
            for flags in (["--help=false"], ["--help=bad"], ["--help=TRUE"], ["--help", "--help"], ["--help", "true"], ["--help", "--lease", "mixed"]):
                with self.subTest(flags=flags):
                    self.assertFalse(agent.is_readonly_help(["env", "run", run_id, *flags]))
                    prepared, operation_id, write = agent.prepare_command(["env", "run", run_id, *flags])
                    self.assertFalse(write)
                    self.assertIsNone(operation_id)
                    self.assertNotIn("--config", prepared)
                    self.assertNotIn("--agent-id", prepared)

    def test_business_command_help_does_not_require_or_inject_write_identity(self) -> None:
        commands = [["repository", "register"], ["candidate", "submit"],
                    ["selection", "set"], ["eval", "suite", "task", "add"], [], ["help"]]
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/missing/config"}, clear=True):
            for command in commands:
                with self.subTest(command=command):
                    prepared, operation, attributed = agent.prepare_command([*command, "--help"])
                    self.assertEqual(prepared, [*command, "--help", "--json"])
                    self.assertIsNone(operation)
                    self.assertFalse(attributed)

    def test_delivery_link_writes_receive_identity_but_trace_stays_read_only(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "history", "GROUNDS_AGENT_NAME": "History"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for action in ("record", "withdraw"):
                prepared, operation_id, attributed = agent.prepare_command(["delivery-link", action])
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                self.assertIn("--agent-id", prepared)
            prepared, operation_id, attributed = agent.prepare_command(["trace", "--at", "refund.ts:2"])
            self.assertFalse(attributed)
            self.assertIsNone(operation_id)
            self.assertNotIn("--agent-id", prepared)

    def test_uuid7_shape_and_uniqueness(self) -> None:
        values = {agent.new_uuid7() for _ in range(100)}
        self.assertEqual(len(values), 100)
        self.assertTrue(all(UUID7.fullmatch(value) for value in values))

    def test_eval_writes_receive_identity_and_replay_id_but_reads_do_not(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "eval", "GROUNDS_AGENT_NAME": "Evaluator"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for command in (["eval", "qa", "publish"], ["eval", "artifact", "submit"], ["eval", "grader", "context"], ["eval", "grader", "execute"], ["eval", "grader", "evidence-submit"], ["eval", "suite", "task", "add"], ["eval", "run", "finish"]):
                prepared, operation_id, attributed = agent.prepare_command(command)
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                self.assertIn("--agent-id", prepared)
            for command in (["eval", "qa", "show"], ["eval", "artifact", "export"], ["eval", "grader", "evidence-export"], ["eval", "run", "context"], ["eval", "experiment", "report"], ["eval", "suite", "show"]):
                prepared, operation_id, attributed = agent.prepare_command(command)
                self.assertFalse(attributed)
                self.assertIsNone(operation_id)
                self.assertNotIn("--agent-id", prepared)

    def test_local_env_commands_are_unattributed_and_never_receive_ledger_config(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "env-operator", "GROUNDS_AGENT_NAME": "Env Operator", "GROUNDS_CONFIG": "/tmp/ledger.yaml"}
        run_id = "01a12b5f-5692-74b7-8990-02765f975d70"
        commands = (
            ["env", "up"],
            ["env", "up", "--workspace", "/tmp/worktree", "--definition", "default"],
            ["env", "list"],
            ["env", "down", run_id],
            ["env", "run", run_id, "--argv-file", "argv.json", "--timeout-seconds", "60"],
            ["env", "cancel", run_id],
            ["env", "logs", run_id, "--tail-bytes", "4096"],
        )
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(agent, "new_uuid7", side_effect=AssertionError("generated write identity")):
            for command in commands:
                with self.subTest(command=command):
                    prepared, operation_id, write = agent.prepare_command(command)
                    self.assertFalse(write)
                    self.assertIsNone(operation_id)
                    self.assertIn("--json", prepared)
                    for option in ("--config", "--agent-id", "--agent-name", "--operation-id"):
                        self.assertNotIn(option, prepared)

    def test_removed_command_families_are_no_longer_write_classified(self) -> None:
        families = {family for family, _ in agent.BUSINESS_WRITES}
        self.assertTrue({"sandbox", "execution", "content", "auth", "environment", "environment-definition"}.isdisjoint(families))

    def test_archive_binding_is_attributed_but_checks_and_guides_are_reads(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "archive-dev", "GROUNDS_AGENT_NAME": "Archive Developer"}
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, write = agent.prepare_command(["repository", "archive-bind", "--repository", "01a14b45-d09e-754f-90ad-d7599a6294f5", "--expected-version", "0"])
            self.assertTrue(write)
            self.assertIsNotNone(operation_id)
            self.assertIn("--agent-id", prepared)
            for action in ("archive-show", "archive-check", "archive-guide", "archive-template"):
                prepared, operation_id, write = agent.prepare_command(["repository", action, "--repository", "01a14b45-d09e-754f-90ad-d7599a6294f5"])
                self.assertFalse(write)
                self.assertIsNone(operation_id)
                self.assertNotIn("--agent-id", prepared)

    def test_business_write_injects_contract_options(self) -> None:
        environment = {
            "GROUNDS_AGENT_ID": "codex-dev",
            "GROUNDS_AGENT_NAME": "Codex Developer",
            "GROUNDS_CONFIG": "/tmp/ledger-config.yaml",
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, business_write = agent.prepare_command(
                ["workspace", "publish", "checkout-flow"]
            )
        self.assertTrue(business_write)
        self.assertIsNone(operation_id)
        self.assertIn("--json", prepared)
        self.assertIn("--config", prepared)
        self.assertIn("--agent-id", prepared)
        self.assertIn("--agent-name", prepared)
        self.assertNotIn("--operation-id", prepared)

    def test_devrun_cleanup_is_an_attributed_write_with_a_replayable_operation(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "dev-1", "GROUNDS_AGENT_NAME": "Dev One", "GROUNDS_CONFIG": "/tmp/ledger.yaml"}
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, write = agent.prepare_command(["devrun", "cleanup", "01a12b5f-5692-74b7-8990-02765f975d70"])
            self.assertTrue(write)
            self.assertRegex(operation_id or "", UUID7)
            self.assertIn("--agent-id", prepared)
            replay, repeated, _ = agent.prepare_command(prepared)
            self.assertEqual(repeated, operation_id)
            self.assertEqual(replay.count("--operation-id"), 1)
            # Read-only neighbours stay unattributed.
            for command in (["devrun", "reconcile", "01a12b5f-5692-74b7-8990-02765f975d70"], ["devrun", "uncommitted"]):
                prepared, operation_id, write = agent.prepare_command(command)
                self.assertFalse(write)
                self.assertIsNone(operation_id)

    def test_environment_writes_preserve_identity_and_operation_on_replay(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "env-author", "GROUNDS_AGENT_NAME": "Environment Author"}
        commands = (
            ["eval", "environment", "publish"],
            ["eval", "envcheck", "submit"],
            ["eval", "preparation", "submit"],
            ["eval", "instance", "submit"],
        )
        for command in commands:
            with self.subTest(command=command), mock.patch.dict(os.environ, environment, clear=True):
                prepared, operation_id, attributed = agent.prepare_command(command)
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                self.assertEqual(prepared[prepared.index("--agent-id") + 1], "env-author")
                self.assertEqual(prepared[prepared.index("--agent-name") + 1], "Environment Author")
                replay, replay_id, _ = agent.prepare_command(prepared)
                self.assertEqual(replay, prepared)
                self.assertEqual(replay_id, operation_id)
            with self.subTest(command=command, identity="missing"), mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(agent.AdapterError, "GROUNDS_AGENT_ID"):
                    agent.prepare_command(command)

    def test_environment_reads_do_not_require_identity_or_operation(self) -> None:
        commands = (
            ["eval", "environment", "show"], ["eval", "environment", "list"],
            ["eval", "envcheck", "show"], ["eval", "envcheck", "list"], ["eval", "envcheck", "export"],
            ["eval", "preparation", "show"], ["eval", "preparation", "list"], ["eval", "preparation", "export"],
            ["eval", "instance", "show"], ["eval", "instance", "list"], ["eval", "instance", "export"],
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            for command in commands:
                with self.subTest(command=command):
                    prepared, operation_id, attributed = agent.prepare_command(command)
                    self.assertFalse(attributed)
                    self.assertIsNone(operation_id)
                    self.assertNotIn("--agent-id", prepared)
                    self.assertNotIn("--operation-id", prepared)

    def test_environment_write_retry_reuses_operation_and_rejects_changed_input(self) -> None:
        failure = mock.Mock(
            stdout=json.dumps({"format": agent.ENVELOPE_FORMAT, "ok": False,
                               "error": {"code": "STORAGE_TRANSIENT", "retryable": True, "message": "busy"}}),
            stderr="", returncode=7,
        )
        success = mock.Mock(
            stdout=json.dumps({"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {}}),
            stderr="", returncode=0,
        )
        environment = {"GROUNDS_AGENT_ID": "env-author", "GROUNDS_AGENT_NAME": "Environment Author"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "definition.json"
            path.write_text("{}", encoding="utf-8")
            command = ["eval", "environment", "publish", "--file", str(path)]
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.object(agent, "grounds_binary", return_value="/tmp/grounds"),
                mock.patch.object(agent.time, "sleep"),
                mock.patch.object(agent.subprocess, "run", side_effect=[failure, success]) as run,
            ):
                result, code = agent.invoke(command, Path(directory), 1)
                self.assertTrue(result["ok"])
                self.assertEqual(code, 0)
                self.assertEqual(run.call_args_list[0].args[0], run.call_args_list[1].args[0])
                self.assertIn("--operation-id", run.call_args_list[0].args[0])

                def change_input(*args: object, **kwargs: object) -> mock.Mock:
                    path.write_text('{"changed":true}', encoding="utf-8")
                    return failure

                run.reset_mock()
                run.side_effect = change_input
                with self.assertRaisesRegex(agent.AdapterError, "input changed"):
                    agent.invoke(command, Path(directory), 1)
                self.assertEqual(run.call_count, 1)

    def test_selection_writes_preserve_operation_and_attribution(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "codex-deliver", "GROUNDS_AGENT_NAME": "Codex Deliver"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for action in ("set", "clear"):
                prepared, operation_id, attributed = agent.prepare_command(["selection", action])
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                self.assertIn("--agent-id", prepared)
                replay, replay_id, _ = agent.prepare_command(prepared)
                self.assertEqual(replay_id, operation_id)
                self.assertEqual(replay, prepared)
            prepared, operation_id, attributed = agent.prepare_command(["selection", "materialize"])
            self.assertFalse(attributed)
            self.assertIsNone(operation_id)
            self.assertNotIn("--agent-id", prepared)

    def test_candidate_archive_reserves_identity_but_preview_is_read_only(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "codex-archive", "GROUNDS_AGENT_NAME": "Codex Archive"}
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, attributed = agent.prepare_command(["candidate", "archive"])
            self.assertTrue(attributed)
            self.assertRegex(operation_id or "", UUID7)
            self.assertEqual(agent.prepare_command(prepared), (prepared, operation_id, attributed))
            for command in (["candidate", "archive", "--dry-run"], ["candidate", "archive-status"], ["candidate", "archive-operation"], ["candidate", "lineage"], ["candidate", "diff"], ["candidate", "fetch"], ["candidate", "restore"]):
                preview, operation_id, attributed = agent.prepare_command(command)
                self.assertFalse(attributed)
                self.assertIsNone(operation_id)
                self.assertNotIn("--agent-id", preview)

    def test_integration_observations_and_decisions_are_attributed_writes(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "codex-deliver", "GROUNDS_AGENT_NAME": "Codex Deliver"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for action in ("observe", "authorize", "consume", "landing"):
                prepared, operation_id, attributed = agent.prepare_command(["integration", action])
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                replay, replay_id, _ = agent.prepare_command(prepared)
                self.assertEqual(replay_id, operation_id)
                self.assertEqual(replay, prepared)
            prepared, operation_id, attributed = agent.prepare_command(["integration", "show"])
            self.assertFalse(attributed)
            self.assertIsNone(operation_id)
            self.assertNotIn("--agent-id", prepared)

    def test_sync_mutations_are_attributed_but_status_is_not(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "sync-author", "GROUNDS_AGENT_NAME": "Sync Author"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for action in ("sync", "sync-complete", "sync-abandon"):
                prepared, operation_id, attributed = agent.prepare_command(["devrun", action])
                self.assertTrue(attributed)
                self.assertRegex(operation_id or "", UUID7)
                replay, replay_id, _ = agent.prepare_command(prepared)
                self.assertEqual(replay, prepared)
                self.assertEqual(replay_id, operation_id)
            for action in ("sync-status", "sync-show"):
                _, operation_id, attributed = agent.prepare_command(["devrun", action])
                self.assertFalse(attributed)
                self.assertIsNone(operation_id)

    def test_business_write_requires_stable_identity(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(agent.AdapterError, "GROUNDS_AGENT_ID"):
                agent.prepare_command(["devrun", "start"])

    def test_development_plan_has_stable_local_operation_without_attribution(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            prepared, operation_id, attributed = agent.prepare_command(["devrun", "plan"])
            self.assertRegex(operation_id or "", UUID7)
            self.assertFalse(attributed)
            self.assertNotIn("--agent-id", prepared)
            replay, replay_id, _ = agent.prepare_command(prepared)
            self.assertEqual(replay, prepared)
            self.assertEqual(replay_id, operation_id)

    def test_development_continuation_is_attributed_and_retries_same_operation(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "branch-author", "GROUNDS_AGENT_NAME": "Branch Author"}
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, attributed = agent.prepare_command(["devrun", "continue"])
            self.assertTrue(attributed)
            self.assertRegex(operation_id or "", UUID7)
            replay, replay_id, _ = agent.prepare_command(prepared)
            self.assertEqual(replay, prepared)
            self.assertEqual(replay_id, operation_id)
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(agent.AdapterError, "GROUNDS_AGENT_ID"):
                agent.prepare_command(["devrun", "continue"])

    def test_adoption_binding_bytes_are_part_of_retry_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            binding = cwd / "adoption.json"
            for option in (["--adoption-file", "adoption.json"], ["--adoption-file=adoption.json"]):
                command = ["integration", "landing", *option]
                binding.write_text('{"target":"release-a"}', encoding="utf-8")
                original = agent.input_fingerprint(command, cwd)
                binding.write_text('{"target":"release-b"}', encoding="utf-8")
                self.assertNotEqual(original, agent.input_fingerprint(command, cwd))

    def test_unverified_preparation_exception_is_attributed_without_changing_ordinary_prepare(self) -> None:
        environment = {"GROUNDS_AGENT_ID": "delivery-author", "GROUNDS_AGENT_NAME": "Delivery Author"}
        with mock.patch.dict(os.environ, environment, clear=True):
            for flag in ("--allow-unverified", "--allow-unverified=true"):
                prepared, operation, attributed = agent.prepare_command(["selection", "materialize", flag, "--reason", "用户明确决定本次继续"])
                self.assertTrue(attributed)
                self.assertRegex(operation or "", UUID7)
                replay, replay_id, _ = agent.prepare_command(prepared)
                self.assertEqual(replay, prepared)
                self.assertEqual(replay_id, operation)
        with mock.patch.dict(os.environ, {}, clear=True):
            for flags in ([], ["--allow-unverified=false"]):
                prepared, operation, attributed = agent.prepare_command(["selection", "materialize", *flags])
                self.assertFalse(attributed)
                self.assertIsNone(operation)
                self.assertNotIn("--agent-id", prepared)
            with self.assertRaisesRegex(agent.AdapterError, "GROUNDS_AGENT_ID"):
                agent.prepare_command(["selection", "materialize", "--allow-unverified"])

    def test_repository_write_injects_operation_and_attribution(self) -> None:
        environment = {
            "GROUNDS_AGENT_ID": "codex-define",
            "GROUNDS_AGENT_NAME": "Codex Define",
            "GROUNDS_CONFIG": "/tmp/ledger-config.yaml",
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            prepared, operation_id, business_write = agent.prepare_command(
                ["repository", "register"]
            )
        self.assertTrue(business_write)
        self.assertRegex(operation_id or "", UUID7)
        self.assertIn("--json", prepared)
        self.assertIn("--config", prepared)
        self.assertIn("--agent-id", prepared)
        self.assertIn("--agent-name", prepared)
        self.assertIn("--operation-id", prepared)

    def test_signed_handoff_submit_uses_embedded_identity(self) -> None:
        with mock.patch.dict(
            os.environ, {"GROUNDS_CONFIG": "/tmp/ledger-config.yaml"}, clear=True
        ):
            prepared, operation_id, business_write = agent.prepare_command(
                ["verification", "submit", "candidate-id", "--handoff", "handoff.json"]
            )
        self.assertTrue(business_write)
        self.assertRegex(operation_id or "", UUID7)
        self.assertIn("--config", prepared)
        self.assertNotIn("--agent-id", prepared)
        self.assertNotIn("--agent-name", prepared)

    def test_env_entry_never_inherits_ledger_configuration(self) -> None:
        run_id = "01a12b5f-5692-74b7-8990-02765f975d70"
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/tmp/private-ledger.yaml"}, clear=True):
            for command in (["env", "up"], ["env", "list"], ["env", "down", run_id], ["env", "run", run_id, "--argv-file", "argv.json"], ["env", "cancel", run_id], ["env", "logs", run_id]):
                with self.subTest(command=command):
                    prepared, operation, attributed = agent.prepare_command(command)
                    self.assertNotIn("--config", prepared)
                    self.assertNotIn("--agent-id", prepared)
                    self.assertIsNone(operation)
                    self.assertFalse(attributed)
                    self.assertIn("--json", prepared)

    def test_offline_handoff_inherits_agent_identity_without_ledger_or_operation(self) -> None:
        command = ["verification", "handoff", "--file", "report.json"]
        with mock.patch.dict(os.environ, {"GROUNDS_AGENT_ID": "verifier", "GROUNDS_AGENT_NAME": "Verifier", "GROUNDS_CONFIG": "/missing"}, clear=True):
            prepared, operation, attributed = agent.prepare_command(command)
            self.assertEqual(prepared, [*command, "--json", "--agent-id", "verifier", "--agent-name", "Verifier"])
            self.assertIsNone(operation)
            self.assertTrue(attributed)
        with mock.patch.dict(os.environ, {}, clear=True):
            explicit = [*command, "--agent-id=explicit", "--agent-name=Explicit"]
            self.assertEqual(agent.prepare_command(explicit)[0], [*explicit, "--json"])
            with self.assertRaises(agent.AdapterError):
                agent.prepare_command(command)

    def test_candidate_help_does_not_fingerprint_a_worktree(self) -> None:
        response = {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {}, "warnings": []}
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(agent, "grounds_binary", return_value="grounds"), mock.patch.object(agent, "worktree_fingerprint", side_effect=AssertionError("read Git for help")), mock.patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(response), "")):
            self.assertEqual(agent.invoke(["candidate", "submit", "--help"], Path("/tmp"), 0)[1], 0)

    def test_offline_verification_commands_do_not_inject_config(self) -> None:
        with mock.patch.dict(
            os.environ, {"GROUNDS_CONFIG": "/tmp/ledger-config.yaml"}, clear=True
        ):
            template, _, _ = agent.prepare_command(
                ["verification", "template", "--context", "blind.json"]
            )
            handoff, _, _ = agent.prepare_command(
                ["verification", "handoff", "--file", "report.json", "--agent-id", "v", "--agent-name", "V"]
            )
        with mock.patch.dict(
            os.environ, {"GROUNDS_CONFIG": "/tmp/ledger-config.yaml"}, clear=True
        ):
            digest, _, _ = agent.prepare_command(
                ["verification", "independent-digest", "--file", "report.json"]
            )
        self.assertNotIn("--config", template)
        self.assertNotIn("--config", handoff)
        self.assertNotIn("--config", digest)

    def test_explicit_options_are_not_duplicated(self) -> None:
        command = [
            "verification",
            "submit",
            "018f0000-0000-7000-8000-000000000001",
            "--agent-id=verifier",
            "--agent-name=Verifier",
            "--operation-id=018f0000-0000-7000-8000-000000000002",
            "--json",
        ]
        with mock.patch.dict(
            os.environ,
            {"GROUNDS_AGENT_ID": "unused", "GROUNDS_AGENT_NAME": "Unused"},
            clear=True,
        ):
            prepared, operation_id, _ = agent.prepare_command(command)
        self.assertEqual(prepared, command)
        self.assertEqual(operation_id, "018f0000-0000-7000-8000-000000000002")

    def test_compare_injects_options_before_candidate_ids(self) -> None:
        with mock.patch.dict(
            os.environ, {"GROUNDS_CONFIG": "/tmp/config.yaml"}, clear=True
        ):
            prepared, _, business_write = agent.prepare_command(
                ["candidate", "compare", "candidate-a", "candidate-b"]
            )
        self.assertFalse(business_write)
        self.assertEqual(
            prepared,
            [
                "candidate",
                "compare",
                "--json",
                "--config",
                "/tmp/config.yaml",
                "candidate-a",
                "candidate-b",
            ],
        )

    def test_compare_moves_user_options_before_candidate_ids(self) -> None:
        with mock.patch.dict(
            os.environ, {"GROUNDS_CONFIG": "/tmp/config.yaml"}, clear=True
        ):
            prepared, _, business_write = agent.prepare_command(
                [
                    "candidate",
                    "compare",
                    "candidate-a",
                    "candidate-b",
                    "--pairwise",
                    "candidate-a:candidate-b",
                    "--include-patch=candidate-a",
                ]
            )
        self.assertFalse(business_write)
        self.assertEqual(
            prepared,
            [
                "candidate",
                "compare",
                "--json",
                "--config",
                "/tmp/config.yaml",
                "--pairwise",
                "candidate-a:candidate-b",
                "--include-patch=candidate-a",
                "candidate-a",
                "candidate-b",
            ],
        )

    def test_explicit_binary_overrides_path_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "custom-grounds"
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o700)
            with mock.patch.dict(os.environ, {"GROUNDS_BIN": str(binary)}, clear=True):
                self.assertTrue(Path(agent.grounds_binary()).samefile(binary))

    def test_linked_npm_binary_is_used_when_path_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory)
            binary = prefix / "bin" / "grounds"
            binary.parent.mkdir()
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o700)
            response = mock.Mock(returncode=0, stdout=f"{prefix}\n")
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(
                    agent.shutil,
                    "which",
                    side_effect=lambda name: "/usr/bin/npm" if name == "npm" else None,
                ),
                mock.patch.object(agent.subprocess, "run", return_value=response),
            ):
                self.assertTrue(Path(agent.grounds_binary()).samefile(binary))

    def test_envelope_rejects_format_drift(self) -> None:
        payload = json.dumps({"format": "patchledger.cli/v2", "ok": True, "data": {}})
        with self.assertRaisesRegex(agent.AdapterError, "unsupported"):
            agent.parse_envelope(payload, 0)

    def test_preflight_surfaces_upgrade_commands_without_blocking_local_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            config.write_text("version: 2\n", encoding="utf-8")

            def response(data: dict[str, object]) -> mock.Mock:
                return mock.Mock(
                    stdout=json.dumps(
                        {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": data, "warnings": []}
                    ),
                    stderr="",
                    returncode=0,
                )

            doctor = response(
                {
                    "upgrade_required": True,
                    "recommended_commands": ["npm install ...", "grounds install skill"],
                }
            )
            config_path = response({"config_path": str(config)})
            config_validation = response({"valid": True})
            database_status = response({"migration_state": "clean"})
            with (
                mock.patch.dict(os.environ, {"HOME": directory}, clear=True),
                mock.patch.object(agent, "grounds_binary", return_value="/tmp/grounds"),
                mock.patch.object(
                    agent.subprocess,
                    "run",
                    side_effect=[doctor, config_path, config_validation, database_status],
                ),
            ):
                result = agent.preflight(False)

        self.assertTrue(result["ready"])
        self.assertTrue(result["upgrade_required"])
        self.assertEqual(len(result["recommended_commands"]), 2)
        self.assertTrue(result["installation_status"]["ok"])

    def test_only_retryable_storage_errors_are_retried(self) -> None:
        failure = mock.Mock(
            stdout=json.dumps(
                {
                    "format": agent.ENVELOPE_FORMAT,
                    "ok": False,
                    "error": {"code": "STORAGE_TRANSIENT", "retryable": True, "message": "busy"},
                }
            ),
            stderr="",
            returncode=7,
        )
        success = mock.Mock(
            stdout=json.dumps({"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {}}),
            stderr="",
            returncode=0,
        )
        environment = {"GROUNDS_AGENT_ID": "agent", "GROUNDS_AGENT_NAME": "Agent"}
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch.object(agent.shutil, "which", return_value="/tmp/grounds"),
            mock.patch.object(agent, "input_fingerprint", return_value="same"),
            mock.patch.object(agent.subprocess, "run", side_effect=[failure, success]) as run,
            mock.patch.object(agent.time, "sleep"),
        ):
            envelope, code = agent.invoke(["requirement", "create", "--file", "x"], Path("/tmp"), 2)
        self.assertTrue(envelope["ok"])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_count, 2)
        first_operation = run.call_args_list[0].args[0][-1]
        second_operation = run.call_args_list[1].args[0][-1]
        self.assertEqual(first_operation, second_operation)

    def test_candidate_retry_stops_when_worktree_changes(self) -> None:
        failure = mock.Mock(
            stdout=json.dumps(
                {
                    "format": agent.ENVELOPE_FORMAT,
                    "ok": False,
                    "error": {"code": "STORAGE_TRANSIENT", "retryable": True, "message": "busy"},
                }
            ),
            stderr="",
            returncode=7,
        )
        environment = {"GROUNDS_AGENT_ID": "agent", "GROUNDS_AGENT_NAME": "Agent"}
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch.object(agent.shutil, "which", return_value="/tmp/grounds"),
            mock.patch.object(agent, "worktree_fingerprint", side_effect=["before", "after"]),
            mock.patch.object(agent, "input_fingerprint", return_value="same"),
            mock.patch.object(agent.subprocess, "run", return_value=failure),
        ):
            with self.assertRaisesRegex(agent.AdapterError, "worktree changed"):
                agent.invoke(
                    ["candidate", "submit", "018f0000-0000-7000-8000-000000000001"],
                    Path("/tmp"),
                    2,
                )

    def test_worktree_fingerprint_includes_tracked_and_untracked_contents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            subprocess.run(["git", "init", "-b", "main"], cwd=repository, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline"],
                cwd=repository,
                check=True,
                capture_output=True,
            )

            tracked = repository / "tracked.txt"
            tracked.write_text("first tracked value\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=repository, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "tracked"],
                cwd=repository,
                check=True,
                capture_output=True,
            )

            tracked.write_text("second tracked value\n", encoding="utf-8")
            first_tracked = agent.worktree_fingerprint(repository)
            tracked.write_text("third tracked value\n", encoding="utf-8")
            second_tracked = agent.worktree_fingerprint(repository)
            self.assertNotEqual(first_tracked, second_tracked)

            untracked = repository / "untracked.txt"
            untracked.write_text("first untracked value\n", encoding="utf-8")
            first_untracked = agent.worktree_fingerprint(repository)
            untracked.write_text("second untracked value\n", encoding="utf-8")
            second_untracked = agent.worktree_fingerprint(repository)
            self.assertNotEqual(first_untracked, second_untracked)

            # An empty checkpoint preserves all file bytes but changes the
            # source identity that a managed-branch Candidate must freeze.
            before_checkpoint = agent.worktree_fingerprint(repository)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "checkpoint"],
                cwd=repository,
                check=True,
                capture_output=True,
            )
            self.assertNotEqual(before_checkpoint, agent.worktree_fingerprint(repository))

    def test_retry_stops_when_input_file_changes(self) -> None:
        failure = mock.Mock(
            stdout=json.dumps(
                {
                    "format": agent.ENVELOPE_FORMAT,
                    "ok": False,
                    "error": {"code": "STORAGE_TRANSIENT", "retryable": True, "message": "busy"},
                }
            ),
            stderr="",
            returncode=7,
        )
        environment = {"GROUNDS_AGENT_ID": "agent", "GROUNDS_AGENT_NAME": "Agent"}
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch.object(agent.shutil, "which", return_value="/tmp/grounds"),
            mock.patch.object(agent, "input_fingerprint", side_effect=["before", "after"]),
            mock.patch.object(agent.subprocess, "run", return_value=failure),
        ):
            with self.assertRaisesRegex(agent.AdapterError, "input changed"):
                agent.invoke(["verification", "submit", "--file", "verification.json"], Path("/tmp"), 2)

    def test_native_candidate_draft_extracts_the_cli_owned_submission(self) -> None:
        submission = {
            "format": "patchledger.candidate-submission/v2",
            "explanation": "",
            "claims": [],
            "change_index": {
                "format": "patchledger.change-index/v1",
                "patch_digest": "sha256:" + "1" * 64,
                "units_digest": "sha256:" + "2" * 64,
            },
            "change_rationales": [],
        }
        envelope = {
            "format": agent.ENVELOPE_FORMAT,
            "ok": True,
            "data": {"submission": submission},
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate.json"
            with mock.patch.object(agent, "invoke", return_value=(envelope, 0)) as invoke:
                path = agent.native_draft(
                    "candidate",
                    Path(directory),
                    output,
                    dev_run="dev-run-id",
                )
            self.assertEqual(path, output)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), submission)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            invoke.assert_called_once_with(
                ["candidate", "template", "dev-run-id"], Path(directory).resolve(), 0
            )

    def test_native_draft_rejects_ambiguous_inputs(self) -> None:
        with self.assertRaisesRegex(agent.AdapterError, "requires --dev-run"):
            agent.native_draft("candidate", Path("/tmp"), None)
        with self.assertRaisesRegex(agent.AdapterError, "requires --context"):
            agent.native_draft("verification", Path("/tmp"), None, dev_run="x")

    def test_native_draft_forwards_chinese_content_language(self) -> None:
        report = {"format": "patchledger.verification-report/v1"}
        envelope = {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {"report": report}}
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "blind.json"
            context.write_text("{}", encoding="utf-8")
            with mock.patch.object(agent, "invoke", return_value=(envelope, 0)) as invoke:
                agent.native_draft(
                    "verification", Path(directory), Path(directory) / "report.json",
                    context=context, content_language="zh-CN",
                )
            invoke.assert_called_once_with(
                ["verification", "template", "--context", str(context.resolve()), "--content-language", "zh-CN"],
                Path(directory).resolve(), 0,
            )

    def test_native_draft_recognises_a_quality_context(self) -> None:
        report = {"format": "patchledger.quality-review-report/v1"}
        envelope = {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {"report": report}}
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / "quality.json"
            context.write_text(json.dumps({"format": "patchledger.quality-context/v1"}), encoding="utf-8")
            with mock.patch.object(agent, "invoke", return_value=(envelope, 0)):
                path = agent.native_draft("verification", Path(directory), Path(directory) / "quality-report.json", context=context)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)

            wrong = {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {"report": {"format": "patchledger.verification-report/v1"}}}
            with mock.patch.object(agent, "invoke", return_value=(wrong, 0)):
                with self.assertRaisesRegex(agent.AdapterError, "quality-review-report"):
                    agent.native_draft("verification", Path(directory), Path(directory) / "other.json", context=context)

    def test_automatic_native_draft_uses_private_permissions(self) -> None:
        submission = {"format": "patchledger.candidate-submission/v2"}
        envelope = {"format": agent.ENVELOPE_FORMAT, "ok": True, "data": {"submission": submission}}
        with mock.patch.object(agent, "invoke", return_value=(envelope, 0)):
            path = agent.native_draft("candidate", Path("/tmp"), None, dev_run="dev-run-id")
        try:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        finally:
            path.unlink()
            path.parent.rmdir()

    def test_skills_keep_executable_safety_steps(self) -> None:
        skill_root = SCRIPT.parents[1] / "skills"
        model = (SCRIPT.parents[1] / "skills/grounds/references/workflows/define.md").read_text(encoding="utf-8")
        verify = (SCRIPT.parents[1] / "skills/grounds/references/workflows/verify.md").read_text(
            encoding="utf-8"
        )
        develop = (SCRIPT.parents[1] / "skills/grounds/references/workflows/develop.md").read_text(
            encoding="utf-8"
        )
        compare = (SCRIPT.parents[1] / "skills/grounds/references/workflows/deliver.md").read_text(
            encoding="utf-8"
        )

        # These checks bind the workflow to stable CLI/contract interfaces.
        # Natural-language policy equivalence needs review and behavioral evals,
        # not an English (or translated) sentence-presence test.
        self.assertIn("draft publish --dry-run", model)
        self.assertIn("../self-contained-contracts.md", model)
        self.assertIn("draft rebase", model)
        self.assertIn("--content-language zh-CN", model)
        self.assertIn("--confirm-initialize", model)
        self.assertIn("--baseline-policy require_override", model)
        self.assertIn("--ca-file", model)
        self.assertIn("--remote", model)
        self.assertIn("#### Traces To", model)
        self.assertIn("../rationale-quality.md", develop)
        self.assertIn("patchledger.candidate-submission/v2", develop)
        self.assertIn("--refines-candidate", develop)
        self.assertIn("verification context CANDIDATE_ID --phase blind", verify)
        self.assertIn("verification context CANDIDATE_ID --phase reconcile", verify)
        self.assertIn("data.context", verify)
        self.assertIn("verification handoff", verify)
        self.assertIn("--handoff", verify)
        # ultra mode: explicit selection, the quality role, and the digest that fixes the blind part.
        self.assertIn("--mode ultra", verify)
        self.assertIn("--role quality", verify)
        self.assertIn("--quality-handoff", verify)
        self.assertIn("verification independent-digest", verify)
        self.assertIn("patchledger.quality-context/v1", verify)
        self.assertIn("../candidate-comparison.md", compare)
        self.assertIn("../review-conversation.md", compare)

    def test_skills_and_references_do_not_name_removed_command_families(self) -> None:
        plugin_root = SCRIPT.parents[1]
        contracts = plugin_root / "references" / "contracts"
        removed = (
            "environment-reuse",
            "--execution-config",
            "bind-host",
            "grounds sandbox",
            "grounds execution",
            "environment acquire",
            "environment exec",
            "environment prepare",
            "environment-definition",
            "content archive",
        )
        for root in (plugin_root / "skills", plugin_root / "references"):
            for path in sorted(root.rglob("*")):
                if not path.is_file() or path.suffix not in {".md", ".json", ".yaml", ".yml"} or contracts in path.parents:
                    continue
                text = path.read_text(encoding="utf-8")
                with self.subTest(path=str(path.relative_to(plugin_root)), term="retired Grounds auth login"):
                    self.assertEqual(retired_auth_login_commands(text), [])
                for term in removed:
                    with self.subTest(path=str(path.relative_to(plugin_root)), term=term):
                        self.assertNotIn(term, text)

    def test_removed_auth_lint_allows_github_login_but_rejects_grounds_login(self) -> None:
        for text in ("`gh auth login --hostname github.com`", "gh\tauth login"):
            with self.subTest(text=text):
                self.assertEqual(retired_auth_login_commands(text), [])
        for text in ("grounds auth login", "auth login", "invoke -- auth login", "xgh auth login", "gh auth login; grounds auth login"):
            with self.subTest(text=text):
                self.assertTrue(retired_auth_login_commands(text))
        onboarding = SCRIPT.parents[1] / "skills/grounds/references/github-archive-onboarding.md"
        self.assertIn("gh auth login --hostname github.com", onboarding.read_text(encoding="utf-8"))

    def test_auto_repair_loop_binds_stable_interfaces_and_links(self) -> None:
        skill_root = SCRIPT.parents[1] / "skills" / "grounds"
        workflows = skill_root / "references" / "workflows"
        loop = (workflows / "auto-repair.md").read_text(encoding="utf-8")
        develop = (workflows / "develop.md").read_text(encoding="utf-8")
        verify = (workflows / "verify.md").read_text(encoding="utf-8")
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")

        # The loop composes existing CLI interfaces; it must not invent commands.
        self.assertIn("devrun prepare --issue ISSUE_ID --refines-candidate PARENT_ID --brief-file BRIEF", loop)
        self.assertIn("`devrun admit`", loop)
        self.assertIn("不能在准备态开始实质开发", loop)
        self.assertIn("refines_candidate_id", loop)
        self.assertIn("verification list --candidate CANDIDATE_ID", loop)
        self.assertIn("candidate show CANDIDATE_ID", loop)
        self.assertIn("devrun context DEV_RUN_ID --include-verification VERIFICATION_ID", loop)
        self.assertIn("`standing`", loop)
        self.assertIn("verification show VERIFICATION_ID", loop)
        self.assertIn("verify.md#establish-isolation", loop)
        self.assertIn("references/workflows/auto-repair.md", skill)
        self.assertIn("auto-repair.md#confirm-once-at-start", develop)
        self.assertIn("auto-repair.md#run-each-round", develop)
        self.assertIn("auto-repair.md", verify)
        anchors = set(re.findall(r'<a id="([^"]+)"></a>', loop))
        self.assertLessEqual({"confirm-once-at-start", "run-each-round", "stop-conditions"}, anchors)

        # Stop rows must precede the single continue row, so first-match wins safely.
        stop_section = loop.split('<a id="stop-conditions"></a>', 1)[1].split('<a id="summarize-the-loop"></a>', 1)[0]
        rows = [line for line in stop_section.splitlines() if line.startswith("| ") and not line.startswith("| ---")][1:]
        self.assertTrue(rows)
        self.assertIn("refinement", rows[-1])
        self.assertTrue(all("refinement" not in row for row in rows[:-1]))

    def test_deliver_skill_defines_review_conversation_behavior(self) -> None:
        plugin_root = SCRIPT.parents[1]
        skill_root = plugin_root / "skills" / "grounds"
        skill = (plugin_root / "skills/grounds/references/workflows/deliver.md").read_text(encoding="utf-8")
        protocol = (skill_root / "references" / "review-conversation.md").read_text(
            encoding="utf-8"
        )
        rationale_quality = (skill_root / "references" / "rationale-quality.md").read_text(
            encoding="utf-8"
        )

        protocol_link = re.search(r"\]\(([^)]+review-conversation\.md)\)", skill)
        self.assertIsNotNone(protocol_link)
        assert protocol_link is not None
        plugin_protocol = (skill_root / "references/workflows" / protocol_link[1]).resolve()
        self.assertTrue(plugin_protocol.is_file())
        self.assertEqual(plugin_protocol, (skill_root / "references/review-conversation.md").resolve())
        self.assertIn("../review-conversation.md", skill)
        self.assertIn("review CANDIDATE_ID --markdown", skill)
        self.assertIn("verification_set.reports_included: false", protocol)
        self.assertIn("verification list --candidate ID --paged --json", protocol)
        self.assertIn("trace.location", protocol)
        self.assertIn("target_refs[].id", protocol)
        self.assertIn("trace.contract.requirement", protocol)
        self.assertIn("traces_to", protocol)
        self.assertIn("rationales[].alternatives", protocol)
        self.assertIn("7/8", rationale_quality)

    def test_develop_skill_defines_advisory_rationale_quality_behavior(self) -> None:
        plugin_root = SCRIPT.parents[1]
        skill_root = plugin_root / "skills" / "grounds"
        skill = (plugin_root / "skills/grounds/references/workflows/develop.md").read_text(encoding="utf-8")
        reference = (skill_root / "references" / "rationale-quality.md").read_text(encoding="utf-8")

        self.assertIn("rationale-quality.md", skill)
        self.assertIn("change_rationales", skill)
        self.assertIn("target_refs", skill)
        self.assertIn("change_ref", reference)
        self.assertIn("TODO:", reference)
        self.assertIn("7/8", reference)


if __name__ == "__main__":
    unittest.main()
