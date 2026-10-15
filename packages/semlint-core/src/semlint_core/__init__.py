"""Pure collection/fact planning and comparison. No provider or repository access."""
from __future__ import annotations

import hashlib
import json

__version__ = "0.1.0"
CONTRACT = "semlint.collections.v1"
UNKNOWN_LABEL = "cannot_tell"
RESULTS = frozenset({"UNKNOWN", "ERROR", "NOT_RUN", "CANNOT_TELL", "AGREE",
                     "CONFLICT", "COMPATIBLE", "GAP", "ONE_SIDED", "NEITHER"})
EVALUATED = frozenset({"CONFLICT_CANDIDATE", "REVIEW", "NO_CONFLICT_ON_SELECTED_FACTS"})


class InvalidCase(ValueError):
    """Invalid declared input; messages contain codes, never original text."""


def _string(value, *, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _json(value):
    if value is None or type(value) in (str, bool, int):
        if isinstance(value, str) and not _string(value, empty=True):
            raise InvalidCase("invalid_unicode")
        return
    if isinstance(value, list):
        for item in value:
            _json(item)
        return
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        for key, item in value.items():
            _json(key)
            _json(item)
        return
    raise InvalidCase("invalid_json_value")


def _canonical(value):
    try:
        _json(value)
        return json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeEncodeError, RecursionError) as error:
        raise InvalidCase("invalid_json_value") from error


def _fact(fact):
    if not isinstance(fact, dict) or set(fact) != {"question", "choices", "absent"}:
        raise InvalidCase("fact_shape")
    choices = fact["choices"]
    if (not _string(fact["question"]) or not isinstance(choices, dict)
            or len(choices) < 2 or not all(_string(k) for k in choices)
            or UNKNOWN_LABEL not in choices
            or any(not (isinstance(v, dict) and v or _string(v)) for v in choices.values())):
        raise InvalidCase("fact_choices")
    absent = fact["absent"]
    if absent is not None and (not isinstance(absent, str)
                               or absent == UNKNOWN_LABEL or absent not in choices):
        raise InvalidCase("fact_absent")
    _canonical(choices)


def request_bytes(fact, text):
    """One independent Choice request; no ids, provenance, absent or Gold."""
    _fact(fact)
    if not _string(text, empty=True):
        raise InvalidCase("invalid_text")
    return _canonical({"type": "choice", "text": text,
                       "question": fact["question"], "criteria": fact["choices"]})


def _validate(collections, facts, relation, reference=None):
    if not isinstance(collections, list) or len(collections) < 2:
        raise InvalidCase("collections")
    ids = []
    for collection in collections:
        if not isinstance(collection, dict) or not _string(collection.get("id")):
            raise InvalidCase("collection_id")
        cid = collection["id"]
        if cid in ids:
            raise InvalidCase("duplicate_collection")
        ids.append(cid)
        units = collection.get("units")
        if not isinstance(units, list) or not units:
            raise InvalidCase("units")
        for unit in units:
            if (not isinstance(unit, dict)
                    or not all(_string(unit.get(k)) for k in ("ref", "revision"))
                    or not _string(unit.get("text"), empty=True)
                    or unit.get("sha256") != hashlib.sha256(unit["text"].encode("utf-8")).hexdigest()):
                raise InvalidCase("unit")
    if not isinstance(facts, dict) or not facts or not all(_string(k) for k in facts):
        raise InvalidCase("facts")
    for fact in facts.values():
        _fact(fact)
    _relation(relation, ids)
    if reference is not None and (not isinstance(reference, str) or reference not in ids):
        raise InvalidCase("reference")
    return ids


def _relation(relation, ids):
    if (not isinstance(relation, dict) or set(relation) != {"type", "edges"}
            or relation["type"] not in ("equal", "compatible", "cover")
            or not isinstance(relation["edges"], list)):
        raise InvalidCase("relation")
    edges = relation["edges"]
    if relation["type"] != "cover":
        if edges:
            raise InvalidCase("unexpected_edges")
        return
    if not edges:
        raise InvalidCase("empty_edges")
    seen = set()
    touched = set()
    for edge in edges:
        if (not isinstance(edge, list) or len(edge) != 2
                or not all(isinstance(k, str) and k in ids for k in edge)
                or edge[0] == edge[1] or tuple(edge) in seen):
            raise InvalidCase("edge")
        seen.add(tuple(edge))
        touched.update(edge)
    if touched != set(ids):
        raise InvalidCase("orphan_collection")


