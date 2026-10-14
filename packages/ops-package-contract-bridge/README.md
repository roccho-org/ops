# ops-package-contract-bridge

A thin, non-authoritative bridge for ADRS #632. It binds exact sources, repository claims, observations, source relations, and receipts without compiling organization meaning.

```text
AcceptedCurrentPacket = existing Governance compiler(accepted source, policy, admitted input)
RepositoryEvidence    = exact source + assertion + observation identities
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

The selector is digest-pinned and non-authoritative. Missing, changed, wrong-decision, wrong-source, and candidate-self-admission selectors are rejected.

```text
proof claim ceiling    = BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION
selector claim ceiling = BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION
```

The `phase1-bundle` job in `.github/workflows/contract-632-phase1.yml` publishes exact-head evidence. Its result is review evidence, not Phase closure or organization admission.

## Phase 2 current path: v5

Phase 2 v5 proves that **every assertion contributing to package coverage** has a valid source relation before it can create `COMPLETE`.

```text
CombinedAssertions
  = central claims
  + registry observations
  + package-local claims
  + explicit derived claims

RelationValid(a)
  = direct source ref resolves and digests match
  | derived support resolves to a direct assertion and both digests match

CoverageInput = { a ∈ CombinedAssertions | RelationValid(a) }

Phase2ReadyForReview
  = every direct package has all mandatory fields in CoverageInput
  ∧ combined relation finding = 0
  ∧ unresolved support = 0
  ∧ UNKNOWN = 0
  ∧ accepted CONFLICT = 0
  ∧ omission = 0
```

The current path keeps source classes distinct:

- central JSON Pointer claims;
- exact `build/packages.jsonl#L<n>` observations;
- literal package metadata blocks;
- ordinary Nix or raw-JSON attrsets;
- bounded lambda `meta.description`;
- derived assertions with structured digest-bound supports.

Old placement derivations with unresolved package-level supports are removed. Each package path is represented by a direct central assertion at `#/packages/<n>/packageId`. Responsibility and non-responsibility derivations retain explicit structured supports.

The result remains non-authoritative. It cannot promote a package to `required`, select Current, change Gate eligibility, or authorize operational adoption.

```text
local claim ceiling = REPOSITORY_LOCAL_CLAIM_NOT_ORGANIZATION_REQUIREMENT
phase 2 v5 ceiling  = PACKAGE_COMBINED_SOURCE_RELATIONS_CLOSED_NOT_ORGANIZATION_ADMISSION
```

See [`PHASE2.md`](./PHASE2.md) for the dirtree, equations, validation matrix, and closure graph.

## Use

```text
ops-package-contract-bridge verify-phase1 <bundle-dir>

ops-package-contract-bridge build-phase2-v5 \
  --ops-source <ops checkout> \
  --ops-candidate-sha <exact SHA> \
  --local-source-universe <evaluated universe JSON> \
  --out <output directory>

ops-package-contract-bridge verify-phase2-v5 <bundle-dir>
```

`build-phase2-v5` reuses the bounded v4 local-source stage, normalizes all combined relations, excludes relation-invalid assertions from coverage, runs destructive controls, and produces a deterministic finite bundle. `verify-phase2-v5` reconstructs the same relation partition and rejects source, support, digest, coverage, authority, omission, or destructive-proof drift.

The single workflow `.github/workflows/contract-632-phase1.yml` runs the Phase 1 regression and the current Phase 2 v5 proof. Superseded results remain reproducible from immutable commits and stored artifacts rather than parallel live implementations.
