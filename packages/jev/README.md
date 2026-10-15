# Jev CLI

Ask Jev a question about text. The CLI reads one JSON request on stdin and writes one JSON line.

Intentionally narrow subset: string `text` and `question` fields; choice questions support 2-255 string-valued options; score questions support 2-10 string-valued levels. The underlying API may support richer data types; CLI constrains input to string values only.

```sh
nix build .#jev
```

## Legacy compatibility usage

The envctl examples below document the older auxiliary interface, not current
normal application acceptance. The target owner supplies an opaque credential
through its approved one-child entry; this package does not acquire or decrypt it.

Set `ENVS_BUNDLE`, `SOPS` and `AGE_KEY_FILE` to absolute paths for the envs auth bundle, sops executable and age identity:

### Noul

```sh
printf '%s\n' '{"type":"noul","text":"A lamp is on.","question":"Is the lamp on?"}' |
  envctl auth exec -bundle "$ENVS_BUNDLE" -environment local \
    -artifact "$PWD/result/share/jev/artifact.jsonl" \
    -sops "$SOPS" -age-key-file "$AGE_KEY_FILE" -- "$PWD/result/bin/jev"
```

Response: `{"model":"...","noul":0.99}` (noul in [0,1]).

### Choice (2-255 options)

```sh
printf '%s\n' '{"type":"choice","text":"...","criteria":{"a":"option a","b":"option b"},"question":"Pick one"}' |
  envctl auth exec ... -- "$PWD/result/bin/jev"
```

Response: `{"model":"...","choice":{"type":"choice","choice":"a","probabilities":{"a":0.8,"b":0.2},"confidence":0.9}}`.

### Score (2-10 levels)

```sh
printf '%s\n' '{"type":"score","text":"...","criteria":["low","medium","high"],"question":"Rate it"}' |
  envctl auth exec ... -- "$PWD/result/bin/jev"
```

Response: `{"model":"...","score":{"type":"score","score":1.05,"legend":{"0":"low","1":"medium","2":"high"},"probabilities":{"0":0.1,"1":0.85,"2":0.05},"confidence":0.92}}`. Score is fractional [0, levels-1]; legend and probabilities keys are 0-indexed.

## Exit codes

- 0: success
- 1: input error (invalid JSON, missing fields, invalid types)
- 2: authentication error (missing or empty JEV_API_KEY)
- 3: provider error (unreachable, HTTP error including transient 503, unparseable response; no automatic retry)
- 4: contract error (invalid response structure)
- 5: internal error (fatal)

## Credentials

The installed artifact requires `jev-api`; the selected envs environment must supply its binding. `envctl` injects `JEV_API_KEY` into the CLI child process. Installing or merging this package does not provision a credential. Pass no key in arguments or stdin.

## Worker-compatible named-choice provider

CLI and Worker adapters share one credential-bound auth/HTTP core. The
`jev-worker-esm` output is a self-contained completed ES module, not the CLI.
`bindJev({apiKey, fetch?})` is the only binder: a frozen capability with
non-secret `available` and `post`. Each target composition binds once; normal
operations carry no key. Availability is not real authentication success.
The old exported client per-call key interface remains a compatibility bridge;
the CLI normal path does not use it. Legacy calls retain their absence of a
new deadline; the batch adapter selects its existing ten-second deadline.
Known raw transport exception details are not reflected by either adapter.
The old CLI request/response shape and its strict probability validation remain
unchanged. It has no application slot/action constants and no apps source input.

`judgeNamedChoices({request, provider, signal?})` receives:

- `request.state`: an object supplied by the caller.
- `request.questions`: a nonempty map of neutral names to
  `{instruction: string, options: {key: string}}` descriptors (2–255 choices).
- The pre-bound capability and optional cancellation signal; no per-call key.

It performs one POST for the whole named batch, with one ten-second deadline
covering headers and body. The normalized result is
`{answers: {name: {choice, confidence, probabilities?}}}`: no wire `type`,
raw model, endpoint, header or credential is returned. Apps must independently
check its own exact slot/choice meaning and retain its existing low-confidence
no-change threshold; a confidence below 0.5 is not a provider contract error.
Top-level provider extras and any model string remain accepted; unknown answer
fields are refused. Probabilities remain optional/subset finite values,
including finite values outside [0,1], independently of the unchanged CLI.

Errors contain only a closed code: `auth_missing`, `input_invalid`,
`provider_unavailable`, `provider_http_error`, `provider_invalid_response`,
`provider_contract_error`, `provider_timeout`, or `cancelled`.
No retry occurs. Fixture tests are mechanical evidence, not live Jev success.

### Exact artifact handoff

