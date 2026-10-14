# Phase 3 — exact selection boundary and two semantic consumers

Phase 3 projects closed Phase 2 Package evidence into two existing consumer contracts while keeping compiler selection context outside Package Purpose semantics.

## Boundary

```text
SelectionEvidence
  = exact Phase 1 selection + AC0 + AC1 + BC1 packets

SemanticEvidence
  = Phase 2 relation-valid Package field assertions

CompilerContext
  = selected AC1 identity shown in UI only

UiProjection
  = exact field mapping
  + exact dependency-target provenance
  + compiler context without semantic package edges

AppsProjection
  = source-supported Package Purpose labels
  + no invented Purpose parent
  + aggregate ideals preserving all 11 fields
  + safe observation/declaration gaps
```

The three sets are not merged. Phase 1 packet identities prove selection. Phase 2 assertion identities support Package fields and relations. Compiler classification is not treated as a Package parent Purpose.

## Candidate isolation

The same projection entry consumes three distinct envelopes:

```text
E0 = accepted AC1 only
E1 = accepted AC1 + exact unadmitted BC1
E2 = accepted AC1 + deterministic proof-mutated unadmitted BC1

Digest(E0) != Digest(E1) != Digest(E2)
Projection(E0) = Projection(E1) = Projection(E2)
```

E1 carries the exact compiler-produced BC1 packet. E2 is an explicit non-authoritative proof mutation derived from BC1 only to show that a changed unadmitted candidate still cannot change the accepted projection. E2 is not claimed to be an existing compiler output. Selecting the unadmitted candidate as current is rejected before either consumer runs.

The verifier repeats this from copied packet bytes, selection data, and the deterministic proof mutation. `append-invariants.json` is evidence output, not trusted input.

## Semantic mapping

Every Phase 2 assertion has one exact base mapping to both projections:

```text
assertion(package, field, relation, value, source)
  -> UI package.contractFields[field][index]
  -> Apps ideal:package:<package>.value[field][index]
```

Additional mappings are allowed only when the source supports that exact meaning:

```text
Purpose label
  <- only purpose assertions whose value equals the chosen label

Dependency edge A -> B
  <- only dependency assertions whose value actually contains B
```

`projection-mapping.jsonl` records the field/relation-specific mapping. `mapping-coverage.json` is derived from those rows and actual projections. It is not populated with a fixed empty list.

## Purpose boundary

Package Purpose nodes have no parent unless the source declares one. The bounded compiler choice `extend_existing` remains a UI context and is not emitted as an Apps Purpose.

```text
PackagePurpose.parents = []  when no source parent exists
CompilerContext -/-> PackagePurpose
```

Changing AC0 to AC1 changes only compiler-context UI paths. The Apps semantic projection remains unchanged because the compiler experiment did not rewrite Package purpose evidence.

## Completed tree

```text
roccho-org/ops
├── .github/workflows/
│   ├── contract-632-phase1.yml
│   └── contract-632-phase3.yml
└── packages/ops-package-contract-bridge/
    ├── PHASE2.md
    ├── PHASE3.md
    ├── README.md
    ├── bin/ops-package-contract-bridge.mjs
    ├── src/
    │   ├── phase2.mjs
    │   ├── phase2-v4.mjs
    │   ├── phase2-v5.mjs
    │   ├── phase3.mjs
    │   ├── serve.mjs
    │   └── verify.mjs
    └── tests/
        ├── e2e.mjs
        ├── phase2.mjs
        ├── phase2-v4.mjs
        ├── phase2-v5.mjs
        └── phase3.mjs
```

Finite Phase 3 evidence includes:

```text
contract-632-phase3-bundle/
├── bundle-manifest.json
├── provenance.json
├── browser-receipt.json
├── browser-dom.html
├── browser.png
├── apps-cli-receipt.json
├── apps-cli-reduced.jsonl
└── proof/
    ├── ui.contract-model-atlas.view.json
    ├── package-architecture.inventory.json
    ├── apps.atlas-purpose-closure.input.jsonl
    ├── apps.atlas-purpose-closure.reduced.jsonl
    ├── projection-mapping.jsonl
    ├── mapping-coverage.json
    ├── append-invariants.json
    ├── phase3-destructive-results.json
    ├── consumer-identities.json
    ├── dist/{index.html,latest.mmd,maps/...}
    ├── phase3-receipt.json
    └── phase3-verification.json
```

