#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "adapters"))

from python import (  # type: ignore  # noqa: E402
    DiagnosticContractError,
    canonicalize_diagnostic_jsonl,
    encode_diagnostic,
    parse_diagnostic_line,
)


def evaluate(corpus: dict) -> dict:
    if corpus.get("schema") != "diagnostic-interchange-corpus/1":
        raise AssertionError("unexpected corpus schema")
    valid = []
    for case in corpus["valid"]:
        parsed = parse_diagnostic_line(case["line"])
        canonical = encode_diagnostic(parsed)
        assert canonical == case["canonical"], case["id"]
        valid.append({"id": case["id"], "canonical": canonical})
    invalid = []
    for case in corpus["invalid"]:
        try:
            parse_diagnostic_line(case["line"])
        except DiagnosticContractError as error:
            assert error.code == case["error"], (case["id"], error.code, case["error"])
            invalid.append({"id": case["id"], "error": error.code})
        else:
            raise AssertionError(f"invalid case accepted: {case['id']}")
    return {"schema": "diagnostic-interchange-report/1", "valid": valid, "invalid": invalid}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", nargs="?")
    parser.add_argument("--canonicalize-stdin", action="store_true")
    args = parser.parse_args()
    if args.canonicalize_stdin:
        sys.stdout.write(canonicalize_diagnostic_jsonl(sys.stdin.read()))
        return 0
    if not args.corpus:
        parser.error("corpus path is required")
    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    print(json.dumps(evaluate(corpus), ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
