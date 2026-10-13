#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from typing import Callable

CORE = Path(__file__).with_name("contract-632-phase1-proof-core.py")
spec = importlib.util.spec_from_file_location("contract_632_phase1_proof_core", CORE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {CORE}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def stable_rejected(case: str, action: Callable[[], None]) -> dict[str, str]:
    try:
        action()
    except Exception as error:
        return {
            "case": case,
            "status": "REJECTED",
            "error": f"{type(error).__name__}:{case}",
        }
    raise RuntimeError(f"destructive selector case passed: {case}")


module.rejected = stable_rejected

if __name__ == "__main__":
    raise SystemExit(module.main())
