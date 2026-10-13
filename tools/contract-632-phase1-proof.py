#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any

DESIGN_VERSION = "CONTRACT_W_632_CLOSURE_DESIGN_V3"
CLAIM_CEILING = "BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION"
EXPECTED_BLOBS = {
    "ops/packages/cue-append-contract-core/cmd/contractcheck/main.go": "8f7d127f0eaf618d6535c72452f2c1c4e74d0ef3",
    "ops/packages/cue-append-contract-core/internal/core/appendonly/appendonly.go": "0ae4e5d26b1751f36a15dd6213f1ff0b407c7a11",
    "governance/tools/contract-modeling/bin/contract_modeling.py": "655fcade7903942922e076a809020fc48be64f22",
    "governance/tools/contract-modeling/bin/engine.py": "8a2c445494aa9885438a0e9fb2b09e118a57e48a",
    "governance/tools/contract-modeling/bin/epoch.py": "7cd58192050b7e4942cfbe2a85842ea9463c2efe",
    "governance/tools/contract-modeling/bin/evaluate_exact.py": "e664e95a118114b8d4640c5421bca4d44f9a0ee4",
    "governance/tools/contract-modeling/schema/envelope.v1.schema.json": "590670cc9e87fdf254467785888e46bed17adc4d",
    "governance/tools/contract-modeling/schema/package-contract.v1.schema.json": "37c7228c0578c8a331b063759731d6050ea0ac18",
    "governance/tools/contract-modeling/schema/data-model.v1.schema.json": "7750780344df7daa792ebbf86e80f9d8ab72848b",
    "governance/tools/contract-modeling/schema/receipt.v1.schema.json": "f0cec3c4029972a5e4229821ab1d97b522b17f0e",
    "governance/tools/contract-modeling/fixtures/accepted-policy.json": "478f3e6dffeb603fccf239c183bd1308f068c777",
    "governance/tools/contract-modeling/fixtures/previous-current.json": "839242e610f04f43747a2af3b48a39a42dff347e",
    "governance/tools/contract-modeling/fixtures/model-only.json": "046984182034f0c3b3cb56a3322508c5ca64e25f",
    "governance/tools/contract-modeling/fixtures/generate.py": "0022ce13de37ac149ceaffe93f6c4b5c98ddb096",
    "governance/tools/contract-modeling/fixtures/generate_legacy.py": "18f30b9a62c4e734c3ac8cf8111e4572392607c6",
}


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    return sha256_bytes(path.read_bytes())


def git_blob_sha(path: pathlib.Path) -> str:
    value = path.read_bytes()
    return hashlib.sha1(f"blob {len(value)}\0".encode() + value).hexdigest()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.write_text(canonical(value) + "\n", encoding="utf-8")


