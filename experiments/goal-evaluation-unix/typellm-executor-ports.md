# TypeLLM ports over an existing typed executor

The Core and its ports can run without receiving the TypeLLM key. A caller supplies executeTyped(request, {signal, callId}) as a real capability to invoke the existing target-owned fixed CLI. The key remains inside that CLI child. This module neither launches a command nor reads credentials. It does not use a fake key or fabricate an HTTP Response to route through fetch.

## Shared requests and existing validation

buildTypeLLMProposalRequest and buildTypeLLMNativeQuestionRequest share snapshot and typed request construction with the existing HTTP ports. Existing HTTP behavior remains supported. The executor bridge uses generateTyped with an explicit provider.post capability: the SDK prepares and validates its request/body/instructions, the real callback executes the frozen typed request, and the SDK validates returned answers, usage and elapsed values. available=true means the callback was supplied; it is not proof of authentication or provider readiness.

The SDK-prepared body is a preflight derivation, not an observed HTTP request. No HTTP is sent by this module. Its callback returns the existing CLI normalized object with result and optional usage/elapsed. Additional top-level fields are refused. Serialized callback output is limited to 1 MiB; SDK answer and usage checks still apply. Proposal strings are parsed without repair and then validated by Core. The actual three-label answer is returned with the UNKNOWN identity sentinel and null rationale.

## Finite slots and cancellation

The factory requires explicit id, mode (live or test-double), executorId, bindingSha256, UUID runId, deadlineMs (1..95000) and executeTyped. It accepts no apiKey or fetch option. maxCalls is 1..4, default 4. One proposal plus at most maxCalls judgments can consume slots: at most five executor dispatches. Slots are consumed before validation or any await. A failed validation consumes its slot. Extra calls are refused before request capture and append no receipt; callers retain those refusals separately.

A pre-aborted request invokes no executor. A local deadline or cancellation settles local waiting and signals the callback. It does not prove that a remote process, provider call or billing stopped. A late callback result cannot replace the frozen failed receipt or trigger a retry. All dispatched remote effects remain UNKNOWN in this port; real transport evidence is separate.

## Call and transport evidence

callId is runId/kind/sequence and is passed only in callback options, never in the model request. The caller must precommit a unique runId and must not reuse it across factories or runs. This factory guarantees call identity within its own lifetime. The real executor must preserve the same callId in its actual transport receipt and reject duplicates; this module does not claim a global ledger.

Typed request bytes/SHA cover JSON.stringify of the frozen callback request. Normalized response bytes/SHA cover JSON.stringify of the successful SDK-normalized response. These are not actual stdin/stdout or HTTP wire digests. Proposal-string and answer digests also differ from Core planDigest. HTTP attempts and wire SHA are null because they are unobserved here. Model identity remains UNREPORTED in the current normalized interface; the requested typellm-latest alias is not a backend revision or evidence of equal models.

executorId and bindingSha256 are DECLARED_ONLY metadata. Before accepting any real result, the caller must join the same callId and typed request digest with actual stdin/stdout bytes/SHA, exact target and source pins, process exit/signal, and the actual CLI invocation. Unknown completion requires readback and no blind resend. The caller retains original failure output privately; this port exposes sanitized codes only.

## Remaining closure

Supplying a fake executor proves synthetic contracts only. The actual existing CLI invocation and its target binding must still be implemented/admitted and observed. The target-owned launcher source is not by itself a Core-to-provider execution proof. No key copy, new credential consumer, new daemon, server, session, workflow or Core is introduced here. The original Jev/provided/three-lane constraints, actual G1/G2 results and product-triggered idle return to the exact original P remain separate requirements. web.chat and periodic automation remain paused.
