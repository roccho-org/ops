#!/usr/bin/env python3
"""Fixed legacy, Jev and TypeLLM ESM leaves; the existing publisher owns effects."""
import argparse
import hashlib
import json
import pathlib
import re
import tempfile
import zipfile

# A closed selection of existing/independent contracts, not a package registry.
SPECS = {
    "legacy": ("jev-provider/1", "named-choices-and-typed/1",
               ["JudgeProviderError", "TypedProviderError", "bindJev", "bindTypeLLM", "generateTyped", "judgeNamedChoices"],
               ("flake.lock", "packages/jev/src/core.mjs", "packages/jev/src/batch.mjs", "packages/jev/src/typellm.mjs", "packages/jev/default.nix", "tools/jev-provider-artifact.py"),
               "batch.mjs", "jev-provider.zip", "provenance.json", "jev-provider-provenance/1"),
    "jev": ("jev-provider/2", "named-questions/1",
            ["JevContractError", "JevError", "JudgeProviderError", "askJevChoice", "askJevNoul", "askJevQuestions", "askJevScore", "bindJev", "judgeNamedChoices"],
            ("flake.lock", "flake.nix", "packages/jev/src/core.mjs", "packages/jev/src/client.mjs", "packages/jev/src/batch.mjs", "packages/jev/src/worker.mjs", "packages/jev/default.nix", "tools/jev-provider-artifact.py"),
            "jev.mjs", "jev-provider.zip", "jev-provenance.json", "jev-provider-provenance/2"),
    "typellm": ("typellm-provider/1", "typed-completion/1",
                ["TypedProviderError", "bindTypeLLM", "generateTyped"],
                ("flake.lock", "flake.nix", "packages/typellm/src/typellm.mjs", "packages/typellm/default.nix", "tools/jev-provider-artifact.py"),
                "typellm.mjs", "typellm-provider.zip", "typellm-provenance.json", "typellm-provider-provenance/1"),
}
PAIRED_MEMBERS = {"jev-provider.zip", "jev-provider.zip.sha256", "jev-provenance.json",
                  "typellm-provider.zip", "typellm-provider.zip.sha256", "typellm-provenance.json", "merged-pr-proof.json"}


def select_provider(provider):
    # Selected once by the CLI. Imports retain the exact legacy verifier default.
    global SCHEMA, CONTRACT, EXPORTS, INPUTS, ENTRY, ARCHIVE, PROVENANCE, PROVENANCE_SCHEMA, MEMBERS
    SCHEMA, CONTRACT, EXPORTS, INPUTS, ENTRY, ARCHIVE, PROVENANCE, PROVENANCE_SCHEMA = SPECS[provider]
    MEMBERS = sorted([ENTRY, "manifest.json"])


select_provider("legacy")


class Refusal(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(ok, code):
    if not ok:
        raise Refusal(code)


def module_contract(data):
    try:
        source = data.decode("utf-8")
    except UnicodeError:
        raise Refusal("unsupported_contract")
    require(not re.search(r"\b(?:import|require|process|fs)\b|node:", source), "unsupported_contract")
    exports = sorted(re.findall(r"export\s+(?:async\s+)?(?:class|function)\s+([A-Za-z_][A-Za-z0-9_]*)", source))
    for block in re.findall(r"export\s*\{([^}]+)\}", source):
        exports.extend(item.strip().split(" as ")[-1] for item in block.split(",") if item.strip())
    require(sorted(exports) == EXPORTS, "unsupported_contract")


def manifest_for(data):
    module_contract(data)
    return {"schema": SCHEMA, "contract": CONTRACT, "entry": ENTRY,
            "exports": EXPORTS, "importClosure": [],
            "files": [{"path": ENTRY, "bytes": len(data), "sha256": digest(data)}]}


def zip_bytes(rows):
    import io
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(rows):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, rows[name])
    return out.getvalue()


