# ops-package-contract-bridge

A thin, non-authoritative bridge for ADRS #632. It transports exact identities and verifies bounded proof bundles. It does not compile organization meaning.

```text
AcceptedCurrentPacket = existing Governance compiler(accepted source, policy, admitted input)
BoundedCandidateProjection = existing Governance compiler(candidate input)
Bridge = bind exact source + packet + observation + receipt identities
```

The bridge never chooses a semantic winner, supersession, applicability, required status, admission, Gate result, provider effect, Gov Release, or adopted operational state.

## Phase 1 boundary

Phase 1 proves the existing compiler's explicit-supersession behavior and the existing append core's physical-prefix behavior against exact sources. The proof is bounded and non-authoritative:

```text
claim ceiling = BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION
```

A candidate append may produce a different candidate packet, but cannot change the selected accepted packet unless the external authority boundary admits it. This package only verifies that the proof bundle binds those distinct inputs and results.

## Use

```text
ops-package-contract-bridge verify-phase1 <bundle-dir>
```

The command verifies closed receipt fields, artifact digests, non-empty semantic output, explicit current change for the admitted proof input, candidate isolation, destructive coverage, and unchanged accepted compiler/core source identities.