def write_jsonl(path: pathlib.Path, values: list[dict[str, Any]]) -> None:
    path.write_text("".join(canonical(value) + "\n" for value in values), encoding="utf-8")


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run(command: list[str], cwd: pathlib.Path, *, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != expected:
        raise RuntimeError(
            f"command failed rc={result.returncode} expected={expected}: {' '.join(command)}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def selected_packet(packet: dict[str, Any], label: str) -> dict[str, Any]:
    current = packet.get("current_state")
    if not isinstance(current, list) or not current:
        raise RuntimeError(f"{label}: current_state is empty")
    return {
        "kind": "ops.packageContractBridge.compilerPacket.v1",
        "label": label,
        "authority": False,
        "claimCeiling": CLAIM_CEILING,
        "semanticDigest": packet["semantic_digest"],
        "currentDigest": packet["current_digest"],
        "replayDigest": packet["replay_digest"],
        "replayEqual": packet["replay_equal"],
        "currentState": current,
        "decisionCount": len(packet.get("decisions", [])),
        "promotionCount": len(packet.get("promotions", [])),
    }


def decision_for(packet: dict[str, Any], subject: str) -> str:
    rows = [row for row in packet["current_state"] if row.get("subject_key") == subject]
    if len(rows) != 1:
        raise RuntimeError(f"expected one current row for {subject}, got {len(rows)}")
    return str(rows[0]["decision"])


def failure(engine: Any, rows: list[dict[str, Any]], policy: dict[str, Any], label: str) -> dict[str, str]:
    try:
        engine.validate_and_reduce(rows, policy)
    except Exception as exc:
        return {"case": label, "status": "REJECTED", "error": str(exc)}
    raise RuntimeError(f"destructive case unexpectedly passed: {label}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--governance-source", type=pathlib.Path, required=True)
    parser.add_argument("--governance-revision", required=True)
    parser.add_argument("--ops-source", type=pathlib.Path, required=True)
    parser.add_argument("--ops-candidate-sha", required=True)
    parser.add_argument("--contractcheck", type=pathlib.Path, required=True)
    parser.add_argument("--bridge", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    work = out / "work"
    governance = work / "governance"
    shutil.copytree(args.governance_source.resolve(), governance)
    fixtures = governance / "tools/contract-modeling/fixtures"
    run([sys.executable, "generate.py"], fixtures)

    policy = json.loads((fixtures / "accepted-policy.json").read_text(encoding="utf-8"))
    rows = [json.loads(line) for line in (fixtures / "claims.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    original = next(row for row in rows if row["id"] == "request:02-semantic")

    v2 = copy.deepcopy(original)
    v2["id"] = "request:02-semantic:v2"
    v2["supersedes"] = [original["id"]]
    v2["payload"]["terms"] = ["customer-alias"]

    v3 = copy.deepcopy(v2)
    v3["id"] = "request:02-semantic:v3"
    v3["supersedes"] = [v2["id"]]
    v3["payload"]["requested_projection"] = "customer-alias-v1"
    v3["payload"]["required_queries"] = []

    l0, l1, l2 = rows, [*rows, v2], [*rows, v2, v3]
    for name, values in (("L0", l0), ("L1", l1), ("L2", l2)):
        write_jsonl(out / f"{name}.jsonl", values)

    append_results: dict[str, Any] = {}
    for name, base, candidate in (("l0-l1", "L0.jsonl", "L1.jsonl"), ("l1-l2", "L1.jsonl", "L2.jsonl")):
        result = run([str(args.contractcheck), "append-only-check", "--base", base, "--candidate", candidate], out)
        parsed = json.loads(result.stdout)
        write_json(out / f"append-{name}.json", parsed)
        append_results[name] = parsed

    bin_root = governance / "tools/contract-modeling/bin"
    epoch = load_module("contract_w_phase1_epoch", bin_root / "epoch.py")
    packets: dict[str, dict[str, Any]] = {}
    for label, ledger in (("AC0", out / "L0.jsonl"), ("AC1", out / "L1.jsonl"), ("BC1", out / "L2.jsonl")):
        packet = epoch.evaluate(
            args.governance_revision,
            governance,
            claims_path=ledger,
            require_duckdb=False,
        )
        packets[label] = packet
        write_json(out / f"{label}.compiler-packet.json", selected_packet(packet, label))

    before = decision_for(packets["AC0"], original["subject_key"])
    after = decision_for(packets["AC1"], original["subject_key"])
    candidate = decision_for(packets["BC1"], original["subject_key"])
    if before == after or after == candidate:
        raise RuntimeError(f"expected distinct decisions, got {before}/{after}/{candidate}")

    engine = load_module("contract_w_phase1_engine", bin_root / "engine.py")
    destructive: list[dict[str, str]] = []

    missing_parent = copy.deepcopy(original)
    missing_parent["id"] = "request:02-semantic:missing-parent"
    missing_parent["supersedes"] = ["request:not-found"]
    destructive.append(failure(engine, [*rows, missing_parent], policy, "missing-parent"))

    cross_subject = copy.deepcopy(original)
    cross_subject["id"] = "request:02-semantic:cross-subject"
    cross_subject["subject_key"] = "request:cross-subject"
    cross_subject["supersedes"] = [original["id"]]
    destructive.append(failure(engine, [*rows, cross_subject], policy, "cross-subject"))

    cycle_a = copy.deepcopy(original)
    cycle_a["id"] = "request:02-semantic:cycle-a"
    cycle_a["supersedes"] = ["request:02-semantic:cycle-b"]
    cycle_b = copy.deepcopy(original)
    cycle_b["id"] = "request:02-semantic:cycle-b"
    cycle_b["supersedes"] = [cycle_a["id"]]
    destructive.append(failure(engine, [*rows, cycle_a, cycle_b], policy, "supersession-cycle"))

    duplicate_active = copy.deepcopy(original)
    duplicate_active["id"] = "request:02-semantic:duplicate-active"
    duplicate_active["supersedes"] = []
    destructive.append(failure(engine, [*rows, duplicate_active], policy, "duplicate-active"))
    write_json(out / "destructive-results.json", {"kind": "ops.packageContractBridge.phase1Destructive.v1", "results": destructive})

    source_paths: list[tuple[str, pathlib.Path]] = []
    for key in EXPECTED_BLOBS:
        owner, relative = key.split("/", 1)
        root = args.ops_source.resolve() if owner == "ops" else governance
        source_paths.append((key, root / relative))
    source_results = []
    for key, file in source_paths:
        actual = git_blob_sha(file)
        expected = EXPECTED_BLOBS[key]
        if actual != expected:
            raise RuntimeError(f"accepted source changed: {key}: {actual} != {expected}")
        source_results.append({"path": key, "gitBlobSha": actual})
    write_json(out / "source-identities.json", {"kind": "ops.packageContractBridge.sourceIdentities.v1", "sources": source_results})

    compiler_files = [file for key, file in source_paths if key.startswith("governance/")]
    compiler_digest = sha256_bytes("\n".join(f"{file.relative_to(governance).as_posix()}:{sha256_file(file)}" for file in sorted(compiler_files)).encode())
    governance_tree_digest = sha256_bytes("\n".join(f"{key}:{EXPECTED_BLOBS[key]}" for key in sorted(EXPECTED_BLOBS) if key.startswith("governance/")).encode())

    manifests = {
        "AC0": {"ledger": "L0.jsonl", "ledgerSha256": sha256_file(out / "L0.jsonl"), "selected": True, "organizationAdmissionChanged": False},
        "AC1": {"ledger": "L1.jsonl", "ledgerSha256": sha256_file(out / "L1.jsonl"), "selected": True, "organizationAdmissionChanged": False},
        "BC1": {"ledger": "L2.jsonl", "ledgerSha256": sha256_file(out / "L2.jsonl"), "selected": False, "organizationAdmissionChanged": False},
    }
    write_json(out / "input-manifests.json", {"kind": "ops.packageContractBridge.phase1Inputs.v1", "claimCeiling": CLAIM_CEILING, "manifests": manifests})

    artifacts = []
    names = [
        "L0.jsonl", "L1.jsonl", "L2.jsonl",
        "append-l0-l1.json", "append-l1-l2.json",
        "AC0.compiler-packet.json", "AC1.compiler-packet.json", "BC1.compiler-packet.json",
        "destructive-results.json", "source-identities.json", "input-manifests.json",
    ]
    for name in names:
        artifacts.append({"path": name, "sha256": sha256_file(out / name)})

    receipt = {
        "kind": "ops.packageContractBridge.phase1Receipt.v1",
        "status": "PASS",
        "authority": False,
        "claimCeiling": CLAIM_CEILING,
        "designVersion": DESIGN_VERSION,
        "phase": 1,
        "phaseClosed": False,
        "source": {
            "opsCandidateSha": args.ops_candidate_sha,
            "governanceRevision": args.governance_revision,
            "governanceTreeDigest": governance_tree_digest,
        },
        "acceptedDecision": {
            "decisionId": policy["decision"]["decision_id"],
            "decisionDigest": policy["decision"]["decision_digest"],
            "acceptedMerge": policy["decision"]["accepted_merge"],
            "source": policy["decision"]["source"],
        },
        "compiler": {
            "version": policy["compiler"]["version"],
            "sourceDigest": compiler_digest,
        },
        "append": {
            "l0ToL1": "PASS" if append_results["l0-l1"]["status"] == "pass" else "FAIL",
            "l1ToL2": "PASS" if append_results["l1-l2"]["status"] == "pass" else "FAIL",
        },
        "supersession": {
            "subjectKey": original["subject_key"],
            "beforeRowId": original["id"],
            "afterRowId": v2["id"],
            "beforeDecision": before,
            "afterDecision": after,
            "beforeCurrentDigest": packets["AC0"]["current_digest"],
            "afterCurrentDigest": packets["AC1"]["current_digest"],
        },
        "candidateIsolation": {
            "candidateRowId": v3["id"],
            "candidateDecision": candidate,
            "candidateAdmitted": False,
            "acceptedCurrentDigest": packets["AC1"]["current_digest"],
            "candidateCurrentDigest": packets["BC1"]["current_digest"],
            "acceptedCurrentUnchanged": True,
        },
        "destructive": {"total": len(destructive), "rejected": sum(row["status"] == "REJECTED" for row in destructive)},
        "commonCode": {"changed": False, "verifiedSourceCount": len(source_results)},
        "artifacts": artifacts,
        "semantic": {
            "nonEmpty": all(bool(packets[name]["current_state"]) for name in packets),
            "replayEqual": all(packets[name]["replay_equal"] for name in packets),
            "ac0SemanticDigest": packets["AC0"]["semantic_digest"],
            "ac1SemanticDigest": packets["AC1"]["semantic_digest"],
            "bc1SemanticDigest": packets["BC1"]["semantic_digest"],
        },
    }
    write_json(out / "phase1-receipt.json", receipt)

    verified = run([str(args.bridge), "verify-phase1", str(out)], out)
    (out / "bridge-verification.json").write_text(verified.stdout, encoding="utf-8")
    shutil.rmtree(work)
    print(canonical({"status": "PASS", "phase": 1, "receipt": str(out / "phase1-receipt.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
