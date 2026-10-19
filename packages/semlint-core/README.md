# semlint-core

A pure Python library for comparing independent answers to the same explicit
fact across two or more named collections. Runtime dependencies: none.
Contract: `semlint.collections.v1`; package version: `0.1.0`.

This is the independent-fact collection contract, distinct from the existing
`packages/jev-review/semlint.mjs` subject/context/checks contract. It does not
replace or duplicate that evaluator, its provider, CLI, model or permission
system. No model is called by this package.

## Goal

Produce independent requests and compare supplied fact answers across named
collections, preserving incomplete and invalid evidence.

## Non-goals

No model invocation, provider, project admission policy or semantic truth claim.
The registered semlint-core-check command is a test harness, not a product CLI.

## Boundary and input

```text
semlint-core/
├─ pyproject.toml                 package/build metadata
├─ src/semlint_core/__init__.py   request bytes, grouping, validity and status
├─ tests/test_core.py             offline contract vectors and negative controls
├─ tests/run.mjs                  standard CI launcher for source and distribution checks
├─ tests/distribution.py         fresh-wheel contents and isolated installed-consumer check
└─ README.md                     public contract and limits

build/packages.jsonl             existing runtime/package declaration (Python)
build/checks.jsonl               existing source and distribution check declaration
```

A collection is `{id, units:[{ref, revision, text, sha256}]}`. Unit text is
original UTF-8; sha256 binds those exact text bytes. Units are ordered and joined
with exactly two LF characters. Nothing is normalized or truncated.
Collections have unique nonempty ids, at least two collections, and at least
one unit each. Empty text remains representable; the caller owns semantic input
sufficiency and applicability.

Facts are an insertion-ordered mapping `fact_id -> {question, choices, absent}`.
Each choices mapping contains at least two labels, including `cannot_tell`.
Choices descriptions are nonempty strings or nonempty JSON objects. Their nested
JSON may contain strings, integers, booleans, null, lists and objects; floats
and non-string object keys are rejected. `absent` is null or a choices label
other than `cannot_tell`. Every fact applies to every collection: applicability
is a caller precondition, never inferred from path or reference.

Relation is `{type:"equal"|"compatible"|"cover", edges:[]}`. Only cover has
edges, explicit ordered `[from,to]` pairs. Endpoints exist, differ, and each
collection participates in at least one edge. Duplicate edges are invalid.
Equal/compatible group all collections in O(n); deterministic label ordering
adds O(k log k) for k distinct stated labels. Cover examines only its declared
edges in O(|E|). There is no implied comparison between targets and no majority
vote. `reference` is null or an existing collection id, reporting metadata only.

The caller loads JSONL, rejects malformed lines, duplicate JSON keys and global
duplicate case ids, resolves named facts and units, and checks applicability,
secrecy, source trust, confidence, record schemas and budgets. This library has
no filesystem, network, environment, clock, provider or executor access.

## API

```python
plan_case(collections, facts, relation, reference=None)
judge_case(collections, facts, relation, answers, reference=None)
judge_slots(slots, facts, relation, answers, *, rejected=(), extra=False)
request_bytes(fact, text)              # shared serialization primitive
compare_answers(relation, absent, answers)  # admitted answers only
case_status(results)                  # nonempty result mapping -> case status
```

`plan_case` returns VALID or INVALID with coded issues. Invalid cases produce
no requests. Valid plans return:
- `slots[fact_id][collection_id] = request_sha256` (nested ids, no delimiter);
- `requests=[{request_sha256,request:bytes}]`, deduplicated by canonical bytes;
- `shared_observations=[{request_sha256,slots:[{fact,collection}]}]`, marking
  shared requests as the same planned observation, not independent corroboration.

Canonical bytes are UTF-8 compact JSON with recursively sorted keys:
`{type:"choice",text,question,criteria}`. No id, path, revision, reference,
absent label, owner, expected result or Gold enters a request. Request order is
first occurrence in declared fact/collection order. Dict insertion order is not
a substitute for global JSONL validation.

`answers[fact_id][collection_id]` contains `request_sha256` and:
- OBSERVED: `raw` in that fact's choices and nonempty `model`;
- UNKNOWN: `raw:null`;
- ERROR: `raw:null,error:"evidence_invalid"|"execution"`;
- NOT_RUN: `raw:null,cause:"stopped"|"not_asked"|"omitted"`.

Core binds each answer digest to the planned slot. The caller additionally
binds whole sendables, confidence, schema, source/pin identity and stored evidence.
`compare_answers` is a lower-level primitive for already admitted answers;
use `judge_case` for slot, choice and digest validation. Non-string OBSERVED
labels raise the typed `InvalidCase`, never an untyped comparison error. It does not rebind old
records to a new current measurement. Shared-request metadata imposes no new
rejection condition on previously admitted observations.

