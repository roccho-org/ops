import { createHash } from 'node:crypto';
import { snapshotJson } from '../../packages/jev-review/semlint-entry.mjs';
import { bindTypeLLM, generateTyped, TypedProviderError } from '../../packages/typellm/src/typellm.mjs';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const labels = Object.freeze(['problem', 'ok', 'unknown']);
const exact = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.trim().length > 0;

// Shared construction only; generateTyped retains the transport guards.
export function buildTypeLLMNativeQuestionRequest(question) {
  const captured = snapshotJson(question);
  if (!exact(captured, ['text', 'instructions', 'criteria'])
      || !text(captured.text) || !text(captured.instructions)
      || !exact(captured.criteria, labels)
      || !labels.every(label => text(captured.criteria[label])))
    throw new Error('INVALID_NATIVE_QUESTION');
  const instructions = [
    'Select one of problem, ok, unknown using the supplied question and every supplied criterion.',
    'The context contains source claims, not independently verified facts. Preserve conditions and uncertainty; do not invent evidence.',
    JSON.stringify({ question: captured.instructions, criteria: captured.criteria })
  ].join('\n');
  return { captured, request: { context: captured.text,
    questions: { judgment: { type: 'string', enum: [...labels], instructions } } } };
}

// Experimental Core ModelPort, independent of the Jev/project adapter.
// UNKNOWN is an identity sentinel, never a claim that two calls used one model.
// Consume reports together with same-call receipts; the normalized SDK response
// does not expose its actual model ID. No environment reads, output repair, or retries occur here.
export function bindTypeLLMNativeModelPort({
  id, mode, apiKey, fetchImpl, deadlineMs, signal, maxCalls = 4
} = {}) {
  const fetchFn = fetchImpl ?? (mode === 'live' ? globalThis.fetch : null);
  if (!text(id) || !['live', 'test-double'].includes(mode)
      || typeof fetchFn !== 'function' || !Number.isInteger(deadlineMs)
      || deadlineMs < 1 || deadlineMs > 95000 || !Number.isInteger(maxCalls)
      || maxCalls < 1 || maxCalls > 4)
    throw new Error('INVALID_TYPELLM_NATIVE_PORT');
  const records = [];
  let consumed = 0;
  const which = async question => {
    if (consumed >= maxCalls) throw new Error('NATIVE_MODEL_CALL_LIMIT');
    consumed++;
    const started = Date.now();
    const record = {
      sequence: consumed, id, mode, status: 'STARTED', questionSha256: null,
      requestedAlias: 'typellm-latest', reportedModel: null, identityStatus: 'UNREPORTED',
      fetchAttempts: 0, wireRequestBytes: null, wireRequestSha256: null,
      answerSha256: null, usageInputTokens: null, usageThinkingTokens: null,
      providerElapsed: null, clientElapsedMs: null, errorCode: null, upstreamStatus: null
    };
    try {
      const { captured, request } = buildTypeLLMNativeQuestionRequest(question);
      record.questionSha256 = hash(JSON.stringify(captured));
      const provider = bindTypeLLM({
        apiKey, deadlineMs,
        fetch: (url, init) => {
          record.fetchAttempts++;
          record.wireRequestBytes = Buffer.byteLength(init.body, 'utf8');
          record.wireRequestSha256 = hash(init.body);
          return fetchFn(url, init);
        }
      });
      const generated = await generateTyped({
        request, provider, signal
      });
      record.usageInputTokens = generated.usage?.input_tokens ?? null;
      record.usageThinkingTokens = generated.usage?.thinking_tokens ?? null;
      record.providerElapsed = generated.elapsed ?? null;
      const answer = Object.freeze({ label: generated.result.judgment, model: 'UNKNOWN', rationale: null });
      record.answerSha256 = hash(JSON.stringify(answer));
      record.status = 'ANSWERED';
      return answer;
    } catch (error) {
      record.status = 'FAILED';
      if (error instanceof TypedProviderError) {
        record.errorCode = error.code;
        record.upstreamStatus = error.upstreamStatus ?? null;
        throw error;
      }
      record.errorCode = error?.message === 'INVALID_NATIVE_QUESTION'
        ? 'INVALID_NATIVE_QUESTION' : 'NATIVE_MODEL_EXECUTION_FAILED';
      throw new Error(record.errorCode);
    } finally {
      record.clientElapsedMs = Math.max(0, Date.now() - started);
      records.push(Object.freeze(record));
    }
  };
  return Object.freeze({ id, mode, which, receipts: () => Object.freeze([...records]) });
}
