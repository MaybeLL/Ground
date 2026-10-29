#!/usr/bin/env python3
"""Synchronize the plugin's bundled contracts from the repository truth."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import sys


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PLUGIN_ROOT.parents[1]
SOURCE = REPO_ROOT / "docs" / "contracts" / "v1"
TARGET = PLUGIN_ROOT / "references" / "contracts" / "v1"


def files(root: Path) -> dict[str, bytes]:
    if not root.is_dir():
        return {}
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail instead of updating")
    args = parser.parse_args()
    if not SOURCE.is_dir():
        print(f"contract source not found: {SOURCE}", file=sys.stderr)
        return 2
    source_files = files(SOURCE)
    target_files = files(TARGET)
    if args.check:
        if source_files != target_files:
            missing = sorted(source_files.keys() - target_files.keys())
            extra = sorted(target_files.keys() - source_files.keys())
            changed = sorted(
                name for name in source_files.keys() & target_files.keys()
                if source_files[name] != target_files[name]
            )
            print(f"contracts are out of sync; missing={missing}, extra={extra}, changed={changed}")
            return 1
        print("contracts are in sync")
        return 0
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE, TARGET)
    print(f"synchronized {len(source_files)} contract files to {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