`nix build .#jev-worker-esm` produces one deterministic ZIP containing only
`batch.mjs` (producer-bundled core and adapter) and a manifest
(`jev-provider/1`, `named-choices/2`, entry,
exports, empty import closure and the entry's byte length/SHA256).
Consumers verify locator/digest/contract/merged proof before import; refusal
must not fall back to source checkout, ambient resolution or a credential read.
Source input digests, the completed ESM digest, and a later app Worker digest
are distinct. Provenance records the core, batch adapter and assembly definition
as source inputs, never claims that bundled bytes equal source bytes. Old
`named-choices/1` assets are retained and are not silently accepted as /2.

The narrow `jev-provider-release.yml` verifies the actual ZIP entry, preserves
old CLI tests, and reuses unchanged reviewed-merge proof/selftest/workflow lint.
Only an explicit proposals publish dispatch can create
`jev-provider-<exact-merge-SHA>` with exactly four assets:

- `jev-provider.zip`
- `jev-provider.zip.sha256`
- `merged-pr-proof.json`
- `provenance.json`

Publication requires the current canonical push nix-check, latest nondismissed
exact-head Green review and equal reviewed/merged trees. Its write job performs
no Nix build and compares a re-download byte-for-byte; existing assets are never
overwritten. This is unsigned, shared-principal review/provenance evidence,
not a provider signature or host immutability guarantee. A PR build is not
formal supply. Old artifacts/real receipts do not transfer to a new identity.


## One-question multiple selection

The source package exports `judgeMultiSelect` from `jev/multi-select`. It accepts
one state, one question stem, a nonempty map of candidate IDs to nonempty string
descriptions, explicit thresholds, and the existing bound provider:

```js
import {judgeMultiSelect} from "jev/multi-select";

const result = await judgeMultiSelect({
  provider, // the target's existing bindJev capability
  request: {
    state: "DEV requires MFA. STG requires an assumed role.",
    question: "Which conditional authentication requirements are explicitly stated?",
    choices: {
      dev_mfa: "DEV requires MFA.",
      stg_role: "STG requires an assumed role.",
      dev_role: "DEV requires an assumed role.",
      stg_mfa: "STG requires MFA.",
    },
  },
  thresholds: {reject: 0.2, accept: 0.8},
});
```

This is a composition of independent [Noul questions](https://docs.typesafe.ai/primitives/noul),
one per candidate, sent in one POST against the same state. It uses the existing
transport's ten-second deadline and cancellation, without retries. The request
uses the existing `jev-latest` default; the resolved response model is retained.
It is separate from single-option Choice and the named-choice Worker artifact.

Question and candidate text are preserved verbatim, including conditions.
Candidate IDs are opaque metadata, mapped to neutral wire question IDs and
returned safely even for IDs such as `__proto__`. Output IDs are sorted by
JavaScript string comparison. State accepts JSON strings, objects and arrays,
with nesting depth at most 64;
non-JSON values, cycles, accessors and implicit `toJSON` conversions are refused.
Empty text remains representable; its applicability and sufficiency belong to
the caller. Structured candidate descriptions are outside this adapter.

A successful result has:

```text
{
  observation: "OBSERVED",
  status: "COMPLETE" | "REVIEW",
  model,
  scores: {candidate_id: raw_noul},
  selected: [...],
  notSelected: [...],
  undecided: [...]
}
```

For finite thresholds `0 <= reject < accept <= 1`, a score at or above
`accept` is selected, at or below `reject` is not selected, and a score
strictly between them is undecided. These are score classifications. A low
score does not prove logical negation or source absence. Threshold quality is
not calibrated by this package.

`OBSERVED` means every candidate's valid score and the nonempty resolved
model were received. `COMPLETE` means no candidate remains undecided;
`REVIEW` preserves successful observations needing a decision. Neither means
semantic correctness. An empty selected set is `COMPLETE` only when every
candidate is classified as not selected. All candidates may be selected.
Exclusivity and cardinality constraints are caller policy.

Invalid input throws the existing `JevError("input_invalid")`; unavailable
binding throws `auth_missing`. Missing, extra or malformed decoded answers,
out-of-range scores and a missing model throw `JevContractError` for the
whole observation. Existing typed transport errors retain their identity.
Failures never return a successful empty set or partial selection. The caller
records ERROR, UNKNOWN or NOT_RUN as appropriate; this adapter does not invent
those source or execution states. The existing transport parses with
`response.json()`: duplicate raw JSON keys cannot be recovered or detected
here. Exact decoded keys and candidate mapping are checked.

Keep different collections in independent states. For C collections with N
candidates each, calling this function once per collection makes C POSTs and
asks C × N Noul questions. It does not combine collections into shared context
or imply C internal model evaluations. JSONL loading, looping over all cases,
block extraction and comparison relations remain caller concerns.

Offline tests use synthetic responses to verify transport count, mapping,
thresholds, retained uncertainty and failure handling. Decoder order tests do
not establish model order invariance. This addition has no live quality,
latency, token-cost or savings measurement.