def plan_case(collections, facts, relation, reference=None):
    """Validate a resolved case; return unique requests and structural slot map.

    facts is an id->fact mapping. JSONL parsing, global case-id uniqueness and
    duplicate JSON object keys are the caller's responsibility, before calling.
    """
    try:
        _validate(collections, facts, relation, reference)
        requests = {}
        slots = {}
        for fid, fact in facts.items():
            slots[fid] = {}
            for collection in collections:
                text = "\n\n".join(unit["text"] for unit in collection["units"])
                wire = request_bytes(fact, text)
                digest = hashlib.sha256(wire).hexdigest()
                requests.setdefault(digest, wire)
                cid = collection["id"]
                slots[fid][cid] = digest
        return {"status": "VALID", "issues": [], "slots": slots,
                "requests": [{"request_sha256": sha, "request": wire}
                             for sha, wire in requests.items()],
                "shared_observations": _shared(slots)}
    except (InvalidCase, RecursionError) as error:
        return {"status": "INVALID", "issues": [str(error) if isinstance(error, InvalidCase)
                                               else "invalid_json_value"],
                "slots": {}, "requests": [], "shared_observations": []}


def case_status(results):
    """Aggregate nonempty fact/edge results; no empty-set success."""
    if (not isinstance(results, dict) or not results
            or not all(isinstance(r, str) and r in RESULTS for r in results.values())):
        return "ERROR"
    values = set(results.values())
    for result, status in (("UNKNOWN", "UNKNOWN"), ("ERROR", "ERROR"),
                           ("NOT_RUN", "INCOMPLETE"), ("CONFLICT", "CONFLICT_CANDIDATE")):
        if result in values:
            return status
    if values & {"CANNOT_TELL", "GAP", "ONE_SIDED", "NEITHER"}:
        return "REVIEW"
    return "NO_CONFLICT_ON_SELECTED_FACTS"


def _groups(ids, answers, absent):
    groups = {}
    missing = []
    for cid in ids:
        answer = answers[cid]
        if answer.get("status") != "OBSERVED":
            continue
        label = answer.get("raw")
        if label == absent:
            missing.append(cid)
        elif label != UNKNOWN_LABEL:
            groups.setdefault(label, []).append(cid)
    return [{"label": label, "collections": groups[label]} for label in sorted(groups)], missing


def _comparison(kind, ids, answers, absent):
    states = [answers[cid].get("status") for cid in ids]
    groups, missing = _groups(ids, answers, absent)
    if "UNKNOWN" in states:
        result = "UNKNOWN"
    elif "ERROR" in states:
        result = "ERROR"
    elif any(state != "OBSERVED" for state in states):
        result = "NOT_RUN"
    elif any(answers[cid].get("raw") == UNKNOWN_LABEL for cid in ids):
        result = "CANNOT_TELL"
    elif len(groups) > 1:
        result = "CONFLICT"
    elif not missing:
        result = "AGREE"
    elif kind == "compatible":
        result = "COMPATIBLE"
    elif len(missing) == len(ids):
        result = "NEITHER"
    elif kind == "cover" and ids[1] in missing:
        result = "GAP"
    else:
        result = "ONE_SIDED"
    return {"collections": list(ids), "result": result, "groups": groups, "absent": missing}


def compare_answers(relation, absent, answers):
    """Compare already admitted answers (confidence/provenance handled by caller).

    relation is explicit, never inferred from file type or id. UNKNOWN/ERROR/
    NOT_RUN/cannot_tell retain their precedence. Use judge_case for checked input.
    """
    if not isinstance(answers, dict) or len(answers) < 2 or not all(
            _string(cid) and isinstance(a, dict) for cid, a in answers.items()):
        raise InvalidCase("answers")
    if any(a.get("status") == "OBSERVED" and not isinstance(a.get("raw"), str)
           for a in answers.values()):
        raise InvalidCase("observed_label")
    ids = list(answers)
    _relation(relation, ids)
    scopes = relation["edges"] if relation["type"] == "cover" else [ids]
    return [_comparison(relation["type"], scope, answers, absent) for scope in scopes]


def _answer_ok(answer, fact, digest):
    if not isinstance(answer, dict) or answer.get("request_sha256") != digest:
        return False
    status = answer.get("status")
    if status == "OBSERVED":
        return (isinstance(answer.get("raw"), str) and answer["raw"] in fact["choices"]
                and _string(answer.get("model")))
    if status == "UNKNOWN":
        return answer.get("raw") is None
    if status == "ERROR":
        return answer.get("raw") is None and isinstance(answer.get("error"), str) and answer.get("error") in {"evidence_invalid", "execution"}
    if status == "NOT_RUN":
        return answer.get("raw") is None and isinstance(answer.get("cause"), str) and answer.get("cause") in {"stopped", "not_asked", "omitted"}
    return False


