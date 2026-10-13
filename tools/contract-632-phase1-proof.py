#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Callable

DESIGN = "CONTRACT_W_632_CLOSURE_DESIGN_V3"
CEILING = "BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION"
SELECTOR_CEILING = "BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION"
SELECTOR_SOURCE_PATH = "governance/contract-632-phase1-selector.v1.json"
EXPECTED_SELECTOR_SHA256 = "14b82b5300b99b1d32209d3acfd3572f2a151de0dc8e47a90b0342f5757c6abc"
EXPECTED_GOVERNANCE_REPOSITORY = "roccho-dev/governance"
EXPECTED_GOVERNANCE_REVISION = "7160e56aa8dbafaff4b98cc21fc4842d6600daf6"
EXPECTED_GOVERNANCE_TREE = "eebaa9ca7b85d63c405eb107f68d5546f26e50ab"
EXPECTED = {
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
ROLE_PROTOCOL = {
    "before": {"ledger": "L0", "packet": "AC0"},
    "accepted": {"ledger": "L1", "packet": "AC1"},
    "candidate": {"ledger": "L2", "packet": "BC1"},
}


def canon(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha_file(path: Path) -> str:
    return sha_bytes(path.read_bytes())


def blob_sha(path: Path) -> str:
    value = path.read_bytes()
    return hashlib.sha1(f"blob {len(value)}\0".encode() + value).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(canon(value) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(canon(row) + "\n" for row in rows), encoding="utf-8")


def command(argv: list[str], cwd: Path, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != expected:
        raise RuntimeError(
            f"rc={result.returncode} expected={expected}: {' '.join(argv)}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def make_writable(root: Path) -> None:
    for path in [root, *root.rglob("*")]:
        mode = path.stat().st_mode
        add = stat.S_IWUSR | (stat.S_IXUSR if path.is_dir() else 0)
        os.chmod(path, mode | add)


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise RuntimeError(f"{label} keys mismatch: actual={sorted(actual)} expected={sorted(expected)}")


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{label} must be non-empty text")
    return value


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be an object")
    return value


def accepted_decision(policy: dict[str, Any]) -> dict[str, Any]:
    decision = policy["decision"]
    return {
        "decisionId": decision["decision_id"],
        "decisionDigest": decision["decision_digest"],
        "acceptedMerge": decision["accepted_merge"],
        "source": decision["source"],
        "release": decision["release"],
        "status": decision["status"],
    }


def validate_selector(
    selector: dict[str, Any],
    policy: dict[str, Any],
    governance_revision: str,
    governance_tree: str,
) -> None:
    exact_keys(
        selector,
        {
            "kind",
            "selectorId",
            "authority",
            "claimCeiling",
            "designVersion",
            "source",
            "acceptedDecision",
            "governanceSource",
            "selection",
        },
        "selector",
    )
    if selector["kind"] != "governance.packageContractPhase1Selector.v1":
        raise RuntimeError("selector kind mismatch")
    if selector["selectorId"] != "adrs-632-phase1-v2":
        raise RuntimeError("selector id mismatch")
    if selector["authority"] is not False:
        raise RuntimeError("selector must be non-authoritative")
    if selector["claimCeiling"] != SELECTOR_CEILING:
        raise RuntimeError("selector claim ceiling mismatch")
    if selector["designVersion"] != DESIGN:
        raise RuntimeError("selector design version mismatch")

    source = require_object(selector["source"], "selector.source")
    exact_keys(source, {"rAcceptance", "pBoundary"}, "selector.source")
    require_text(source["rAcceptance"], "selector.source.rAcceptance")
    require_text(source["pBoundary"], "selector.source.pBoundary")

    decision = require_object(selector["acceptedDecision"], "selector.acceptedDecision")
    exact_keys(
        decision,
        {"decisionId", "decisionDigest", "acceptedMerge", "source", "release", "status"},
        "selector.acceptedDecision",
    )
    if decision != accepted_decision(policy):
        raise RuntimeError("selector accepted decision mismatch")

    governance_source = require_object(selector["governanceSource"], "selector.governanceSource")
    exact_keys(governance_source, {"repository", "revision", "treeSha"}, "selector.governanceSource")
    if governance_source != {
        "repository": EXPECTED_GOVERNANCE_REPOSITORY,
        "revision": governance_revision,
        "treeSha": governance_tree,
    }:
        raise RuntimeError("selector governance source mismatch")
    if governance_revision != EXPECTED_GOVERNANCE_REVISION or governance_tree != EXPECTED_GOVERNANCE_TREE:
        raise RuntimeError("unexpected governance source identity")

    selection = require_object(selector["selection"], "selector.selection")
    exact_keys(selection, {"subjectKey", "before", "accepted", "candidate"}, "selector.selection")
    require_text(selection["subjectKey"], "selector.selection.subjectKey")
    for role, protocol in ROLE_PROTOCOL.items():
        entry = require_object(selection[role], f"selector.selection.{role}")
        expected_keys = {"ledger", "rowId"} if role == "before" else {"ledger", "rowId", "supersedes"}
        exact_keys(entry, expected_keys, f"selector.selection.{role}")
        if entry["ledger"] != protocol["ledger"]:
            raise RuntimeError(f"selector {role} ledger mismatch")
        require_text(entry["rowId"], f"selector.selection.{role}.rowId")
        if role != "before":
            require_text(entry["supersedes"], f"selector.selection.{role}.supersedes")


def load_selector(
    path: Path,
    expected_sha256: str,
    policy: dict[str, Any],
    governance_revision: str,
    governance_tree: str,
) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeError(f"selector missing: {path}")
    actual = sha_file(path)
    if actual != expected_sha256:
        raise RuntimeError(f"selector digest mismatch: {actual} != {expected_sha256}")
    selector = json.loads(path.read_text(encoding="utf-8"))
    validate_selector(selector, policy, governance_revision, governance_tree)
    return selector


def find_row(rows: list[dict[str, Any]], row_id: str, label: str) -> dict[str, Any]:
    found = [row for row in rows if row.get("id") == row_id]
    if len(found) != 1:
        raise RuntimeError(f"{label}: expected one row {row_id}, got {len(found)}")
    return found[0]


def bind_selector_to_ledgers(selector: dict[str, Any], ledgers: dict[str, list[dict[str, Any]]]) -> None:
    selection = selector["selection"]
    subject = selection["subjectKey"]
    before = find_row(ledgers["L0"], selection["before"]["rowId"], "before")
    accepted = find_row(ledgers["L1"], selection["accepted"]["rowId"], "accepted")
    candidate = find_row(ledgers["L2"], selection["candidate"]["rowId"], "candidate")
    if any(row.get("subject_key") != subject for row in (before, accepted, candidate)):
        raise RuntimeError("selector subject binding mismatch")
    if before.get("supersedes") != []:
        raise RuntimeError("before row must not supersede another row")
    if accepted.get("supersedes") != [selection["accepted"]["supersedes"]]:
        raise RuntimeError("accepted supersession binding mismatch")
    if candidate.get("supersedes") != [selection["candidate"]["supersedes"]]:
        raise RuntimeError("candidate supersession binding mismatch")
    if selection["accepted"]["supersedes"] != before["id"]:
        raise RuntimeError("accepted row does not supersede before row")
    if selection["candidate"]["supersedes"] != accepted["id"]:
        raise RuntimeError("candidate row does not supersede accepted row")
    if ledgers["L1"][:-1] != ledgers["L0"] or ledgers["L1"][-1] != accepted:
        raise RuntimeError("L1 is not exactly L0 plus the accepted row")
    if ledgers["L2"][:-1] != ledgers["L1"] or ledgers["L2"][-1] != candidate:
        raise RuntimeError("L2 is not exactly L1 plus the candidate row")


def compiler_packet(
    packet: dict[str, Any],
    label: str,
    ledger_name: str,
    ledger_sha256: str,
) -> dict[str, Any]:
    current = packet.get("current_state")
    if not isinstance(current, list) or not current:
        raise RuntimeError(f"{label}: empty current_state")
    return {
        "kind": "ops.packageContractBridge.compilerPacket.v2",
        "label": label,
        "authority": False,
        "claimCeiling": CEILING,
        "input": {"ledger": f"{ledger_name}.jsonl", "ledgerSha256": ledger_sha256},
        "semanticDigest": packet["semantic_digest"],
        "currentDigest": packet["current_digest"],
        "replayDigest": packet["replay_digest"],
        "replayEqual": packet["replay_equal"],
        "currentState": current,
        "decisionCount": len(packet.get("decisions", [])),
        "promotionCount": len(packet.get("promotions", [])),
    }


def current_decision(packet: dict[str, Any], subject: str) -> str:
    rows = [row for row in packet["current_state"] if row.get("subject_key") == subject]
    if len(rows) != 1:
        raise RuntimeError(f"expected one current row for {subject}, got {len(rows)}")
    return str(rows[0]["decision"])


def compiler_rejected(
    engine: Any,
    rows: list[dict[str, Any]],
    policy: dict[str, Any],
    case: str,
) -> dict[str, str]:
    try:
        engine.validate_and_reduce(rows, policy)
    except Exception as error:
        return {"case": case, "status": "REJECTED", "error": str(error)}
    raise RuntimeError(f"destructive compiler case passed: {case}")


def rejected(case: str, action: Callable[[], None]) -> dict[str, str]:
    try:
        action()
    except Exception as error:
        return {"case": case, "status": "REJECTED", "error": str(error)}
    raise RuntimeError(f"destructive selector case passed: {case}")


def selection_record(
    selector: dict[str, Any],
    out: Path,
    packets: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    subject = selector["selection"]["subjectKey"]
    record: dict[str, Any] = {
        "kind": "ops.packageContractBridge.phase1Selection.v2",
        "authority": False,
        "claimCeiling": CEILING,
        "selector": {
            "path": "phase1-selector.json",
            "sha256": sha_file(out / "phase1-selector.json"),
            "selectorId": selector["selectorId"],
        },
    }
    for role, protocol in ROLE_PROTOCOL.items():
        packet_label = protocol["packet"]
        packet_path = f"{packet_label}.compiler-packet.json"
        packet = packets[packet_label]
        record[role] = {
            "ledger": f"{protocol['ledger']}.jsonl",
            "ledgerSha256": sha_file(out / f"{protocol['ledger']}.jsonl"),
            "rowId": selector["selection"][role]["rowId"],
            "packet": packet_path,
            "packetSha256": sha_file(out / packet_path),
            "decision": current_decision(packet, subject),
            "currentDigest": packet["current_digest"],
        }
    record["acceptedCurrentAfterCandidate"] = {
        "sourceRole": "accepted",
        "packet": record["accepted"]["packet"],
        "packetSha256": record["accepted"]["packetSha256"],
        "currentDigest": record["accepted"]["currentDigest"],
    }
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--governance-source", type=Path, required=True)
    parser.add_argument("--governance-revision", required=True)
    parser.add_argument("--ops-source", type=Path, required=True)
    parser.add_argument("--ops-candidate-sha", required=True)
    parser.add_argument("--contractcheck", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    work = out / "work"
    governance = work / "governance"
    shutil.copytree(args.governance_source.resolve(), governance)
    make_writable(governance)

    fixtures = governance / "tools/contract-modeling/fixtures"
    command([sys.executable, "generate.py"], fixtures)
    policy = json.loads((fixtures / "accepted-policy.json").read_text(encoding="utf-8"))
    rows = [
        json.loads(line)
        for line in (fixtures / "claims.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    original = next(row for row in rows if row["id"] == "request:02-semantic")

    selector_source = args.ops_source.resolve() / SELECTOR_SOURCE_PATH
    selector = load_selector(
        selector_source,
        EXPECTED_SELECTOR_SHA256,
        policy,
        args.governance_revision,
        EXPECTED_GOVERNANCE_TREE,
    )
    shutil.copyfile(selector_source, out / "phase1-selector.json")

    v2 = copy.deepcopy(original)
    v2.update(id=selector["selection"]["accepted"]["rowId"], supersedes=[original["id"]])
    v2["payload"]["terms"] = ["customer-alias"]
    v3 = copy.deepcopy(v2)
    v3.update(id=selector["selection"]["candidate"]["rowId"], supersedes=[v2["id"]])
    v3["payload"]["requested_projection"] = "customer-alias-v1"

    ledgers = {"L0": rows, "L1": [*rows, v2], "L2": [*rows, v2, v3]}
    bind_selector_to_ledgers(selector, ledgers)
    for label, value in ledgers.items():
        write_jsonl(out / f"{label}.jsonl", value)

    append_results: dict[str, Any] = {}
    for label, base, candidate in (
        ("l0-l1", "L0.jsonl", "L1.jsonl"),
        ("l1-l2", "L1.jsonl", "L2.jsonl"),
    ):
        result = command(
            [str(args.contractcheck), "append-only-check", "--base", base, "--candidate", candidate],
            out,
        )
        append_results[label] = json.loads(result.stdout)
        write_json(out / f"append-{label}.json", append_results[label])

    bin_root = governance / "tools/contract-modeling/bin"
    epoch = load("contract_w_phase1_epoch_v2", bin_root / "epoch.py")
    packets: dict[str, dict[str, Any]] = {}
    for label, ledger_name in (("AC0", "L0"), ("AC1", "L1"), ("BC1", "L2")):
        ledger = out / f"{ledger_name}.jsonl"
        packet = epoch.evaluate(
            args.governance_revision,
            governance,
            claims_path=ledger,
            require_duckdb=False,
        )
        packets[label] = packet
        write_json(
            out / f"{label}.compiler-packet.json",
            compiler_packet(packet, label, ledger_name, sha_file(ledger)),
        )

    subject = selector["selection"]["subjectKey"]
    before = current_decision(packets["AC0"], subject)
    after = current_decision(packets["AC1"], subject)
    candidate = current_decision(packets["BC1"], subject)
    if len({before, after, candidate}) != 3:
        raise RuntimeError(f"expected three decisions, got {before}/{after}/{candidate}")

    engine = load("contract_w_phase1_engine_v2", bin_root / "engine.py")
    compiler_bad: list[dict[str, str]] = []
    row = copy.deepcopy(original)
    row.update(id="request:02-semantic:missing-parent", supersedes=["request:not-found"])
    compiler_bad.append(compiler_rejected(engine, [*rows, row], policy, "missing-parent"))
    row = copy.deepcopy(original)
    row.update(
        id="request:02-semantic:cross-subject",
        subject_key="request:cross-subject",
        supersedes=[original["id"]],
    )
    compiler_bad.append(compiler_rejected(engine, [*rows, row], policy, "cross-subject"))
    a = copy.deepcopy(original)
    a.update(id="request:02-semantic:cycle-a", supersedes=["request:02-semantic:cycle-b"])
    b = copy.deepcopy(original)
    b.update(id="request:02-semantic:cycle-b", supersedes=[a["id"]])
    compiler_bad.append(compiler_rejected(engine, [*rows, a, b], policy, "supersession-cycle"))
    row = copy.deepcopy(original)
    row.update(id="request:02-semantic:duplicate-active", supersedes=[])
    compiler_bad.append(compiler_rejected(engine, [*rows, row], policy, "duplicate-active"))
    write_json(
        out / "destructive-results.json",
        {"kind": "ops.packageContractBridge.phase1CompilerDestructive.v2", "results": compiler_bad},
    )

    selector_bad: list[dict[str, str]] = []
    selector_bad.append(
        rejected(
            "selector-missing",
            lambda: load_selector(
                out / "does-not-exist.json",
                EXPECTED_SELECTOR_SHA256,
                policy,
                args.governance_revision,
                EXPECTED_GOVERNANCE_TREE,
            ),
        )
    )
    with tempfile.TemporaryDirectory() as temporary:
        tampered_path = Path(temporary) / "selector.json"
        tampered_path.write_bytes(selector_source.read_bytes() + b" ")
        selector_bad.append(
            rejected(
                "selector-byte-tamper",
                lambda: load_selector(
                    tampered_path,
                    EXPECTED_SELECTOR_SHA256,
                    policy,
                    args.governance_revision,
                    EXPECTED_GOVERNANCE_TREE,
                ),
            )
        )
    wrong_decision = copy.deepcopy(selector)
    wrong_decision["acceptedDecision"]["decisionDigest"] = "0" * 64
    selector_bad.append(
        rejected(
            "selector-wrong-decision-digest",
            lambda: validate_selector(
                wrong_decision,
                policy,
                args.governance_revision,
                EXPECTED_GOVERNANCE_TREE,
            ),
        )
    )
    wrong_source = copy.deepcopy(selector)
    wrong_source["governanceSource"]["revision"] = "0" * 40
    selector_bad.append(
        rejected(
            "selector-wrong-governance-revision",
            lambda: validate_selector(
                wrong_source,
                policy,
                args.governance_revision,
                EXPECTED_GOVERNANCE_TREE,
            ),
        )
    )
    self_admitted = copy.deepcopy(selector)
    self_admitted["selection"]["accepted"] = {
        "ledger": "L2",
        "rowId": selector["selection"]["candidate"]["rowId"],
        "supersedes": selector["selection"]["candidate"]["supersedes"],
    }
    selector_bad.append(
        rejected(
            "candidate-self-admission",
            lambda: validate_selector(
                self_admitted,
                policy,
                args.governance_revision,
                EXPECTED_GOVERNANCE_TREE,
            ),
        )
    )
    write_json(
        out / "selector-destructive-results.json",
        {"kind": "ops.packageContractBridge.phase1SelectorDestructive.v2", "results": selector_bad},
    )

    ops_files: list[dict[str, str]] = []
    governance_files: list[dict[str, str]] = []
    selected_governance_files: list[Path] = []
    for key, expected in EXPECTED.items():
        owner, relative = key.split("/", 1)
        root = args.ops_source.resolve() if owner == "ops" else governance
        file = root / relative
        actual = blob_sha(file)
        if actual != expected:
            raise RuntimeError(f"accepted source changed: {key}: {actual} != {expected}")
        item = {"path": relative, "gitBlobSha": actual, "sha256": sha_file(file)}
        if owner == "ops":
            ops_files.append(item)
        else:
            governance_files.append(item)
            selected_governance_files.append(file)

    selector_identity = {
        "path": SELECTOR_SOURCE_PATH,
        "gitBlobSha": blob_sha(selector_source),
        "sha256": sha_file(selector_source),
    }
    ops_files.append(selector_identity)
    governance_file_set_digest = sha_bytes(
        "\n".join(
            f"{file.relative_to(governance).as_posix()}:{sha_file(file)}"
            for file in sorted(selected_governance_files)
        ).encode()
    )
    source_identities = {
        "kind": "ops.packageContractBridge.sourceIdentities.v2",
        "ops": {"candidateSha": args.ops_candidate_sha, "selectedFiles": ops_files},
        "governance": {
            "repository": EXPECTED_GOVERNANCE_REPOSITORY,
            "revision": args.governance_revision,
            "treeSha": EXPECTED_GOVERNANCE_TREE,
            "selectedFileSetSha256": governance_file_set_digest,
            "selectedFiles": governance_files,
        },
    }
    write_json(out / "source-identities.json", source_identities)

    manifests = {
        label: {"ledger": f"{label}.jsonl", "ledgerSha256": sha_file(out / f"{label}.jsonl")}
        for label in ("L0", "L1", "L2")
    }
    input_manifests = {
        "kind": "ops.packageContractBridge.phase1Inputs.v2",
        "claimCeiling": CEILING,
        "selector": {
            "path": "phase1-selector.json",
            "sha256": sha_file(out / "phase1-selector.json"),
            "selectorId": selector["selectorId"],
        },
        "manifests": manifests,
    }
    write_json(out / "input-manifests.json", input_manifests)

    selected_current = selection_record(selector, out, packets)
    write_json(out / "accepted-current-selection.json", selected_current)

    names = [
        "phase1-selector.json",
        "L0.jsonl",
        "L1.jsonl",
        "L2.jsonl",
        "append-l0-l1.json",
        "append-l1-l2.json",
        "AC0.compiler-packet.json",
        "AC1.compiler-packet.json",
        "BC1.compiler-packet.json",
        "destructive-results.json",
        "selector-destructive-results.json",
        "source-identities.json",
        "input-manifests.json",
        "accepted-current-selection.json",
    ]
    artifacts = [{"path": name, "sha256": sha_file(out / name)} for name in names]
    receipt = {
        "kind": "ops.packageContractBridge.phase1Receipt.v2",
        "status": "PASS",
        "authority": False,
        "claimCeiling": CEILING,
        "designVersion": DESIGN,
        "phase": 1,
        "phaseClosed": False,
        "source": {
            "opsCandidateSha": args.ops_candidate_sha,
            "governanceRepository": EXPECTED_GOVERNANCE_REPOSITORY,
            "governanceRevision": args.governance_revision,
            "governanceTreeSha": EXPECTED_GOVERNANCE_TREE,
            "governanceSelectedFileSetSha256": governance_file_set_digest,
        },
        "acceptedDecision": accepted_decision(policy),
        "selector": {
            "selectorId": selector["selectorId"],
            "sourcePath": SELECTOR_SOURCE_PATH,
            "bundlePath": "phase1-selector.json",
            "sha256": sha_file(out / "phase1-selector.json"),
            "authority": False,
            "claimCeiling": SELECTOR_CEILING,
        },
        "compiler": {
            "version": policy["compiler"]["version"],
            "selectedFileSetSha256": governance_file_set_digest,
        },
        "append": {
            "l0ToL1": "PASS" if append_results["l0-l1"]["status"] == "pass" else "FAIL",
            "l1ToL2": "PASS" if append_results["l1-l2"]["status"] == "pass" else "FAIL",
        },
        "supersession": {
            "subjectKey": subject,
            "beforeRowId": selector["selection"]["before"]["rowId"],
            "afterRowId": selector["selection"]["accepted"]["rowId"],
            "beforeDecision": before,
            "afterDecision": after,
            "beforeCurrentDigest": packets["AC0"]["current_digest"],
            "afterCurrentDigest": packets["AC1"]["current_digest"],
        },
        "selection": {
            "path": "accepted-current-selection.json",
            "sha256": sha_file(out / "accepted-current-selection.json"),
            "acceptedCurrentDigest": packets["AC1"]["current_digest"],
            "candidateCurrentDigest": packets["BC1"]["current_digest"],
        },
        "destructive": {
            "compiler": {
                "total": len(compiler_bad),
                "rejected": sum(row["status"] == "REJECTED" for row in compiler_bad),
            },
            "selector": {
                "total": len(selector_bad),
                "rejected": sum(row["status"] == "REJECTED" for row in selector_bad),
            },
        },
        "commonCode": {"changed": False, "verifiedSourceCount": len(ops_files) + len(governance_files)},
        "artifacts": artifacts,
        "semantic": {
            "nonEmpty": all(bool(packet["current_state"]) for packet in packets.values()),
            "replayEqual": all(packet["replay_equal"] for packet in packets.values()),
            "ac0SemanticDigest": packets["AC0"]["semantic_digest"],
            "ac1SemanticDigest": packets["AC1"]["semantic_digest"],
            "bc1SemanticDigest": packets["BC1"]["semantic_digest"],
        },
    }
    write_json(out / "phase1-receipt.json", receipt)
    verified = command([str(args.bridge), "verify-phase1", str(out)], out)
    (out / "bridge-verification.json").write_text(verified.stdout, encoding="utf-8")
    shutil.rmtree(work)
    print(canon({"status": "PASS", "phase": 1, "receipt": str(out / "phase1-receipt.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
