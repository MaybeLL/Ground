from __future__ import annotations

import importlib.util
import os
import json
import subprocess
import tempfile
import select
import signal
import sys
from pathlib import Path
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "grounds_agent.py"
SPEC = importlib.util.spec_from_file_location("grounds_workspace_agent", SCRIPT)
assert SPEC and SPEC.loader
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)

# Public actions which accept both attribution and an idempotency key.
WRITES = (
    "config-save", "create", "restore", "route-prepare", "route-bind",
    "environment-save", "environment-check", "environment-set-default",
    "recipe-save", "recipe-prepare", "recipe-preparation-cancel", "recipe-preparation-cleanup",
    "build-material-capture", "image-prepare", "image-cancel", "image-cleanup",
    "execution-start", "end", "cleanup", "service-cleanup",
    "service-volume-export", "service-volume-restore", "service-volume-retire",
    "service-volume-restoration-stop", "service-volume-restoration-cleanup",
    "service-volume-delete",
)


class CodeWorkspaceHelperTests(unittest.TestCase):
    def test_nonzero_control_results_retain_envelope_and_operation_id(self) -> None:
        cases = (
            ("environment-check", "environment-control", {"check": {"state": "failed"}}),
            ("recipe-prepare", "development-image", {"preparation": {"state": "needs-recovery"}}),
            ("image-prepare", "repository-image", {"preparation": {"state": "failed"}}),
        )
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "grounds"
            binary.write_text("#!" + sys.executable + "\nimport json,sys\n"
                              "args=sys.argv[1:]\n"
                              "data=json.loads(__import__('os').environ['FIXTURE_DATA'])\n"
                              "print(json.dumps({'format':'patchledger.cli/v1','ok':True,"
                              "'operation_id':args[args.index('--operation-id')+1],"
                              "'data':data,'warnings':[]}))\nsys.exit(1)\n")
            binary.chmod(0o700)
            for action, kind, detail in cases:
                for explicit in (False, True):
                    with self.subTest(action=action, explicit=explicit):
                        data = {"result_type": f"grounds.result.{kind}/v1",
                                "command": f"code-workspace.{action}", **detail}
                        op = "018f0000-0000-7000-8000-000000000001"
                        command = [sys.executable, str(SCRIPT), "invoke", "--cwd", directory, "--",
                                   "code-workspace", action, "route"]
                        if explicit:
                            command += ["--operation-id", op]
                        env = dict(os.environ, GROUNDS_BIN=str(binary), GROUNDS_AGENT_ID="dev",
                                   GROUNDS_AGENT_NAME="Dev", FIXTURE_DATA=json.dumps(data))
                        result = subprocess.run(command, env=env, text=True, capture_output=True, check=False)
                        self.assertEqual(result.returncode, 1, result.stderr)
                        envelope = json.loads(result.stdout)
                        self.assertEqual(envelope["data"], data)
                        self.assertRegex(envelope["operation_id"], r"^[0-9a-f-]{36}$")
                        if explicit:
                            self.assertEqual(envelope["operation_id"], op)

    def test_unrelated_success_envelope_with_nonzero_exit_is_rejected(self) -> None:
        payload = {"format": "patchledger.cli/v1", "ok": True, "data": {}}
        with self.assertRaisesRegex(agent.AdapterError, "success envelope with a nonzero"):
            agent.parse_envelope(json.dumps(payload), 1)

    def test_control_result_rejects_inconsistent_exit_or_wrong_command(self) -> None:
        data = {"result_type": "grounds.result.environment-control/v1",
                "command": "code-workspace.environment-check", "check": {"state": "passed"}}
        payload = {"format": "patchledger.cli/v1", "ok": True, "data": data}
        with self.assertRaises(agent.AdapterError):
            agent.parse_envelope(json.dumps(payload), 1, ("code-workspace", "environment-check"))
        data["check"]["state"] = "failed"
        for code, command in ((2, ("code-workspace", "environment-check")),
                              (1, ("code-workspace", "image-prepare"))):
            with self.subTest(code=code, command=command), self.assertRaises(agent.AdapterError):
                agent.parse_envelope(json.dumps(payload), code, command)

    def test_foreground_execution_preserves_nonzero_exit_and_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "grounds"
            for outcome, code in (({"reason": "cancelled"}, 130),
                                  ({"reason": "exited", "exit_code": 17}, 1)):
                with self.subTest(outcome=outcome):
                    output = json.dumps({"format": "patchledger.cli/v1", "ok": True,
                                         "data": {"outcome": outcome}})
                    binary.write_text("#!" + sys.executable + "\nimport sys\nprint(" + repr(output) + ")\nsys.exit(" + str(code) + ")\n")
                    binary.chmod(0o700)
                    result = subprocess.run([sys.executable, str(SCRIPT), "invoke", "--cwd", directory, "--",
                                             "code-workspace", "execution-serve", "route", "execution"],
                                            env=dict(os.environ, GROUNDS_BIN=str(binary)), text=True, capture_output=True)
                    self.assertEqual(result.returncode, code)
                    self.assertEqual(json.loads(result.stdout), json.loads(output))

    def test_verification_run_start_is_not_automatically_recreated_after_unknown_reply(self) -> None:
        failure = {"format": "patchledger.cli/v1", "ok": False,
                   "error": {"code": "STORAGE_TRANSIENT", "retryable": True}}
        with mock.patch.dict(os.environ, {"GROUNDS_AGENT_ID": "coordinator", "GROUNDS_AGENT_NAME": "Coordinator"}, clear=True), \
                mock.patch.object(agent, "grounds_binary", return_value="grounds"), \
                mock.patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, json.dumps(failure), "")) as run, \
                mock.patch.object(agent.time, "sleep"):
            result, code = agent.invoke(["verification", "run", "start", "candidate"], Path("/tmp"), 2)
            self.assertEqual(result, failure)
            self.assertEqual(code, 1)
            self.assertEqual(run.call_count, 1)

    def test_verification_run_start_uses_agent_identity_without_unsupported_operation_id(self) -> None:
        with mock.patch.dict(os.environ, {"GROUNDS_AGENT_ID": "coordinator", "GROUNDS_AGENT_NAME": "Coordinator"}, clear=True):
            prepared, operation, attributed = agent.prepare_command(["verification", "run", "start", "candidate"])
            self.assertTrue(attributed)
            self.assertIsNone(operation)
            self.assertNotIn("--operation-id", prepared)
            self.assertEqual(prepared[prepared.index("--agent-id") + 1], "coordinator")
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/missing"}, clear=True):
            command = ["verification", "run", "start", "candidate", "--help"]
            self.assertEqual(agent.prepare_command(command), ([*command, "--json"], None, False))
            for action in ("show", "stage", "freeze", "handoff", "submit"):
                prepared, operation, attributed = agent.prepare_command(["verification", "run", action, "run"])
                self.assertFalse(attributed)
                self.assertIsNone(operation)
                self.assertNotIn("--agent-id", prepared)

    def test_foreground_controller_exposes_startup_before_it_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "grounds"
            binary.write_text("#!" + sys.executable + "\nimport sys,time\nprint('execution_id: fixture', file=sys.stderr, flush=True)\ntime.sleep(60)\n")
            binary.chmod(0o700)
            process = subprocess.Popen([sys.executable, str(SCRIPT), "invoke", "--cwd", directory, "--",
                                        "code-workspace", "execution-serve", "route", "execution"],
                                       env=dict(os.environ, GROUNDS_BIN=str(binary)), stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                ready, _, _ = select.select([process.stderr], [], [], 3)
                self.assertTrue(ready, "controller startup was buffered until shutdown")
                self.assertEqual(process.stderr.readline().strip(), "execution_id: fixture")
                self.assertIsNone(process.poll())
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=10)

    def test_changed_volume_checks_refuse_automatic_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checks = root / "checks.json"
            checks.write_text('{"tables": []}')
            failure = {"format": "patchledger.cli/v1", "ok": False,
                       "error": {"code": "STORAGE_TRANSIENT", "retryable": True}}
            def reply(*args, **kwargs):
                checks.write_text('{"tables": ["changed"]}')
                return subprocess.CompletedProcess([], 1, json.dumps(failure), "")
            with mock.patch.dict(os.environ, {"GROUNDS_AGENT_ID": "dev", "GROUNDS_AGENT_NAME": "Dev"}, clear=True), \
                    mock.patch.object(agent, "grounds_binary", return_value="grounds"), \
                    mock.patch.object(agent.subprocess, "run", side_effect=reply) as run, \
                    mock.patch.object(agent.time, "sleep"):
                with self.assertRaisesRegex(agent.AdapterError, "input changed"):
                    agent.invoke(["code-workspace", "service-volume-restore", "--checks-file=checks.json"], root, 1)
                self.assertEqual(run.call_count, 1)

    def test_writes_receive_identity_and_preserve_the_operation_on_replay(self) -> None:
        env = {"GROUNDS_AGENT_ID": "workspace-dev", "GROUNDS_AGENT_NAME": "Developer",
               "GROUNDS_CONFIG": "/tmp/selected-ledger.json"}
        with mock.patch.dict(os.environ, env, clear=True):
            for action in WRITES:
                with self.subTest(action=action):
                    prepared, operation, attributed = agent.prepare_command(["code-workspace", action])
                    self.assertTrue(attributed)
                    self.assertRegex(operation or "", r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
                    self.assertEqual(prepared[prepared.index("--config") + 1], env["GROUNDS_CONFIG"])
                    self.assertEqual(prepared[prepared.index("--agent-id") + 1], env["GROUNDS_AGENT_ID"])
                    self.assertEqual(agent.prepare_command(prepared), (prepared, operation, True))
                    explicit = ["code-workspace", action, "--operation-id=" + operation]
                    self.assertEqual(agent.prepare_command(explicit)[1], operation)

    def test_writes_require_identity_but_valid_help_does_not(self) -> None:
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/unavailable"}, clear=True):
            for action in WRITES:
                with self.subTest(action=action):
                    command = ["code-workspace", action]
                    with self.assertRaises(agent.AdapterError):
                        agent.prepare_command(command)
                    self.assertEqual(agent.prepare_command([*command, "--help"]),
                                     ([*command, "--help", "--json"], None, False))
                    with self.assertRaises(agent.AdapterError):
                        agent.prepare_command([*command, "--help=false"])

    def test_reads_and_local_recovery_keep_ledger_config_without_unsupported_flags(self) -> None:
        actions = ("show", "config-show", "route-show", "environment-show", "environment-default",
                   "environment-check-show", "build-material-show", "image-show", "cleanup-preview",
                   "service-cleanup-preview", "service-volume-preview", "service-volume-assess",
                   "service-volume-restoration-show", "prepare", "execution-show", "execution-stop", "execution-serve")
        with mock.patch.dict(os.environ, {"GROUNDS_CONFIG": "/tmp/ledger"}, clear=True):
            for action in actions:
                with self.subTest(action=action):
                    self.assertEqual(agent.prepare_command(["code-workspace", action]),
                                     (["code-workspace", action, "--json", "--config", "/tmp/ledger"], None, False))


if __name__ == "__main__":
    unittest.main()
