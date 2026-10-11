import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("prove.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def rows(models=("a", "b", "b")):
    result = [{"type": "session", "version": 3, "id": "s", "cwd": "/proof"}]
    parent = None
    for i, model in enumerate(models):
        u, a = f"u{i}", f"a{i}"
        result += [{"type": "message", "id": u, "parentId": parent,
                    "message": {"role": "user", "content": "marker" if i == 0 else "recall"}},
                   {"type": "message", "id": a, "parentId": u,
                    "message": {"role": "assistant", "provider": "opencode-go", "model": model,
                                "stopReason": "stop", "content": [{"type": "text", "text": "marker"}]}}]
        parent = a
    return result


def encoded(value):
    return b"".join(json.dumps(row).encode() + b"\n" for row in value)


class ProbeTests(unittest.TestCase):
    def inspect(self, value, previous=b""):
        return p.inspect_session(encoded(value), previous, "s", "/proof", "b", "marker", 3)

    def refuse(self, mutate, code):
        value = rows()
        mutate(value)
        with self.assertRaisesRegex(p.Refused, code):
            self.inspect(value)

    def test_positive_appended_history(self):
        self.assertEqual(self.inspect(rows(), encoded(rows()[:5]))["assistant_count"], 3)

    def test_wrong_session(self):
        self.refuse(lambda r: r[0].update(id="other"), "SESSION_IDENTITY")

    def test_wrong_cwd(self):
        self.refuse(lambda r: r[0].update(cwd="/other"), "SESSION_IDENTITY")

    def test_wrong_provider(self):
        self.refuse(lambda r: r[-1]["message"].update(provider="opencode"), "PROVIDER_OR_MODEL")

    def test_wrong_model(self):
        self.refuse(lambda r: r[-1]["message"].update(model="cheap-fallback"), "PROVIDER_OR_MODEL")

    def test_failed_assistant(self):
        self.refuse(lambda r: r[-1]["message"].update(stopReason="error"), "ASSISTANT_NOT_SUCCESS")

    def test_wrong_recall(self):
        self.refuse(lambda r: r[-1]["message"]["content"][0].update(text="forgot"), "HISTORY_RECALL")

    def test_tool_call(self):
        self.refuse(lambda r: r[-1]["message"]["content"].append({"type": "toolCall"}), "UNEXPECTED_TOOL")

    def test_duplicate_id(self):
        self.refuse(lambda r: r[-1].update(id="u0"), "ENTRY_ID")

    def test_dangling_parent(self):
        self.refuse(lambda r: r[-1].update(parentId="missing"), "ENTRY_PARENT")

    def test_branch_skips_history(self):
        self.refuse(lambda r: r[-1].update(parentId="u0"), "HISTORY_BRANCH")

    def test_rewritten_history(self):
        with self.assertRaisesRegex(p.Refused, "HISTORY_REWRITTEN"):
            self.inspect(rows(), encoded(rows(("a", "a"))))

    def test_no_new_assistant(self):
        with self.assertRaisesRegex(p.Refused, "ASSISTANT_COUNT"):
            self.inspect(rows(("a", "b")))

    def test_json_and_framing(self):
        for raw in (b"not-json\n", b"[]\n", encoded(rows()).rstrip()):
            with self.assertRaises(p.Refused):
                p.inspect_session(raw, b"", "s", "/proof", "b", "marker", 3)

    def args(self, **overrides):
        result = dict(source_sha="a" * 40, envs_sha="b" * 40, model_a="a", model_b="b",
                      timeout=2, run=False, pi="/missing/pi", workspace="/missing/fresh", pi_sha256=None)
        result.update(overrides)
        return argparse.Namespace(**result)

    def test_plan_never_invokes(self):
        with mock.patch.object(p, "invoke") as call:
            self.assertEqual(p.probe(self.args())["provider_use"], "NOT_RUN")
            call.assert_not_called()

    def test_model_scope(self):
        for model in ("opencode/model", "a*", "--model", ""):
            with self.assertRaisesRegex(p.Refused, "EXACT_MODEL_IDS"):
                p.probe(self.args(model_b=model))

    def test_same_model_refused(self):
        with self.assertRaisesRegex(p.Refused, "TWO_MODELS_REQUIRED"):
            p.probe(self.args(model_b="a"))

    def test_bad_source_refused(self):
        with self.assertRaisesRegex(p.Refused, "SOURCE_SHA"):
            p.probe(self.args(source_sha="proposals"))

    def test_public_ci_refused(self):
        with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}):
            with self.assertRaisesRegex(p.Refused, "NO_LIVE_IN_CI"):
                p.probe(self.args(run=True))

    def test_command_is_noninteractive_and_explicit(self):
        argv = p.command(Path("/pi"), "a" * 40, "model", "session", Path("/sessions"), "query")
        self.assertEqual(argv[argv.index("--mode") + 1], "json")
        self.assertEqual(argv[argv.index("--provider") + 1], "opencode-go")
        self.assertIn("--no-tools", argv)
        self.assertNotIn("--api-key", argv)
        self.assertEqual(argv[-2:], ["--", "query"])


if __name__ == "__main__":
    unittest.main()
