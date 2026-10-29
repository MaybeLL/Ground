#!/usr/bin/env python3
"""Local worksheets for the knowledge Skill. Never runs models, Git or Grounds."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import time
from urllib.parse import urlsplit


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, f"Duplicate JSON key: {key}")
            obj[key] = value
        return obj
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)


def unwrap(value):
    if "ok" in value:
        require(value["ok"] is True, "Native command failed; inspect its receipt")
        value = value["data"]
        value = value.get("payload", value)
    return value


def ref(value, digest=False):
    require(isinstance(value, dict), "Missing native reference")
    require(isinstance(value.get("id"), str) and value["id"].strip(), "Missing native ID")
    require(type(value.get("version")) is int and value["version"] > 0, "Missing native version")
    result = {"id": value["id"], "version": value["version"]}
    if digest:
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", value.get("digest", "")), "Missing environment digest")
        result["digest"] = value["digest"]
    return result


def record(value, kind):
    value = unwrap(value)
    ref(value)
    require(value.get("kind") == kind and isinstance(value.get("data"), dict), f"Expected native {kind} record")
    return value


def write_new(path, value):
    # Exclusive creation also refuses symlinks and keeps private material private.
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(text)


def source(path):
    path = Path(path).resolve(strict=True)
    return {"path": str(path), "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


def outside(path, roots):
    path = Path(path).resolve()
    require(all(not path.is_relative_to(root) for root in roots), "Private output must be outside every material repository")
    return path


def inputs(args):
    roots = [Path(p).resolve(strict=True) for p in [args.doc_repo, *args.code_repo]]
    require(all(p.is_dir() and (p / ".git").exists() for p in roots), "Use existing Git repository roots")
    require(all(not a.is_relative_to(b) and not b.is_relative_to(a)
                for i, a in enumerate(roots) for b in roots[i + 1:]), "Repository paths must be distinct and non-nested")
    require(args.scope.strip(), "Scope must not be empty")
    require(all(type(n) is int and n > 0 for n in [args.max_questions, args.max_repairs, args.budget_seconds]), "Budgets must be positive integers")
    allowed = []
    for item in args.allow_doc:
        path = PurePosixPath(item)
        require(item and not path.is_absolute() and ".." not in path.parts and ".git" not in path.parts
                and "\\" not in item and str(path) != ".", "Use explicit relative document paths")
        require((roots[0] / item).resolve().is_relative_to(roots[0]), "Document path escapes its repository")
        require(item not in allowed, "Duplicate allowed document path")
        allowed.append(item)
    output = outside(args.out, roots)
    started = int(time.time())
    value = {"doc_repo": str(roots[0]), "code_repos": [str(p) for p in roots[1:]],
             "scope": args.scope, "allowed_doc_paths": allowed,
             "max_questions": args.max_questions, "max_repairs": args.max_repairs,
             "started_epoch": started, "deadline_epoch": started + args.budget_seconds}
    output.mkdir(mode=0o700)  # Deliberately no exist_ok: resume reads, never initializes.
    write_new(output / "inputs.json", value)
    return value


def budget(args):
    value = read(args.inputs)
    require(type(value.get("deadline_epoch")) is int, "Missing original deadline")
    remaining = max(0, value["deadline_epoch"] - int(time.time()))
    require(args.minimum_seconds >= 0, "Minimum budget must not be negative")
    require(remaining >= args.minimum_seconds and remaining > 0, "Original total budget exhausted or insufficient")
    return {"deadline_epoch": value["deadline_epoch"], "remaining_seconds": remaining}


def config(value, host=False, captured=False):
    allowed = {"auth_mode", "model", "model_base_url", "codex_version", "timeout_seconds",
               "max_tool_calls", "enable_kb", "required_skills"}
    host_fields = {"codex_command", "codex_home", "api_key_env"}
    require(isinstance(value, dict) and set(value) <= allowed | (host_fields if host else set()), "Unknown or GraphKB execution configuration")
    require(value.get("enable_kb") is False and value.get("required_skills") == [], "Disable KB and tested Skills explicitly")
    require(value.get("auth_mode") in ("codex-login", "api-key"), "Missing authentication mode")
    for key in ("model", "codex_version"):
        require(isinstance(value.get(key), str) and value[key].strip(), f"Missing {key}")
    for key in ("timeout_seconds", "max_tool_calls"):
        require(type(value.get(key)) is int and value[key] > 0, f"Missing positive {key}")
    if value["auth_mode"] == "api-key":
        require(isinstance(value.get("model_base_url"), str) and value["model_base_url"].strip(), "API-key configuration needs model_base_url")
        provider = urlsplit(value["model_base_url"])
        require(provider.scheme == "https" and provider.hostname
                and provider.username is None and provider.password is None
                and not provider.query and not provider.fragment,
                "model_base_url must be a plain HTTPS endpoint without credentials")
        if host and not captured:
            require(isinstance(value.get("api_key_env"), str) and value["api_key_env"].strip(), "Use a credential environment variable name")
    else:
        require(not ({"model_base_url", "api_key_env"} & set(value)), "Codex-login configuration cannot carry API-key fields")
    return {k: v for k, v in value.items() if k not in host_fields}


def binding(value):
    require(set(value) == {"environment", "parameters", "validation", "execution_config"}, "Incomplete or unknown environment binding")
    require(isinstance(value["parameters"], dict), "Invalid environment parameters")
    return {"environment": ref(value["environment"], True), "parameters": value["parameters"],
            "validation": ref(value["validation"]), "execution_config": config(value["execution_config"])}


def subject(args):
    checked = record(read(args.check), "envcheck")
    data = checked["data"]
    require(set(data) == {"format", "environment", "adapter", "parameters", "checks", "files"},
            "Incomplete or unknown native validation fields")
    require(data.get("format") == "grounds.environment-validation/v1", "Unsupported validation format")
    adapter = data["adapter"]
    require(isinstance(adapter, dict) and set(adapter) == {"name", "version", "platform"}
            and all(isinstance(v, str) and v.strip() for v in adapter.values()), "Invalid validation adapter")
    files = data["files"]
    require(isinstance(files, list) and len(files) <= 100, "Invalid validation evidence files")
    names, total = set(), 0
    for item in files:
        require(isinstance(item, dict) and set(item) == {"name", "digest", "size"}, "Invalid validation evidence file")
        require(isinstance(item["name"], str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", item["name"])
                and item["name"] not in names, "Invalid or duplicate validation evidence filename")
        require(isinstance(item["digest"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", item["digest"]), "Invalid validation evidence digest")
        require(type(item["size"]) is int and 0 <= item["size"] <= 32 * 1024 * 1024, "Invalid validation evidence size")
        names.add(item["name"])
        total += item["size"]
    require(total <= 128 * 1024 * 1024, "Validation evidence bundle exceeds 128 MiB")
    checks = data.get("checks", {})
    require(isinstance(checks, dict) and set(checks) == {"success", "failure", "protocol", "isolation"}
            and all(v is True for v in checks.values()), "Required environment checks did not all pass")
    parameters = read(args.parameters)
    require(parameters == data.get("parameters"), "Validation parameters differ")
    require(set(parameters) == {"repository_snapshot"} and re.fullmatch(r"sha256:[0-9a-f]{64}", parameters["repository_snapshot"]), "Expected repository snapshot parameters")
    answer = {"environment": ref(data["environment"], True), "parameters": parameters,
              "validation": ref(checked), "execution_config": config(read(args.answer_config), host=True)}
    value = {"name": args.name, "description": "Doc-only QA against a frozen documentation snapshot",
             "environment": {"answer": answer, "grade": binding(read(args.grade_binding))}}
    require(args.name.strip(), "Subject name must not be empty")
    write_new(args.out, value)
    return value


def report(path):
    value = unwrap(read(path))
    require(value.get("format") == "patchledger.eval-report/v1", "Expected native eval experiment report")
    experiment = record(value["experiment"], "experiment")
    snapshot = record(value["snapshot"], "snapshot")
    require(experiment["data"]["snapshot_id"] == snapshot["id"], "Experiment snapshot mismatch")
    require(isinstance(value.get("tasks"), list), "Missing report tasks")
    require([row["task"] for row in value["tasks"]] == snapshot["data"]["tasks"], "Report tasks differ from frozen snapshot")
    seen = set()
    for row in value["tasks"]:
        task = row["task"]
        require(task["kind"] == "qa", "Only native QA reports are supported")
        ref(task["qa"])
        require(task["id"] not in seen, "Duplicate report task")
        seen.add(task["id"])
        require(isinstance(row.get("runs"), list), "Missing run list")
        require(task["graders"] and [ref(g) for g in row["graders"]] == task["graders"], "Grader bindings differ")
        for attempt in row["runs"]:
            run = record(attempt["run"], "run")
            require(run["data"]["task"] == task and run["data"]["experiment_id"] == experiment["id"], "Run binding mismatch")
    return value


def fields(value, names):
    return {k: value[k] for k in names if k in value}


def strings(value, name):
    require(isinstance(value, list) and all(isinstance(v, str) for v in value), f"Invalid {name}")
    return value


def submission(value):
    if value is None:
        return None
    result = fields(value, ("status", "explanation", "execution_id", "context_digest"))
    require(all(isinstance(v, str) for v in result.values()), "Invalid submission text")
    if "outcome" in value:
        outcome = fields(value["outcome"], ("kind", "verdict", "value", "reason"))
        require(all(isinstance(v, str) or (key == "value" and type(v) in (int, float))
                    for key, v in outcome.items()), "Invalid QA outcome")
        result["outcome"] = outcome
    result["evidence"] = []
    for item in value.get("evidence", []):
        clean = fields(item, ("kind", "content", "path", "locator"))
        require(all(isinstance(v, str) for v in clean.values()), "Invalid evidence text")
        result["evidence"].append(clean)
    return result


def execution(value):
    result = fields(value, ("status", "exit_code", "started_at", "finished_at", "session_id"))
    require(all(v is None or isinstance(v, (str, int)) for v in result.values()), "Invalid execution metadata")
    return result


def captures(item, graders):
    """Include missing evidence, so a submitted grade cannot stand in for a capture."""
    result = [("answer", item.get("artifact", {}).get("data", {}).get("execution", {}))]
    executions = item.get("executions", [])
    for ex in executions:
        result.append(("grade", ex["data"].get("grading_evidence", {}).get("execution", {})))
    for grader in graders:
        if not any(ex["data"]["grader"] == grader for ex in executions):
            result.append(("grade", {}))
    return result


def capture_complete(captured):
    try:
        config(captured.get("declared"), host=True, captured=True)
    except (TypeError, ValueError):
        return False
    return captured.get("status") == "completed"


def attempts(row):
    """Project every attempt, including open/failed/regrade attempts; never pick a winner."""
    result = []
    for item in row["runs"]:
        run = item["run"]
        data = run["data"]
        details = fields(data, ("mode", "state", "rerun_of"))
        require(all(isinstance(v, str) for v in details.values()), "Invalid run metadata")
        output = {"run": ref(run), **details,
                  "answer": None, "result": None, "graders": [], "executions": []}
        if item.get("artifact"):
            artifact = record(item["artifact"], "artifact")
            body = artifact["data"]
            require(body["run_id"] == run["id"] or data.get("mode") == "qa_regrade", "Artifact run mismatch")
            answer_qa = ref(body["qa"])
            task_qa = row["task"]["qa"]
            require(answer_qa == task_qa or
                    (data.get("mode") == "qa_regrade" and answer_qa["id"] == task_qa["id"]),
                    "Artifact QA mismatch")
            require(isinstance(body.get("answer"), str), "Missing actual answer")
            output.update(artifact=ref(artifact), answer_input_qa=answer_qa, answer=body["answer"],
                          answer_execution=execution(body.get("execution", {})),
                          limitations=strings(body.get("capture", {}).get("limitations", []), "capture limitations"))
            output["citations"] = []
            for citation in body.get("citations", []):
                clean = fields(citation, ("content", "locator"))
                require(all(isinstance(v, str) for v in clean.values()), "Invalid citation text")
                output["citations"].append(clean)
        for ex in item.get("executions", []):
            ex = record(ex, "execution")
            ed = ex["data"]
            require(ed["run_id"] == run["id"], "Grading execution run mismatch")
            output["executions"].append({"execution": ref(ex), "grader": ref(ed["grader"]),
                "capture": execution(ed.get("grading_evidence", {}).get("execution", {})),
                "limitations": strings(ed.get("grading_evidence", {}).get("capture", {}).get("limitations", []), "grading limitations"),
                "submission": submission(ed.get("submission"))})
        if item.get("result"):
            res = record(item["result"], "result")
            require(res["data"]["run_id"] == run["id"], "Result run mismatch")
            output["result"] = ref(res)
            if "reason" in res["data"]:
                require(isinstance(res["data"]["reason"], str), "Invalid result reason")
                output["reason"] = res["data"]["reason"]
            for grade in res["data"]["graders"]:
                details = fields(grade, ("status", "reason", "execution_id", "missing_reason"))
                require(all(isinstance(v, str) for v in details.values()), "Invalid grading metadata")
                output["graders"].append({"grader": ref(grade["grader"]),
                    "submission": submission(grade.get("submission")), **details})
        output["measurement_incomplete"] = (data.get("state") != "closed" or output["answer"] is None
            or output["result"] is None or data.get("mode") != "answer"
            or output.get("answer_execution", {}).get("status") != "completed"
            or any(not capture_complete(captured) for _, captured in captures(item, row["task"]["graders"]))
            or "reason" in output
            or len(output["graders"]) != len(row["task"]["graders"])
            or any(g.get("submission", {}).get("status") != "completed" if g.get("submission") else True
                   for g in output["graders"]))
        result.append(output)
    return result


def handoff(args):
    worksheet = read(args.inputs)
    roots = [Path(p).resolve(strict=True) for p in [worksheet["doc_repo"], *worksheet["code_repos"]]]
    output = outside(args.out, roots)
    baseline = report(args.report)
    selected = []
    for token in args.main_qa:
        identity, version = token.rsplit("@", 1)
        key = (identity, int(version))
        require(key not in selected, "Duplicate main QA selection")
        selected.append(key)
    qas = {}
    for path in args.qa:
        qa = record(read(path), "qa")
        key = (qa["id"], qa["version"])
        require(key not in qas, "Duplicate QA export")
        qas[key] = qa
    questions = []
    for key in selected:
        require(key in qas, "Selected QA ID/version missing from exports")
        rows = [row for row in baseline["tasks"] if row["task"]["qa"] == {"id": key[0], "version": key[1]}]
        require(rows, "Selected QA ID/version missing from baseline")
        qa = qas[key]
        clean = {"qa": ref(qa)}
        for field in ("name", "question", "instructions", "rubric"):
            require(isinstance(qa["data"].get(field), str), f"Missing QA {field}")
            clean[field] = qa["data"][field]
        if "reference_answer" in qa["data"]:
            require(isinstance(qa["data"]["reference_answer"], str), "Invalid reference answer")
            clean["reference_answer"] = qa["data"]["reference_answer"]
        for field in ("required_points", "forbidden_claims", "references"):
            clean[field] = strings(qa["data"].get(field, []), field)
        clean["baseline"] = [{"task_id": row["task"]["id"], "graders": row["task"]["graders"],
                              "attempts": attempts(row)} for row in rows]
        questions.append(clean)
    value = {"doc_repo": str(roots[0]), "code_repos": [str(p) for p in roots[1:]],
             "allowed_doc_paths": worksheet["allowed_doc_paths"], "questions": questions,
             "baseline_experiment": ref(baseline["experiment"]),
             "source_verification": "Coordinator must supply and recheck source versions; this export does not verify Git or sandbox permissions."}
    # No input/report paths: granting this directory must not expose their parents.
    output.mkdir(mode=0o700)
    write_new(output / "handoff.json", value)
    return {"out": str(output), "main_questions": len(questions)}


def comparison(args):
    before, after = report(args.before), report(args.after)
    reasons = []
    if ref(before["snapshot"]) != ref(after["snapshot"]) or before["snapshot"]["data"] != after["snapshot"]["data"]:
        reasons.append("Suite Snapshot / QA / Grader bindings differ")
    try:
        bindings = [r["experiment"]["data"]["environment"] for r in (before, after)]
        for phase in bindings:
            binding(phase["answer"])
            binding(phase["grade"])
        a, b = (phase["answer"] for phase in bindings)
        for field in ("environment", "execution_config"):
            if a[field] != b[field]:
                reasons.append(f"Answer {field} differs")
        if bindings[0]["grade"] != bindings[1]["grade"]:
            reasons.append("Grading binding differs")
        if set(a["parameters"]) != {"repository_snapshot"} or set(b["parameters"]) != {"repository_snapshot"}:
            reasons.append("Expected only repository_snapshot answer parameter")
        for label, native, phase in zip(("before", "after"), (before, after), bindings):
            for row in native["tasks"]:
                for attempt in row["runs"]:
                    for role, captured in captures(attempt, row["task"]["graders"]):
                        try:
                            declared = config(captured.get("declared"), host=True, captured=True)
                        except (TypeError, ValueError):
                            declared = None
                        expected = phase[role]["execution_config"]
                        observed = captured.get("observed", {})
                        if (declared != expected or
                                ("requested_model" in observed and observed["requested_model"] != expected["model"])):
                            reasons.append(f"{label} run {attempt['run']['id']} {role} captured configuration missing or differs")
    except (KeyError, TypeError, ValueError) as error:
        reasons.append(f"Missing/invalid environment or execution configuration: {error}")
    phases = []
    for label, path, native in [("before", args.before, before), ("after", args.after, after)]:
        phases.append({"phase": label, "source": source(path), "experiment": ref(native["experiment"]),
            "tasks": [{"task": row["task"], "attempts": attempts(row), "not_executed": not row["runs"]} for row in native["tasks"]],
            # Environment failures may occur before any run exists. Preserve native facts.
            "environment": native.get("environment"), "notices": native.get("notices", [])})
    value = {"comparison": "incomparable" if reasons else "recorded_conditions_match",
             "reasons": reasons,
             "limitations": ["Derived view of native exports; refresh exports to include later attempts.",
                 "Matching recorded conditions alone does not verify doc-only isolation, source stability or improvement.",
                 "All attempts retained. Missing/error/regrade results do not prove a fresh answer passed; no best-attempt selection."],
             "phases": phases}
    write_new(args.out, value)
    return {"out": str(Path(args.out).resolve()), "comparison": value["comparison"], "reasons": reasons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inputs", help="Create a new private worksheet with one absolute deadline")
    p.add_argument("--doc-repo", required=True)
    p.add_argument("--code-repo", action="append", required=True)
    p.add_argument("--allow-doc", action="append", required=True)
    p.add_argument("--scope", required=True)
    p.add_argument("--max-questions", type=int, default=5)
    p.add_argument("--max-repairs", type=int, default=2)
    p.add_argument("--budget-seconds", type=int, default=1800)
    p.add_argument("--out", required=True)
    p.set_defaults(action=inputs)
    p = sub.add_parser("budget", help="Read remaining time without resetting the deadline")
    p.add_argument("--inputs", required=True)
    p.add_argument("--minimum-seconds", type=int, default=1)
    p.set_defaults(action=budget)
    p = sub.add_parser("subject", help="Project a native subject from successful environment validation")
    for name in ("check", "parameters", "answer-config", "grade-binding", "name", "out"):
        p.add_argument("--" + name, required=True)
    p.set_defaults(action=subject)
    p = sub.add_parser("handoff", help="Export only explicitly selected main QA versions to a new private directory")
    for name in ("inputs", "report", "out"):
        p.add_argument("--" + name, required=True)
    for name in ("qa", "main-qa"):
        p.add_argument("--" + name, action="append", required=True)
    p.set_defaults(action=handoff)
    p = sub.add_parser("compare", help="Derive an all-attempt view; never run or grade anything")
    for name in ("before", "after", "out"):
        p.add_argument("--" + name, required=True)
    p.set_defaults(action=comparison)
    args = parser.parse_args()
    try:
        print(json.dumps(args.action(args), ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError, OSError) as error:
        parser.exit(2, f"grounds knowledge materials: {error}\n")


if __name__ == "__main__":
    main()
