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


def base_value() -> dict:
    return {
        "schema": "diagnostic/1",
        "code": "boundary.case",
        "level": "info",
        "message": "x",
    }


def raw_json_line(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


def encoded_boundary_value(target: int) -> dict:
    value = base_value()
    value["fields"] = {}
    index = 0
    while True:
        current = len(raw_json_line(value).encode("utf-8"))
        if current == target:
            return value
        if current > target or index >= 32:
            raise AssertionError(f"cannot construct encoded boundary {target}: {current}")
        key = f"f{index:02d}"
        value["fields"][key] = ""
        empty = len(raw_json_line(value).encode("utf-8"))
        room = target - empty
        if room < 0:
            raise AssertionError(f"encoded boundary overrun {target}: {empty}")
        value["fields"][key] = "x" * min(8192, room)
        index += 1


def generated_value(case: dict) -> dict:
    value = base_value()
    kind = case["kind"]
    if kind == "message":
        value["message"] = case["value"]
    elif kind == "code-bytes":
        value["code"] = "a" * case["size"]
        assert len(value["code"].encode("utf-8")) == case["size"]
    elif kind == "message-bytes":
        value["message"] = "x" * case["size"]
        assert len(value["message"].encode("utf-8")) == case["size"]
    elif kind == "field-count":
        value["fields"] = {f"f{index:02d}": index for index in range(case["size"])}
        assert len(value["fields"]) == case["size"]
    elif kind == "field-name-bytes":
        key = "a" * case["size"]
        assert len(key.encode("utf-8")) == case["size"]
        value["fields"] = {key: "x"}
    elif kind == "field-string-bytes":
        field = "x" * case["size"]
        assert len(field.encode("utf-8")) == case["size"]
        value["fields"] = {"value": field}
    elif kind == "encoded-bytes":
        value = encoded_boundary_value(case["size"])
        assert len(raw_json_line(value).encode("utf-8")) == case["size"]
    elif kind == "nonfinite-number":
        value["fields"] = {"value": float("inf")}
    elif kind == "malformed-message":
        value["message"] = chr(0xD800)
    else:
        raise AssertionError(f"unknown generated case kind: {kind}")
    return value


def evaluate(corpus: dict) -> dict:
    if corpus.get("schema") != "diagnostic-interchange-corpus/2":
        raise AssertionError("unexpected corpus schema")
    literal_valid = []
    for case in corpus["valid"]:
        parsed = parse_diagnostic_line(case["line"])
        canonical = encode_diagnostic(parsed)
        assert canonical == case["canonical"], case["id"]
        literal_valid.append({"id": case["id"], "canonical": canonical})
    literal_invalid = []
    for case in corpus["invalid"]:
        try:
            parse_diagnostic_line(case["line"])
        except DiagnosticContractError as error:
            assert error.code == case["error"], (case["id"], error.code, case["error"])
            literal_invalid.append({"id": case["id"], "error": error.code})
        else:
            raise AssertionError(f"invalid case accepted: {case['id']}")

    generated = []
    for case in corpus["generated"]:
        try:
            canonical = encode_diagnostic(generated_value(case))
        except DiagnosticContractError as error:
            assert case["accept"] is False, (case["id"], error.code)
            assert error.code == case["error"], (case["id"], error.code, case["error"])
            generated.append({"id": case["id"], "result": "rejected", "error": error.code})
        else:
            assert case["accept"] is True, case["id"]
            generated.append({"id": case["id"], "result": "accepted", "canonical": canonical})

    return {
        "schema": "diagnostic-interchange-report/2",
        "literalValid": literal_valid,
        "literalInvalid": literal_invalid,
        "generated": generated,
    }


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
