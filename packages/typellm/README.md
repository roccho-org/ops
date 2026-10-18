# TypeLLM

Independent typed generation. The caller supplies the request's meaning;
TypeLLM validates the bounded typed-answer contract. It imports no Jev module.

```sh
nix build .#typellm
nix build .#typellm-worker-esm
```

`bindTypeLLM({apiKey, fetch?, deadlineMs?})` binds one credential once.
`generateTyped({request, provider, signal?})` returns validated `result`,
optional token usage and elapsed seconds. `TypedProviderError` carries closed
codes and, for HTTP failures, a numeric status. No upstream body, key, thinking
or raw exception is reflected. No retry occurs.

## Contract

The existing subset is preserved: string/enum, boolean, integer, number,
object and top-level bounded arrays. All object fields are required; extra
answer fields are refused. Arrays require `minItems` and `maxItems` (at most
32). Nested arrays and conditional/resumable calls remain outside the subset.
Requests are limited to 128 KiB, responses to 1 MiB. The default 35 s deadline
covers response reading. Endpoint/model are fixed; redirects are refused.

Scalar/object fields may declare `depends_on` sibling names. Object dependencies
expand over their scalar leaves. Unknown/duplicate names, cycles and unsupported
array dependencies are refused before sending. The existing 64-field and
depth-six bounds remain; the service executes the declared dependencies in one
HTTP request. Thinking defaults off for top-level scalars and is omitted on
object/array containers. String enums admit 2–64 choices,
or at most 26 inside array items. Typed validity is not semantic correctness.

A top-level scalar may opt in with `thinking: true` and an explicit integer
`thinking_budget` from 1 to 4096. The budget is required when enabled; a budget
without enabled thinking is refused. `thinking: false` accepts no budget.
Nested fields, containers, `auto` and `thinking_effort` remain outside this
subset. Existing request bodies keep their exact default-off wire behavior.
The endpoint, model, 30 s service timeout and one-send policy do not change.
Only typed results and numeric usage/elapsed metadata are returned; reasoning
text is still discarded. More accuracy is not guaranteed. See the official
[thinking contract](https://typellm.ai/docs/thinking).

The CLI reads one bounded JSON request on stdin and writes one JSON line. Only
this CLI reads `TYPELLM_API_KEY`. Exit classes are input 1, auth 2, provider 3,
typed contract 4, internal 5. The auth declaration requires `typellm-api`;
installing/building the package does not supply a credential.

## Independent distribution

`typellm-worker-esm` produces a self-contained `typellm.mjs` and deterministic
`typellm-provider.zip`. The manifest is `typellm-provider/1`, contract
`typed-completion/1`, and exports exactly `TypedProviderError`, `bindTypeLLM`,
`generateTyped`. There is no Jev source/runtime dependency.

The [existing shared release workflow](../../.github/workflows/jev-provider-release.yml)
builds and executes each independent archive entry. One public release contains
both ZIPs, their checksums and separate provenance, plus one common merged-PR
proof. The write job builds nothing, preserves old assets, and byte-compares a
re-download. Consumers explicitly adopt the new contract; old combined pins do
not change. Source tests and local ZIPs are not public supply or live evidence.

## Existing local credential handoff

The existing envs `dev.typellm-authoring` target and target-private identity
remain unchanged. Do not copy the API key/private identity to Windows or pass
them in arguments. The Windows `oci/dev` launcher currently builds `.#jev`
and invokes `bin/typellm`; that installed compatibility entry now symlinks to
this independent package. No Windows launcher edit or credential migration is
needed for this producer split. A new direct consumer may build `.#typellm`.

The existing launcher still verifies its exact ops/environment inputs before
decrypting and delivers the credential only to one closed child. This refactor
does not authorize new keys, budgets, paid calls, runtime placement or admission.
