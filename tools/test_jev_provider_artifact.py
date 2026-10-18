"""Archive/provenance tests; synthetic modules are not runtime evidence."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("artifact", pathlib.Path(__file__).with_name("jev-provider-artifact.py"))
artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifact)


class IndependentContracts(unittest.TestCase):
    def test_each_fixed_leaf_retains_its_positive_and_negative_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            for provider in artifact.SPECS:
                artifact.select_provider(provider)
                source = pathlib.Path(directory) / artifact.ENTRY
                source.write_text("\n".join(f"export function {name}() {{}}" for name in artifact.EXPORTS))
                self.assertEqual(artifact.selftest(source)["status"], "PASS")

    def test_paired_release_has_seven_assets_and_one_exact_common_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            release = root / "release"
            release.mkdir()
            sha, tree = "a" * 40, "b" * 40
            proof_path = release / "merged-pr-proof.json"
            proof = {"merge_sha": sha, "merge_tree": tree, "reviewed_tree": tree,
                     "reviewed_head": "c" * 40, "base": "proposals", "pr_number": 1,
                     "r_exact_head_verdict_ref": "fixture", "merged_at": "fixture"}
            proof_path.write_text(json.dumps(proof))
            for provider in ("jev", "typellm"):
                artifact.select_provider(provider)
                source = root / artifact.ENTRY
                source.write_text("\n".join(f"export function {name}() {{}}" for name in artifact.EXPORTS))
                artifact.assemble(source, release)
                # Assembly expands manifest/module locally; only release assets are public.
                (release / artifact.ENTRY).unlink()
                (release / "manifest.json").unlink()
                for name in artifact.INPUTS:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("synthetic source")
                artifact.provenance(release / artifact.ARCHIVE, proof_path, release / artifact.PROVENANCE,
                                    sha, tree, "fixture", "1", "1", root)
            self.assertEqual({p.name for p in release.iterdir()}, artifact.PAIRED_MEMBERS)
            for provider in ("jev", "typellm"):
                artifact.select_provider(provider)
                artifact.verify_release(release, sha, paired=True)
            original = {p.name: p.read_bytes() for p in release.iterdir()}
            for name, value in [("extra", b"unexpected"),
                                ("merged-pr-proof.json", json.dumps({**proof, "reviewed_head": "d" * 40}).encode()),
                                ("typellm-provider.zip", original["jev-provider.zip"])]:
                (release / name).write_bytes(value)
                with self.assertRaises(artifact.Refusal):
                    artifact.verify_release(release, sha, paired=True)
                if name in original:
                    (release / name).write_bytes(original[name])
                else:
                    (release / name).unlink()
            (release / "jev-provenance.json").unlink()
            with self.assertRaises(artifact.Refusal):
                artifact.verify_release(release, sha, paired=True)


if __name__ == "__main__":
    unittest.main()