## Completion equation

```text
CandidateBoundaryClosed
  = three distinct envelope digests
  ∧ accepted projection bytes equal
  ∧ candidate misselection rejected
  ∧ accepted/candidate identity collision rejected
  ∧ verifier recomputes from packet bytes

MappingClosed
  = every Phase 2 assertion mapped to UI field and Apps ideal field
  ∧ every dependency edge source declares that exact target
  ∧ every Purpose label source supports that exact label
  ∧ unmapped Package fields = 0
  ∧ unexpected source attribution = 0

PurposeBoundaryClosed
  = no compiler decision Purpose
  ∧ no compiler-context semantic edge
  ∧ no unsupported Package Purpose parent

Phase3ReadyForReview
  = CandidateBoundaryClosed
  ∧ MappingClosed
  ∧ PurposeBoundaryClosed
  ∧ actual UI validator PASS
  ∧ actual Apps reducer and file CLI PASS
  ∧ existing viewer served and read in a real browser
  ∧ deterministic bundle
  ∧ authority = false
```

`Phase3ReadyForReview != PhaseClosed`. R and P must judge the same exact head, run, and artifact.

## Validation matrix

| Requirement | Positive evidence | Safe failure |
|---|---|---|
| actual candidate path | E1 contains exact BC1 bytes and differs from E0 | candidate packet/digest mismatch rejects |
| changed unadmitted candidate | E2 uses deterministic proof mutation derived from BC1 | candidate changes accepted projection blocks |
| no identity collision | accepted identity and candidate identity must differ | same packet/current identity rejects |
| no self-admission | selected identity remains AC1 | selecting BC1 rejects |
| exact field mapping | 1 mapping per Phase 2 assertion | one mapping omission rejects |
| exact dependency provenance | edge sources contain target value | unrelated dependency source rejects |
| exact Purpose provenance | label sources equal chosen purpose value | unrelated Purpose source rejects |
| no invented hierarchy | Package Purpose parents empty when undeclared | compiler decision parent is absent |
| semantic source parity | UI and Apps sets equal all Phase 2 assertions | digest/set mismatch rejects |
| no invented closure effects | Fill/Receipt/Residual are zero | unsupported records reject |
| deterministic replay | two builds byte-equal | output drift fails |
| artifact integrity | manifest binds every file | one-byte mutation rejects |

## Destructive set

```text
candidate misselection                  -> REJECTED
candidate context identity collision    -> REJECTED
unrelated dependency source             -> REJECTED
unrelated Purpose source                -> REJECTED
field/relation mapping omission         -> REJECTED
cross-projection source digest mismatch -> REJECTED
unknown relation                        -> REJECTED
UI missing edge target                  -> REJECTED
UI forbidden authority field            -> REJECTED
Apps authority=true                     -> REJECTED
Apps missing Purpose reference          -> REJECTED
```

## Closure process

```mermaid
flowchart TB
  P2["PhaseClosed 2 v5"] --> S["exact Phase 2 semantic assertions"]
  P1["AC0 / AC1 / BC1 + deterministic proof mutation"] --> E["selection envelopes E0 / E1 / E2"]
  E --> C{"AC1 remains selected and identities are distinct?"}
  C -->|NO| X["reject candidate self-admission or identity collision"]
  C -->|YES| UI["UI field + exact dependency projection"]
  C -->|YES| APPS["Apps Purpose + ideal + safe gaps"]
  S --> UI
  S --> APPS
  UI --> M["derive projection-mapping.jsonl"]
  APPS --> M
  M --> V{"exact mapping and source parity?"}
  V -->|NO| FIX["W fixes Phase 3"]
  V -->|YES| B["existing viewer + browser readback"]
  B --> ART["content-addressed evidence bundle"]
  ART --> R{"R same-version verdict"]
  R -->|BLOCK| FIX
  R -->|GO| P{"P same-version verdict"]
  P -->|BLOCK| FIX
  P -->|GO| CLOSED["PhaseClosed 3 vN"]
```

## Claim ceiling

```text
PACKAGE_PROJECTIONS_CONSUMED_NOT_ORGANIZATION_ADMISSION
```

This phase does not resolve Package claim winners, infer missing Purpose ancestry, change Governance Gate scope, transfer Apps ownership, start Phase 4, merge the PR, publish a Gov Release, or adopt operational state.
