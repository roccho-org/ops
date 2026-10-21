# semlint G1 measurement instrument (R1)

The R-owned instrument for the finite semlint G1 comparison agreed in
[roccho-dev/adrs#635 comment 6313476031](https://github.com/roccho-dev/adrs/issues/635#issuecomment-6313476031)
and its addendum [6313494258](https://github.com/roccho-dev/adrs/issues/635#issuecomment-6313494258).
It defines ledger row shapes and order/pin/theta checks. It holds no case content, calls no provider and
judges nothing by itself.

## Ledger rows (JSONL, closed keys; `schema.mjs`)

| schema | fields | notes |
|---|---|---|
| `ops.semlint.g1.seal.v1` | `caseRef`, `kind`, `laneId`, `sha256`, `sealedAt`, `evidence{repository, commentId}` | `kind` ∈ no-jev, sys2-direct, with-jev, answer-key, deadline, rubric. Lane kinds carry a `laneId`, others `null`. Only the hash is recorded; content is refused. |
| `ops.semlint.g1.judgment.v1` | `caseRef`, `scorer` (R/W), `blindId`, `rubricSha256`, `counts{falseFinding, duplicate, inconsistency, omission}`, `requiredKept{kept, required}`, `laneGuess`, `judgedAt` | `laneGuess` ∈ no-jev, with-jev, sys2-direct, unsure: the scorer's sealed guess, used to measure blinding leakage. |
| `ops.semlint.g1.burden.v1` | `caseRef`, `laneId`, `kind`, `quantity{unit, value}`, `evidence`, `observedAt` | `kind` ∈ input-authoring, reading, recovery, round-trip. `unit` ∈ bytes, seconds, count. UNKNOWN is `null`, never 0. |
| `ops.semlint.g1.theta.v1` | `file`, `constant`, `value`, `band{low, high}`, `recordedAt` | A copy of the W1 code constant. `file` is fixed to `packages/jev-review/github-comment.mjs`; `band` is the official 0.30–0.70. |

## Checks (`verify.mjs`)

- `seal-order`: no-jev, sys2-direct, answer-key, deadline and rubric each sealed exactly once and strictly
  before the run start; the with-Jev lane strictly after it. Equal times fail.
- `pin-diff`: between two runtime pins only `packages/jev-review/issue-actions.json` and
  `.github/workflows/jev-issue-comment.yml` may change (`git diff --no-renames`). Anything else is a
  prerequisite failure.
- `theta`: the ledger copy must equal the single `export const NAME = <number>;` in the display file at the
  pinned SHA. While W1 has not defined it the result is `THETA_CONSTANT_ABSENT` (a failure, never a pass);
  a second assignment is `AMBIGUOUS`, a non-literal is `NOT_NUMERIC_LITERAL`.
- `judgments`: one R and one W vote per blind ID on one rubric hash, every blind ID in P's unblinding map;
  reports agreement, disagreements and each scorer's lane-guess hits, misses and unsure.

```sh
node verification/semlint-g1/verify.mjs pin-diff . <previousPinSha> <nextPinSha>
node verification/semlint-g1/verify.mjs theta . <ledger.jsonl> <pinSha>
node verification/semlint-g1/run.mjs   # every *.test.mjs here; registered in build/checks.jsonl
```
