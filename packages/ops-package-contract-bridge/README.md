# ops-package-contract-bridge

A thin, non-authoritative bridge for ADRS #632. It binds exact sources, repository claims, observations, source relations, consumer projections, and receipts without compiling organization meaning.

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

## Phase 3 current path

Phase 3 consumes the same accepted source identity through two different existing contracts:

```text
Phase 2 relation-valid evidence
├─ ui.contractModelAtlas.view.v1
│  └─ actual UI validator
│     └─ existing package-architecture-map viewer
│        └─ serve-dist + real browser readback
└─ atlas.purpose-closure/1
   └─ actual Apps reduceClosure
      └─ actual Apps file CLI
```

The UI and Apps schemas remain separate. Their source-identity sets and digests must be equal. All 11 Package fields are retained in both projections. Observation-to-claim DRIFT becomes Apps `current` / `ideal` / `gap`; claim-to-claim DRIFT remains visible in UI diagnostics because no authoritative direction exists. Fill, Receipt, and Residual are never invented.

An unadmitted candidate must leave accepted projections byte-identical. An accepted source change must change the corresponding decision locations in both projections.

```text
phase 3 ceiling = PACKAGE_PROJECTIONS_CONSUMED_NOT_ORGANIZATION_ADMISSION
```

See [`PHASE3.md`](./PHASE3.md) for the completed tree, equations, validation matrix, and closure process graph.

## Use

```text
ops-package-contract-bridge verify-phase1 <bundle-dir>

ops-package-contract-bridge build-phase2-v5 \
  --ops-source <ops checkout> \
  --ops-candidate-sha <exact SHA> \
  --local-source-universe <evaluated universe JSON> \
  --out <output directory>

ops-package-contract-bridge verify-phase2-v5 <bundle-dir>

ops-package-contract-bridge build-phase3 \
  --phase1-bundle <dir> \
  --phase2-bundle <dir> \
  --ui-source <pinned ui checkout> \
  --apps-source <pinned apps checkout> \
  --ui-revision <sha> \
  --apps-revision <sha> \
  --package-map-command <file> \
  --package-map-viewer <file> \
  --ops-candidate-sha <sha> \
  --out <dir>

ops-package-contract-bridge verify-phase3 <bundle-dir>
ops-package-contract-bridge serve-dist --dir <dist> [--host 127.0.0.1] [--port 4173]
```

`build-phase2-v5` reuses the bounded v4 local-source stage, normalizes all combined relations, excludes relation-invalid assertions from coverage, runs destructive controls, and produces a deterministic finite bundle. `verify-phase2-v5` reconstructs the same relation partition and rejects source, support, digest, coverage, authority, omission, or destructive-proof drift.

`build-phase3` imports the exact pinned UI and Apps consumers, produces their separate projections, invokes the existing package map, proves append invariants, and emits a deterministic finite bundle. `verify-phase3` replays the copied consumers and rejects projection, source-identity, mapping, append-boundary, or artifact drift. The Phase 3 workflow additionally runs the actual Apps file consumer and the existing viewer in a real browser through `serve-dist`.

The Phase 1/2 workflow and the Phase 3 workflow publish separate exact-head evidence. Superseded results remain reproducible from immutable commits and stored artifacts rather than parallel authority implementations.
