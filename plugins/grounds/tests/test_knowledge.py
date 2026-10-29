import argparse
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/grounds_knowledge.py"
spec = importlib.util.spec_from_file_location("grounds_knowledge", SCRIPT)
k = importlib.util.module_from_spec(spec)
spec.loader.exec_module(k)
DIGEST = "sha256:" + "a" * 64


def ref(name):
    return {"id": name, "version": 1}


def rec(kind, name, data):
    return {**ref(name), "kind": kind, "data": data}


def config():
    return {"auth_mode": "codex-login", "model": "test-model", "codex_version": "test-cli",
            "timeout_seconds": 60, "max_tool_calls": 8, "enable_kb": False, "required_skills": []}


def binding(name):
    return {"environment": {**ref(name), "digest": DIGEST},
            "parameters": {"repository_snapshot": DIGEST} if name == "answer" else {},
            "validation": ref(name + "-check"), "execution_config": config()}


def qa(name):
    return rec("qa", name, {"name": name, "question": name + " question", "instructions": "doc only",
        "rubric": "correctness", "reference_answer": "source-backed answer", "required_points": ["point"],
        "forbidden_claims": ["production assertion"], "references": ["fixed-source@sha:file:line"],
        "source": {"record": {"holdout": "SECRET_SOURCE_RECORD"}}, "extra": "SECRET_QA_EXTRA"})


def native_report():
    rows = []
    for name in ("main", "holdout"):
        task = {"id": name + "-task", "kind": "qa", "name": name, "qa": ref(name), "graders": [ref("grader")]}
        submission = {"status": "completed", "outcome": {"kind": "qa_decision", "verdict": "partial"},
                      "explanation": "missing boundary", "evidence": [{"kind": "observation", "content": "omitted"}],
                      "extra": "SECRET_SUBMISSION_EXTRA"}
        attempt = {"run": rec("run", name + "-run", {"experiment_id": "before", "task": task, "mode": "answer", "state": "closed"}),
            "artifact": rec("artifact", name + "-artifact", {"run_id": name + "-run", "qa": ref(name),
                "answer": name + " actual answer", "execution": {"status": "completed", "exit_code": 0, "declared": config()},
                "capture": {"limitations": []}, "trace": "SECRET_TRACE"}),
            "executions": [rec("execution", name + "-execution", {"run_id": name + "-run", "grader": ref("grader"),
                "submission": submission, "grading_evidence": {"execution": {"status": "completed", "declared": config()}, "files": ["SECRET_TRACE_PATH"]}})],
            "result": rec("result", name + "-result", {"run_id": name + "-run", "graders": [{"grader": ref("grader"), "submission": submission}]})}
        rows.append({"task": task, "graders": [rec("grader", "grader", {"private": "SECRET_GRADER_EXTRA"})], "runs": [attempt]})
    return {"format": "patchledger.eval-report/v1", "experiment": rec("experiment", "before", {
                "snapshot_id": "snapshot", "environment": {"answer": binding("answer"), "grade": binding("grade")}}),
            "snapshot": rec("snapshot", "snapshot", {"tasks": [r["task"] for r in rows]}), "tasks": rows,
            "environment": {"attempts": [{"state": "failed", "error": "preparation failed"}]}, "notices": []}


class KnowledgeMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.doc = self.root / "doc"
        self.code = self.root / "code"
        for path in (self.doc, self.code):
            path.mkdir()
            (path / ".git").mkdir()

    def save(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return str(path)

    def input_args(self, **changes):
        return argparse.Namespace(**({"doc_repo": str(self.doc), "code_repo": [str(self.code)],
            "allow_doc": ["topics/rules.md"], "scope": "failure boundaries", "max_questions": 5,
            "max_repairs": 2, "budget_seconds": 1800, "out": str(self.root / "private")} | changes))

    def test_deadline_is_created_once_and_resume_only_reads(self):
        with patch.object(k.time, "time", return_value=100):
            k.inputs(self.input_args())
        path = self.root / "private/inputs.json"
        original = path.read_bytes()
        with patch.object(k.time, "time", return_value=200):
            self.assertEqual(k.budget(argparse.Namespace(inputs=path, minimum_seconds=1))["remaining_seconds"], 1700)
            with self.assertRaises(FileExistsError):
                k.inputs(self.input_args())
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_exhausted_or_insufficient_budget_fails(self):
        path = self.save("inputs.json", {"deadline_epoch": 10})
        for now, minimum in [(11, 1), (9, 2)]:
            with self.subTest(now=now), patch.object(k.time, "time", return_value=now), self.assertRaises(ValueError):
                k.budget(argparse.Namespace(inputs=path, minimum_seconds=minimum))

    def test_invalid_paths_budgets_and_scope_fail_without_output(self):
        for change in [{"out": str(self.doc / "private")}, {"code_repo": [str(self.doc)]},
                       {"allow_doc": ["../escape"]}, {"allow_doc": ["/absolute"]},
                       {"allow_doc": [".git/config"]}, {"allow_doc": ["."]},
                       {"budget_seconds": 0}, {"max_questions": -1}, {"scope": " "}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                k.inputs(self.input_args(**change))
        self.assertFalse((self.root / "private").exists())

    def test_symlink_document_escape_is_rejected(self):
        (self.doc / "escape").symlink_to(self.code, target_is_directory=True)
        with self.assertRaises(ValueError):
            k.inputs(self.input_args(allow_doc=["escape/rules.md"]))

    def subject_args(self):
        check = rec("envcheck", "checked", {"format": "grounds.environment-validation/v1",
            "environment": binding("answer")["environment"], "parameters": {"repository_snapshot": DIGEST},
            "adapter": {"name": "synthetic", "version": "1", "platform": "test"}, "files": [],
            "checks": {name: True for name in ("success", "failure", "protocol", "isolation")}})
        return argparse.Namespace(check=self.save("check.json", {"ok": True, "data": {"payload": check}}),
            parameters=self.save("params.json", {"repository_snapshot": DIGEST}),
            answer_config=self.save("config.json", config() | {"codex_home": "/host-only", "codex_command": "/host/codex"}),
            grade_binding=self.save("grade.json", binding("grade")), name="before", out=str(self.root / "subject.json"))

    def test_subject_uses_native_binding_and_strips_host_fields(self):
        args = self.subject_args()
        value = k.subject(args)
        self.assertEqual(value["environment"]["answer"]["validation"], ref("checked"))
        self.assertEqual(value["environment"]["answer"]["execution_config"], config())
        self.assertEqual(value["environment"]["grade"], binding("grade"))
        with self.assertRaises(FileExistsError):
            k.subject(args)

    def test_empty_partial_failed_checks_and_false_receipt_rejected(self):
        for checks in ({}, {"success": True}, {"success": True, "failure": True, "protocol": True, "isolation": False}):
            with self.subTest(checks=checks):
                args = self.subject_args()
                value = k.read(args.check)
                value["data"]["payload"]["data"]["checks"] = checks
                self.save("check.json", value)
                with self.assertRaises(ValueError):
                    k.subject(args)
        args = self.subject_args()
        self.save("check.json", {"ok": False, "error": "failure"})
        with self.assertRaises(ValueError):
            k.subject(args)

    def test_mismatched_parameters_and_missing_binding_rejected(self):
        args = self.subject_args()
        self.save("params.json", {"repository_snapshot": "sha256:" + "b" * 64})
        with self.assertRaises(ValueError):
            k.subject(args)
        args = self.subject_args()
        grade = binding("grade")
        del grade["validation"]
        self.save("grade.json", grade)
        with self.assertRaises(ValueError):
            k.subject(args)

    def test_incomplete_or_malformed_native_validation_metadata_rejected(self):
        evidence = {"name": "probe.json", "digest": DIGEST, "size": 1}
        for change in ({"adapter": None}, {"files": None}, {"adapter": {}},
                       {"adapter": {"name": " ", "version": "1", "platform": "test"}},
                       {"files": {}}, {"files": [evidence, evidence]},
                       {"files": [evidence | {"name": "../escape"}]},
                       {"files": [evidence | {"digest": "invalid"}]},
                       {"files": [evidence | {"size": True}]},
                       {"files": [evidence | {"size": 32 * 1024 * 1024 + 1}]}):
            with self.subTest(change=change):
                args = self.subject_args()
                value = k.read(args.check)
                data = value["data"]["payload"]["data"]
                for key, entry in change.items():
                    if entry is None:
                        del data[key]
                    else:
                        data[key] = entry
                self.save("check.json", value)
                with self.assertRaises(ValueError):
                    k.subject(args)
                self.assertFalse(Path(args.out).exists())

    def test_api_endpoint_rejects_credentials_and_non_plain_https_for_both_roles(self):
        for role in ("answer", "grade"):
            for url in ("https://user:synthetic-password@example.invalid/v1",
                        "https://user@example.invalid/v1", "https://@example.invalid/v1",
                        "http://example.invalid/v1", "https:///v1",
                        "https://example.invalid/v1?token=synthetic", "https://example.invalid/v1#secret"):
                with self.subTest(role=role, url=url):
                    args = self.subject_args()
                    value = config() | {"auth_mode": "api-key", "model_base_url": url}
                    if role == "answer":
                        self.save("config.json", value | {"api_key_env": "SYNTHETIC_API_KEY"})
                    else:
                        self.save("grade.json", binding("grade") | {"execution_config": value})
                    with self.assertRaises(ValueError):
                        k.subject(args)
                    self.assertFalse(Path(args.out).exists())

    def test_plain_https_endpoint_preserved_without_host_credential_reference(self):
        args = self.subject_args()
        value = config() | {"auth_mode": "api-key", "model_base_url": "https://example.invalid/v1"}
        self.save("config.json", value | {"api_key_env": "SYNTHETIC_API_KEY"})
        self.save("grade.json", binding("grade") | {"execution_config": value})
        output = k.subject(args)
        for role in ("answer", "grade"):
            self.assertEqual(output["environment"][role]["execution_config"], value)

    def test_subject_host_api_input_still_requires_credential_variable(self):
        args = self.subject_args()
        self.save("config.json", config() | {"auth_mode": "api-key", "model_base_url": "https://example.invalid/v1"})
        with self.assertRaises(ValueError):
            k.subject(args)
        self.assertFalse(Path(args.out).exists())

    def test_kb_skills_and_unknown_config_rejected_in_both_roles(self):
        for role in ("answer", "grade"):
            for change in ({"enable_kb": True}, {"required_skills": ["secret"]}, {"graphkb_command": "anything"},
                           {"kb": "anything"}, {"api_key": "secret"}, {"model": ""}, {"timeout_seconds": 0}):
                with self.subTest(role=role, change=change):
                    args = self.subject_args()
                    if role == "answer":
                        self.save("config.json", config() | change)
                    else:
                        grade = binding("grade")
                        grade["execution_config"].update(change)
                        self.save("grade.json", grade)
                    with self.assertRaises(ValueError):
                        k.subject(args)

    def handoff_args(self):
        worksheet = {"doc_repo": str(self.doc), "code_repos": [str(self.code)], "allowed_doc_paths": ["rules.md"]}
        return argparse.Namespace(inputs=self.save("inputs.json", worksheet),
            report=self.save("before.json", native_report()), qa=[self.save("main.json", qa("main")), self.save("holdout.json", qa("holdout"))],
            main_qa=["main@1"], out=str(self.root / "repair"))

    def test_handoff_exports_main_only_without_trace_parent_paths_or_extra_fields(self):
        args = self.handoff_args()
        k.handoff(args)
        output = self.root / "repair/handoff.json"
        text = output.read_text()
        value = json.loads(text)
        self.assertEqual([q["qa"] for q in value["questions"]], [ref("main")])
        self.assertIn("main actual answer", text)
        self.assertIn("partial", text)
        self.assertIn("fixed-source@sha:file:line", text)
        for forbidden in ("holdout", "SECRET_", args.report, "before.json", "source.record"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(list(output.parent.iterdir()), [output])
        with self.assertRaises(FileExistsError):
            k.handoff(args)

    def test_selection_unknown_duplicate_and_wrong_version_rejected(self):
        for selected in (["unknown@1"], ["main@2"], ["main@1", "main@1"]):
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                args = self.handoff_args()
                args.main_qa = selected
                k.handoff(args)
        self.assertFalse((self.root / "repair").exists())

    def test_duplicate_qa_and_report_mismatch_rejected(self):
        args = self.handoff_args()
        args.qa.append(args.qa[0])
        with self.assertRaises(ValueError):
            k.handoff(args)
        args = self.handoff_args()
        report = native_report()
        report["tasks"][0]["task"]["qa"] = ref("different")
        self.save("before.json", report)
        with self.assertRaises(ValueError):
            k.handoff(args)

    def compare_args(self):
        before = native_report()
        after = copy.deepcopy(before)
        after["experiment"]["id"] = "after"
        after["experiment"]["data"]["environment"]["answer"]["parameters"]["repository_snapshot"] = "sha256:" + "b" * 64
        after["experiment"]["data"]["environment"]["answer"]["validation"] = ref("new-doc-check")
        for row in after["tasks"]:
            for attempt in row["runs"]:
                attempt["run"]["data"]["experiment_id"] = "after"
        return argparse.Namespace(before=self.save("before.json", before), after=self.save("after.json", after), out=str(self.root / "comparison.json"))

    def test_comparison_retains_all_attempts_errors_and_not_executed(self):
        args = self.compare_args()
        before = k.read(args.before)
        row = before["tasks"][0]
        incomplete = {"run": rec("run", "open-run", {"experiment_id": "before", "task": row["task"], "state": "open", "mode": "answer"}), "executions": []}
        failed = copy.deepcopy(row["runs"][0])
        failed["artifact"]["data"]["execution"].update(status="error", exit_code=1)
        failed["artifact"]["data"]["capture"]["limitations"] = ["model error"]
        failed["result"]["data"]["graders"][0]["submission"] = {"status": "error", "explanation": "grading failed"}
        row["runs"] = [failed, *row["runs"], incomplete]
        before["tasks"][1]["runs"] = []
        self.save("before.json", before)
        k.comparison(args)
        result = k.read(args.out)
        self.assertEqual(result["comparison"], "incomparable")
        self.assertTrue(any("open-run" in reason for reason in result["reasons"]))
        rows = result["phases"][0]["tasks"]
        self.assertEqual(len(rows[0]["attempts"]), 3)
        self.assertEqual([r["measurement_incomplete"] for r in rows[0]["attempts"]], [True, False, True])
        self.assertTrue(rows[1]["not_executed"])
        self.assertIn("preparation failed", Path(args.out).read_text())
        self.assertIn("grading failed", Path(args.out).read_text())

    def test_changed_environment_model_limits_grader_snapshot_are_incomparable(self):
        for field in ("model", "timeout_seconds", "environment", "grade", "snapshot"):
            with self.subTest(field=field):
                args = self.compare_args()
                after = k.read(args.after)
                environment = after["experiment"]["data"]["environment"]
                if field in ("model", "timeout_seconds"):
                    environment["answer"]["execution_config"][field] = "other" if field == "model" else 100
                elif field == "environment":
                    environment["answer"]["environment"]["digest"] = "sha256:" + "c" * 64
                elif field == "grade":
                    environment["grade"]["validation"] = ref("different-grading")
                else:
                    after["snapshot"]["id"] = "different-snapshot"
                    after["experiment"]["data"]["snapshot_id"] = "different-snapshot"
                self.save("after.json", after)
                k.comparison(args)
                self.assertEqual(k.read(args.out)["comparison"], "incomparable")
                Path(args.out).unlink()

    def test_complete_matching_conditions_preserve_complete_measurements(self):
        args = self.compare_args()
        k.comparison(args)
        result = k.read(args.out)
        self.assertEqual(result["comparison"], "recorded_conditions_match")
        self.assertEqual(result["reasons"], [])
        self.assertTrue(all(not attempt["measurement_incomplete"]
                            for phase in result["phases"] for row in phase["tasks"]
                            for attempt in row["attempts"]))

    def test_native_sanitized_api_captures_match_without_host_credential_variable(self):
        args = self.compare_args()
        for path in (args.before, args.after):
            report = k.read(path)
            for role in ("answer", "grade"):
                report["experiment"]["data"]["environment"][role]["execution_config"].update(
                    auth_mode="api-key", model_base_url="https://example.invalid/v1")
            for row in report["tasks"]:
                for attempt in row["runs"]:
                    for captured in [attempt["artifact"]["data"]["execution"],
                                     *[ex["data"]["grading_evidence"]["execution"] for ex in attempt["executions"]]]:
                        # Native capture deliberately removes api_key_env from declared.
                        captured["declared"].update(auth_mode="api-key", model_base_url="https://example.invalid/v1")
            self.save(Path(path).name, report)
        k.comparison(args)
        result = k.read(args.out)
        self.assertEqual(result["comparison"], "recorded_conditions_match")
        self.assertTrue(all(not attempt["measurement_incomplete"]
                            for phase in result["phases"] for row in phase["tasks"]
                            for attempt in row["attempts"]))

    def test_missing_conditions_are_not_treated_as_comparable(self):
        args = self.compare_args()
        after = k.read(args.after)
        del after["experiment"]["data"]["environment"]
        self.save("after.json", after)
        k.comparison(args)
        self.assertEqual(k.read(args.out)["comparison"], "incomparable")

    def test_actual_capture_drift_is_not_hidden_by_equal_bindings(self):
        for role in ("answer", "grade"):
            with self.subTest(role=role):
                args = self.compare_args()
                after = k.read(args.after)
                attempt = after["tasks"][0]["runs"][0]
                captured = (attempt["artifact"]["data"]["execution"] if role == "answer"
                    else attempt["executions"][0]["data"]["grading_evidence"]["execution"])
                captured["declared"]["model"] = "other-model"
                self.save("after.json", after)
                k.comparison(args)
                self.assertEqual(k.read(args.out)["comparison"], "incomparable")
                Path(args.out).unlink()

    def test_missing_grading_capture_or_execution_is_incomparable_and_incomplete(self):
        for mode in ("missing_evidence", "empty_evidence", "missing_execution", "no_executions", "missing_declared"):
            with self.subTest(mode=mode):
                args = self.compare_args()
                after = k.read(args.after)
                attempt = after["tasks"][0]["runs"][0]
                if mode == "no_executions":
                    attempt["executions"] = []
                elif mode == "missing_evidence":
                    del attempt["executions"][0]["data"]["grading_evidence"]
                elif mode == "empty_evidence":
                    attempt["executions"][0]["data"]["grading_evidence"] = {}
                elif mode == "missing_declared":
                    del attempt["executions"][0]["data"]["grading_evidence"]["execution"]["declared"]
                else:
                    del attempt["executions"][0]["data"]["grading_evidence"]["execution"]
                attempt["result"]["data"]["reason"] = "Stopped: missing measured grading"
                self.save("after.json", after)
                k.comparison(args)
                result = k.read(args.out)
                self.assertEqual(result["comparison"], "incomparable")
                self.assertTrue(result["reasons"])
                projected = result["phases"][1]["tasks"][0]["attempts"][0]
                self.assertTrue(projected["measurement_incomplete"])
                self.assertEqual(projected["reason"], attempt["result"]["data"]["reason"])
                self.assertEqual(projected["graders"][0]["submission"]["outcome"]["verdict"], "partial")
                Path(args.out).unlink()

    def test_one_grader_capture_cannot_cover_another_required_grader(self):
        args = self.compare_args()
        after = k.read(args.after)
        row = after["tasks"][0]
        row["runs"][0]["executions"][0]["data"]["grader"] = ref("unrelated-grader")
        self.save("after.json", after)
        k.comparison(args)
        result = k.read(args.out)
        self.assertEqual(result["comparison"], "incomparable")
        self.assertTrue(result["phases"][1]["tasks"][0]["attempts"][0]["measurement_incomplete"])

    def test_failed_grading_capture_is_not_a_complete_measurement(self):
        row = native_report()["tasks"][0]
        row["runs"][0]["executions"][0]["data"]["grading_evidence"]["execution"]["status"] = "error"
        self.assertTrue(k.attempts(row)[0]["measurement_incomplete"])

    def test_regrade_is_not_a_fresh_success(self):
        report = native_report()
        row = report["tasks"][0]
        row["runs"][0]["run"]["data"]["mode"] = "qa_regrade"
        self.assertTrue(k.attempts(row)[0]["measurement_incomplete"])

    def regrade_report(self):
        report = native_report()
        report["snapshot"]["id"] = "regraded-snapshot"
        report["experiment"]["id"] = "regraded-experiment"
        report["experiment"]["data"]["snapshot_id"] = "regraded-snapshot"
        for task in report["tasks"]:
            for attempt in task["runs"]:
                attempt["run"]["data"]["experiment_id"] = "regraded-experiment"
        row = report["tasks"][0]
        row["task"]["qa"] = {"id": "main", "version": 2}
        run = row["runs"][0]["run"]
        run["data"].update(mode="qa_regrade", artifact_id="main-artifact")
        run["id"] = "regrade-run"
        row["runs"][0]["executions"][0]["data"]["run_id"] = run["id"]
        row["runs"][0]["result"]["data"]["run_id"] = run["id"]
        return report

    def test_native_regrade_retains_original_qa_version_in_compare_and_handoff(self):
        native = self.regrade_report()
        args = self.compare_args()
        self.save("after.json", native)
        k.comparison(args)
        result = k.read(args.out)
        self.assertEqual(result["comparison"], "incomparable")  # QA v2 changes frozen conditions.
        projected = result["phases"][1]["tasks"][0]["attempts"][0]
        self.assertEqual(projected["answer_input_qa"], ref("main"))
        self.assertEqual(projected["mode"], "qa_regrade")
        self.assertTrue(projected["measurement_incomplete"])
        args = self.handoff_args()
        self.save("before.json", native)
        revised = qa("main")
        revised["version"] = 2
        self.save("main.json", revised)
        args.main_qa = ["main@2"]
        k.handoff(args)
        question = k.read(Path(args.out) / "handoff.json")["questions"][0]
        self.assertEqual(question["qa"], {"id": "main", "version": 2})
        attempt = question["baseline"][0]["attempts"][0]
        self.assertEqual(attempt["answer_input_qa"], ref("main"))
        self.assertEqual(attempt["answer"], "main actual answer")
        self.assertEqual(attempt["graders"][0]["submission"]["outcome"]["verdict"], "partial")

    def test_regrade_never_accepts_other_qa_and_fresh_answer_requires_exact_version(self):
        for mode, answer_qa in (("qa_regrade", ref("other")), ("answer", ref("main"))):
            with self.subTest(mode=mode):
                row = self.regrade_report()["tasks"][0]
                attempt = row["runs"][0]
                attempt["run"]["data"]["mode"] = mode
                attempt["artifact"]["data"].update(qa=answer_qa, run_id=attempt["run"]["id"])
                with self.assertRaises(ValueError):
                    k.attempts(row)

    def test_numeric_score_inconclusive_and_missing_grading_are_preserved(self):
        for outcome in ({"kind": "score", "value": 0.25}, {"kind": "inconclusive", "reason": "missing runtime evidence"}):
            row = native_report()["tasks"][0]
            row["runs"][0]["result"]["data"]["graders"][0]["submission"]["outcome"] = outcome
            self.assertEqual(k.attempts(row)[0]["graders"][0]["submission"]["outcome"], outcome)
        row = native_report()["tasks"][0]
        row["runs"][0]["result"]["data"]["graders"][0] = {"grader": ref("grader"), "missing_reason": "no completed grading execution"}
        actual = k.attempts(row)[0]
        self.assertTrue(actual["measurement_incomplete"])
        self.assertEqual(actual["graders"][0]["missing_reason"], "no completed grading execution")

    def test_optional_reference_answer_and_extra_citation_fields(self):
        args = self.handoff_args()
        value = qa("main")
        del value["data"]["reference_answer"]
        self.save("main.json", value)
        native = native_report()
        native["tasks"][0]["runs"][0]["artifact"]["data"]["citations"] = [{"content": "boundary", "locator": "material-v1:doc/rules.md#L1", "extra": "SECRET_CITATION"}]
        self.save("before.json", native)
        k.handoff(args)
        text = (self.root / "repair/handoff.json").read_text()
        self.assertIn("material-v1:doc/rules.md#L1", text)
        self.assertNotIn("SECRET_CITATION", text)

    def test_structured_extra_data_cannot_hide_inside_allowed_text(self):
        args = self.handoff_args()
        value = qa("main")
        value["data"]["references"] = [{"secret": "holdout"}]
        self.save("main.json", value)
        with self.assertRaises(ValueError):
            k.handoff(args)
        self.assertFalse((self.root / "repair").exists())

    def test_duplicate_json_keys_fail_closed(self):
        path = self.root / "bad.json"
        path.write_text('{"ok": false, "ok": true}')
        with self.assertRaises(ValueError):
            k.read(path)


if __name__ == "__main__":
    unittest.main()
