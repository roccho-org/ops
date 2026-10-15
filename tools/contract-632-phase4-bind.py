#!/usr/bin/env python3
from __future__ import annotations

import argparse, hashlib, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path
from typing import Any

HEX40 = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
OID = "ops.final-ci-migration-consumer.v1"
ROLE = "final-ci-receipt"
CEILING = "OPS_SELF_DIFF_CONSUMED_NOT_ORGANIZATION_ADMISSION"
SOURCES = {
    "acceptedDecision": ("roccho-dev/governance", "governance/accepted-final-ci-decision.v1.json", "sources/governance/accepted-final-ci-decision.v1.json"),
    "acceptedRollout": ("roccho-dev/governance", "governance/selected-final-ci-rollout.v1.json", "sources/governance/selected-final-ci-rollout.v1.json"),
    "providerClaim": ("roccho-org/ops", "governance/final-ci-claim.v1.json", "sources/ops/final-ci-claim.v1.json"),
    "receiptProducer": ("roccho-org/ops", "tools/check-final-ci-consumer.py", "sources/ops/check-final-ci-consumer.py"),
    "comparatorCli": ("roccho-org/ops", "packages/contract-diff/bin/contract-diff.py", "sources/ops/contract-diff/bin/contract-diff.py"),
    "comparatorCore": ("roccho-org/ops", "packages/contract-diff/core.py", "sources/ops/contract-diff/core.py"),
    "binder": ("roccho-org/ops", "tools/contract-632-phase4-bind.py", "sources/ops/contract-632-phase4-bind.py"),
}
NEGATIVE = {
    "contract-drift": "OPEN",
    "missing-observation": "OPEN",
    "wrong-candidate": "OPEN",
    "missing-admission": "UNKNOWN",
}


def canonical(v: Any) -> bytes:
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha_bytes(v: bytes) -> str:
    return "sha256:" + hashlib.sha256(v).hexdigest()


def sha_file(p: Path) -> str:
    return sha_bytes(p.read_bytes())


def read(p: Path) -> Any:
    return json.loads(p.read_text())


