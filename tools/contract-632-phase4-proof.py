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
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
OBLIGATION_ID = "ops.final-ci-migration-consumer.v1"
EPOCH = "contract-632-phase4-v1"
ROLE = "final-ci-receipt"
CLAIM_CEILING = "OPS_SELF_DIFF_CONSUMED_NOT_ORGANIZATION_ADMISSION"


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


def semantic_contract(repository: str, role: str, branch: str, check: str, assertion_id: str, bundle_digest: str) -> dict[str, Any]:
    body = {
        "capability": "final-ci-migration-consumer",
        "consumer": repository,
        "stage": role,
        "target": {"provider": "github", "resource": check, "account": branch},
        "slot": assertion_id,
        "binding": bundle_digest,
        "profile": [{"role": ROLE, "operation": "check", "readback": True, "grade": "real"}],
    }
    return {"obligation_digest": digest(body), **body}


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def comparator(comparator_path: Path, packet_path: Path, admission_path: Path, cwd: Path) -> tuple[int, dict[str, Any]]:
    process = run([sys.executable, str(comparator_path), "--input", str(packet_path), "--admission", str(admission_path)], cwd)
    require(process.stdout.strip() != "", "contract-diff-empty-output")
    value = json.loads(process.stdout)
    return process.returncode, value


def inventory_item(export: dict[str, Any]) -> dict[str, Any]:
    rows = sorted(export["rows"], key=lambda row: row["id"])
    return {"source": export["source"], "rows_digest": digest(rows), "count": len(rows)}


