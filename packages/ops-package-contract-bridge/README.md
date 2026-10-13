# ops-package-contract-bridge

A thin, non-authoritative bridge for ADRS #632. It transports exact identities and verifies bounded proof bundles. It does not compile organization meaning.

```text
AcceptedCurrentPacket = existing Governance compiler(accepted source, policy, admitted input)
BoundedCandidateProjection = existing Governance compiler(candidate input)
Bridge = bind exact source + packet + observation + receipt identities
```

The bridge never chooses a semantic winner, supersession, applicability, required status, organization admission, Gate result, provider effect, Gov Release, or adopted operational state.

## Phase 1 boundary

Phase 1 uses three separate inputs:

```text
L0 = accepted before input
L1 = L0 + explicit superseding row selected by the bounded selector
L2 = L1 + unadmitted candidate row

AC0 = existing compiler(L0)
AC1 = existing compiler(L1)
BC1 = existing compiler(L2)

AcceptedCurrentAfterCandidate = bounded selector(AC1), not BC1
```

The selector is a separate, digest-pinned, non-authoritative source record. The proof generator cannot make a candidate accepted by setting `selected`, `admitted`, or receipt booleans. Missing, changed, wrong-decision, wrong-source, and candidate-self-admission selectors are rejected.

```text
proof claim ceiling    = BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION
selector claim ceiling = BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION
```

The exact proof inputs, compiler packets, destructive results, source identities, selector, receipt, and verification are uploaded by `.github/workflows/contract-632-phase1.yml` as one exact-head artifact. This is review evidence, not Phase closure or organization admission.

## Phase 2 boundary

Phase 2 joins the candidate's complete direct `packages/*` set with an explicit, source-bound, DRY repository implementation claim set.

```text
Coverage(p,f) = all source-bound assertions for package p and mandatory field f
Complete(p) = every mandatory field has an allowed source for p.position

Phase2ReadyForReview
  = every direct package appears exactly once
  ∧ every mandatory field is substantive
  ∧ unknown = 0
  ∧ conflict = 0
```

The claims are not accepted organization requirements. They cannot promote a package to `required`, choose Current, alter Gate eligibility, or grant operational adoption. Missing fields remain `UNKNOWN`; shared responsibility is not a conflict unless incompatible accepted assertions overlap.

See [`PHASE2.md`](./PHASE2.md) for the dirtree, equations, validation matrix, and closure graph.

```text
package claim ceiling = REPO_IMPLEMENTATION_CLAIM_NOT_ORGANIZATION_REQUIREMENT
phase 2 receipt ceiling = PACKAGE_PURPOSE_COVERAGE_PROVEN_NOT_ORGANIZATION_ADMISSION
```

## Use

```text
ops-package-contract-bridge verify-phase1 <bundle-dir>

ops-package-contract-bridge build-phase2 \
  --ops-source <ops checkout> \
  --ops-candidate-sha <exact SHA> \
  --out <output directory>

ops-package-contract-bridge verify-phase2 <bundle-dir>
```

`verify-phase1` derives the accepted-current selection from the selector, input manifests, and compiler packets; verifies all artifact digests; checks explicit accepted supersession and candidate isolation; and confirms the actual Governance revision, Git tree identity, and selected-file-set identity remain distinct.

`build-phase2` enumerates all direct package directories, joins them with the checked-in claim set, expands explicit common and package-specific fields, preserves field provenance, records safe destructive cases, and emits a deterministic finite bundle. `verify-phase2` independently reconstructs the coverage and rejects digest, set, field, source-class, authority, or destructive-proof drift.
