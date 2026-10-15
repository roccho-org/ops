"""Offline contract vectors; --source is an explicit test-only import mode."""
import copy
import hashlib
import itertools
import sys
import unittest
from pathlib import Path

if "--source" in sys.argv:
    sys.argv.remove("--source")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import semlint_core as core

FACT = {"question": "What value is stated?", "choices": {
    "x": "X", "y": "Y", "none": "Not stated", "cannot_tell": "Cannot decide"},
    "absent": "none"}


def collections(*ids):
    return [{"id": cid, "units": [unit(cid)]} for cid in ids]


def unit(text):
    return {"ref": "source", "revision": "fixed", "text": text,
            "sha256": hashlib.sha256(text.encode()).hexdigest()}


def relation(kind="equal", edges=None):
    return {"type": kind, "edges": edges or []}


def observed(label, model="m"):
    return {"status": "OBSERVED", "raw": label, "model": model}


def state(name):
    return {"status": name, "raw": None,
            **({"cause": "stopped"} if name == "NOT_RUN" else {}),
            **({"error": "execution"} if name == "ERROR" else {})}


def answers(cs, labels, facts=None, rel=None):
    facts = facts or {"f": FACT}
    plan = core.plan_case(cs, facts, rel or relation())
    assert plan["status"] == "VALID", plan
    return {fid: {c["id"]: {**copy.deepcopy(a),
                           "request_sha256": plan["slots"][fid][c["id"]]}
                  for c, a in zip(cs, labels)}
            for fid in facts}


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.cs = collections("A", "B", "C")
        self.facts = {"f": copy.deepcopy(FACT)}

    def judge(self, labels, rel=None, cs=None, facts=None):
        cs, facts, rel = cs or self.cs, facts or self.facts, rel or relation()
        a = answers(cs, labels, facts, rel)
        result = core.judge_case(cs, facts, rel, a)
        plan = core.plan_case(cs, facts, rel)
        self.assertEqual(result, core.judge_slots(plan["slots"], facts, rel, a))
        return result

    def test_literal_canonical_unicode_and_escaping(self):
        fact = {"question": "問", "choices": {"z": "乙", "cannot_tell": "不明", "a": "甲"},
                "absent": None}
        text = '日"\\\n\nZ' + "\u2028\u2029"
        expected = (r'{"criteria":{"a":"甲","cannot_tell":"不明","z":"乙"},"question":"問","text":"日\"\\\n\nZ'
                    + "\u2028\u2029" + r'","type":"choice"}').encode("utf-8")
        self.assertEqual(core.request_bytes(fact, text), expected)

    def test_ordered_units_and_metadata_do_not_leak(self):
        cs = collections("A", "B")
        cs[0]["units"] = [unit("first\n\n"), unit("second")]
        cs[0]["owner"] = "PRIVATE_OWNER"
        plan = core.plan_case(cs, self.facts, relation(), reference="A")
        wire = next(r["request"] for r in plan["requests"]
                    if r["request_sha256"] == plan["slots"]["f"]["A"])
        self.assertIn(b'"text":"first\\n\\n\\n\\nsecond"', wire)
        self.assertNotIn(b"PRIVATE_OWNER", wire)
        self.assertNotIn(b"absent", wire)
        self.assertNotIn(b"revision", wire)
        self.assertNotIn(b"reference", wire)
        changed = copy.deepcopy(cs)
        changed[0]["units"].reverse()
        self.assertNotEqual(plan["slots"], core.plan_case(changed, self.facts, relation())["slots"])

    def test_three_equal(self):
        r = self.judge([observed("x")] * 3)
        self.assertEqual(r["status"], "NO_CONFLICT_ON_SELECTED_FACTS")
        self.assertEqual(r["results"]["f"][0]["result"], "AGREE")

    def test_two_one_is_conflict_with_groups(self):
        r = self.judge([observed("x"), observed("x"), observed("y")])
        self.assertEqual(r["status"], "CONFLICT_CANDIDATE")
        self.assertEqual(r["results"]["f"][0]["groups"], [
            {"label": "x", "collections": ["A", "B"]}, {"label": "y", "collections": ["C"]}])

    def test_cover_no_unrequested_target_comparison(self):
        rel = relation("cover", [["A", "B"], ["A", "C"]])
        r = self.judge([observed("none"), observed("x"), observed("y")], rel)
        self.assertEqual(r["status"], "REVIEW")
        self.assertEqual([x["result"] for x in r["results"]["f"]], ["ONE_SIDED", "ONE_SIDED"])
        self.assertFalse(any(f["observed_conflict"] for f in r["findings"]))

    def test_cover_edges_have_local_validity(self):
        cs = collections("A", "B", "C", "D")
        rel = relation("cover", [["A", "B"], ["C", "D"]])
        r = self.judge([observed("x"), observed("x"), state("UNKNOWN"), observed("y")], rel, cs)
        self.assertEqual(r["status"], "UNKNOWN")
        self.assertEqual([x["result"] for x in r["results"]["f"]], ["AGREE", "UNKNOWN"])

    def test_partial_conflict_survives_every_unfinished_state(self):
        for pending, expected in [("NOT_RUN", "INCOMPLETE"), ("ERROR", "ERROR"),
                                  ("UNKNOWN", "UNKNOWN")]:
            with self.subTest(pending=pending):
                r = self.judge([observed("x"), observed("y"), state(pending)])
                self.assertEqual(r["status"], expected)
                self.assertTrue(r["findings"][0]["observed_conflict"])
                self.assertEqual(len(r["results"]["f"]), 1)

    def test_missing_extra_malformed_and_wrong_digest(self):
        base = answers(self.cs, [observed("x")] * 3)
        cases = []
        a = copy.deepcopy(base); del a["f"]["C"]; cases.append(a)
        a = copy.deepcopy(base); a["extra"] = {}; cases.append(a)
        a = copy.deepcopy(base); a["f"]["extra"] = observed("x"); cases.append(a)
        a = copy.deepcopy(base); a["f"]["C"]["raw"] = "outside_choices"; cases.append(a)
        a = copy.deepcopy(base); a["f"]["C"]["request_sha256"] = "stale"; cases.append(a)
        a = copy.deepcopy(base); a["f"]["C"] = None; cases.append(a)
        a = copy.deepcopy(base); a["f"] = []; cases.append(a)
        a = copy.deepcopy(base); a["f"]["C"] = {**state("ERROR"), "error": [],
            "request_sha256": base["f"]["C"]["request_sha256"]}; cases.append(a)
        a = copy.deepcopy(base); a["f"]["C"] = {**state("NOT_RUN"), "cause": [],
            "request_sha256": base["f"]["C"]["request_sha256"]}; cases.append(a)
        for a in cases + [None, []]:
            with self.subTest(answer=a):
                r = core.judge_case(self.cs, self.facts, relation(), a)
                self.assertEqual(r["status"], "ERROR")
                self.assertFalse(r["exact"])

    def test_valid_unknown_precedes_structure_failure(self):
        a = answers(self.cs, [state("UNKNOWN"), observed("x"), observed("x")])
        del a["f"]["C"]
        r = core.judge_case(self.cs, self.facts, relation(), a)
        self.assertEqual(r["status"], "UNKNOWN")
        self.assertFalse(r["exact"])

    def test_declared_not_run_is_not_missing(self):
        r = self.judge([observed("x"), observed("x"), state("NOT_RUN")])
        self.assertTrue(r["exact"])
        self.assertEqual(r["status"], "INCOMPLETE")

    def test_mixed_models_only_downgrade_evaluated(self):
        for labels in [[observed("x", "m"), observed("x", "n"), observed("x")],
                       [observed("x", "m"), observed("y", "n"), observed("x")],
                       [observed("x", "m"), observed("none", "n"), observed("x")]]:
            self.assertEqual(self.judge(labels)["status"], "INCOMPLETE")
        for state_name in ("UNKNOWN", "ERROR"):
            r = self.judge([observed("x", "m"), observed("x", "n"), state(state_name)])
            self.assertEqual(r["status"], state_name)

    def test_same_request_is_one_marked_observation(self):
        cs = collections("A", "B", "C")
        for c in cs:
            c["units"] = [unit("identical")]
        p = core.plan_case(cs, self.facts, relation())
        self.assertEqual(len(p["requests"]), 1)
        self.assertEqual(len(p["shared_observations"][0]["slots"]), 3)
        r = self.judge([observed("x")] * 3, cs=cs)
        self.assertEqual(r["status"], "NO_CONFLICT_ON_SELECTED_FACTS")
        self.assertEqual(r["shared_observations"], p["shared_observations"])

    def test_absentless_fact_and_slash_ids(self):
        facts = {"f/a": {**FACT, "absent": None}}
        cs = collections("a/b", "b/c", "c/d")
        r = self.judge([observed("none"), observed("x"), observed("x")], cs=cs, facts=facts)
        self.assertEqual(r["status"], "CONFLICT_CANDIDATE")
        self.assertEqual(list(r["results"]), ["f/a"])

    def test_invalid_cases_never_plan_or_judge_clear(self):
        cases = []
        def add(cs=None, facts=None, rel=None, ref=None):
            cases.append((self.cs if cs is None else cs, self.facts if facts is None else facts,
                          relation() if rel is None else rel, ref))
        add(cs=[]); add(cs=collections("A")); add(cs=collections("A", "A"))
        a = copy.deepcopy(self.cs); a[0]["id"] = ""; add(cs=a)
        a = copy.deepcopy(self.cs); a[0]["units"] = []; add(cs=a)
        a = copy.deepcopy(self.cs); a[0]["units"][0]["sha256"] = "wrong"; add(cs=a)
        a = copy.deepcopy(self.cs); a[0]["units"][0]["text"] = "\ud800"; add(cs=a)
        add(facts={}); add(facts={"": FACT}); add(facts={"f": {**FACT, "absent": "not_a_choice"}})
        add(facts={"f": {**FACT, "expected": "x"}})
        add(rel={"type": "unknown", "edges": []})
        add(rel=relation("equal", [["A", "B"]]))
        add(rel=relation("cover")); add(rel=relation("cover", [["A", "B"]]))
        add(rel=relation("cover", [["A", "A"], ["B", "C"]]))
        add(rel=relation("cover", [["A", "missing"], ["B", "C"]]))
        add(rel=relation("cover", [["A", "B"], ["B", "C"], ["A", "B"]]))
        add(ref="missing"); add(ref=[])
        for cs, facts, rel, ref in cases:
            with self.subTest(case=(cs, facts, rel, ref)):
                p = core.plan_case(cs, facts, rel, ref)
                self.assertEqual(p["status"], "INVALID")
                self.assertEqual(p["requests"], [])
                self.assertTrue(p["issues"])
                self.assertEqual(core.judge_case(cs, facts, rel, {}, ref)["status"], "INVALID")

    def test_canonical_rejects_float_keys_surrogate(self):
        bad_choices = [{**FACT["choices"], "x": {"v": float("nan")}},
                       {**FACT["choices"], "x": {"v": 1.0}},
                       {**FACT["choices"], 1: "invalid"},
                       {**FACT["choices"], "x": "\ud800"}]
        for choices in bad_choices:
            with self.assertRaises(core.InvalidCase):
                core.request_bytes({**FACT, "choices": choices}, "text")
        with self.assertRaises(core.InvalidCase):
            core.request_bytes(FACT, "\ud800")

    def test_case_status_empty_invalid_and_priority(self):
        for invalid in ({}, None, [], {"f": "bogus"}, {"f": []}):
            self.assertEqual(core.case_status(invalid), "ERROR")
        ordered = ["UNKNOWN", "ERROR", "NOT_RUN", "CONFLICT", "GAP", "AGREE"]
        expected = ["UNKNOWN", "ERROR", "INCOMPLETE", "CONFLICT_CANDIDATE", "REVIEW",
                    "NO_CONFLICT_ON_SELECTED_FACTS"]
        for i, result in enumerate(ordered):
            self.assertEqual(core.case_status(dict(enumerate(ordered[i:]))), expected[i])

    def test_full_two_collection_table(self):
        # Independent explicit state/absence table, no calls to the implementation
        # under comparison to create the expected cells.
        labels = ["x", "y", "none", "cannot_tell"]
        semantic = {
            "equal": [
                ["AGREE", "CONFLICT", "ONE_SIDED", "CANNOT_TELL"],
                ["CONFLICT", "AGREE", "ONE_SIDED", "CANNOT_TELL"],
                ["ONE_SIDED", "ONE_SIDED", "NEITHER", "CANNOT_TELL"],
                ["CANNOT_TELL"] * 4],
            "compatible": [
                ["AGREE", "CONFLICT", "COMPATIBLE", "CANNOT_TELL"],
                ["CONFLICT", "AGREE", "COMPATIBLE", "CANNOT_TELL"],
                ["COMPATIBLE", "COMPATIBLE", "COMPATIBLE", "CANNOT_TELL"],
                ["CANNOT_TELL"] * 4],
            "cover": [
                ["AGREE", "CONFLICT", "GAP", "CANNOT_TELL"],
                ["CONFLICT", "AGREE", "GAP", "CANNOT_TELL"],
                ["ONE_SIDED", "ONE_SIDED", "NEITHER", "CANNOT_TELL"],
                ["CANNOT_TELL"] * 4]}
        states = [state(s) for s in ("UNKNOWN", "ERROR", "NOT_RUN")] + [
            observed(label) for label in labels]
        cs = collections("A", "B")
        for kind, a, b in itertools.product(semantic, range(7), range(7)):
            rel = relation(kind, [["A", "B"]] if kind == "cover" else [])
            if min(a, b) < 3:
                expected = ["UNKNOWN", "ERROR", "NOT_RUN"][min(a, b)]
            else:
                expected = semantic[kind][a-3][b-3]
            with self.subTest(kind=kind, a=a, b=b):
                r = self.judge([states[a], states[b]], rel=rel, cs=cs)
                self.assertEqual(r["results"]["f"][0]["result"], expected)
                expected_status = {
                    "UNKNOWN": "UNKNOWN", "ERROR": "ERROR", "NOT_RUN": "INCOMPLETE",
                    "CONFLICT": "CONFLICT_CANDIDATE", "GAP": "REVIEW", "ONE_SIDED": "REVIEW",
                    "NEITHER": "REVIEW", "CANNOT_TELL": "REVIEW", "AGREE": "NO_CONFLICT_ON_SELECTED_FACTS",
                    "COMPATIBLE": "NO_CONFLICT_ON_SELECTED_FACTS"}[expected]
                self.assertEqual(r["status"], expected_status)

    def test_repeat_deterministic_and_no_mutation(self):
        a = answers(self.cs, [observed("x"), observed("y"), observed("none")])
        before = copy.deepcopy((self.cs, self.facts, a))
        first = core.judge_case(self.cs, self.facts, relation(), a)
        self.assertEqual(first, core.judge_case(self.cs, self.facts, relation(), a))
        self.assertEqual((self.cs, self.facts, a), before)

    def test_slot_admission_distinguishes_invalid_from_valid_error(self):
        a = answers(self.cs, [state("ERROR"), observed("x"), observed("x")])
        a["f"]["B"]["request_sha256"] = "wrong"
        r = core.judge_case(self.cs, self.facts, relation(), a)
        self.assertEqual(r["admission"]["f"], {"A": "valid", "B": "invalid", "C": "valid"})
        self.assertEqual(r["status"], "ERROR")
        a = answers(self.cs, [state("UNKNOWN"), observed("x"), observed("x")])
        del a["f"]["C"]
        r = core.judge_case(self.cs, self.facts, relation(), a)
        self.assertEqual(r["admission"]["f"], {"A": "valid", "B": "valid", "C": "missing"})
        self.assertEqual(r["status"], "UNKNOWN")

    def test_low_level_non_string_observed_labels_are_typed_invalid(self):
        for bad in [None, 3, [1], {"k": 1}]:
            for kind in ["equal", "compatible", "cover"]:
                with self.subTest(bad=bad, kind=kind):
                    with self.assertRaises(core.InvalidCase):
                        core.compare_answers(relation(kind, [["A", "B"]] if kind == "cover" else []),
                                             "none", {"A": observed(bad), "B": observed("x")})

    def test_metadata_judge_matches_all_relations_and_partial_answers(self):
        for kind in ["equal", "compatible", "cover"]:
            rel = relation(kind, [["A", "B"], ["A", "C"]] if kind == "cover" else [])
            shapes = [observed("x"), observed("y"), observed("none"),
                      observed("cannot_tell"), state("UNKNOWN"), state("ERROR"), state("NOT_RUN")]
            for labels in itertools.product(shapes, repeat=3):
                a = answers(self.cs, labels, self.facts, rel)
                p = core.plan_case(self.cs, self.facts, rel)
                self.assertEqual(core.judge_slots(p["slots"], self.facts, rel, a),
                                 core.judge_case(self.cs, self.facts, rel, a))

    def test_project_admission_metadata_only_demotes(self):
        p = core.plan_case(self.cs, self.facts, relation())
        a = answers(self.cs, [observed("x")] * 3)
        clear = core.judge_slots(p["slots"], self.facts, relation(), a)
        self.assertEqual(clear["status"], "NO_CONFLICT_ON_SELECTED_FACTS")
        self.assertEqual(core.judge_slots(p["slots"], self.facts, relation(), a, extra=True)["status"], "ERROR")
        del a["f"]["C"]
        r = core.judge_slots(p["slots"], self.facts, relation(), a, rejected=[("f", "C")])
        self.assertEqual(r["status"], "ERROR")
        self.assertEqual(r["admission"]["f"]["C"], "invalid")
        self.assertFalse(r["exact"])
        a["f"]["A"] = {**state("UNKNOWN"), "request_sha256": p["slots"]["f"]["A"]}
        self.assertEqual(core.judge_slots(p["slots"], self.facts, relation(), a,
                                         rejected=[("f", "C")], extra=True)["status"], "UNKNOWN")

    def test_metadata_plan_and_admission_structural_negatives(self):
        p = core.plan_case(self.cs, self.facts, relation())
        a = answers(self.cs, [observed("x")] * 3)
        bad_slots = [{}, [], {"extra": p["slots"]["f"]}, {"f": {}}, {"f": {"A": "0" * 64}}]
        for digest in [None, [], "stale", "A" * 64]:
            s = copy.deepcopy(p["slots"]); s["f"]["A"] = digest; bad_slots.append(s)
        for s in bad_slots:
            self.assertEqual(core.judge_slots(s, self.facts, relation(), a)["status"], "INVALID")
        two_facts = {"f": FACT, "g": FACT}
        two_slots = {"f": p["slots"]["f"], "g": dict(reversed(list(p["slots"]["f"].items())))}
        self.assertEqual(core.judge_slots(two_slots, two_facts, relation(), {})["status"], "INVALID")
        for rejected in [[("f", "C")], [("f", "missing")], [("extra", "C")], "f/C", [(None, [])]]:
            self.assertEqual(core.judge_slots(p["slots"], self.facts, relation(), a,
                                             rejected=rejected)["status"], "INVALID")
        del a["f"]["C"]
        self.assertEqual(core.judge_slots(p["slots"], self.facts, relation(), a,
                         rejected=[("f", "C"), ("f", "C")])["status"], "INVALID")
        for extra in [1, "true", None, []]:
            self.assertEqual(core.judge_slots(p["slots"], self.facts, relation(), a,
                                             extra=extra)["status"], "INVALID")
        invalid_relation = relation("cover", [["A", "B"]])
        self.assertEqual(core.judge_slots(p["slots"], self.facts, invalid_relation, a)["status"], "INVALID")



if __name__ == "__main__":
    unittest.main()
