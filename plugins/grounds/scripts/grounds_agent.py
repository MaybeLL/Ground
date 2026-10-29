#!/usr/bin/env python3
"""Safe, dependency-free Grounds CLI adapter for Codex skills."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence


ENVELOPE_FORMAT = "patchledger.cli/v1"
BUSINESS_WRITES = {
    ("repository", "archive-bind"),
    ("preflight", "observe"),
    ("preflight", "assess"),
    ("devrun", "prepare"),
    ("devrun", "admit"),
    ("integration", "observe"),
    ("integration", "authorize"),
    ("integration", "consume"),
    ("integration", "landing"),
    ("delivery-link", "record"),
    ("delivery-link", "withdraw"),
    ("completion", "record"),
    ("completion", "reopen"),
    ("selection", "set"),
    ("selection", "clear"),
    ("repository", "register"),
    ("repository", "move"),
    ("repository", "alias-add"),
    ("repository", "alias-retire"),
    ("devrun", "start"),
    ("devrun", "continue"),
    ("devrun", "sync"),
    ("devrun", "sync-complete"),
    ("devrun", "sync-abandon"),
    ("devrun", "abandon"),
    ("devrun", "cleanup"),
    ("candidate", "submit"),
    ("candidate", "archive"),
    ("verification", "submit"),
}
BUSINESS_WRITES |= {
    ("code-workspace", action) for action in (
        "config-save", "create", "restore", "route-prepare", "route-bind",
        "environment-save", "environment-check", "environment-set-default",
        "recipe-save", "recipe-prepare", "recipe-preparation-cancel", "recipe-preparation-cleanup",
        "build-material-capture", "image-prepare", "image-cancel", "image-cleanup",
        "execution-start", "end", "cleanup", "service-cleanup",
        "service-volume-export", "service-volume-restore", "service-volume-retire",
        "service-volume-restoration-stop", "service-volume-restoration-cleanup",
        "service-volume-delete",
    )
}
ATTRIBUTED_WRITES = BUSINESS_WRITES | {("workspace", "publish"), ("verification", "handoff")}
LOCAL_OPERATION_WRITES = {("devrun", "plan")}
# Local runtime families never open the ledger: no identity, no --config, no operation ID.
LOCAL_FAMILIES = frozenset({"env"})


class AdapterError(RuntimeError):
    pass


def new_uuid7() -> str:
    """Return a lowercase RFC 9562 UUIDv7 without third-party packages."""
    timestamp_ms = int(time.time() * 1000)
    if timestamp_ms >= 1 << 48:
        raise AdapterError("current timestamp cannot be represented as UUIDv7")
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = timestamp_ms << 80
    value |= 0x7 << 76
    value |= random_a << 64
    value |= 0b10 << 62
    value |= random_b
    raw = f"{value:032x}"
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


def has_option(argv: Sequence[str], name: str) -> bool:
    prefix = name + "="
    return any(arg == name or arg.startswith(prefix) for arg in argv)


def command_key(argv: Sequence[str]) -> tuple[str, str]:
    positionals = [arg for arg in argv if not arg.startswith("-")]
    if not positionals:
        return ("", "")
    return ("workspace" if positionals[0] == "draft" else positionals[0], positionals[1] if len(positionals) > 1 else "")


def normalize_candidate_compare_options(argv: Sequence[str]) -> list[str]:
    """Put compare options before Candidate IDs for parsers that stop at positionals."""
    if len(argv) < 2 or argv[0:2] != ["candidate", "compare"]:
        return list(argv)

    options: list[str] = []
    positionals: list[str] = []
    index = 2
    value_options = {"--include-patch", "--pairwise"}
    while index < len(argv):
        item = argv[index]
        if item in value_options:
            options.append(item)
            if index + 1 < len(argv):
                options.append(argv[index + 1])
                index += 1
        elif any(item.startswith(option + "=") for option in value_options):
            options.append(item)
        else:
            positionals.append(item)
        index += 1
    return ["candidate", "compare", *options, *positionals]


def is_readonly_help(argv: Sequence[str]) -> bool:
    """Recognize only read-only help shapes; leave command validation to CLI.

    Like CLI parseArgs, help/json are booleans with inline values, not
    space-separated values. Repeated, disabled and malformed help is not help;
    it then takes the normal path, which adds no identity or config to env.
    """
    positionals: list[str] = []
    options: dict[str, str] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        index += 1
        if not token.startswith("--"):
            positionals.append(token)
            continue
        name, equal, value = token[2:].partition("=")
        if name not in ("help", "json", "config", "cwd") or name in options:
            return False
        if name in ("help", "json"):
            value = value if equal else "true"
            if value not in ("true", "false"):
                return False
        elif not equal:
            if index == len(argv) or argv[index].startswith("-"):
                return False
            value = argv[index]
            index += 1
        if not value:
            return False
        options[name] = value
    topic = positionals[:1] == ["help"]
    if topic:
        positionals = positionals[1:]
    maximum = 4 if positionals[:1] in (["verification"], ["code-workspace"], ["eval"]) else 3
    return (len(positionals) <= maximum
            and (options.get("help") == "true" or topic and "help" not in options))


def prepare_command(argv: Sequence[str]) -> tuple[list[str], str | None, bool]:
    if not argv:
        raise AdapterError("a Grounds command is required after --")
    prepared = normalize_candidate_compare_options(argv)
    if is_readonly_help(prepared):
        if not has_option(prepared, "--json"):
            prepared.append("--json")
        return prepared, None, False
    command_path: tuple[str, str] = command_key(prepared)
    eval_write = tuple(prepared[:3]) in {
        ("eval", "environment", "publish"), ("eval", "envcheck", "submit"),
        ("eval", "preparation", "submit"), ("eval", "instance", "submit"),
        ("eval", "qa", "publish"), ("eval", "artifact", "submit"),
        ("eval", "grader", "publish"), ("eval", "grader", "discourage"), ("eval", "grader", "context"),
        ("eval", "grader", "execute"), ("eval", "grader", "submit"), ("eval", "grader", "evidence-submit"),
        ("eval", "suite", "create"), ("eval", "experiment", "create"),
        ("eval", "run", "start"), ("eval", "run", "finish"), ("eval", "run", "stop"),
    } or tuple(prepared[:4]) in {
        ("eval", "suite", "task", "add"), ("eval", "suite", "task", "update"),
        ("eval", "suite", "task", "remove"),
    }
    business_write = command_path in BUSINESS_WRITES or eval_write
    attributed_write = command_path in ATTRIBUTED_WRITES or eval_write or tuple(prepared[:3]) == ("verification", "run", "start")
    if command_path == ("candidate", "archive") and has_option(prepared, "--dry-run"):
        business_write = attributed_write = False
    # Ordinary materialization keeps its historical local preparation path.
    # The explicit unverified exception adds an audited, fixed ledger fact.
    if command_path == ("selection", "materialize") and any(
        item in ("--allow-unverified", "--allow-unverified=true") for item in prepared
    ):
        business_write = attributed_write = True
    offline = command_path[0] in LOCAL_FAMILIES or command_path in {("verification", "handoff"), ("verification", "independent-digest")} or (
        command_path == ("verification", "template") and has_option(prepared, "--context")
    )
    embedded_attribution = command_path == ("verification", "submit") and has_option(
        prepared, "--handoff"
    )
    operation_id: str | None = None
    injected: list[str] = []

    if not has_option(prepared, "--json"):
        injected.append("--json")
    config_path = os.environ.get("GROUNDS_CONFIG", "")
    if config_path and not offline and not has_option(prepared, "--config"):
        injected.extend(["--config", config_path])

    if attributed_write:
        if not embedded_attribution:
            agent_id = os.environ.get("GROUNDS_AGENT_ID", "")
            agent_name = os.environ.get("GROUNDS_AGENT_NAME", "")
            if (not has_option(prepared, "--agent-id") and not agent_id) or (not has_option(prepared, "--agent-name") and not agent_name):
                raise AdapterError(
                    "GROUNDS_AGENT_ID and GROUNDS_AGENT_NAME are required for business writes"
                )
            if not has_option(prepared, "--agent-id"):
                injected.extend(["--agent-id", agent_id])
            if not has_option(prepared, "--agent-name"):
                injected.extend(["--agent-name", agent_name])
    if business_write or command_path in LOCAL_OPERATION_WRITES:
        if not has_option(prepared, "--operation-id"):
            operation_id = new_uuid7()
            injected.extend(["--operation-id", operation_id])
        else:
            for index, item in enumerate(prepared):
                if item == "--operation-id" and index + 1 < len(prepared):
                    operation_id = prepared[index + 1]
                elif item.startswith("--operation-id="):
                    operation_id = item.split("=", 1)[1]
    # Keep compare options before Candidate IDs so every supported CLI parser
    # receives a deterministic command shape. Other handlers either have no
    # positional arguments or remove their leading ID before parsing flags.
    if command_path == ("candidate", "compare"):
        prepared[2:2] = injected
    else:
        prepared.extend(injected)
    return prepared, operation_id, attributed_write


def grounds_binary() -> str:
    """Resolve the supported CLI from an explicit override or PATH."""
    configured = os.environ.get("GROUNDS_BIN", "")
    if configured:
        binary = shutil.which(configured)
        if binary:
            return binary
        path = Path(configured).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path.resolve())
        raise AdapterError(f"GROUNDS_BIN is not an executable: {configured}")
    binary = shutil.which("grounds")
    if binary:
        return binary
    npm = shutil.which("npm")
    if npm:
        try:
            completed = subprocess.run(
                [npm, "prefix", "-g"], text=True, capture_output=True, check=False
            )
        except OSError:
            completed = None
        if completed and completed.returncode == 0:
            prefix = Path(completed.stdout.strip())
            executable = "grounds.cmd" if os.name == "nt" else "grounds"
            linked = prefix / "bin" / executable
            if linked.is_file() and os.access(linked, os.X_OK):
                return str(linked)
    raise AdapterError(
        "grounds is not available; run npm link in typescript or set GROUNDS_BIN"
    )


def is_control_failure_result(payload: dict[str, Any], returncode: int, command: tuple[str, str]) -> bool:
    """Recognize CLI control replies whose recorded outcome has failed."""
    if returncode != 1 or command[0] != "code-workspace":
        return False
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("command") != f"code-workspace.{command[1]}":
        return False
    kinds = {
        "environment-check": ("environment-control", "check", "passed"),
        "recipe-prepare": ("development-image", "preparation", "ready"),
        "image-prepare": ("repository-image", "preparation", "ready"),
    }
    spec = kinds.get(command[1])
    if spec is None or data.get("result_type") != f"grounds.result.{spec[0]}/v1":
        return False
    result = data.get(spec[1])
    if not isinstance(result, dict) or not isinstance(result.get("state"), str):
        return False
    if command[1] == "recipe-prepare" and result["state"] == "ready":
        return not result.get("environment_revision_id")
    return result["state"] != spec[2]


def parse_envelope(stdout: str, returncode: int, command: tuple[str, str] = ("", "")) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AdapterError(f"grounds did not emit one JSON document: {exc}") from exc
    if not isinstance(payload, dict):
        raise AdapterError("grounds JSON output must be an object")
    if payload.get("format") != ENVELOPE_FORMAT:
        raise AdapterError(
            f"unsupported Grounds envelope: {payload.get('format')!r}; expected {ENVELOPE_FORMAT!r}"
        )
    if not isinstance(payload.get("ok"), bool):
        raise AdapterError("Grounds envelope is missing boolean ok")
    if payload["ok"] and returncode != 0 and not is_control_failure_result(payload, returncode, command):
        raise AdapterError("Grounds returned a success envelope with a nonzero exit code")
    if not payload["ok"] and returncode == 0:
        raise AdapterError("Grounds returned an error envelope with exit code zero")
    if payload["ok"] and "data" not in payload:
        raise AdapterError("Grounds success envelope is missing data")
    if not payload["ok"]:
        error = payload.get("error")
        if not isinstance(error, dict) or not isinstance(error.get("code"), str):
            raise AdapterError("Grounds error envelope is missing error.code")
    return payload


def worktree_fingerprint(cwd: Path) -> str:
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=cwd, check=True, capture_output=True
        ).stdout
        with tempfile.TemporaryDirectory(prefix="grounds-fingerprint-") as directory:
            index = Path(directory) / "index"
            environment = os.environ.copy()
            environment["GIT_INDEX_FILE"] = str(index)
            subprocess.run(
                ["git", "read-tree", "HEAD"],
                cwd=cwd,
                env=environment,
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "add", "-A"],
                cwd=cwd,
                env=environment,
                check=True,
                capture_output=True,
            )
            tree = subprocess.run(
                ["git", "write-tree"],
                cwd=cwd,
                env=environment,
                check=True,
                capture_output=True,
            ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AdapterError(f"cannot fingerprint Candidate worktree: {exc}") from exc
    return hashlib.sha256(head + b"\0" + tree).hexdigest()


def input_fingerprint(argv: Sequence[str], cwd: Path) -> str:
    """Fingerprint argv and every explicit file input used by a write."""
    digest = hashlib.sha256()
    digest.update(json.dumps(list(argv), ensure_ascii=False).encode("utf-8"))
    index = 0
    while index < len(argv):
        item = argv[index]
        path_value: str | None = None
        if item in ("--file", "--handoff", "--adoption-file", "--checks-file") and index + 1 < len(argv):
            path_value = argv[index + 1]
            index += 1
        elif any(item.startswith(option + "=") for option in ("--file", "--handoff", "--adoption-file", "--checks-file")):
            path_value = item.split("=", 1)[1]
        if path_value is not None:
            if path_value == "-":
                raise AdapterError("automatic retry is not supported when --file reads stdin")
            path = Path(path_value)
            if not path.is_absolute():
                path = cwd / path
            try:
                content = path.read_bytes()
            except OSError as exc:
                raise AdapterError(f"cannot fingerprint input file {path}: {exc}") from exc
            digest.update(b"\0file\0")
            digest.update(str(path.resolve()).encode("utf-8"))
            digest.update(b"\0")
            digest.update(content)
        index += 1
    return digest.hexdigest()


def invoke(argv: Sequence[str], cwd: Path, retries: int) -> tuple[dict[str, Any], int]:
    binary = grounds_binary()
    prepared, _, business_write = prepare_command(argv)
    is_candidate_submit = business_write and command_key(prepared) == ("candidate", "submit")
    fingerprint = worktree_fingerprint(cwd) if is_candidate_submit else ""
    request_fingerprint = input_fingerprint(prepared, cwd) if business_write else ""

    for attempt in range(retries + 1):
        completed = subprocess.run(
            [binary, *prepared], cwd=cwd, text=True, capture_output=True, check=False
        )
        envelope = parse_envelope(completed.stdout, completed.returncode, command_key(prepared))
        if completed.stderr:
            sys.stderr.write(completed.stderr)
        if envelope["ok"]:
            return envelope, completed.returncode
        error = envelope["error"]
        transient = error.get("code") == "STORAGE_TRANSIENT" and error.get("retryable") is True
        # Run creation has no caller-supplied idempotency key. A transient reply
        # may follow a saved session; the coordinator must inspect it first.
        if not transient or attempt == retries or tuple(prepared[:3]) == ("verification", "run", "start"):
            return envelope, completed.returncode
        if business_write and input_fingerprint(prepared, cwd) != request_fingerprint:
            raise AdapterError("Grounds write input changed after a transient failure; refusing retry")
        if is_candidate_submit and worktree_fingerprint(cwd) != fingerprint:
            raise AdapterError("Candidate worktree changed after a transient failure; refusing retry")
        time.sleep(2**attempt)
    raise AssertionError("retry loop exhausted")


def draft_path(kind: str, output: Path | None) -> Path:
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        return output
    directory = Path(tempfile.mkdtemp(prefix="grounds-"))
    directory.chmod(0o700)
    return directory / f"{kind}.json"


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def native_draft(
    kind: str,
    cwd: Path,
    output: Path | None,
    dev_run: str | None = None,
    context: Path | None = None,
    content_language: str | None = None,
) -> Path:
    """Create an editable draft from the native CLI's authoritative skeleton."""
    if kind == "candidate":
        if not dev_run or context is not None:
            raise AdapterError("candidate draft requires --dev-run and does not accept --context")
        command = ["candidate", "template", dev_run]
        field = "submission"
        expected_format = "patchledger.candidate-submission/v2"
        default_name = "candidate-submission"
    elif kind == "verification":
        if context is None or dev_run is not None:
            raise AdapterError("verification draft requires --context and does not accept --dev-run")
        command = ["verification", "template", "--context", str(context.resolve())]
        field = "report"
        # A quality context (ultra mode's code-quality reviewer) yields a quality review draft;
        # the native CLI recognises it by format, so the helper only has to expect the matching report.
        try:
            context_format = json.loads(context.read_text(encoding="utf-8")).get("format")
        except (OSError, ValueError, AttributeError):
            context_format = None
        if context_format == "patchledger.quality-context/v1":
            expected_format = "patchledger.quality-review-report/v1"
            default_name = "quality-review-report"
        else:
            expected_format = "patchledger.verification-report/v1"
            default_name = "verification-report"
    else:
        raise AdapterError(f"unsupported draft kind: {kind}")

    if content_language:
        command.extend(["--content-language", content_language])

    envelope, _ = invoke(command, cwd.resolve(), 0)
    if not envelope["ok"]:
        error = envelope.get("error", {})
        raise AdapterError(
            f"cannot create {kind} draft: {error.get('code', 'UNKNOWN')}: "
            f"{error.get('message', 'Grounds rejected the template request')}"
        )
    value = envelope.get("data", {}).get(field)
    if not isinstance(value, dict) or value.get("format") != expected_format:
        raise AdapterError(f"native {kind} template did not contain {expected_format}")
    path = draft_path(default_name, output)
    write_json(path, value)
    return path


