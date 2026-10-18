import { createHash } from 'node:crypto';
import { snapshotJson } from '../../packages/jev-review/semlint-entry.mjs';
import { generateTyped, TypedProviderError } from '../../packages/typellm/src/typellm.mjs';
import { buildTypeLLMProposalRequest } from './typellm-port.mjs';
import { buildTypeLLMNativeQuestionRequest } from './typellm-native-model-port.mjs';
import { buildTypeLLMStructuredProposalRequest, assembleTypeLLMStructuredProposal } from './typellm-structured-proposal.mjs';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fail = code => { throw new TypedProviderError(code); };
const codes = new Set(['auth_missing', 'cancelled', 'provider_timeout', 'provider_http_error',
  'provider_unavailable', 'input_invalid', 'provider_invalid_response', 'provider_contract_error',
  'executor_timeout', 'executor_failed', 'executor_contract_error',
  'INVALID_NATIVE_QUESTION', 'INVALID_PROPOSAL_INPUT', 'INVALID_PROPOSAL_JSON']);
const structuredCodes = new Set(['INVALID_STRUCTURED_PROPOSAL_INPUT',
  'STRUCTURED_PROPOSAL_LIMIT', 'INVALID_STRUCTURED_PROPOSAL']);
const optionKeys = ['id', 'mode', 'executeTyped', 'executorId', 'bindingSha256',
  'runId', 'deadlineMs', 'signal', 'maxCalls', 'proposalFormat', 'requestTimeoutSeconds'];

