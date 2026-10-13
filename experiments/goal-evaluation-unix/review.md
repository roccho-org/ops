# Independent prospective review — baseline

The fixture/expectation author `/root/semlint_adrs` reviewed the fixed plans before reading judge outputs, then independently compared all outputs with the unchanged prospective expectations. The author did not implement the engine, call providers, repair plans, or alter inputs/Gold after outputs.

## What was observed

The finite proof used four synthetic cases from two Goal families. Root recorded native Claude CLI generation at source `a34b11fe686b937d197c1331d0bd3998880bbb22` and judging at `a5cdff1144edd2b89bdfc6d067e6bb75b17f1ddd`. The independently inspected source difference adds one validation call after the empty-plan fallback; it does not change the frozen questions. The recorded model label is `claude-opus-5-5`; this is the provider/adapter-reported label, not an independent claim about hidden provider execution.

`results/provider-plan.jsonl` records four successful CLI exits and `results/provider-judge.jsonl` records seven. Requests contain no held expectation fields. Generation requests have `goal, observations, cores, maxQuestions`; judging requests have `text, instructions, criteria`. The two input/Gold SHA-256 observations still match the pre-output values reported by the fixture author.

The plans contain two reused question instances and five generated instances. All seven questions, including all three UNKNOWN judgments and the questionable deduplication criterion, remain in the results. No execution-error result was observed. Every question ID matches its plan and every missing-evidence item is preserved. All four results retain `goalCoverage=NOT_CERTIFIED` and `authority=false`.

| Case | Question | Actual label | Independent comparison |
|---|---|---|---|
| q17 | q1 — preserve source decisions | ok | Matches: pre-approval, post-publication readback and read-only exemption are retained. |
| w42 | q1 — preserve source decisions | problem | Matches: post-publication readback/result confirmation is omitted. |
| w42 | q2 — preserve readback obligation | problem | Matches the same omission; this overlaps q1 and is not a second independent example. |
| r28 | q-exactly-once-delivered | ok | Matches: terminal initial zero effect, one delivery on retry and complete destination log agree. Two attempts are not falsely treated as two deliveries. |
| n53 | q-delivered-count | unknown | Matches: timeout/accepted do not establish actual destination delivery count. |
| n53 | q-first-attempt-outcome | unknown | Matches: the initial destination effect was not observed. |
| n53 | q-dedup-mechanism | unknown | The missing mechanism information is accurately reported, but the question's mandatory criterion is not justified by the Goal; see defect below. |

All four **case-level qualitative outcomes** agree with the fixed expectations. This does not mean all generated criteria are appropriate.

## Retained negative findings

**F1 — an implementation method is promoted into a required Goal condition.** In n53, `q-dedup-mechanism.criteria.problem` treats absence/non-use of an identifier-based deduplication mechanism as a problem. Its second missing item says that this mechanism information decides whether retry can still deliver once. The Goal requires one actual delivery, not a particular deduplication design. Confirmed terminal zero effect followed by one retry is a legitimate alternative, as r28 demonstrates. A deduplication question can be an advisory hypothesis, but this plan does not mark it optional or conditional and its criterion/reason present it as necessary. A later observation proving one delivery could therefore leave an unjustified extra block. The correct final UNKNOWN for n53 must not hide this plan-quality defect.

**F2 — overlapping questions add burden.** In w42, reused q1 already covers omission of the readback obligation; generated q2 evaluates that omission again. A focused diagnostic may be useful, but the proof does not establish additional value for the extra call. Seven judgments are not seven independent cases.

**Scope limit — shortening is a mechanical check.** The two compression plans focus on meaning preservation. The Goal also asks for shorter text. The fixture author's direct string-length observation is 69 characters for the source, 46 for q17 and 30 for w42. This is ordinary Program evidence, not an additional semantic-model achievement. A missing generated length question should not force another model call; the overall Goal clause still needs this separate evidence. The engine correctly does not certify whole-Goal coverage.

## Cost and meaning of this proof

CLI-reported cost is USD 0.1676722 for generation and USD 0.105328 for judging, totaling USD 0.2730002. Native HTTP-call counts and invoice cost are unavailable in the recorded accounting, so CLI invocations must not be called exact native API-call counts or billed totals.

The proof supports a small functional claim: raw Goals plus observations can produce reusable or novel questions as data, and the same judgment interface can evaluate both meaning-preservation and delivery-specific questions while retaining missing observations. It also exposes a concrete criterion-generation defect. It does not establish general Goal discovery/coverage quality, independent population performance, actual notification delivery, reusable-Core admission, or completion of ops#523/#524.

Any prompt repair is a new prospective trial with separately fixed inputs and expectations. This baseline, its questions, missing items and negative findings remain intact.
