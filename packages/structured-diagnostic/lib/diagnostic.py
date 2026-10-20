"""Independent Python implementation of the diagnostic/1 meaning.

This module is standard-library-only and never delegates validation or encoding
to the JavaScript implementation. Environment effects belong in adapters.
"""
from __future__ import annotations

from decimal import Decimal
import json
import math
import re
from typing import Any, Mapping


class DiagnosticContractError(ValueError):
    def __init__(self, code: str, path: str, message: str, *, line: int | None = None):
        super().__init__(message)
        self.code = code
        self.path = path
        self.line = line


def _fail(code: str, path: str, message: str, *, line: int | None = None) -> None:
    raise DiagnosticContractError(code, path, message, line=line)


def _utf8_bytes(value: str) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        _fail("DIAGNOSTIC_STRING_INVALID_UNICODE", "$", "string must contain well-formed Unicode")


def _well_formed_unicode(value: str) -> bool:
    return not any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def _plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _string_array(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        _fail("DIAGNOSTIC_CONTRACT_INVALID", path, f"{path} must be an array of strings")
    if len(set(value)) != len(value):
        _fail("DIAGNOSTIC_CONTRACT_INVALID", path, f"{path} must not contain duplicates")
    return value


def _positive_integer(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail("DIAGNOSTIC_CONTRACT_INVALID", path, f"{path} must be a positive integer")
    return value


def _read_contract(contract: Mapping[str, Any]) -> dict[str, Any]:
    if not _plain_object(contract) or contract.get("schema") != "diagnostic-contract/1":
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract", "contract schema must be diagnostic-contract/1")

    allowed = _string_array(contract.get("allowedTopLevel"), "contract.allowedTopLevel")
    required = _string_array(contract.get("requiredTopLevel"), "contract.requiredTopLevel")
    host_owned = _string_array(contract.get("hostOwnedTopLevel"), "contract.hostOwnedTopLevel")
    levels = _string_array(contract.get("levels"), "contract.levels")
    field_types = _string_array(contract.get("fieldValueTypes"), "contract.fieldValueTypes")

    allowed_set = set(allowed)
    for key in required:
        if key not in allowed_set:
            _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.requiredTopLevel", f"required field is not allowed: {key}")
    for key in host_owned:
        if key in allowed_set:
            _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.hostOwnedTopLevel", f"host-owned field must not be allowed: {key}")
    supported_types = {"null", "string", "boolean", "number"}
    if any(kind not in supported_types for kind in field_types):
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.fieldValueTypes", "unsupported field value type")
    if contract.get("nestedFieldsAllowed") is not False:
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.nestedFieldsAllowed", "nestedFieldsAllowed must be false")

    schema = contract.get("diagnosticSchema")
    if not isinstance(schema, str) or not schema:
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.diagnosticSchema", "diagnosticSchema must be a non-empty string")
    patterns = contract.get("patterns")
    limits = contract.get("limits")
    if not _plain_object(patterns) or not _plain_object(limits):
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract", "patterns and limits must be objects")
    try:
        code_pattern = re.compile(patterns["code"], re.ASCII)
        field_pattern = re.compile(patterns["field"], re.ASCII)
    except (KeyError, TypeError, re.error):
        _fail("DIAGNOSTIC_CONTRACT_INVALID", "contract.patterns", "patterns must be valid regular expressions")

    return {
        "schema": schema,
        "allowed": allowed_set,
        "required": required,
        "host_owned": set(host_owned),
        "levels": set(levels),
        "field_types": set(field_types),
        "code_pattern": code_pattern,
        "field_pattern": field_pattern,
        "limits": {
            name: _positive_integer(limits.get(name), f"contract.limits.{name}")
            for name in (
                "encodedBytes", "codeBytes", "messageBytes", "fields",
                "fieldNameBytes", "fieldStringBytes",
            )
        },
    }


def _token(value: Any, path: str, pattern: re.Pattern[str], maximum: int, kind: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"DIAGNOSTIC_{kind}_INVALID", path, f"{path} must be a non-empty string")
    if _utf8_bytes(value) > maximum:
        _fail(f"DIAGNOSTIC_{kind}_TOO_LARGE", path, f"{path} exceeds {maximum} UTF-8 bytes")
    if pattern.fullmatch(value) is None:
        _fail(f"DIAGNOSTIC_{kind}_INVALID", path, f"{path} does not match the required token pattern")
    return value


def _js_number(value: int | float) -> str:
    number = float(value)
    if not math.isfinite(number):
        _fail("DIAGNOSTIC_FIELD_VALUE_INVALID", "fields", "number field values must be finite")
    if number == 0:
        return "0"
    raw = repr(number).lower()
    absolute = abs(number)
    if "e" in raw:
        mantissa, exponent_text = raw.split("e", 1)
        exponent = int(exponent_text)
        if 1e-6 <= absolute < 1e21:
            fixed = format(Decimal(raw), "f")
            if "." in fixed:
                fixed = fixed.rstrip("0").rstrip(".")
            return "0" if fixed in {"-0", ""} else fixed
        if mantissa.endswith(".0"):
            mantissa = mantissa[:-2]
        if "." in mantissa:
            mantissa = mantissa.rstrip("0").rstrip(".")
        return f"{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"
    return raw[:-2] if raw.endswith(".0") else raw


def _json_string(value: str) -> str:
    if not _well_formed_unicode(value):
        _fail("DIAGNOSTIC_STRING_INVALID_UNICODE", "$", "string must contain well-formed Unicode")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _js_number(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{_json_string(key)}:{_canonical_json(value[key])}" for key in value
        ) + "}"
    _fail("DIAGNOSTIC_FIELD_VALUE_INVALID", "$", "value is not JSON-compatible")


def _canonical_fields(value: Any, compiled: Mapping[str, Any]) -> dict[str, Any]:
    if not _plain_object(value):
        _fail("DIAGNOSTIC_FIELDS_INVALID", "fields", "fields must be an object")
    keys = sorted(value)
    if not all(isinstance(key, str) for key in keys):
        _fail("DIAGNOSTIC_FIELD_NAME_INVALID", "fields", "field names must be strings")
    if len(keys) > compiled["limits"]["fields"]:
        _fail("DIAGNOSTIC_FIELDS_TOO_MANY", "fields", f"fields exceeds {compiled['limits']['fields']} entries")
    fields: dict[str, Any] = {}
    for key in keys:
        _token(key, f"fields.{key}", compiled["field_pattern"], compiled["limits"]["fieldNameBytes"], "FIELD_NAME")
        field = value[key]
        if field is None:
            kind = "null"
        elif isinstance(field, bool):
            kind = "boolean"
        elif isinstance(field, (int, float)) and not isinstance(field, bool):
            kind = "number"
            field = float(field)
            if not math.isfinite(field):
                _fail("DIAGNOSTIC_FIELD_VALUE_INVALID", f"fields.{key}", "number field values must be finite")
        elif isinstance(field, str):
            kind = "string"
            if not _well_formed_unicode(field):
                _fail("DIAGNOSTIC_FIELD_STRING_INVALID_UNICODE", f"fields.{key}", "string field value must contain well-formed Unicode")
            if _utf8_bytes(field) > compiled["limits"]["fieldStringBytes"]:
                _fail("DIAGNOSTIC_FIELD_STRING_TOO_LARGE", f"fields.{key}", f"string field value exceeds {compiled['limits']['fieldStringBytes']} UTF-8 bytes")
        else:
            _fail("DIAGNOSTIC_FIELD_VALUE_INVALID", f"fields.{key}", "field values must be null, string, boolean, or finite number")
        if kind not in compiled["field_types"]:
            _fail("DIAGNOSTIC_FIELD_VALUE_INVALID", f"fields.{key}", f"{kind} field values are not allowed")
        fields[key] = field
    return fields


def validate_diagnostic(value: Any, contract: Mapping[str, Any]) -> dict[str, Any]:
    compiled = _read_contract(contract)
    if not _plain_object(value):
        _fail("DIAGNOSTIC_NOT_OBJECT", "$", "diagnostic must be an object")
    for key in sorted(value):
        if not isinstance(key, str):
            _fail("DIAGNOSTIC_NON_JSON_PROPERTY", "$", "diagnostic contains a non-string property")
        if key not in compiled["allowed"]:
            if key in compiled["host_owned"]:
                _fail("DIAGNOSTIC_HOST_FIELD_FORGED", key, f"{key} is host-owned and prohibited in diagnostic/1")
            _fail("DIAGNOSTIC_UNKNOWN_FIELD", key, f"unknown top-level field: {key}")
    for key in compiled["required"]:
        if key not in value:
            _fail("DIAGNOSTIC_REQUIRED_FIELD_MISSING", key, f"missing required field: {key}")
    if value.get("schema") != compiled["schema"]:
        _fail("DIAGNOSTIC_SCHEMA_INVALID", "schema", f"schema must be {compiled['schema']}")
    code = _token(value.get("code"), "code", compiled["code_pattern"], compiled["limits"]["codeBytes"], "CODE")
    level = value.get("level")
    if not isinstance(level, str) or level not in compiled["levels"]:
        _fail("DIAGNOSTIC_LEVEL_INVALID", "level", "level must be debug, info, warn, or error")
    message = value.get("message")
    if not isinstance(message, str) or not message.strip():
        _fail("DIAGNOSTIC_MESSAGE_INVALID", "message", "message must be a non-blank string")
    if not _well_formed_unicode(message):
        _fail("DIAGNOSTIC_MESSAGE_INVALID_UNICODE", "message", "message must contain well-formed Unicode")
    if _utf8_bytes(message) > compiled["limits"]["messageBytes"]:
        _fail("DIAGNOSTIC_MESSAGE_TOO_LARGE", "message", f"message exceeds {compiled['limits']['messageBytes']} UTF-8 bytes")

    canonical: dict[str, Any] = {
        "schema": compiled["schema"],
        "code": code,
        "level": level,
        "message": message,
    }
    if "fields" in value:
        canonical["fields"] = _canonical_fields(value["fields"], compiled)
    encoded = _canonical_json(canonical) + "\n"
    if len(encoded.encode("utf-8")) > compiled["limits"]["encodedBytes"]:
        _fail("DIAGNOSTIC_ENCODED_TOO_LARGE", "$", f"encoded diagnostic exceeds {compiled['limits']['encodedBytes']} UTF-8 bytes")
    return canonical


def encode_diagnostic(value: Any, contract: Mapping[str, Any]) -> str:
    return _canonical_json(validate_diagnostic(value, contract)) + "\n"


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DIAGNOSTIC_DUPLICATE_KEY", key, f"duplicate object key: {key}")
        result[key] = value
    return result


def parse_diagnostic_line(line: str, contract: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(line, str) or not line.strip():
        _fail("DIAGNOSTIC_JSONL_EMPTY_LINE", "$", "diagnostic JSONL line must not be blank")
    try:
        value = json.loads(line, object_pairs_hook=_pairs, parse_int=float, parse_float=float)
    except DiagnosticContractError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        _fail("DIAGNOSTIC_JSON_INVALID", "$", "diagnostic line is not valid JSON")
    return validate_diagnostic(value, contract)


def canonicalize_diagnostic_jsonl(text: str, contract: Mapping[str, Any]) -> str:
    if not isinstance(text, str):
        _fail("DIAGNOSTIC_JSONL_INPUT_INVALID", "$", "diagnostic JSONL input must be text")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        _fail("DIAGNOSTIC_JSONL_EMPTY", "$", "diagnostic JSONL input must contain at least one row")
    values: list[dict[str, Any]] = []
    for index, line in enumerate(lines, start=1):
        try:
            values.append(parse_diagnostic_line(line, contract))
        except DiagnosticContractError as error:
            raise DiagnosticContractError(error.code, error.path, str(error), line=index) from error
    return "".join(_canonical_json(value) + "\n" for value in values)