def judge_case(collections, facts, relation, answers, reference=None):
    """Check all slots, retain partial findings, aggregate with mixed-model guard.

    answers[fact_id][collection_id] carries request_sha256 plus the admitted
    status/raw/model fields. Confidence, sendable and record/pin trust are owned
    by the caller, not by this pure core.
    """
    plan = plan_case(collections, facts, relation, reference)
    if plan["status"] == "INVALID":
        return {**plan, "results": {}, "findings": [], "admission": {}, "exact": False}
    return _judge(plan["slots"], facts, relation, answers)


def _shared(slots):
    shared = {}
    for fid, row in slots.items():
        for cid, digest in row.items():
            shared.setdefault(digest, []).append({"fact": fid, "collection": cid})
    return [{"request_sha256": sha, "slots": members}
            for sha, members in shared.items() if len(members) > 1]


def judge_slots(slots, facts, relation, answers, *, rejected=(), extra=False):
    """Judge a caller-admitted plan without text or I/O.

    The caller owns digest provenance, whole-record and confidence admission.
    rejected lists declared (fact, collection) pairs refused by that admission;
    those pairs must be absent from answers. extra records unmappable extras.
    """
    try:
        if (not isinstance(facts, dict) or not facts or not all(_string(k) for k in facts)
                or not isinstance(slots, dict) or set(slots) != set(facts)):
            raise InvalidCase("slots")
        ids = None
        for fid, fact in facts.items():
            _fact(fact)
            row = slots[fid]
            if (not isinstance(row, dict) or len(row) < 2
                    or not all(_string(cid) for cid in row)
                    or not all(isinstance(digest, str) and len(digest) == 64
                               and all(ch in "0123456789abcdef" for ch in digest)
                               for digest in row.values())):
                raise InvalidCase("slots")
            if ids is None:
                ids = list(row)
            elif list(row) != ids:
                raise InvalidCase("collection_order")
        _relation(relation, ids)
        if type(extra) is not bool or not isinstance(rejected, (list, tuple)):
            raise InvalidCase("admission_metadata")
        refused = set()
        for pair in rejected:
            if (not isinstance(pair, (list, tuple)) or len(pair) != 2
                    or not all(isinstance(k, str) for k in pair)
                    or pair[0] not in slots or pair[1] not in slots[pair[0]]
                    or tuple(pair) in refused):
                raise InvalidCase("rejected_slot")
            fid, cid = pair
            if (isinstance(answers, dict) and isinstance(answers.get(fid), dict)
                    and cid in answers[fid]):
                raise InvalidCase("answered_and_rejected")
            refused.add(tuple(pair))
        return _judge(slots, facts, relation, answers, refused, extra)
    except (InvalidCase, RecursionError) as error:
        return {"status": "INVALID", "issues": [str(error) if isinstance(error, InvalidCase)
                                               else "invalid_json_value"],
                "slots": {}, "requests": [], "shared_observations": [],
                "results": {}, "findings": [], "admission": {}, "exact": False}


def _judge(slots, facts, relation, answers, rejected=frozenset(), extra=False):
    """The single admission, comparison and case-state implementation."""
    if not isinstance(answers, dict):
        answers = {}
    exact = not extra and not rejected and set(answers) == set(facts)
    results = {}
    admission = {}
    findings = []
    valid = []
    flat = {}
    for fid, fact in facts.items():
        supplied_row = answers.get(fid)
        row = supplied_row if isinstance(supplied_row, dict) else {}
        expected = slots[fid]
        good = {cid: a for cid, a in row.items()
                if cid in expected and (fid, cid) not in rejected and _answer_ok(a, fact, expected[cid])}
        exact = exact and set(row) == set(expected) and set(good) == set(expected)
        admission[fid] = {cid: ("valid" if cid in good else
                               "invalid" if ((fid, cid) in rejected or cid in row or (fid in answers and not isinstance(supplied_row, dict)))
                               else "missing") for cid in expected}
        valid.extend(good.values())
        admitted = {cid: good.get(cid, {"status": "ERROR", "raw": None}) for cid in expected}
        compared = compare_answers(relation, fact["absent"], admitted)
        results[fid] = compared
        for index, compared_row in enumerate(compared):
            flat[(fid, index)] = compared_row["result"]
            if compared_row["groups"]:
                findings.append({"fact": fid, **compared_row,
                                 "observed_conflict": len(compared_row["groups"]) > 1})
    status = ("UNKNOWN" if any(a.get("status") == "UNKNOWN" for a in valid)
              else "ERROR" if not exact else case_status(flat))
    models = {a["model"] for a in valid if a.get("status") == "OBSERVED"}
    if len(models) > 1 and status in EVALUATED:
        status = "INCOMPLETE"
    return {"status": status, "results": results, "findings": findings,
            "admission": admission, "exact": bool(exact),
            "shared_observations": _shared(slots)}
