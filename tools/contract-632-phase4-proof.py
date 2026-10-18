#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

HEX40 = re.compile(r"^[0-9a-f]{40}$")
OBLIGATION_ID = "ops.final-ci-migration-consumer.v1"
EPOCH = "contract-632-phase4-v1"
ROLE = "final-ci-receipt"
CLAIM_CEILING = "OPS_SELF_DIFF_CONSUMED_NOT_ORGANIZATION_ADMISSION"
COLLECTIONS = ("required", "provided", "observations", "receipts")


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(value) + b"\n")


def require(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def source(repository: str, revision: str, path: str, root: Path) -> dict[str, str]:
    require(HEX40.fullmatch(revision) is not None, "source-revision")
    target = root / path
    require(target.is_file() and not target.is_symlink(), f"source-missing:{path}")
    return {"repository": repository, "revision": revision, "path": path, "digest": file_digest(target)}


def check_token(value: str) -> str:
    token = value.replace(" / ", "/").replace(" ", "")
    require(token != "" and " " not in token, "check-token")
    return token


def semantic_contract(repository: str, role: str, branch: str, check: str, assertion_id: str, bundle_digest: str) -> dict[str, Any]:
    body = {
        "capability": "final-ci-migration-consumer",
        "consumer": repository,
        "stage": role,
        "target": {"provider": "github", "resource": check_token(check), "account": branch},
        "slot": assertion_id,
        "binding": bundle_digest,
        "profile": [{"role": ROLE, "operation": "check", "readback": True, "grade": "real"}],
    }
    return {"obligation_digest": digest(body), **body}


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def compare(comparator_path: Path, packet_path: Path, admission_path: Path, cwd: Path) -> tuple[int, dict[str, Any]]:
    process = run([sys.executable, str(comparator_path), "--input", str(packet_path), "--admission", str(admission_path)], cwd)
    require(process.stdout.strip() != "", "contract-diff-empty-output")
    return process.returncode, json.loads(process.stdout)


def inventory_item(export: dict[str, Any]) -> dict[str, Any]:
    rows = sorted(export["rows"], key=lambda row: row["id"])
    return {"source": export["source"], "rows_digest": digest(rows), "count": len(rows)}


def refresh_inventory(packet: dict[str, Any], admission: dict[str, Any]) -> None:
    admission["inventory"] = {name: inventory_item(packet[name]) for name in COLLECTIONS}


def build(args: argparse.Namespace) -> dict[str, Any]:
    governance = args.governance_source.resolve()
    ops = args.ops_source.resolve()
    observer_root = args.observer_root.resolve()
    out = args.out.resolve()
    require(not out.exists(), "output-exists")
    out.mkdir(parents=True)
    for value, label in ((args.governance_revision, "governance-revision"), (args.ops_candidate, "ops-candidate"), (args.observer_revision, "observer-revision")):
        require(HEX40.fullmatch(value) is not None, label)

    decision_path = Path("governance/accepted-final-ci-decision.v1.json")
    rollout_path = Path("governance/selected-final-ci-rollout.v1.json")
    claim_path = Path("governance/final-ci-claim.v1.json")
    receipt_producer_path = Path("tools/check-final-ci-consumer.py")

    decision = read_json(governance / decision_path)
    rollout = read_json(governance / rollout_path)
    claim = read_json(ops / claim_path)
    require(decision.get("kind") == "governance.acceptedFinalCiDecisionProjection.v1", "accepted-decision-kind")
    require(decision.get("stableRequiredCheck") == "gov-final-scope-purpose-join / gate", "accepted-final-check")
    selected = [row for row in rollout.get("repositories", []) if row.get("assertionId") == OBLIGATION_ID]
    require(len(selected) == 1, "selected-obligation")
    accepted = selected[0]
    require(accepted.get("repository") == "roccho-dev/ops", "accepted-repository")
    require(accepted.get("role") == "migration-consumer-known-mismatch", "accepted-role")
    require(accepted.get("knownMismatchRejected") is True, "accepted-mismatch-rejection")
    require(accepted.get("branch") == "proposals", "accepted-branch")
    require(accepted.get("claimPath") == claim_path.as_posix(), "accepted-claim-path")
    require(accepted.get("acceptedBundleDigest") == "sha256:" + decision["contractCanonicalDigest"], "accepted-bundle")

    require(claim.get("kind") == "governance.selectedConsumerClaim.v1", "claim-kind")
    require(claim.get("repository") == accepted["repository"], "claim-repository")
    require(claim.get("role") == accepted["role"], "claim-role")
    require(claim.get("assertion", {}).get("assertionId") == OBLIGATION_ID, "claim-obligation")
    require(claim.get("assertion", {}).get("acceptedBundleDigest") == accepted["acceptedBundleDigest"], "claim-bundle")
    require(claim.get("migration", {}).get("knownMismatchRejected") is True, "claim-known-mismatch")

    required_contract = semantic_contract(
        accepted["repository"], accepted["role"], accepted["branch"], decision["stableRequiredCheck"],
        accepted["assertionId"], accepted["acceptedBundleDigest"],
    )
    corrected = claim["migration"]["correctedState"]
    provided_contract = semantic_contract(
        claim["repository"], claim["role"], corrected["defaultBranch"], corrected["requiredCheck"],
        claim["assertion"]["assertionId"], claim["assertion"]["acceptedBundleDigest"],
    )
    require(required_contract == provided_contract, "semantic-claim-drift")

    required_source = source("roccho-dev/governance", args.governance_revision, rollout_path.as_posix(), governance)
    provided_source = source("roccho-org/ops", args.ops_candidate, claim_path.as_posix(), ops)
    observation_source = source(args.observer_repository, args.observer_revision, args.observer_path, observer_root)
    receipt_source = source("roccho-org/ops", args.ops_candidate, receipt_producer_path.as_posix(), ops)
    scope_authority = source("roccho-dev/governance", args.governance_revision, decision_path.as_posix(), governance)

    actual_receipt_path = out / "ops-final-ci-consumer-receipt.json"
    process = run([
        sys.executable, str(ops / receipt_producer_path), "check", "--claim", str(ops / claim_path),
        "--candidate-sha", args.ops_candidate, "--out", str(actual_receipt_path),
    ], ops)
    require(process.returncode == 0 and actual_receipt_path.is_file(), "receipt-producer-failed")
    actual_receipt = read_json(actual_receipt_path)
    require(actual_receipt.get("status") == "pass" and actual_receipt.get("candidateSha") == args.ops_candidate, "receipt-readback")
    require(actual_receipt.get("authority") is False, "receipt-authority")

    receipt_id = "receipt:" + args.ops_candidate
    receipt_row = {
        "id": receipt_id,
        "obligation_id": OBLIGATION_ID,
        "role": ROLE,
        "attempt": args.ops_candidate,
        "epoch": EPOCH,
        "source": provided_source,
        "target": provided_contract["target"],
        "slot": provided_contract["slot"],
        "operation": "check",
        "status": "PASS",
        "readback": "PASS",
        "grade": "real",
    }
    packet = {
        "kind": "contractDiffInput.v1",
        "required": {"source": required_source, "rows": [{"id": OBLIGATION_ID, "contract": required_contract}]},
        "provided": {"source": provided_source, "rows": [{"id": OBLIGATION_ID, "contract": provided_contract, "evidence_refs": {ROLE: receipt_id}}]},
        "observations": {"source": observation_source, "rows": [{"id": OBLIGATION_ID, "attempt": args.ops_candidate, "epoch": EPOCH, "refs": {ROLE: receipt_id}}]},
        "receipts": {"source": receipt_source, "rows": [receipt_row]},
    }
    admission = {
        "kind": "contractDiffAdmission.v1",
        "scope": {"id": "contract-632-phase4-ops-self", "authority": scope_authority, "epoch": EPOCH, "allow_empty": False, "grade": "source", "excluded_ids": []},
        "universe": [{"id": OBLIGATION_ID, "obligation_digest": required_contract["obligation_digest"], "profile": required_contract["profile"]}],
        "inventory": {},
        "evidence": {receipt_id: digest(receipt_row)},
    }
    refresh_inventory(packet, admission)
    packet_path = out / "contract-diff-input.json"
    admission_path = out / "contract-diff-admission.json"
    write_json(packet_path, packet)
    write_json(admission_path, admission)

    positive_code, positive = compare(args.contract_diff, packet_path, admission_path, ops)
    write_json(out / "contract-diff-positive.json", positive)
    require(positive_code == 0 and positive.get("status") == "CLOSED" and positive.get("findings") == [], "positive-not-closed:" + canonical(positive).decode("utf-8"))

    cases: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {}
    drift_packet = copy.deepcopy(packet)
    drift_packet["provided"]["rows"][0]["contract"]["target"]["resource"] = "repo-governance/proof"
    drift_admission = copy.deepcopy(admission)
    refresh_inventory(drift_packet, drift_admission)
    cases["contract-drift"] = (drift_packet, drift_admission, "OPEN")

    missing_packet = copy.deepcopy(packet)
    missing_packet["observations"]["rows"] = []
    missing_admission = copy.deepcopy(admission)
    refresh_inventory(missing_packet, missing_admission)
    cases["missing-observation"] = (missing_packet, missing_admission, "OPEN")

    stale_packet = copy.deepcopy(packet)
    stale_packet["observations"]["rows"][0]["attempt"] = "0" * 40
    stale_admission = copy.deepcopy(admission)
    refresh_inventory(stale_packet, stale_admission)
    cases["wrong-candidate"] = (stale_packet, stale_admission, "OPEN")
    cases["missing-admission"] = (packet, {}, "UNKNOWN")

    negative_results: dict[str, Any] = {}
    for name, (bad_packet, bad_admission, expected) in cases.items():
        bad_packet_path = out / f"negative-{name}-input.json"
        bad_admission_path = out / f"negative-{name}-admission.json"
        write_json(bad_packet_path, bad_packet)
        write_json(bad_admission_path, bad_admission)
        code, result = compare(args.contract_diff, bad_packet_path, bad_admission_path, ops)
        write_json(out / f"contract-diff-negative-{name}.json", result)
        require(result.get("status") == expected and code != 0, f"negative-{name}:" + canonical(result).decode("utf-8"))
        negative_results[name] = result

    run_scope = {
        "kind": "ops.contract632.phase4RunScope.v1",
        "authority": False,
        "scopeId": "contract-632-phase4-ops-self",
        "selectedObligations": [OBLIGATION_ID],
        "opsCandidate": args.ops_candidate,
        "governanceRevision": args.governance_revision,
        "acceptedRequirementDigest": required_contract["obligation_digest"],
        "requiredEvidenceTypes": [ROLE],
    }
    write_json(out / "run-scope.json", run_scope)
    evidence = {
        "kind": "ops.contract632.phase4Evidence.v1",
        "status": "PASS",
        "authority": False,
        "adoption": False,
        "releasePublished": False,
        "claimCeiling": CLAIM_CEILING,
        "scope": run_scope,
        "acceptedRequirement": {"source": required_source, "decisionSource": scope_authority, "obligationId": OBLIGATION_ID, "contract": required_contract},
        "provider": {"source": provided_source, "claimDigest": file_digest(ops / claim_path)},
        "observation": {"source": observation_source, "candidate": args.ops_candidate},
        "receipt": {"source": receipt_source, "actualReceiptDigest": file_digest(actual_receipt_path), "normalizedReceiptDigest": digest(receipt_row)},
        "comparator": {"source": source("roccho-org/ops", args.ops_candidate, "packages/contract-diff/core.py", ops), "positive": positive, "negative": negative_results},
        "remaining": 0,
    }
    write_json(out / "phase4-evidence.json", evidence)
    manifest = [
        {"path": path.relative_to(out).as_posix(), "sha256": file_digest(path)}
        for path in sorted(p for p in out.rglob("*") if p.is_file() and p.name != "bundle-manifest.json")
    ]
    write_json(out / "bundle-manifest.json", manifest)
    return evidence


def verify(bundle: Path) -> dict[str, Any]:
    root = bundle.resolve()
    evidence = read_json(root / "phase4-evidence.json")
    manifest = read_json(root / "bundle-manifest.json")
    require(evidence.get("kind") == "ops.contract632.phase4Evidence.v1", "evidence-kind")
    require(evidence.get("status") == "PASS", "evidence-status")
    require(evidence.get("authority") is False and evidence.get("adoption") is False and evidence.get("releasePublished") is False, "authority-boundary")
    require(evidence.get("claimCeiling") == CLAIM_CEILING and evidence.get("remaining") == 0, "claim-ceiling")
    require(evidence["comparator"]["positive"].get("status") == "CLOSED", "positive-status")
    expected_negatives = {"contract-drift": "OPEN", "missing-observation": "OPEN", "wrong-candidate": "OPEN", "missing-admission": "UNKNOWN"}
    require({key: value.get("status") for key, value in evidence["comparator"]["negative"].items()} == expected_negatives, "negative-status")
    actual = []
    for item in manifest:
        path = root / item["path"]
        require(path.is_file() and file_digest(path) == item["sha256"], f"manifest:{item['path']}")
        actual.append(item["path"])
    expected = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file() and path.name != "bundle-manifest.json")
    require(sorted(actual) == expected, "manifest-coverage")
    return {
        "kind": "ops.contract632.phase4Verification.v1",
        "status": "PASS",
        "authority": False,
        "adoption": False,
        "remaining": 0,
        "manifestCount": len(manifest),
        "claimCeiling": CLAIM_CEILING,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    build_p = sub.add_parser("build")
    build_p.add_argument("--governance-source", type=Path, required=True)
    build_p.add_argument("--governance-revision", required=True)
    build_p.add_argument("--ops-source", type=Path, required=True)
    build_p.add_argument("--ops-candidate", required=True)
    build_p.add_argument("--observer-root", type=Path, required=True)
    build_p.add_argument("--observer-repository", required=True)
    build_p.add_argument("--observer-revision", required=True)
    build_p.add_argument("--observer-path", required=True)
    build_p.add_argument("--contract-diff", type=Path, required=True)
    build_p.add_argument("--out", type=Path, required=True)
    verify_p = sub.add_parser("verify")
    verify_p.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    value = build(args) if args.command == "build" else verify(args.bundle)
    print(canonical(value).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