`judge_case` returns `{status,results,findings,admission,exact,shared_observations}`
(or INVALID with issues and empty requests/results). Results retain every fact
and every declared edge. Findings retain stated-label groups and an
`observed_conflict` flag even when another answer is missing, invalid, UNKNOWN
or NOT_RUN. Groups exclude absent and cannot_tell and sort by label; members
keep declared collection order for equal/compatible and from→to order for cover.

`admission[fact_id][collection_id]` is valid, missing or invalid for each
declared slot. A valid stored ERROR is distinct from an invalid synthetic ERROR.
A consumer that displays only fully admitted comparisons filters by this map;
it does not repeat core answer validation. Extra slots still make exact false.

Validity priority for each fact/edge is UNKNOWN > ERROR > NOT_RUN >
CANNOT_TELL. Missing/extra/malformed/digest-mismatched slots make the case ERROR;
a valid UNKNOWN still takes precedence. Declared NOT_RUN is INCOMPLETE.
Edge validity is local to its two endpoints.

| Valid observed answers | equal | compatible | cover from→to |
|---|---|---|---|
| Same stated label | AGREE | AGREE | AGREE |
| Different stated labels | CONFLICT | CONFLICT | CONFLICT |
| One stated label plus absence | ONE_SIDED | COMPATIBLE | GAP if only from states; otherwise ONE_SIDED |
| All absent | NEITHER | COMPATIBLE | NEITHER |

Case priority is UNKNOWN > ERROR > INCOMPLETE > CONFLICT_CANDIDATE > REVIEW >
NO_CONFLICT_ON_SELECTED_FACTS. The last status means no conflict on these selected
facts, never semantic correctness or completeness of the project. Empty result
sets are ERROR. Multiple observed models downgrade only the last three evaluated
states to INCOMPLETE. Confidence is never a decision weight.

## Metadata-only record judgement

`judge_slots` accepts the nested `slots` map from a pre-admitted project plan:
every fact declares the same ordered set of at least two collection ids, with
lowercase 64-hex request digests. Facts and the relation are validated as above.
The caller owns digest-to-text provenance; this entry does not reconstruct or
read text. `judge_case` still binds text through `plan_case`. Both entries use
one internal judge for admission, findings, status and the mixed-model rule.

`rejected` lists declared (fact, collection) pairs refused by project-specific
admission (for example confidence or whole-sendable identity); each must be
absent from answers. Duplicate, undeclared or simultaneously answered/rejected
slots are INVALID. A rejected slot is invalid, distinct from missing. The strict
boolean `extra` reports additional record slots that the caller cannot map:
it makes exact false. Both metadata inputs only demote; valid UNKNOWN still
takes precedence over a non-exact record. They never fabricate source or answers.

## CI registration

The existing build JSONL declares the Python runtime and generated
`semlint-core-check` test command. The existing generated check runs
`tests/run.mjs`, which directly invokes that command with `--source` and
propagates its output and failure. It then runs `tests/distribution.py` with
the declared Python and uv tools. No purity rule, flake or workflow is changed.
The two gates test source mechanics and the actual fresh distribution separately.

## Offline validation and distribution

From this package directory, with the existing Python (no key or provider):
```sh
python3 -I -B tests/test_core.py --source
python3 -B tests/distribution.py
```

Only the explicit test-only `--source` option adds `src` to the test harness
import path. The installed-wheel test has no import fallback. Consumer code uses
the installed package, including under `python -I`.

The distribution check uses standard offline `uv build`, `uv venv` and
`uv pip install`, with an explicit existing Python and Python downloads disabled.
It builds into a fresh test directory and reads every wheel entry. For this
package's current single-module layout, the only file payloads are the module,
METADATA, WHEEL and RECORD; the two ordinary empty directory entries are allowed.
Module bytes match source, metadata fields match `pyproject.toml`, its body is
the exact README, and RECORD hashes and sizes bind every payload.

Three synthetic in-memory payload changes must fail specifically for a changed
README body, changed module bytes or an extra entry. They are never installed.
Only the normal fresh wheel is installed into a fresh virtual environment.
The check confirms the actual imported module and distribution metadata are
inside that environment and match the wheel/source, then runs the unchanged
core tests with `-I -B`, without `--source` or an import fallback.

This is a package-specific regression check, not a general wheel safety verifier.
Its closed metadata/header and payload expectations describe this declared
package layout. It neither reuses an old wheel nor inspects a consumer project.
Test directories are retained for inspection; the check never recursively
deletes them. The normal Nix/CI workspace owns their lifetime.

Consumers pin the merged package revision and `packages/semlint-core`
subdirectory in their lock. Offline installation requires that revision and a compatible
build backend. uv uses its bundled backend when it satisfies the declared range;
otherwise the required backend must already be available offline. Where source verification is required, verify
the installed module bytes; a package version alone does not prove exact source
bytes. Missing dependencies or a wrong core identity fail closed.

These tests prove deterministic mechanics and package consumption for declared
examples. They do not measure model accuracy, unknown-case coverage, savings or
the completion of a consumer's migration. The registered upstream check now runs
both source and fresh-distribution checks; bind both results to the exact source
head and report unavailable or unrun checks separately.
