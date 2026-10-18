# Optional typed proposal relations

`bindTypeLLMExecutorPorts({ ..., proposalFormat: 'typed-relations-v1' })` opts a caller into a different proposal wire. Omission or `json-string` retains the existing JSON-in-string builder, request, parser and receipt shape. The HTTP proposal port, SDK, Core, production defaults and all existing budgets are unchanged.

The new pure exports are `buildTypeLLMStructuredProposalRequest(prompt)` and `assembleTypeLLMStructuredProposal(result, prompt)`. They prepare or assemble ordinary data; neither calls a model. The latter returns a frozen `{ candidate, metadata }`; Core must still validate the candidate.

The existing SDK permits only top-level arrays. The wire therefore has seven typed arrays: clauses, questions, questionClauseLinks, basisLinks, requiredLinks, needs and missing. The recursive SDK field count is 27 with an empty core catalog, 29 otherwise: clauses 5, questions 7 or 9, four relation arrays 3 each, missing 3. Item object containers add no named field. No array dependencies are added; the SDK forbids them. Independent fields can still produce incoherent references.

Clause ids must already be c1,c2,... and question ids q1,q2,... in emitted order. These are output ids, never replacements for original Goal/observation refs or supplied core ids. Relations attach to an exact emitted question id in emitted relation order. Unknown/orphan emitted question/clause ids, duplicate ids or per-question relations, surplus fields and overflow fail closed. The assembler never renames ids, deduplicates, clips, parses an embedded JSON string, or repairs output. Core still checks exact quotes, original refs, obligation linkage, Goal basis and adopted core question/criteria.

With an empty core catalog, no non-null Core can be valid. The constructor therefore omits hasCore/coreId from the question schema and the assembler sets core:null; extra generated core fields are rejected. This uses no generated content or semantic choice. With a nonempty catalog a question carries boolean hasCore and string coreId. False requires the empty coreId and maps only to null. True requires an exact supplied core id and maps only to that string. A nonempty id with false is rejected rather than discarded. A provider unable to return the required empty string can still fail this nonempty-catalog contract; there is no repair. Criteria retain their original three-property object.

Caller maxClauses/maxQuestions are copied into their array limits; 1..32 is supported. Core defaults remain 16/4, and legal Core limits above 32 are unsupported by this opt-in, not silently lowered. Each of the four relation arrays and missing has a fixed total limit of 32 across all questions. Thus at most 224 rows are representable with 32/32 caller limits, or 180 with 16/4. These aggregate relation limits can be insufficient even when individual questions fit. Every SDK string leaf remains limited to 2048 UTF-16 units; total structured proposal size is no longer limited by one string. Core's byte limits, the SDK 131072-byte prepared request limit, its 8192-unit instructions limit, the executor's 1MiB normalized output bound and transport/argv bounds remain separate and unchanged.

Only typed receipts add proposalFormat, structuredFieldCount, structuredArrayLimit, structuredRows, saturatedArrays and structuredCoverage. Their status is STRUCTURED_ASSEMBLED, not JSON_PARSED or Core-valid. proposalBytes/proposalSha256 describe the assembled candidate JSON; proposalUnits stays null. The existing normalized response digest describes the typed response separately. Coverage is always UNKNOWN, including when no array is saturated. Saturation marks a representational warning; it cannot establish whether content was omitted. No completeness, fit, fidelity, model identity, utility, G1/G2 or provided-lane success follows from assembly.

Current [TypeLLM API documentation](https://typellm.ai/docs/api) separately states a 128-token string-answer limit and larger hosted array limits. The local SDK's 2048-unit validation and 32-item arrays remain governing local checks. The failed first live string proposal is retained; its actual finish cause was not observed. This source change neither retries it nor proves a future typed call will be coherent. An exact input quote or other field too long for a leaf remains unsupported; do not summarize or split away its meaning to fit.

Any future finite experiment must separately pin its local builder/executor source and remote CLI/SDK source, establish actual request/transport receipts and bounds, and preserve the original comparison/sealing requirements. No runtime, credential, launcher, profile or private case is changed by this slice. The new request schema adds bytes, so an old request-size or Windows argv estimate is not a new admission proof.

## Explicit provider timeout

`bindTypeLLMExecutorPorts` accepts the optional `requestTimeoutSeconds: 60`. When supplied, it adds `timeout: 60` to the typed request before freezing, hashing and dispatch. The SDK accepts only this explicit value; all other explicit values, including 30, 90 and undefined, fail before provider dispatch. Omitting the option preserves the previous request serialization and the existing SDK wire timeout of 30 seconds. The independent HTTP proposal/model ports do not acquire a new option.

The CLI consumes that same typed request: an explicit 60-second provider timeout selects a 65,000 ms local provider deadline; an omitted timeout retains 35,000 ms. Existing output and opt-in metadata frames are unchanged. Remote CLI/SDK source must support the option: changing the local caller alone does not update the remote body. Pin and accept the actual rebuilt remote source/output separately, and repeat offline typed-request/body identity checks before a new finite live call.

This does not alter Core input or Plan limits, seven-array limits, per-string limits, request size, Jev provided admission, model identity or coverage status. A 65-second provider deadline leaves only a finite interval inside the existing 95-second outer limit; successful completion is not guaranteed. A 90-second option is unsupported. HTTP 504 remains a reported provider HTTP error, with backend execution, its precise timeout cause, billing and remote effects unproven; no automatic retry is added.


## Opt-in dependent relations

Set the existing executor port's proposalFormat to typed-relations-dependent-v1,
which calls buildTypeLLMStructuredProposalRequest(prompt,
 'typed-relations-dependent-v1'). Omitting this option keeps json-string;
typed-relations-v1 and both existing request/wire encodings are unchanged.
The new format keeps the same seven arrays, native assembly and 27/29 field
counts. It adds exactly two dependency layers:

- clauses and questions independently read the complete original context/Goal.
- questionClauseLinks, basisLinks, requiredLinks, needs and missing each depend
  on both actual clauses and questions. No item-level or nested-array dependency
  is introduced. missing does not see the other relation answers.

The SDK treats a top-level array as one atomic dependency node, and accepts it
as a target. Unknown names, duplicate dependencies and scalar/object/array
cycles are rejected before transport. Existing 32-item, 64-field, 2048 UTF16
answer, 8192 UTF16 instruction and 131072-byte request guards remain unchanged.
The optional timeout remains 60 seconds for the whole request; dependency
layers do not reset that deadline. Old defaults remain 30/35 seconds.

The new quote instruction asks for an unchanged contiguous substring of the
decoded original ref.content, rather than JSON serialization escapes. This
does not certify semantic selection or coverage. Nothing normalizes, repairs,
clips, substitutes refs, invents links or reaccepts a prior failed candidate.
Core still validates exact quotes, supplied refs and obligation links. Empty
questions/all-missing remain legal; relation minItems remains zero. A question
without a legitimate obligation link is rejected, rather than given one by
the assembler. The exception/alternative/unknown and missing-limit instructions
remain intact.

This addresses a source capability gap: without depends_on, independent
service fields do not see sibling answers. It does not establish the sole
cause of any prior failed response. Successful assembly, unsaturated arrays,
or a dependency declaration never proves coverage/fidelity/utility. Saturation
and structuredCoverage: UNKNOWN remain in receipts. Real service execution,
per-layer latency, backend inference count and total cost require separate
finite evidence; one HTTP request does not establish those counts or fit.
Sources: https://typellm.ai/docs/workflows and
https://typellm.ai/docs/output-types (top-level arrays and their dependencies).
