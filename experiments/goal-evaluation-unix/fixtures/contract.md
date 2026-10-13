# Prospective independent fixture contract

These four synthetic cases and their expectations were authored before generator plans or judge outputs were observed, by the read-only ADRS inquiry/review actor `/root/semlint_adrs`, independently of the implementation actor. `/root/semlint_ops` reviewed the case design before execution and added counterexamples for legitimate exceptions, zero-effect retries, and missing delivery observations.

`inputs.jsonl` contains only a local neutral ID, raw Goal, and referenced observations. The generator receives only `goal` and `observations`; it receives neither ID, family, expectations nor this contract. `expectations.jsonl` is held separately and is not loaded into generator/judge prompts or candidate selection. Root opens it only after plans and model outputs are fixed.

The two Goal families are meaning-preserving compression and single notification delivery. The local comparison includes a preserved read-only exception, an omitted readback obligation, a legitimate retry after a final zero-effect observation, and insufficient observations after timeout/transport acceptance. Inputs describe no actual provider operation and confer no operation authority.

The proof asks whether Goal-specific questions can be constructed as data and passed through the shared evaluator without case-ID branches or a fixed six-axis catalog hiding a delivery-specific need. Missing evidence must remain UNKNOWN. Judgments, observations, diagnostic questions and effect authority remain distinct.

This is a four-case prospective functional/semantic check, not an independent population benchmark, statistical quality claim, real delivery proof, paid-trial continuation, reusable-Core admission, or product completion claim. Generation/judging uses only root's separately authorized bounded local proof route; the fixture author makes no provider calls.
