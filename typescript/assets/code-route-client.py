#!/usr/bin/env python3
"""Container-only managed Git client. A timeout preserves the request for retry."""
import argparse
import fcntl
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import time
import uuid

LIMIT = 192 * 1024
TERMINAL = ("completed", "rejected", "aborted")


class ProtocolChanged(ValueError):
    pass


def read_json(path, maximum=LIMIT):
    # A host atomic replacement can unlink an already-open receipt. Reopen it;
    # do not accept torn bytes or turn this ordinary race into command failure.
    for attempt in range(5):
        try:
            return read_once(path, maximum)
        except ProtocolChanged:
            if attempt == 4:
                raise
            time.sleep(0.01)


def read_once(path, maximum):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink > 1 or before.st_size > maximum:
            raise ValueError("Expected a bounded regular protocol file")
        if before.st_nlink == 0:
            raise ProtocolChanged("Protocol file was replaced after opening; retry")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(fd)
        if len(data) != before.st_size or len(data) > maximum or (
            before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink
        ) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink):
            raise ProtocolChanged("Protocol file changed while reading; retry")
        return json.loads(data)
    finally:
        os.close(fd)


def atomic_write(path, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > LIMIT:
        raise ValueError("Request exceeds its size limit")
    fd, temporary = tempfile.mkstemp(prefix=".request-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def uuid7():
    value = bytearray(secrets.token_bytes(16))
    value[:6] = int(time.time() * 1000).to_bytes(6, "big")
    value[6] = (value[6] & 15) | 112
    value[8] = (value[8] & 63) | 128
    return str(uuid.UUID(bytes=bytes(value)))


def host_length(value):
    return len(value.encode("utf-16-le")) // 2


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value)


def matching(receipt, request):
    return isinstance(receipt, dict) and receipt.get("execution_id") == request["execution_id"] and (
        receipt.get("request_id") == request["request_id"] and receipt.get("state") in TERMINAL
    )


def main():
    parser = argparse.ArgumentParser(prog="grounds-git", description=__doc__)
    parser.add_argument("--timeout", type=float, default=120, help="seconds to wait; expiry does not cancel the request")
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("stage", "unstage"):
        commands.add_parser(action).add_argument("paths", nargs="+")
    commit = commands.add_parser("commit")
    commit.add_argument("-m", "--message", required=True)
    commit.add_argument("--author-name", required=True)
    commit.add_argument("--author-email", required=True)
    commands.add_parser("retry", help="wait for the original request; never creates a new commit request")
    args = parser.parse_args()
    if not 0 < args.timeout <= 86400:
        raise ValueError("timeout must be greater than zero and at most 86400 seconds")
    execution = os.environ.get("GROUNDS_CODE_EXECUTION_ID")
    if not valid_id(execution):
        raise ValueError("This command requires a Grounds development execution")
    root = os.environ.get("GROUNDS_CODE_CHANNEL", "/grounds-requests")
    inbox, response = os.path.join(root, "inbox"), os.path.join(root, "outbox", "response.json")
    request_path = os.path.join(inbox, "request.json")
    lock = os.open(os.path.join(inbox, ".client.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Invalid client lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another grounds-git command is waiting; retry after it exits") from None
        previous = read_json(request_path)
        if previous is not None and (not isinstance(previous, dict) or previous.get("execution_id") != execution or not valid_id(previous.get("request_id"))):
            raise ValueError("The saved request does not belong to this execution")
        if args.action == "retry":
            if previous is None:
                raise ValueError("There is no saved request to retry")
            request = previous
        else:
            if previous is not None and not matching(read_json(response, 16384), previous):
                raise ValueError("A request is unresolved; use grounds-git retry")
            request = {"request_id": uuid7(), "execution_id": execution, "action": args.action}
            if args.action in ("stage", "unstage"):
                if len(args.paths) > 128 or len(set(args.paths)) != len(args.paths) or any(
                    host_length(path) > 1024 or re.search(r"[\\\x00-\x1f\x7f:]", path) or any(
                        part in ("", ".", "..") or part.lower() == ".git" for part in path.split("/")
                    ) for path in args.paths
                ):
                    raise ValueError("Use distinct explicit relative paths without Git metadata or traversal")
                request["paths"] = args.paths
            else:
                if not args.message.strip() or host_length(args.message) > 65536 or "\0" in args.message or any(
                    not item.strip() or host_length(item) > 256 or re.search(r"[<>\x00-\x1f\x7f]", item)
                    for item in (args.author_name, args.author_email)
                ):
                    raise ValueError("Use a bounded commit message and author identity")
                request.update(message=args.message, author={"name": args.author_name, "email": args.author_email})
            atomic_write(request_path, request)
        deadline = time.monotonic() + args.timeout
        while True:
            receipt = read_json(response, 16384)
            if matching(receipt, request):
                print(json.dumps(receipt, ensure_ascii=False))
                return 0 if receipt["state"] == "completed" else 2
            if time.monotonic() >= deadline:
                print(json.dumps({"state": "waiting", "request_id": request["request_id"], "execution_id": execution,
                    "message": "Timeout does not cancel the request; use grounds-git retry."}), file=sys.stderr)
                return 3
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print(json.dumps({"state": "interrupted", "message": "The request is preserved; use grounds-git retry."}), file=sys.stderr)
        sys.exit(130)
    except (ValueError, OSError) as error:
        print(json.dumps({"state": "error", "message": str(error)}), file=sys.stderr)
        sys.exit(2)