// A real normalized typed capability, not a synthetic HTTP response or API key.
// Declared binding metadata is not proof of the actual target or source revision.
export function bindTypeLLMExecutorPorts(options = {}) {
  if (!object(options) || Object.keys(options).some(key => !optionKeys.includes(key)))
    throw new Error('INVALID_TYPELLM_EXECUTOR_PORT');
  const { id, mode, executeTyped, executorId, bindingSha256, runId,
    deadlineMs, signal, maxCalls = 4, proposalFormat = 'json-string', requestTimeoutSeconds } = options;
  if (!text(id) || !['live', 'test-double'].includes(mode) || !text(executorId)
      || typeof executeTyped !== 'function' || typeof bindingSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(bindingSha256) || typeof runId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)
      || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 95000
      || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 4
      || !['json-string', 'typed-relations-v1', 'typed-relations-dependent-v1'].includes(proposalFormat)
      || (Object.hasOwn(options, 'requestTimeoutSeconds') && requestTimeoutSeconds !== 60)
      || (signal !== undefined && !(signal instanceof AbortSignal)))
    throw new Error('INVALID_TYPELLM_EXECUTOR_PORT');
  const records = [];
  let proposalConsumed = false, judgmentsConsumed = 0, sequence = 0;

  const dispatch = async (request, record, callerSignal) => {
    if (callerSignal?.aborted) fail('cancelled');
    const controller = new AbortController();
    let timer, rejectStop, stopCode;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => {
      if (stopCode) return;
      stopCode = code;
      record.executorStatus = code === 'executor_timeout' ? 'TIMED_OUT' : 'CANCELLED';
      controller.abort();
      rejectStop(new TypedProviderError(code));
    };
    const abort = () => stop('cancelled');
    callerSignal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('executor_timeout'), deadlineMs);
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted || callerSignal?.aborted) fail('cancelled');
      record.executorInvocations++;
      record.executorStatus = 'IN_FLIGHT';
      record.remoteEffects = 'UNKNOWN';
      return executeTyped(request, { signal: controller.signal, callId: record.callId });
    });
    try {
      const returned = await Promise.race([call, stopped]);
      record.executorStatus = 'RETURNED';
      const captured = snapshotJson(returned);
      if (!object(captured) || !Object.hasOwn(captured, 'result')
          || Object.keys(captured).some(key => !['result', 'usage', 'elapsed'].includes(key)))
        fail('executor_contract_error');
      const serialized = JSON.stringify(captured);
      if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) fail('executor_contract_error');
      return captured;
    } catch (error) {
      if (!stopCode && record.executorStatus === 'IN_FLIGHT') record.executorStatus = 'FAILED';
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  };

  const invoke = async (kind, value) => {
    const started = Date.now();
    const current = ++sequence;
    const record = {
      kind, sequence: current, callId: runId + '/' + kind + '/' + current, id, mode,
      executorId, bindingSha256, bindingAuthority: 'DECLARED_ONLY', status: 'STARTED',
      typedRequestBytes: null, typedRequestSha256: null,
      normalizedResponseBytes: null, normalizedResponseSha256: null,
      executorInvocations: 0, executorStatus: 'NOT_INVOKED', remoteEffects: 'NOT_DISPATCHED_BY_PORT',
      httpFetchAttempts: null, wireRequestSha256: null,
      requestedAlias: 'typellm-latest', reportedModel: null, identityStatus: 'UNREPORTED',
      answerSha256: null, proposalUnits: null, proposalBytes: null, proposalSha256: null,
      usageInputTokens: null, usageThinkingTokens: null, providerElapsed: null,
      clientElapsedMs: null, errorCode: null, upstreamStatus: null
    };
    if (kind === 'proposal' && proposalFormat !== 'json-string') {
      record.proposalFormat = proposalFormat;
      record.structuredCoverage = 'UNKNOWN';
      record.saturatedArrays = null;
    }
    try {
      const built = kind === 'proposal' ? (proposalFormat !== 'json-string'
        ? buildTypeLLMStructuredProposalRequest(value, proposalFormat) : buildTypeLLMProposalRequest(value))
        : buildTypeLLMNativeQuestionRequest(value);
      const request = freeze(requestTimeoutSeconds === 60 ? { ...built.request, timeout: 60 } : built.request);
      const serialized = JSON.stringify(request);
      record.typedRequestBytes = Buffer.byteLength(serialized, 'utf8');
      record.typedRequestSha256 = hash(serialized);
      // generateTyped retains the real SDK body, field, result and usage checks.
      // available means the typed capability is supplied, not that auth was proved.
      const generated = await generateTyped({ request, signal, provider: {
        available: true,
        post: (_preparedBody, { signal: callerSignal }) => dispatch(request, record, callerSignal)
      } });
      const normalized = JSON.stringify(generated);
      record.normalizedResponseBytes = Buffer.byteLength(normalized, 'utf8');
      record.normalizedResponseSha256 = hash(normalized);
      record.usageInputTokens = generated.usage?.input_tokens ?? null;
      record.usageThinkingTokens = generated.usage?.thinking_tokens ?? null;
      record.providerElapsed = generated.elapsed ?? null;
      let answer;
      if (kind === 'proposal' && proposalFormat !== 'json-string') {
        const assembled = assembleTypeLLMStructuredProposal(generated.result, built.captured);
        answer = assembled.candidate;
        Object.assign(record, assembled.metadata);
        const encoded = JSON.stringify(answer);
        record.proposalBytes = Buffer.byteLength(encoded, 'utf8');
        record.proposalSha256 = hash(encoded);
        record.status = 'STRUCTURED_ASSEMBLED';
      } else if (kind === 'proposal') {
        const output = generated.result.proposal;
        record.proposalUnits = output.length;
        record.proposalBytes = Buffer.byteLength(output, 'utf8');
        record.proposalSha256 = hash(output);
        try { answer = JSON.parse(output); }
        catch { fail('INVALID_PROPOSAL_JSON'); }
        record.status = 'JSON_PARSED';
      } else {
        answer = Object.freeze({ label: generated.result.judgment, model: 'UNKNOWN', rationale: null });
        record.status = 'ANSWERED';
      }
      record.answerSha256 = hash(JSON.stringify(answer));
      return answer;
    } catch (error) {
      record.status = 'FAILED';
      const known = code => codes.has(code) || (kind === 'proposal'
        && proposalFormat !== 'json-string' && structuredCodes.has(code));
      const code = error instanceof TypedProviderError && known(error.code) ? error.code
        : known(error?.message) ? error.message : 'executor_failed';
      record.errorCode = code;
      if (code === 'provider_http_error' && Number.isInteger(error?.upstreamStatus)
          && error.upstreamStatus >= 300 && error.upstreamStatus <= 599)
        record.upstreamStatus = error.upstreamStatus;
      throw new TypedProviderError(code, record.upstreamStatus);
    } finally {
      record.clientElapsedMs = Math.max(0, Date.now() - started);
      records.push(Object.freeze(record));
    }
  };
  const propose = value => {
    if (proposalConsumed) return Promise.reject(new Error('PROPOSAL_ALREADY_CONSUMED'));
    proposalConsumed = true;
    return invoke('proposal', value);
  };
  const which = value => {
    if (judgmentsConsumed >= maxCalls) return Promise.reject(new Error('NATIVE_MODEL_CALL_LIMIT'));
    judgmentsConsumed++;
    return invoke('judgment', value);
  };
  return Object.freeze({ id, mode, propose, which, receipts: () => Object.freeze([...records]) });
}