def assemble(source, out):
    data = source.read_bytes()
    manifest = manifest_for(data)
    rows = {ENTRY: data, "manifest.json": (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()}
    payload = zip_bytes(rows)
    out.mkdir(parents=True, exist_ok=True)
    for name, value in rows.items():
        (out / name).write_bytes(value)
    (out / ARCHIVE).write_bytes(payload)
    (out / (ARCHIVE + ".sha256")).write_text(digest(payload) + "  " + ARCHIVE + "\n")
    return digest(payload)


def verify_bytes(payload, expected, contract=None):
    contract = CONTRACT if contract is None else contract
    import io
    require(re.fullmatch(r"[0-9a-f]{64}", expected or "") is not None and digest(payload) == expected, "artifact_identity_mismatch")
    require(contract == CONTRACT, "unsupported_contract")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
            require(ENTRY in names, "module_missing")
            require(sorted(names) == MEMBERS, "manifest_mismatch")
            require(all(info.file_size < 1_048_576 and not (info.external_attr >> 16) & 0o170000 == 0o120000
                        for info in archive.infolist()), "manifest_mismatch")
            data, raw = archive.read(ENTRY), archive.read("manifest.json")
            manifest = json.loads(raw)
            require(isinstance(manifest, dict) and manifest.get("schema") == SCHEMA and manifest.get("contract") == CONTRACT, "unsupported_contract")
            require(manifest == manifest_for(data), "manifest_mismatch")
            return data, manifest
    except Refusal:
        raise
    except Exception:
        raise Refusal("manifest_mismatch")


def proof_binding(proof, sha, tree):
    require(re.fullmatch(r"[0-9a-f]{40}", sha or "") is not None, "proof_invalid")
    require(re.fullmatch(r"[0-9a-f]{40}", tree or "") is not None and re.fullmatch(r"[0-9a-f]{40}", proof.get("reviewed_head", "")) is not None, "proof_invalid")
    require(proof.get("merge_sha") == sha and proof.get("base") == "proposals", "proof_invalid")
    require(proof.get("reviewed_tree") == proof.get("merge_tree") == tree, "proof_invalid")
    require(all(proof.get(k) for k in ("pr_number", "r_exact_head_verdict_ref", "merged_at", "reviewed_head", "reviewed_tree")), "proof_invalid")


def provenance(archive, proof_path, out, sha, tree, workflow_ref, run_id, run_attempt, root):
    payload = archive.read_bytes()
    _, manifest = verify_bytes(payload, digest(payload))
    # Bundled entry identity is distinct from its reviewed source inputs.
    proof = json.loads(proof_path.read_text())
    proof_binding(proof, sha, tree)
    # The generic helper owns head/tree/review admission; bind its exact bytes.
    result = {"schema": PROVENANCE_SCHEMA, "repository": "roccho-org/ops",
              "source": {"repository": "roccho-org/ops", "commit": sha, "tree": tree},
              "producer": {"workflow_ref": workflow_ref, "run_id": run_id, "run_attempt": run_attempt},
              "locator": f"https://github.com/roccho-org/ops/releases/download/jev-provider-{sha}/{ARCHIVE}",
              "inputDigests": {name: digest((root / name).read_bytes()) for name in INPUTS},
              "entrySha256": manifest["files"][0]["sha256"],
              "cross_host_bytes_reproducible": False,
              "contract": CONTRACT, "artifact": {"name": ARCHIVE, "bytes": len(payload), "sha256": digest(payload)},
              "manifestSha256": digest((json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()),
              "proof": {"name": "merged-pr-proof.json", "sha256": digest(proof_path.read_bytes())},
              "mergedProof": proof}
    out.write_text(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")


def verify_release(directory, sha, paired=False):
    require(not paired or SCHEMA != "jev-provider/1", "unsupported_contract")
    expected_files = PAIRED_MEMBERS if paired else {ARCHIVE, ARCHIVE + ".sha256", "merged-pr-proof.json", PROVENANCE}
    require({p.name for p in directory.iterdir()} == expected_files, "release_set_invalid")
    payload = (directory / ARCHIVE).read_bytes()
    expected = digest(payload)
    require((directory / (ARCHIVE + ".sha256")).read_text().split() == [expected, ARCHIVE], "artifact_identity_mismatch")
    _, manifest = verify_bytes(payload, expected)
    record = json.loads((directory / PROVENANCE).read_text())
    proof_path = directory / "merged-pr-proof.json"
    proof = json.loads(proof_path.read_text())
    require(record.get("schema") == PROVENANCE_SCHEMA and record.get("contract") == CONTRACT, "provenance_invalid")
    require(record.get("source", {}).get("repository") == "roccho-org/ops" and record["source"].get("commit") == sha, "provenance_invalid")
    proof_binding(proof, sha, record["source"].get("tree"))
    require(record.get("artifact") == {"name": ARCHIVE, "bytes": len(payload), "sha256": expected}, "provenance_invalid")
    require(record.get("proof") == {"name": "merged-pr-proof.json", "sha256": digest(proof_path.read_bytes())}
            and record.get("mergedProof") == proof, "proof_invalid")
    require(record.get("manifestSha256") == digest((json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()), "manifest_mismatch")
    require(record.get("locator") == f"https://github.com/roccho-org/ops/releases/download/jev-provider-{sha}/{ARCHIVE}"
            and record.get("cross_host_bytes_reproducible") is False, "provenance_invalid")
    require(set(record.get("inputDigests", {})) == set(INPUTS)
            and all(re.fullmatch(r"[0-9a-f]{64}", v) for v in record["inputDigests"].values()), "provenance_invalid")
    require(manifest["files"][0]["sha256"] == record.get("entrySha256"), "source_identity_mismatch")


def selftest(source):
    data = source.read_bytes()
    with tempfile.TemporaryDirectory(prefix="jev-provider-") as directory:
        out = pathlib.Path(directory)
        expected = assemble(source, out)
        payload = (out / ARCHIVE).read_bytes()
        verify_bytes(payload, expected)
        rows = {ENTRY: data, "manifest.json": (out / "manifest.json").read_bytes()}
        wrong_contract = json.loads(rows["manifest.json"])
        wrong_contract["contract"] = "other/1"
        cases = [
            ("artifact_identity_mismatch", payload, "0" * 64, CONTRACT),
            ("module_missing", zip_bytes({"manifest.json": rows["manifest.json"]}), None, CONTRACT),
            ("manifest_mismatch", zip_bytes({**rows, ENTRY: data + b"\n"}), None, CONTRACT),
            ("unsupported_contract", payload, expected, "other/1"),
            ("unsupported_contract", zip_bytes({**rows, "manifest.json": json.dumps(wrong_contract).encode()}), None, CONTRACT),
        ]
        for reason, value, wanted, contract in cases:
            try:
                verify_bytes(value, wanted or digest(value), contract)
            except Refusal as error:
                require(str(error) == reason, "selftest_failure")
            else:
                raise Refusal("selftest_failure")
        fixture = out / "source-fixture"
        for name, value in {name: (data if name.endswith(ENTRY) else b"source fixture") for name in INPUTS}.items():
            path = fixture / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        release = out / "release"
        release.mkdir()
        for name in (ARCHIVE, (ARCHIVE + ".sha256")):
            (release / name).write_bytes((out / name).read_bytes())
        sha, tree = "a" * 40, "b" * 40
        proof = {"merge_sha": sha, "merge_tree": tree, "reviewed_tree": tree, "reviewed_head": "c" * 40, "base": "proposals", "pr_number": 1, "r_exact_head_verdict_ref": "fixture", "merged_at": "fixture"}
        proof_path = release / "merged-pr-proof.json"
        proof_path.write_text(json.dumps(proof))
        provenance(release / ARCHIVE, proof_path, release / PROVENANCE, sha, tree, "fixture", "1", "1", fixture)
        verify_release(release, sha)
        original = {path.name: path.read_bytes() for path in release.iterdir()}
        record = json.loads(original[PROVENANCE])
        bad_source = {**record, "source": {**record["source"], "commit": "d" * 40}}
        bad_input = {**record, "entrySha256": "0" * 64}
        release_cases = [("release_set_invalid", "extra", b"extra"),
                         ("provenance_invalid", PROVENANCE, json.dumps(bad_source).encode()),
                         ("proof_invalid", "merged-pr-proof.json", json.dumps({**proof, "reviewed_head": "d" * 40}).encode()),
                         ("source_identity_mismatch", PROVENANCE, json.dumps(bad_input).encode())]
        for reason, name, value in release_cases:
            (release / name).write_bytes(value)
            try:
                verify_release(release, sha)
            except Refusal as error:
                require(str(error) == reason, "selftest_failure")
            else:
                raise Refusal("selftest_failure")
            if name not in original:
                (release / name).unlink()
            else:
                (release / name).write_bytes(original[name])
    return {"status": "PASS", "positive": 1, "negative": len(cases), "release": {"positive": 1, "negative": len(release_cases)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=SPECS, default="legacy")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("assemble")
    create.add_argument("--source", type=pathlib.Path, required=True)
    create.add_argument("--out", type=pathlib.Path, required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--archive", type=pathlib.Path, required=True)
    verify.add_argument("--sha256", required=True)
    verify.add_argument("--contract")
    verify.add_argument("--extract", type=pathlib.Path)
    check = sub.add_parser("selftest")
    check.add_argument("--source", type=pathlib.Path, required=True)
    prov = sub.add_parser("provenance")
    prov.add_argument("--archive", type=pathlib.Path, required=True)
    prov.add_argument("--proof", type=pathlib.Path, required=True)
    prov.add_argument("--out", type=pathlib.Path, required=True)
    for name in ("sha", "tree", "workflow-ref", "run-id", "run-attempt"):
        prov.add_argument("--" + name, required=True)
    prov.add_argument("--root", type=pathlib.Path, required=True)
    release = sub.add_parser("verify-release")
    release.add_argument("--dir", type=pathlib.Path, required=True)
    release.add_argument("--sha", required=True)
    release.add_argument("--paired", action="store_true")
    args = parser.parse_args()
    select_provider(args.provider)
    try:
        if args.command == "assemble":
            result = {"status": "PASS", "sha256": assemble(args.source, args.out)}
        elif args.command == "verify":
            data, manifest = verify_bytes(args.archive.read_bytes(), args.sha256, args.contract)
            if args.extract:
                args.extract.mkdir(parents=True, exist_ok=True)
                (args.extract / ENTRY).write_bytes(data)
                (args.extract / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
            result = {"status": "PASS", "contract": manifest["contract"], "entrySha256": digest(data)}
        elif args.command == "provenance":
            provenance(args.archive, args.proof, args.out, args.sha, args.tree,
                       args.workflow_ref, args.run_id, args.run_attempt, args.root)
            result = {"status": "PASS"}
        elif args.command == "verify-release":
            verify_release(args.dir, args.sha, args.paired)
            result = {"status": "PASS"}
        else:
            result = selftest(args.source)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        code = str(error) if isinstance(error, Refusal) else "artifact_invalid"
        print(json.dumps({"status": "RED", "code": code}, sort_keys=True))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