def preflight(write: bool) -> dict[str, Any]:
    binary = grounds_binary()
    if write:
        for name in ("GROUNDS_AGENT_ID", "GROUNDS_AGENT_NAME"):
            if not os.environ.get(name):
                raise AdapterError(f"{name} is required for business writes")
    result: dict[str, Any] = {"binary": binary, "ready": True}
    helper_root = Path(__file__).resolve().parents[1]
    managed_skills_root = (
        helper_root.parent
        if (helper_root / ".grounds-managed.json").is_file()
        else Path.home() / ".agents" / "skills"
    )
    doctor = subprocess.run(
        [
            binary,
            "doctor",
            "--skills-path",
            str(managed_skills_root),
            "--json",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    try:
        doctor_envelope = parse_envelope(doctor.stdout, doctor.returncode)
    except AdapterError as exc:
        doctor_envelope = {
            "format": ENVELOPE_FORMAT,
            "ok": False,
            "error": {
                "code": "VERSION_CHECK_UNAVAILABLE",
                "message": str(exc),
                "retryable": False,
            },
        }
    result["installation_status"] = doctor_envelope
    if doctor_envelope.get("ok"):
        doctor_data = doctor_envelope.get("data", {})
        result["upgrade_required"] = bool(doctor_data.get("upgrade_required"))
        result["recommended_commands"] = doctor_data.get("recommended_commands", [])

    command = ["config", "path"]
    if os.environ.get("GROUNDS_CONFIG"):
        command.extend(["--config", os.environ["GROUNDS_CONFIG"]])
    command.append("--json")
    completed = subprocess.run([binary, *command], text=True, capture_output=True, check=False)
    envelope = parse_envelope(completed.stdout, completed.returncode)
    if not envelope["ok"]:
        return {"binary": binary, "config": envelope, "ready": False}
    config_path = Path(envelope["data"]["config_path"])
    result.update({
        "config_path": str(config_path),
        "agent_id": os.environ.get("GROUNDS_AGENT_ID"),
        "agent_name": os.environ.get("GROUNDS_AGENT_NAME"),
        "ready": True,
    })
    if not config_path.is_file():
        result["configured"] = False
        return result
    result["configured"] = True
    for label, args in (
        ("config_validation", ["config", "validate", "--config", str(config_path), "--json"]),
        ("database_status", ["db", "status", "--config", str(config_path), "--json"]),
    ):
        completed = subprocess.run([binary, *args], text=True, capture_output=True, check=False)
        checked = parse_envelope(completed.stdout, completed.returncode)
        result[label] = checked
        if not checked["ok"]:
            result["ready"] = False
            break
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("uuid7")
    preflight_parser = subparsers.add_parser("preflight")
    preflight_parser.add_argument("--write", action="store_true")
    invoke_parser = subparsers.add_parser("invoke")
    invoke_parser.add_argument("--cwd", type=Path, default=Path.cwd())
    invoke_parser.add_argument("--retries", type=int, default=2, choices=range(0, 3))
    invoke_parser.add_argument("command", nargs=argparse.REMAINDER)
    draft_parser = subparsers.add_parser("draft")
    draft_parser.add_argument("kind", choices=("candidate", "verification"))
    draft_parser.add_argument("--cwd", type=Path, default=Path.cwd())
    draft_parser.add_argument("--dev-run")
    draft_parser.add_argument("--context", type=Path)
    draft_parser.add_argument("--output", type=Path)
    draft_parser.add_argument("--content-language", choices=("zh-CN",))
    return parser


def is_foreground_contract_session(command: list[str]) -> bool:
    """Live sessions inherit stdout so their initial JSON arrives before shutdown."""
    key = command_key(command)
    return key == ("workspace", "edit") or (
        key == ("contract", "render")
        and not any(arg == "--output" or arg.startswith("--output=") for arg in command)
    )


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.action == "uuid7":
            print(new_uuid7())
            return 0
        if args.action == "preflight":
            print(json.dumps(preflight(args.write), ensure_ascii=False, indent=2))
            return 0
        if args.action == "invoke":
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            # Foreground services must expose startup diagnostics immediately;
            # preserve their own final output and exit status without retries.
            if is_foreground_contract_session(command) or command_key(command) == ("code-workspace", "execution-serve"):
                prepared, _, _ = prepare_command(command)
                return subprocess.run([grounds_binary(), *prepared], cwd=args.cwd.resolve(), check=False).returncode
            envelope, returncode = invoke(command, args.cwd.resolve(), args.retries)
            print(json.dumps(envelope, ensure_ascii=False, indent=2))
            return returncode
        if args.action == "draft":
            path = native_draft(
                args.kind,
                args.cwd,
                args.output,
                dev_run=args.dev_run,
                context=args.context,
                content_language=args.content_language,
            )
            print(path)
            return 0
    except AdapterError as exc:
        print(f"grounds-agent: {exc}", file=sys.stderr)
        return 2
    raise AssertionError("unknown action")


if __name__ == "__main__":
    raise SystemExit(main())
