# Independent functional review

Reviewed source: `a5cdff1144edd2b89bdfc6d067e6bb75b17f1ddd`.
Reviewer: `/root/semlint_ops`; implementation was owned by Root. The reviewer changed only `core.test.mjs` and this report, made no provider calls, and did not read semantic Gold or alter tests in response to live model outcomes.

The mechanical/adversarial obligations were stated before reading the prototype. Tests were written after its API and source became available. This review assesses the two-function contract and observed data flow, not completeness or usefulness of generated criteria.

## Final functional result

The independent final run of `node --test experiments/goal-evaluation-unix/core.test.mjs` passed all 11 tests, with no skipped, cancelled or failed tests. It used the existing native Node runtime and test doubles, with zero provider calls.

The tests cover:

- A novel generated question and all three criterion descriptions reaching the model port unchanged after a JSON serialization roundtrip.
- Request/proposal snapshots, deep freezing and isolation from caller mutation.
- Refusal of generated Goal, authority, budget, threshold and expected-label fields, and invalid provenance.
- A known Core match coexisting with a new question and an unresolved Need.
- Missing required observations preserving other judgments and causing no call for the unavailable question.
- Empty questions retaining explicit unresolved Goal coverage with zero calls.
- Question, plan-byte, actual-question-byte and call ceilings.
- Execution failure and invalid labels remaining failures rather than semantic success.
- Trusted criterion comparison being independent of JSON property order.
- The final emitted Plan remaining inside its byte ceiling, including its automatic missing-coverage annotation.

Source inspection also confirms that `judge` snapshots the supplied serialized Plan, passes a separate criterion copy to the model, and validates returned labels against the original frozen criteria. It does not generate or rewrite questions. Its result always carries `goalCoverage: "NOT_CERTIFIED"` and `authority: false`; a raw label is not a Goal completion or effect authorization.

## Counterexamples found and corrected

1. The initial actual-question-byte test failed: a Plan admitted under a 2,710-byte host ceiling produced a 4,529-byte serialized model question because its request JSON was escaped again inside `text`. The mock model port was invoked. Root added an actual-question byte check before incrementing calls or invoking the model. Oversized questions now produce `NOT_RUN` plus a missing reason and zero calls. The independent rerun passed.
2. Source inspection found that the automatic empty-question missing-coverage row was appended after the Plan byte check. A separate test reproduced an emitted Plan exceeding its own narrow host ceiling. Root added final validation after that annotation. The independent final 11-test run passed.

These earlier failures remain review facts; the final passing result does not erase them. Neither counterexample involved a live provider call.

## Observed live data flow

The reviewer independently read the completed `results/plan.jsonl`, `results/provider-plan.jsonl` and `results/provider-judge.jsonl` and compared the serialized Plan with the recorded native CLI inputs.

- Four planning CLI records produced Plans containing seven questions in total.
- Seven judging CLI records were present.
- Every recorded judging `instructions` string matched its Plan question exactly.
- Every `problem`, `ok` and `unknown` criterion description matched its Plan value exactly.
- Every recorded judging state reconstructed the corresponding original Goal and observation snapshot without a content change.
- All 11 CLI response session IDs were present and distinct: four planning sessions and seven judging sessions, with no cross-role overlap.

The runner's source reads planning inputs and Core data in planning mode, then reads the serialized Plans in judging mode. It contains no read of Gold or expected labels. Native CLI processes are separate invocations with tools disabled. This verifies the inspected runner's data paths and the recorded session separation, not absence of every possible external model bias.

This live path uses the existing draft portable Choice model port and the already authenticated native Claude CLI. It does not demonstrate a live Jev call, the canonical semlint owner entry's Choice support, model interchangeability, or production activation. Actual HTTP counts and invoiced cost are not established by these CLI records.

## Claim boundary

The small local prototype functionally supports raw Goal and observations becoming supplied reusable or newly generated diagnostic questions, followed by unchanged-question evaluation through a separate model port. JSON piping works without a process-local brand. Missing context, unresolved Needs, operation errors and budgets remain explicit.

Criteria discovery quality, legitimate-exception preservation, semantic false positives/false negatives, and alignment to the original Goal belong to the separate prospective semantic review. This functional result neither certifies whole-Goal coverage nor admits a reusable Core, changes acceptance conditions, authorizes an effect, or proves the entire improvement loop.