def build(args: argparse.Namespace) -> dict[str, Any]:
    governance = args.governance_source.resolve()
    ops = args.ops_source.resolve()
    out = args.out.resolve()
    require(not out.exists(), "output-exists")
    out.mkdir(parents=True)
    require(HEX40.fullmatch(args.governance_revision) is not None, "governance-revision")
    require(HEX40.fullmatch(args.ops_candidate) is not None, "ops-candidate")
    require(HEX40.fullmatch(args.observer_revision) is not None, "observer-revision")

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
    require(required_contract["obligation_digest"] == provided_contract["obligation_digest"], "semantic-claim-drift")

    required_source = source("roccho-dev/governance", args.governance_revision, rollout_path.as_posix(), governance)
    provided_source = source("roccho-org/ops", args.ops_candidate, claim_path.as_posix(), ops)
    observation_source = source(args.observer_repository, args.observer_revision, args.observer_path, args.observer_root.resolve())
    receipt_source = source("roccho-org/ops", args.ops_candidate, receipt_producer_path.as_posix(), ops)

    receipt_file = out / "ops-final-ci-consumer-receipt.json"
    receipt_process = run([
        sys.executable, str(ops / receipt_producer_path), "check", "--claim", str(ops / claim_path),
        "--candidate-sha", args.ops_candidate, "--out", str(receipt_file),
    ], ops)
    require(receipt_process.returncode == 0 and receipt_file.is_file(), "receipt-producer-failed")
    actual_receipt = read_json(receipt_file)
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
    required_export = {"source": required_source, "rows": [{"id": OBLIGATION_ID, "contract": required_contract}]}
    provided_export = {"source": provided_source, "rows": [{"id": OBLIGATION_ID, "contract": provided_contract, "evidence_refs": {ROLE: receipt_id}}]}
    observation_export = {"source": observation_source, "rows": [{"id": OBLIGATION_ID, "attempt": args.ops_candidate, "epoch": EPOCH, "refs": {ROLE: receipt_id}}]}
    receipt_export = {"source": receipt_source, "rows": [receipt_row]}
    packet = {"kind": "contractDiffInput.v1", "required": required_export, "provided": provided_export, "observations": observation_export, "receipts": receipt_export}
    scope_authority = source("roccho-dev/governance", args.governance_revision, decision_path.as_posix(), governance)
    admission = {
        "kind": "contractDiffAdmission.v1",
        "scope": {"id": "contract-632-phase4-ops-self", "authority": scope_authority, "epoch": EPOCH, "allow_empty": False, "grade": "source", "excluded_ids": []},
        "universe": [{"id": OBLIGATION_ID, "obligation_digest": required_contract["obligation_digest"], "profile": required_contract["profile"]}],
        "inventory": {name: inventory_item(packet[name]) for name in ("required", "provided", "observations", "receipts")},
        "evidence": {receipt_id: digest(receipt_row)},
    }
    write_json(out / "contract-diff-input.json", packet)
    write_json(out / "contract-diff-admission.json", admission)

    positive_code, positive = comparator(args.contract_diff, out / "contract-diff-input.json", out / "contract-diff-admission.json", ops)
    require(positive_code == 0 and positive.get("status") == "CLOSED" and positive.get("findings") == [], "positive-not-closed")
    write_json(out / "contract-diff-positive.json", positive)

    negative_results: dict[str, Any] = {}
    cases: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {}
    drift_packet = copy.deepcopy(packet)
    drift_packet["provided"]["rows"][0]["contract"]["target"]["resource"] = "repo-governance / proof"
    drift_admission = copy.deepcopy(admission)
    drift_admission["inventory"]["provided"] = inventory_item(drift_packet["provided"])
    cases["contract-drift"] = (drift_packet, drift_admission, "OPEN")
    missing_packet = copy.deepcopy(packet)
    missing_packet["observations"]["rows"] = []
    missing_admission = copy.deepcopy(admission)
    missing_admission["inventory"]["observations"] = inventory_item(missing_packet["observations"])
    cases["missing-observation"] = (missing_packet, missing_admission, "OPEN")
    stale_packet = copy.deepcopy(packet)
    stale_packet["observations"]["rows"][0]["attempt"] = "0" * 40
    stale_admission = copy.deepcopy(admission)
    stale_admission["inventory"]["observations"] = inventory_item(stale_packet["observations"])
    cases["wrong-candidate"] = (stale_packet, stale_admission, "OPEN")
    cases["missing-admission"] = (packet, {}, "UNKNOWN")
    for name, (bad_packet, bad_admission, expected) in cases.items():
        p = out / f"negative-{name}-input.json"
        a = out / f"negative-{name}-admission.json"
        write_json(p, bad_packet); write_json(a, bad_admission)
        code, result = comparator(args.contract_diff, p, a, ops)
        require(result.get("status") == expected, f"negative-{name}-status")
        require(code != 0, f"negative-{name}-exit")
        negative_results[name] = result
        write_json(out / f"contract-diff-negative-{name}.json", result)

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
        "receipt": {"source": receipt_source, "actualReceiptDigest": file_digest(receipt_file), "normalizedReceiptDigest": digest(receipt_row)},
        "comparator": {"source": source("roccho-org/ops", args.ops_candidate, "packages/contract-diff/core.py", ops), "positive": positive, "negative": negative_results},
        "remaining": 0,
    }
    write_json(out / "phase4-evidence.json", evidence)
    manifest = []
    for path in sorted(p for p in out.rglob("*") if p.is_file()):
        if path.name == "bundle-manifest.json":
            continue
        manifest.append({"path": path.relative_to(out).as_posix(), "sha256": file_digest(path)})
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
    require({k: v.get("status") for k, v in evidence["comparator"]["negative"].items()} == expected_negatives, "negative-status")
    actual = []
    for item in manifest:
        path = root / item["path"]
        require(path.is_file() and file_digest(path) == item["sha256"], f"manifest:{item['path']}")
        actual.append(item["path"])
    expected = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and p.name != "bundle-manifest.json")
    require(sorted(actual) == expected, "manifest-coverage")
    return {"kind": "ops.contract632.phase4Verification.v1", "status": "PASS", "authority": False, "adoption": False, "remaining": 0, "manifestCount": len(manifest), "claimCeiling": CLAIM_CEILING}


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
