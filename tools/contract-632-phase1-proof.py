#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from typing import Callable

EXPECTED_GOVERNANCE_REVISION = "7160e56aa8dbafaff4b98cc21fc4842d6600daf6"
SOURCE_GUARD_CEILING = "NO_SEMANTIC_PROOF_NO_ORGANIZATION_ADMISSION"


def argument_value(name: str) -> str:
    try:
        index = sys.argv.index(name)
        return sys.argv[index + 1]
    except (ValueError, IndexError) as error:
        raise RuntimeError(f"missing required argument: {name}") from error


def argument_path(name: str) -> Path:
    return Path(argument_value(name)).resolve()


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def write_source_guard() -> int:
    ops_source = argument_path("--ops-source")
    selector_path = ops_source / "governance/contract-632-phase1-selector.v1.json"
    selector = json.loads(selector_path.read_text(encoding="utf-8"))
    selected_revision = selector["governanceSource"]["revision"]
    if selected_revision != EXPECTED_GOVERNANCE_REVISION:
        raise RuntimeError("selector no longer pins the accepted Governance revision")
    if selector.get("authority") is not False:
        raise RuntimeError("selector authority must remain false")

    observed_revision = argument_value("--governance-revision")
    if observed_revision == EXPECTED_GOVERNANCE_REVISION:
        raise RuntimeError("source guard called for accepted Governance revision")

    out = argument_path("--out")
    out.mkdir(parents=True, exist_ok=False)
    guard = {
        "kind": "governance.packageContractPhase1SourceGuard.v1",
        "status": "PASS",
        "applicable": False,
        "semanticProofExecuted": False,
        "semanticProofPass": False,
        "authority": False,
        "phaseClosed": False,
        "claimCeiling": SOURCE_GUARD_CEILING,
        "reason": "EXTERNAL_GOVERNANCE_OVERRIDE_NOT_ACCEPTED_SOURCE",
        "expectedGovernanceRevision": EXPECTED_GOVERNANCE_REVISION,
        "observedGovernanceRevision": observed_revision,
        "selectorId": selector["selectorId"],
    }
    (out / "phase1-receipt.json").write_text(canonical(guard), encoding="utf-8")
    (out / "bridge-verification.json").write_text(canonical(guard), encoding="utf-8")
    return 0


observed_governance_revision = argument_value("--governance-revision")
if observed_governance_revision != EXPECTED_GOVERNANCE_REVISION:
    if __name__ == "__main__":
        raise SystemExit(write_source_guard())
    raise RuntimeError("Phase 1 source guard is executable-only")

CORE = argument_path("--ops-source") / "tools/contract-632-phase1-proof-core.py"
if not CORE.is_file():
    raise RuntimeError(f"proof core missing from exact ops source: {CORE}")

spec = importlib.util.spec_from_file_location("contract_632_phase1_proof_core", CORE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {CORE}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def stable_rejected(case: str, action: Callable[[], None]) -> dict[str, str]:
    try:
        action()
    except Exception:
        return {
            "case": case,
            "status": "REJECTED",
            "error": f"rejected:{case}",
        }
    raise RuntimeError(f"destructive selector case passed: {case}")


module.rejected = stable_rejected

if __name__ == "__main__":
    raise SystemExit(module.main())
