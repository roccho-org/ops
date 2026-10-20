"""Python environment adapter bound to the canonical contract.json."""
from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any, TextIO

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "lib"))

from diagnostic import (  # noqa: E402
    DiagnosticContractError,
    canonicalize_diagnostic_jsonl as _canonicalize,
    encode_diagnostic as _encode,
    parse_diagnostic_line as _parse,
    validate_diagnostic as _validate,
)

DIAGNOSTIC_CONTRACT = json.loads((PACKAGE_ROOT / "contract.json").read_text(encoding="utf-8"))


def validate_diagnostic(value: Any) -> dict[str, Any]:
    return _validate(value, DIAGNOSTIC_CONTRACT)


def encode_diagnostic(value: Any) -> str:
    return _encode(value, DIAGNOSTIC_CONTRACT)


def parse_diagnostic_line(line: str) -> dict[str, Any]:
    return _parse(line, DIAGNOSTIC_CONTRACT)


def canonicalize_diagnostic_jsonl(text: str) -> str:
    return _canonicalize(text, DIAGNOSTIC_CONTRACT)


def write_diagnostic(value: Any, stream: TextIO = sys.stderr) -> int:
    if stream is None or not callable(getattr(stream, "write", None)):
        raise DiagnosticContractError("DIAGNOSTIC_STREAM_INVALID", "stream", "stream must expose a write(text) function")
    return stream.write(encode_diagnostic(value))