def write(p: Path, v: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(canonical(v) + b"\n")


def need(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def check_token(v: str) -> str:
    v = v.replace(" / ", "/").replace(" ", "")
    need(v != "" and " " not in v, "check-token")
    return v


def digest(v: Any) -> str:
    return sha_bytes(canonical(v))


def semantic(repo: str, role: str, branch: str, check: str, assertion: str, binding: str) -> dict[str, Any]:
    body = {
        "capability": "final-ci-migration-consumer", "consumer": repo, "stage": role,
        "target": {"provider": "github", "resource": check_token(check), "account": branch},
        "slot": assertion, "binding": binding,
        "profile": [{"role": ROLE, "operation": "check", "readback": True, "grade": "real"}],
    }
    return {"obligation_digest": digest(body), **body}


def descriptor(repo: str, rev: str, path: str, source: Path) -> dict[str, str]:
    need(HEX40.fullmatch(rev) is not None, "revision")
    need(source.is_file() and not source.is_symlink(), "source-missing:" + path)
    return {"repository": repo, "revision": rev, "path": path, "digest": sha_file(source)}


def compare(cli: Path, packet: Path, admission: Path, cwd: Path) -> tuple[int, Any]:
    p = run([sys.executable, str(cli), "--input", str(packet), "--admission", str(admission)], cwd)
    need(p.stdout.strip() != "", "comparator-empty")
    return p.returncode, json.loads(p.stdout)


def manifest(root: Path) -> list[dict[str, str]]:
    rows = read(root / "bundle-manifest.json")
    need(isinstance(rows, list) and rows, "manifest")
    seen = set()
    for row in rows:
        need(set(row) == {"path", "sha256"}, "manifest-row")
        rel = row["path"]
        need(rel not in seen and not rel.startswith("/") and ".." not in Path(rel).parts, "manifest-path")
        seen.add(rel)
        p = root / rel
        need(p.is_file() and sha_file(p) == row["sha256"], "manifest-digest:" + rel)
    expected = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and p.name != "bundle-manifest.json"}
    need(seen == expected, "manifest-coverage")
    return rows


def source_bindings(root: Path, gov_rev: str, ops_rev: str, observer_repo: str, observer_rev: str, observer_path: str) -> dict[str, Any]:
    bindings = read(root / "source-bindings.json")
    need(set(bindings) == {*SOURCES, "observer"}, "bindings-keys")
    expected = {k: (repo, gov_rev if repo.endswith("governance") else ops_rev, path, bundle) for k, (repo, path, bundle) in SOURCES.items()}
    expected["observer"] = (observer_repo, observer_rev, observer_path, "sources/observer/source")
    for key, (repo, rev, path, bundle) in expected.items():
        row = bindings[key]
        need(row["source"] == {"repository": repo, "revision": rev, "path": path, "digest": row["source"].get("digest")}, "source-id:" + key)
        need(row["bundlePath"] == bundle and DIGEST.fullmatch(row["source"]["digest"]) is not None, "source-shape:" + key)
        need(sha_file(root / bundle) == row["source"]["digest"], "source-bytes:" + key)
    need(sha_file(Path(__file__).resolve()) == bindings["binder"]["source"]["digest"], "binder-self-digest")
    return bindings


def verify(root: Path) -> dict[str, Any]:
    root = root.resolve()
    rows = manifest(root)
    scope = read(root / "run-scope.json")
    evidence = read(root / "phase4-evidence.json")
    need(scope.get("selectedObligations") == [OID] and scope.get("authority") is False, "scope")
    need(evidence.get("status") == "PASS" and evidence.get("authority") is False and evidence.get("remaining") == 0, "evidence")
    need(evidence.get("claimCeiling") == CEILING and evidence.get("scope") == scope, "evidence-scope")
    ops = scope["opsCandidate"]; gov = scope["governanceRevision"]
    need(HEX40.fullmatch(ops) and HEX40.fullmatch(gov), "scope-revisions")
    bound = read(root / "bound-verification.json")
    need(bound.get("kind") == "ops.contract632.phase4BoundVerification.v1", "bound-kind")
    need(bound.get("opsCandidate") == ops and bound.get("governanceRevision") == gov, "bound-revisions")
    bindings = source_bindings(root, gov, ops, bound["observerRepository"], bound["observerRevision"], bound["observerPath"])

    decision = read(root / bindings["acceptedDecision"]["bundlePath"])
    rollout = read(root / bindings["acceptedRollout"]["bundlePath"])
    claim = read(root / bindings["providerClaim"]["bundlePath"])
    selected = [r for r in rollout.get("repositories", []) if r.get("assertionId") == OID]
    need(len(selected) == 1, "accepted-selection")
    accepted = selected[0]
    need(decision.get("stableRequiredCheck") == "gov-final-scope-purpose-join / gate", "decision-check")
    need(accepted.get("repository") == "roccho-dev/ops" and accepted.get("branch") == "proposals", "accepted-target")
    need(accepted.get("acceptedBundleDigest") == "sha256:" + decision["contractCanonicalDigest"], "accepted-binding")
    need(claim.get("repository") == accepted["repository"] and claim.get("role") == accepted["role"], "claim-target")
    need(claim["assertion"]["assertionId"] == OID and claim["assertion"]["acceptedBundleDigest"] == accepted["acceptedBundleDigest"], "claim-assertion")
    required = semantic(accepted["repository"], accepted["role"], accepted["branch"], decision["stableRequiredCheck"], OID, accepted["acceptedBundleDigest"])
    state = claim["migration"]["correctedState"]
    provided = semantic(claim["repository"], claim["role"], state["defaultBranch"], state["requiredCheck"], OID, claim["assertion"]["acceptedBundleDigest"])
    need(required == provided and scope.get("acceptedRequirementDigest") == required["obligation_digest"], "semantic-drift")

    packet = read(root / "contract-diff-input.json")
    admission = read(root / "contract-diff-admission.json")
    need(packet["required"]["source"] == bindings["acceptedRollout"]["source"], "packet-required-source")
    need(packet["required"]["rows"] == [{"id": OID, "contract": required}], "packet-required")
    need(packet["provided"]["source"] == bindings["providerClaim"]["source"], "packet-provided-source")
    need(packet["provided"]["rows"][0]["contract"] == provided, "packet-provided")
    need(packet["observations"]["source"] == bindings["observer"]["source"], "packet-observation-source")
    need(packet["receipts"]["source"] == bindings["receiptProducer"]["source"], "packet-receipt-source")
    need(admission["scope"]["authority"] == bindings["acceptedDecision"]["source"], "admission-authority")

    with tempfile.TemporaryDirectory() as tmp:
        receipt = Path(tmp) / "receipt.json"
        p = run([sys.executable, str(root / bindings["receiptProducer"]["bundlePath"]), "check", "--claim", str(root / bindings["providerClaim"]["bundlePath"]), "--candidate-sha", ops, "--out", str(receipt)], root)
        need(p.returncode == 0 and receipt.read_bytes() == (root / "ops-final-ci-consumer-receipt.json").read_bytes(), "receipt-replay")

    cli = root / bindings["comparatorCli"]["bundlePath"]
    code, result = compare(cli, root / "contract-diff-input.json", root / "contract-diff-admission.json", root)
    need(code == 0 and result == read(root / "contract-diff-positive.json") and result.get("status") == "CLOSED", "positive-replay")
    for name, status in NEGATIVE.items():
        code, result = compare(cli, root / f"negative-{name}-input.json", root / f"negative-{name}-admission.json", root)
        need(code != 0 and result.get("status") == status and result == read(root / f"contract-diff-negative-{name}.json"), "negative-replay:" + name)

    expected = {
        "kind": "ops.contract632.phase4BoundVerification.v1", "status": "PASS", "authority": False,
        "adoption": False, "releasePublished": False, "remaining": 0, "claimCeiling": CEILING,
        "opsCandidate": ops, "governanceRevision": gov,
        "observerRepository": bindings["observer"]["source"]["repository"],
        "observerRevision": bindings["observer"]["source"]["revision"],
        "observerPath": bindings["observer"]["source"]["path"],
        "sourceBytesVerified": len(bindings), "receiptReplayed": True, "comparatorReplayed": True,
        "evidenceBound": True,
    }
    need(bound == expected, "bound-reconstruction")
    return {**expected, "manifestCount": len(rows), "scopeDigest": sha_file(root / "run-scope.json"), "evidenceDigest": sha_file(root / "phase4-evidence.json")}


def bind(args: argparse.Namespace) -> dict[str, Any]:
    root = args.bundle.resolve(); gov = args.governance_source.resolve(); ops = args.ops_source.resolve(); obs = args.observer_root.resolve()
    need((root / "phase4-evidence.json").is_file(), "base-bundle")
    scope = read(root / "run-scope.json")
    need(scope.get("opsCandidate") == args.ops_candidate and scope.get("governanceRevision") == args.governance_revision, "scope-revisions")
    bindings = {}
    for key, (repo, path, bundle) in SOURCES.items():
        source_root = gov if repo.endswith("governance") else ops
        rev = args.governance_revision if repo.endswith("governance") else args.ops_candidate
        src = source_root / path; dst = root / bundle
        dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)
        bindings[key] = {"source": descriptor(repo, rev, path, src), "bundlePath": bundle}
    src = obs / args.observer_path; dst = root / "sources/observer/source"
    dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)
    bindings["observer"] = {"source": descriptor(args.observer_repository, args.observer_revision, args.observer_path, src), "bundlePath": "sources/observer/source"}
    write(root / "source-bindings.json", bindings)
    bound = {
        "kind": "ops.contract632.phase4BoundVerification.v1", "status": "PASS", "authority": False,
        "adoption": False, "releasePublished": False, "remaining": 0, "claimCeiling": CEILING,
        "opsCandidate": args.ops_candidate, "governanceRevision": args.governance_revision,
        "observerRepository": args.observer_repository, "observerRevision": args.observer_revision,
        "observerPath": args.observer_path, "sourceBytesVerified": len(bindings),
        "receiptReplayed": True, "comparatorReplayed": True, "evidenceBound": True,
    }
    write(root / "bound-verification.json", bound)
    rows = [{"path": p.relative_to(root).as_posix(), "sha256": sha_file(p)} for p in sorted(root.rglob("*")) if p.is_file() and p.name != "bundle-manifest.json"]
    write(root / "bundle-manifest.json", rows)
    return verify(root)


def main() -> int:
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("bind")
    b.add_argument("--bundle", type=Path, required=True); b.add_argument("--governance-source", type=Path, required=True)
    b.add_argument("--governance-revision", required=True); b.add_argument("--ops-source", type=Path, required=True)
    b.add_argument("--ops-candidate", required=True); b.add_argument("--observer-root", type=Path, required=True)
    b.add_argument("--observer-repository", required=True); b.add_argument("--observer-revision", required=True); b.add_argument("--observer-path", required=True)
    v = sub.add_parser("verify"); v.add_argument("--bundle", type=Path, required=True)
    args = p.parse_args(); result = bind(args) if args.command == "bind" else verify(args.bundle)
    print(canonical(result).decode()); return 0

if __name__ == "__main__":
    raise SystemExit(main())
