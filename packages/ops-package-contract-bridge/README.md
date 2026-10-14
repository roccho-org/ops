# ops-package-contract-bridge

A thin, non-authoritative bridge for ADRS #632. It binds exact sources, repository claims, observations and receipts without compiling organization meaning.

```text
AcceptedCurrentPacket = existing Governance compiler(accepted source, policy, admitted input)
RepositoryEvidence    = exact local source + assertion + observation identities
Bridge                = validate and transport bounded evidence
```

The bridge never chooses a semantic winner, supersession, applicability, required status, organization admission, Gate result, provider effect, Gov Release, merge, or adopted operational state.

## Phase 1

Phase 1 proves bounded supersession with the existing Governance compiler.

```text
L0 = accepted before input
L1 = L0 + explicit superseding row selected by the bounded selector
L2 = L1 + unadmitted candidate row

AC0 = existing compiler(L0)
AC1 = existing compiler(L1)
BC1 = existing compiler(L2)

AcceptedCurrentAfterCandidate = bounded selector(AC1), not BC1
```

The selector is digest-pinned and non-authoritative. Missing, changed, wrong-decision, wrong-source and candidate-self-admission selectors are rejected.

```text
proof claim ceiling    = BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION
selector claim ceiling = BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION
```

`.github/workflows/contract-632-phase1.yml` publishes exact-head evidence. Its result is review evidence, not Phase closure or organization admission.

## Phase 2 current path: v4

Phase 2 v4 proves that every emitted local assertion returns to an actual source statement and that explicit standard metadata in supported source forms cannot disappear silently.

```text
DefaultNixUniverse
  = { packages/<p>/default.nix | p ∈ directDirs(packages) }

DirectLocalAssertion
  = exact existing Nix attr path
  | exact supported lambda metadata path

DerivedAssertion
  = derived:<package>:<field>:<version>
  + one or more exact supports bound by file and assertion digests

Phase2ReadyForReview
  = every direct package classified
  ∧ every mandatory field substantive
  ∧ every discovered supported local source represented
  ∧ UNKNOWN = 0
  ∧ accepted CONFLICT = 0
  ∧ omission = 0
  ∧ source-universe finding = 0
  ∧ source-relation finding = 0
```

Supported local source forms are:

- ordinary Nix attrsets;
- raw JSON attrsets stored in `default.nix`;
- bounded standard metadata in Nix lambdas, currently literal `meta.description`.

Composite values are not represented by invented paths. Direct fields are emitted separately. A future composite must use `relation=derived_from` with exact digest-bound supports.

The result remains non-authoritative. It cannot promote a package to `required`, select Current, change Gate eligibility, or authorize operational adoption.

```text
local claim ceiling = REPOSITORY_LOCAL_CLAIM_NOT_ORGANIZATION_REQUIREMENT
phase 2 v4 ceiling  = PACKAGE_EXACT_SOURCE_RELATIONS_CLOSED_NOT_ORGANIZATION_ADMISSION
```

See [`PHASE2.md`](./PHASE2.md) for the source model, dirtree, validation matrix and closure graph.

## Use

```text
ops-package-contract-bridge verify-phase1 <bundle-dir>

ops-package-contract-bridge build-phase2-v4 \
  --ops-source <ops checkout> \
  --ops-candidate-sha <exact SHA> \
  --local-source-universe <evaluated universe JSON> \
  --out <output directory>

ops-package-contract-bridge verify-phase2-v4 <bundle-dir>
```

`build-phase2-v4` independently classifies the direct-package source universe, emits exact source-bound assertions, checks source relations, retains DRIFT without selecting a winner, runs destructive controls and produces a deterministic finite bundle. `verify-phase2-v4` reconstructs the evidence from copied source bytes and rejects set, field, relation, support, digest, authority, omission or destructive-proof drift.

The older `build/verify-phase2` and `build/verify-phase2-v3` commands remain available only to reproduce historical evidence. They are not the current Phase 2 review path.
