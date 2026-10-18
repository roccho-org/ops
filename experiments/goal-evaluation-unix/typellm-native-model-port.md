# Experimental TypeLLM native ModelPort

This port connects the existing three-label Core judge to the existing TypeLLM SDK. It is a separate native method. It does not establish production admission through Jev/project/async preparePlan, replace the original three comparison lanes, or prove G1, G2 or product return to the same P.

## Input and finite calls

Bind with an explicit id, mode, apiKey and deadlineMs. The port reads no environment variables. test-double requires a supplied fetchImpl; live may use the existing global fetch. deadlineMs is an integer from 1 to 95000. maxCalls is an integer from 1 to 4, default 4. Each which invocation consumes one slot before validation. An exhausted port refuses more calls; it does not retry.

which accepts exactly text, instructions and criteria. All three criteria (problem, ok, unknown) and their text must be present. The full original text travels unchanged as context. The question and all criteria travel in instructions. No clipping, translation, output repair, or implicit evidence selection occurs. The SDK separately enforces its actual encoded 131072-byte HTTP body, 8192 UTF-16 instruction units, response cap and deadline. A Core maxBytes value is a separate preflight bound, never proof that the HTTP request fits. Jev's existing limits remain unchanged.

## Answer and model identity

The actual returned enum label becomes label. Rationale is null because this enum request does not ask the provider for one. The provider's normalized response does not report its actual model ID. Core currently requires a nonempty model string, so the adapter returns the reserved identity sentinel UNKNOWN. This is distinct from the answer label unknown.

Every report must travel with the port's same-call receipts. Each receipt binds sequence, questionSha256, actual wireRequestSha256 and answerSha256, and records requestedAlias=typellm-latest, reportedModel=null and identityStatus=UNREPORTED. requestedAlias is a request declaration. It is not an observed model identity. Consumers must reject actual-model equality claims when identityStatus is UNREPORTED; two UNKNOWN strings do not prove the same model. A bare Core report cannot certify identity.

Receipts contain transport attempts, usage returned by the service, elapsed values and sanitized failure codes. Usage is not an independent measurement of hidden model state or total operator/financial cost. A failed or refused call remains failed; no empty answer or fabricated unknown verdict is substituted.

## Evidence boundary

Synthetic tests demonstrate the port contract only. Real input privacy, independent expectations, full needs and unassessed observations, actual provider execution and exact entry/version bindings require their own evidence. Direct Sys2 input must exclude planner output, generated questions/criteria, judgments and Gold. G2 requires the revised procedure to be consumed under the previous failure conditions and its result observed. Return to P requires the exact original session/thread, a product trigger and actual consumption, not a manual message or another Codex session.

An over-limit which invocation throws NATIVE_MODEL_CALL_LIMIT before request capture and appends no receipt. Receipts cover consumed slots only; callers must preserve the thrown refusal separately. Thus receipt count is bounded by maxCalls, while refused invocation count must not be inferred from receipts.

The [hosted API reference](https://typellm.ai/docs/api) currently documents a public response model field. This existing SDK normalized interface omits it; UNREPORTED describes that interface, not every server response. A public alias also does not pin the underlying backend revision. The 131072-byte and 8192-unit guards above are local SDK limits, not claims about the hosted service maximum.
