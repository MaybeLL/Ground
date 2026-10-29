from __future__ import annotations

import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parents[1]
SCRIPT = PLUGIN_ROOT / "scripts" / "grounds_agent.py"
SPEC = importlib.util.spec_from_file_location("grounds_agent_e2e", SCRIPT)
assert SPEC and SPEC.loader
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()


def fill_todos(value: object, replacement: str) -> object:
    if isinstance(value, str):
        return replacement if value.startswith("TODO:") else value
    if isinstance(value, list):
        return [fill_todos(item, replacement) for item in value]
    if isinstance(value, dict):
        return {key: fill_todos(item, replacement) for key, item in value.items()}
    return value


@unittest.skipUnless(
    shutil.which("node") and shutil.which("npm") and shutil.which("git"),
    "Node.js, npm, and Git are required",
)
class GroundsPluginE2E(unittest.TestCase):
    def test_core_sqlite_workflow(self) -> None:
        with tempfile.TemporaryDirectory(prefix="grounds-plugin-e2e-", dir=os.environ.get("GROUNDS_TEST_ROOT")) as directory:
            root = Path(directory).resolve()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            binary = bin_dir / "grounds"
            subprocess.run(["npm", "run", "build"], cwd=REPO_ROOT / "typescript", check=True)
            cli = root / "isolated-cli.mjs"
            compiled = REPO_ROOT / "typescript" / "dist" / "src"
            cli.write_text(
                "import {runCLI} from " + json.dumps((compiled / "cli.js").as_uri()) + ";\n" +
                "import {withRuntimeDirectories} from " + json.dumps((compiled / "runtime-files.js").as_uri()) + ";\n" +
                "process.exitCode = await withRuntimeDirectories(" + json.dumps({"runtimeHome":str(root / "runtime"), "directoryRegistryHome":str(root / "registry")}) + ",()=>runCLI(process.argv.slice(2)));\n"
            )
            binary.write_text(
                f"#!/bin/sh\nexec {shlex.quote(shutil.which('node'))} {shlex.quote(str(cli))} \"$@\"\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)

            clone = root / "repo"
            clone.mkdir()
            git(clone, "init", "-b", "main")
            git(clone, "config", "user.name", "Plugin Test")
            git(clone, "config", "user.email", "plugin@example.test")
            exclude = clone / git(clone, "rev-parse", "--git-path", "info/exclude")
            exclude.write_text("/.grounds/\n", encoding="utf-8")
            (clone / "app.txt").write_text("baseline\n", encoding="utf-8")
            git(clone, "add", "app.txt")
            git(clone, "commit", "-m", "baseline")
            git(clone, "remote", "add", "origin", "ssh://git@example.test/team/plugin-e2e")
            git(clone, "remote", "add", "upstream", "https://example.test/grounds/upstream.git")
            remote = root / "remote.git"
            git(root, "init", "--bare", str(remote))
            git(clone, "push", str(remote), "HEAD:refs/heads/main")
            hook = remote / "hooks/update"
            hook.write_text('#!/bin/sh\ncase "$1" in refs/tags/grounds/candidates/*) case "$2" in *[!0]*) exit 1;; esac;; esac\nexit 0\n')
            hook.chmod(0o700)
            ssh = bin_dir / "ssh"
            ssh.write_text("#!" + shutil.which("python3") + "\n" +
                "import os,subprocess,sys\n" +
                "args=sys.argv[1:]\n" +
                "if '-G' in args: sys.exit(1)\n" +
                "command=args[-1] if args else ''\n" +
                "mode='upload-pack' if command.startswith('git-upload-pack ') else 'receive-pack' if command.startswith('git-receive-pack ') else None\n" +
                "if not mode or 'git@example.test' not in args: sys.exit(255)\n" +
                "sys.exit(subprocess.call([" + repr(shutil.which('git')) + ", mode, os.environ['TEST_ARCHIVE_REMOTE']]))\n")
            ssh.chmod(0o700)
            head = git(clone, "rev-parse", "HEAD")
            git(clone, "update-ref", "refs/remotes/origin/main", head)

            config = root / "config.yaml"
            database = root / "ledger.db"
            home = root / "home"
            home.mkdir()
            old_environment = os.environ.copy()
            os.environ.update(
                {
                    "PATH": f"{bin_dir}{os.pathsep}{old_environment.get('PATH', '')}",
                    "HOME": str(home),
                    "GROUNDS_CONFIG": str(config),
                    "TEST_ARCHIVE_REMOTE": str(remote),
                    "GROUNDS_DATA_HOME": str(root / "data"),
                    "GROUNDS_AGENT_ID": "plugin-e2e-developer",
                    "GROUNDS_AGENT_NAME": "Plugin E2E Developer",
                }
            )
            try:
                init, _ = agent.invoke(
                    ["init", "--driver", "sqlite", "--path", str(database), "--non-interactive"],
                    clone,
                    0,
                )
                self.assertTrue(init["ok"], init)
                ambiguous, _ = agent.invoke(
                    ["workspace", "new", "plugin-e2e"],
                    clone,
                    0,
                )
                self.assertFalse(ambiguous["ok"])
                self.assertEqual(ambiguous["error"]["code"], "REPOSITORY_AMBIGUOUS")
                workspace, _ = agent.invoke(
                    ["workspace", "new", "plugin-e2e", "--remote", "origin"],
                    clone,
                    0,
                )
                self.assertTrue(workspace["ok"])
                # The configured identity is retained while the ledger is unavailable.
                offline = root / "offline.sqlite"
                database.rename(offline)
                try:
                    draft, _ = agent.invoke(["draft", "read", "plugin-e2e"], clone, 0)
                    self.assertTrue(draft["ok"], draft)
                    self.assertFalse(database.exists())
                finally:
                    offline.rename(database)
                published, _ = agent.invoke(
                    ["workspace", "publish", "plugin-e2e", "--expected-version", draft["data"]["version"]],
                    clone,
                    0,
                )
                self.assertTrue(published["ok"])
                issue_id = published["data"]["issues"][0]["id"]

                candidate_ids: list[str] = []
                dev_run_ids: list[str] = []
                worktrees: list[Path] = []
                for index in (1, 2):
                    started, _ = agent.invoke(
                        ["devrun", "start", issue_id, "--development-mode", "simple", "--legacy-fixed", "--exploration-brief", f"alternative {index}"],
                        clone,
                        0,
                    )
                    # Fixed-start evaluation still archives a clean ordinary Git commit.
                    self.assertTrue(started["ok"], started)
                    self.assertEqual(started["data"]["local_worktree"]["status"], "available")
                    worktree = Path(started["data"]["local_worktree"]["path"])
                    self.assertEqual(git(worktree, "rev-parse", "HEAD"), head)
                    context = started["data"]["context"]
                    dev_run_ids.append(context["dev_run"]["id"])
                    worktrees.append(worktree)
                    (worktree / "app.txt").write_text(f"candidate {index}\n", encoding="utf-8")
                    git(worktree, "add", "app.txt")
                    git(worktree, "commit", "-m", f"candidate {index}")
                    deployment = root / "deployment.json"
                    deployment.write_text(json.dumps({"repository":context["repository"]["canonical_remote"],"create_only_archive_namespace":True}))
                    now = datetime.datetime.now(datetime.timezone.utc)
                    policy = root / "archive-policy.json"
                    policy.write_text(json.dumps({
                        "format":"grounds.archive-protection/v1", "repository_id":context["repository"]["id"],
                        "canonical_remote":context["repository"]["canonical_remote"], "ref_namespace":"refs/tags/grounds/candidates/",
                        "source":{"kind":"verified-deployment-config","locator":deployment.as_uri(),"revision":"sha256:"+hashlib.sha256(deployment.read_bytes()).hexdigest(),"verified_by":"isolated-test-operator"},
                        "observed_at":(now-datetime.timedelta(seconds=1)).isoformat().replace("+00:00","Z"),
                        "valid_until":(now+datetime.timedelta(hours=1)).isoformat().replace("+00:00","Z"),
                        "currently_applicable":True,"archive_identity_can_create":True,"ordinary_identity_cannot_update":True,
                        "ordinary_identity_cannot_delete":True,"team_can_read_by_ref":True,"repository_backup":"verified","database_backup":"verified"
                    }))
                    submission_file = root / f"submission-{index}.json"
                    agent.native_draft(
                        "candidate",
                        worktree,
                        submission_file,
                        dev_run=context["dev_run"]["id"],
                    )
                    submission = fill_todos(json.loads(submission_file.read_text()), f"candidate {index} evidence")
                    criterion_id = context["issue"]["goals"][0]["criteria"][0]["id"]
                    for rationale in submission["change_rationales"]:
                        rationale["target_refs"] = [{"type": "criterion", "id": criterion_id}]
                    submission_file.write_text(json.dumps(submission), encoding="utf-8")
                    submitted, _ = agent.invoke(
                        [
                            "candidate",
                            "submit",
                            context["dev_run"]["id"],
                            "--file",
                            str(submission_file),
                            "--archive-policy", str(policy),
                            "--expected-version",
                            str(context["dev_run"]["version"]),
                        ],
                        worktree,
                        0,
                    )
                    self.assertTrue(submitted["ok"], submitted)
                    candidate_ids.append(submitted["data"]["candidate_id"])

                (worktrees[0] / "after-submit.txt").write_text("not captured\n", encoding="utf-8")
                refused, _ = agent.invoke(
                    ["devrun", "cleanup", dev_run_ids[0]], clone, 6
                )
                self.assertEqual(refused["error"]["code"], "WORKTREE_MISMATCH")
                (worktrees[0] / "after-submit.txt").unlink()
                cleaned, _ = agent.invoke(
                    ["devrun", "cleanup", dev_run_ids[0]], clone, 0
                )
                self.assertTrue(cleaned["data"]["removed"])
                self.assertEqual(cleaned["data"]["local_worktree"]["status"], "removed")
                self.assertFalse(worktrees[0].exists())
                repeated, _ = agent.invoke(
                    ["devrun", "cleanup", dev_run_ids[0]], clone, 0
                )
                self.assertFalse(repeated["data"]["removed"])

                blind, _ = agent.invoke(
                    ["verification", "context", candidate_ids[0], "--phase", "blind"], clone, 0
                )
                self.assertTrue(blind["ok"], blind)
                blind_file = root / "blind.json"
                blind_file.write_text(json.dumps(blind["data"]["context"]), encoding="utf-8")
                review = root / "review"
                materialized, _ = agent.invoke(
                    ["candidate", "materialize", candidate_ids[0], "--mode", "review", "--path", str(review)],
                    clone,
                    0,
                )
                self.assertEqual(materialized["data"]["materialization_mode"], "review")
                traced, _ = agent.invoke(
                    ["review", "--at", "app.txt:1"], review, 0
                )
                self.assertEqual(traced["data"]["trace"]["submission"]["format"], "patchledger.candidate-submission/v2")
                self.assertEqual(traced["data"]["trace"]["location"]["rationale_coverage"]["status"], "complete")
                self.assertEqual(traced["data"]["trace"]["explanation_coverage"]["unexplained_change_unit_ids"], [])

                report_file = root / "verification.json"
                offline_environment = {"GROUNDS_BIN": str(binary), "PATH": os.environ["PATH"], "HOME": str(root / "offline-home")}
                with mock.patch.dict(os.environ, offline_environment, clear=True):
                    agent.native_draft("verification", review, report_file, context=blind_file)
                report = json.loads(report_file.read_text())
                self.assertEqual(report["candidate_id"], candidate_ids[0])
                self.assertEqual(report["blind_context_digest"], blind["data"]["context"]["blind_context_digest"])
                for assessment in report["assessments"]:
                    for criterion in assessment["criteria"]:
                        criterion["independent"]["explanation"] = "Fixture does not assess behavior; inconclusive"
                report_file.write_text(json.dumps(report), encoding="utf-8")
                fixed_independent = [
                    json.dumps(criterion["independent"], sort_keys=True)
                    for assessment in report["assessments"] for criterion in assessment["criteria"]
                ]
                reconcile, _ = agent.invoke(
                    ["verification", "context", candidate_ids[0], "--phase", "reconcile"], clone, 0
                )
                self.assertTrue(reconcile["ok"], reconcile)
                for field in ("candidate_id", "result_tree_oid", "blind_context_digest"):
                    self.assertEqual(reconcile["data"]["context"][field], report[field])
                report = fill_todos(report, "Fixture retains inconclusive assessment after reconciliation")
                self.assertEqual(
                    [json.dumps(criterion["independent"], sort_keys=True)
                     for assessment in report["assessments"] for criterion in assessment["criteria"]],
                    fixed_independent,
                )
                report_file.write_text(json.dumps(report), encoding="utf-8")
                with mock.patch.dict(os.environ, offline_environment, clear=True):
                    signed, _ = agent.invoke(
                        ["verification", "handoff", "--file", str(report_file),
                         "--agent-id", "plugin-e2e-verifier", "--agent-name", "Plugin E2E Verifier"],
                        review, 0,
                    )
                self.assertTrue(signed["ok"], signed)
                handoff_file = root / "handoff.json"
                handoff_file.write_text(json.dumps(signed["data"]["handoff"]), encoding="utf-8")
                tampered = json.loads(handoff_file.read_text())
                tampered["report"]["assessments"][0]["criteria"][0]["independent"]["explanation"] = "Changed after signing"
                tampered_file = root / "tampered-handoff.json"
                tampered_file.write_text(json.dumps(tampered), encoding="utf-8")
                with mock.patch.dict(os.environ, {
                    "GROUNDS_AGENT_ID": "plugin-e2e-coordinator",
                    "GROUNDS_AGENT_NAME": "Plugin E2E Coordinator",
                }):
                    rejected, _ = agent.invoke(
                        ["verification", "submit", candidate_ids[0], "--handoff", str(tampered_file)], clone, 0
                    )
                    self.assertFalse(rejected["ok"])
                    self.assertEqual(rejected["error"]["code"], "VALIDATION_ERROR")
                    self.assertEqual(rejected["error"]["details"]["field"], "handoff.report_digest")
                    verification, _ = agent.invoke(
                        ["verification", "submit", candidate_ids[0], "--handoff", str(handoff_file)], clone, 0
                    )
                self.assertTrue(verification["ok"], verification)
                self.assertEqual(verification["data"]["overall_verdict"], "inconclusive")
                if os.environ.get("GROUNDS_PLUGIN_DOCKER") == "1":
                    # This is a persistence/cleanup integration, not a real LLM
                    # verifier: pass the already signed fixed report through Docker.
                    runner = root / "report-runner"
                    (runner / ".grounds/environments").mkdir(parents=True)
                    (runner / ".grounds/environments/report.yaml").write_text(
                        "format: grounds.environment-definition/v1\nname: report\nbackend: docker\n"
                        "repositories: [{name: runner, path: .}]\nrequirements: {network: none}\n"
                        "base: {image: {dockerfile: Dockerfile, context: .}}\ntools: [python3]\n")
                    (runner / "Dockerfile").write_text("FROM node:22-bookworm\n")
                    git(runner, "init", "-q", "-b", "main")
                    git(runner, "add", ".")
                    git(runner, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixed report runner")
                    inputs = root / "report-inputs.json"
                    inputs.write_text(json.dumps([{"name":"handoff.json", "path":str(handoff_file)}]))
                    prepared, _ = agent.invoke(["env", "up", "--workspace", str(runner), "--definition", "report",
                        "--input-commit", "sha1:" + git(runner,"rev-parse","HEAD"), "--branch", "grounds/report/fixture",
                        "--material-scope", "blind", "--fixed-inputs-file", str(inputs)], runner, 0)
                    self.assertTrue(prepared["ok"], prepared)
                    environment_id = prepared["data"]["environment"]["id"]
                    argv = root / "report-argv.json"
                    argv.write_text(json.dumps(["python3","-c","from pathlib import Path; assert Path('/.dockerenv').exists(); Path('/output/handoff.json').write_bytes(Path('/inputs/handoff.json').read_bytes())"]))
                    executed, _ = agent.invoke(["env","run",environment_id,"--argv-file",str(argv),"--artifact","handoff.json"],runner,0)
                    self.assertTrue(executed["ok"],executed)
                    self.assertEqual(executed["data"]["run"]["state"],"succeeded")
                    released, _ = agent.invoke(["env","down",environment_id],runner,0)
                    self.assertTrue(released["ok"],released)
                    environment = released["data"]["environment"]
                    self.assertEqual(environment["state"],"released")
                    self.assertEqual((Path(environment["directory"])/"artifacts/handoff.json").read_bytes(),handoff_file.read_bytes())
                    # The next public show must use the ledger, not original files.
                    report_file.unlink(); handoff_file.unlink(); tampered_file.unlink()
                    print(json.dumps({"docker_report_environment":environment_id,"state":environment["state"],
                        "verification_already_submitted":verification["data"]["verification_id"],"original_report_files_removed":True,
                        "scope":"fixed signed report transport; no real model or verifier continuation"}),flush=True)
                candidate_detail, _ = agent.invoke(
                    ["candidate", "show", candidate_ids[0]], clone, 0
                )
                self.assertFalse(candidate_detail["data"]["candidate"]["verifications_omitted"])
                verification_detail, _ = agent.invoke(
                    ["verification", "show", verification["data"]["verification_id"]], clone, 0
                )
                self.assertEqual(
                    verification_detail["data"]["report"]["candidate_id"], candidate_ids[0]
                )
                self.assertEqual(verification_detail["data"]["report"]["assessments"], report["assessments"])
                self.assertEqual(verification_detail["data"]["attribution"], {
                    "kind": "agent", "agent_id": "plugin-e2e-verifier", "display_name": "Plugin E2E Verifier",
                })

                comparison, _ = agent.invoke(
                    ["candidate", "compare", *candidate_ids], clone, 0
                )
                self.assertTrue(comparison["ok"])
                # A fixed-start Candidate has no target-flow gate. Delivery keeps
                # its archived source commit rather than synthesizing a new one.
                delivery = root / "delivery"
                delivered, _ = agent.invoke(
                    ["candidate", "materialize", candidate_ids[0], "--mode", "delivery", "--path", str(delivery), "--branch", "plugin-e2e-delivery"], clone, 0)
                self.assertTrue(delivered["ok"], delivered)
                self.assertEqual(delivered["data"]["branch"], "plugin-e2e-delivery")
                self.assertEqual(git(delivery, "rev-parse", "HEAD"), git(remote, "rev-parse", "refs/tags/grounds/candidates/" + candidate_ids[0]))
                restored = root / "restored"
                restored_result, _ = agent.invoke(
                    ["candidate", "restore", "--candidate", candidate_ids[0], "--path", str(restored), "--branch", "plugin-e2e-restored"], clone, 0)
                self.assertTrue(restored_result["ok"], restored_result)
                self.assertEqual((restored / "app.txt").read_text(), "candidate 1\n")
                self.assertEqual(git(restored, "branch", "--show-current"), "plugin-e2e-restored")
                self.assertEqual(git(restored, "rev-parse", "HEAD"), git(remote, "rev-parse", "refs/tags/grounds/candidates/" + candidate_ids[0]))
            finally:
                os.environ.clear()
                os.environ.update(old_environment)


if __name__ == "__main__":
    unittest.main()
