# Jev CLI

Ask Jev a question about text. The CLI reads one JSON request on stdin and writes one JSON line.

The [refactor design and phase gates](REFACTOR.md) describe the completed
Jev/TypeLLM split and the separate provider and consumer migration phases.

## Named questions (source API)

`askJevQuestions({state, questions, provider, signal?, deadlineMs?})` sends a
nonempty named map of Noul, Choice and Score questions in one POST. `state` is
a nonempty string or JSON object. Each question has `type`, `instructions` and,
for Choice/Score, the same `criteria` shape as the single-question client.
The caller supplies an already bound provider; this API reads no environment
or per-operation key and performs no retry. A deadline is optional and explicit
(an integer from 1 to 2,147,483,647 ms, within the native timer range).

The result is `{model, answers, usage?}`. Answers retain their names and types;
missing/extra names and invalid typed values are refused. Choice uses the
strict single-question contract (all probability keys, each in `[0,1]`), and
Score preserves the existing fractional range and exact legend contract.
Usage is limited to finite nonnegative `input_tokens`, `output_tokens`, and
`total_tokens`. Transport failures expose closed codes; `JevError` represents
input/auth errors and `JevContractError` invalid typed responses.

This is the first source slice: the old Worker ZIP still exposes its existing
named-choice/TypeLLM contract. The new named API becomes a distributed Worker
capability only in the later explicit artifact-contract phase. Its existence
does not mean apps has migrated or started using Noul.

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
(`jev-provider/1`, `named-choices-and-typed/1`, entry,
exports, empty import closure and the entry's byte length/SHA256).
Consumers verify locator/digest/contract/merged proof before import; refusal
must not fall back to source checkout, ambient resolution or a credential read.
Source input digests, the completed ESM digest, and a later app Worker digest
are distinct. Provenance records the core, batch adapter and assembly definition
as source inputs, never claims that bundled bytes equal source bytes. Old
Earlier `named-choices/1` and `named-choices/2` releases are retained. A consumer
must explicitly admit the new contract; old pins never silently gain generation.

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
# TypeLLM typed completion

`src/typellm.mjs` owns the TypeLLM transport and typed-answer contract. `bindTypeLLM`
captures one credential; `generateTyped({request, provider, signal})` returns only
validated `result`, optional token usage and elapsed seconds. The existing Worker
artifact exports `bindTypeLLM`, `generateTyped`, and `TypedProviderError` beside
its three existing Jev exports, with the explicit `named-choices-and-typed/1`
contract and TypeLLM source digest. The consumer supplies
the questions and their meaning. No generated operator, diagram mutation, retry,
environment lookup or credential is part of that domain API.

The intentionally small subset is a complete batch of string/enum, boolean,
integer, number, object and top-level bounded array questions. All object fields
are required, extra answer fields are refused, and arrays require `minItems` and
`maxItems` (at most 32). Conditional/resumable calls and nested arrays are outside
this contract. Requests are limited to 128 KiB; responses to 1 MiB; the 35 s
deadline includes response reading. Model/endpoint are fixed, thinking is off,
redirects are refused and each invocation sends at most once. Typed validity is
not evidence of semantic correctness or drawing quality.

Scalar and object questions may specify `depends_on: ["sibling_name", ...]`.
Names resolve in the same question map or containing object's properties;
forward references are allowed. Depending on an object includes all its scalar
properties, and an object's dependencies apply to all its nested properties.
The provider checks unknown names, duplicate references, self-dependencies and
cycles across the expanded scalar graph before sending. Existing 64-field and
depth-six bounds apply. Array dependencies, dependencies inside array items,
and arbitrary dotted paths are outside this subset; existing dependency-free
arrays retain their behavior. The service evaluates the dependencies within
the same single HTTP request; this core does not issue per-field calls or add
application meaning. See the [upstream workflow contract](https://typellm.ai/docs/workflows).
This capability alone does not prove a caller's candidate-generation quality.

Thinking is explicitly disabled on top-level scalar questions. Object/array
containers omit that scalar-only option and retain the API's default off on
their properties/items; callers cannot supply thinking options anywhere.
String enums accept 2–64 choices, or at most 26 inside an array item. These
bounds and container rules follow the
[upstream schema compiler](https://github.com/TypeLLM/TypeLLM/blob/deac4f40830a561adbbe5498d96aeb55107c7bbb/typellm/schema.py).

The existing `.#jev` package also installs `bin/typellm`. It takes one JSON request
on stdin and writes one JSON line. Only the CLI reads `TYPELLM_API_KEY`. Its exit
codes match the existing CLI classes: input 1, missing auth 2, provider 3,
typed-answer contract 4, internal failure 5. Error output contains closed codes
and, for HTTP failures, a numeric status; no upstream body or exception text.

## Local envs handoff

Author `TYPELLM_API_KEY` through the `dev.typellm-authoring` target in
[`roccho-org/envs`](https://github.com/roccho-org/envs). The OCI ciphertext is
`ciphertexts/dev-typellm-api.oci-dev.sops.yaml`, encrypted for the existing own
target identity. The private key stays on that target, mode 0600, owned by the
caller. Do not copy its value or the API key to the Windows workspace.

The sibling `jev.typellm` tool in `roccho-dev/windows/oci/dev/nix.nix` builds
`ops-typellm` explicitly; it is not added to a global profile. On the existing
own target, build it from a reviewed Windows commit with that commit's pinned
Nixpkgs, then feed a public request to:

```sh
/nix/store/<built-launcher>/bin/ops-typellm \
  --envs-sha <current-ciphertext-commit> --ops-sha <exact-ops-commit> < request.json
```

The launcher verifies envs ancestry/current ciphertext, the single field and
recipient, and the target identity. It builds the exact ops program before
decryption. Descriptor 3 hands the credential into one child, which has only
stdio descriptors, an absent HOME and a closed environment. The caller's stdin
remains the request; launcher diagnostics go to stderr. `ops-jev` keeps its own
credential and command. Source tests and this handoff do not establish API
availability, semantic effect or acceptance; those require separate live records.
