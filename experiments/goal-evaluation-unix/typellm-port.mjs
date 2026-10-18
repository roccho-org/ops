import { createHash } from 'node:crypto';
import { snapshotJson } from '../../packages/jev-review/semlint-entry.mjs';
import { bindTypeLLM, generateTyped, TypedProviderError } from '../../packages/typellm/src/typellm.mjs';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const instructions = [
  'Return only a JSON object with exactly clauses, questions, and missing arrays; no Markdown or code fence.',
  'A clause has id, kind (obligation, exception, or alternative), ref, and an exact quote from that supplied ref.',
  'A question has id, core (null or a supplied core id), question, criteria (problem, ok, unknown strings), clauseIds, basisRefs, requiredRefs, and needs.',
  'basisRefs includes the Goal ref; requiredRefs names supplied observations only. Unsupplied information belongs in needs.',
  'A missing row has need and reason. Respect maxQuestions and maxClauses. Preserve obligations, exceptions, legitimate alternatives, and unknown information.',
  'A quoted claim is provenance, not proof. Do not remove conditions or uncertainty to fit an output limit. Do not invent observations or evidence.'
].join(' ');

// One proposal attempt per bound port; Core owns native Plan validation.
// This port does not read environment variables, repair output, or retry.
// TypeLLM bounds strings at 2048 UTF-16 units, independently of Core's byte limits.
// Its normalized response exposes no actual model identity: the alias is declared,
// never a reported identity. Wire digests cover the actual request body; proposal
// digests cover the returned string, independently of Core's planDigest.
// Owners may retain raw responses privately at fetchImpl.
export function bindTypeLLMProposalPort({
  id, mode, apiKey, fetchImpl, deadlineMs, signal
} = {}) {
  const fetchFn = fetchImpl ?? (mode === 'live' ? globalThis.fetch : null);
  if (typeof id !== 'string' || !id.trim() || !['live', 'test-double'].includes(mode)
      || typeof fetchFn !== 'function' || !Number.isInteger(deadlineMs)
      || deadlineMs < 1 || deadlineMs > 95000)
    throw new Error('INVALID_TYPELLM_PROPOSAL_PORT');
  const records = [];
  let consumed = false;
  const propose = async prompt => {
    if (consumed) throw new Error('PROPOSAL_ALREADY_CONSUMED');
    consumed = true;
    const started = Date.now();
    const record = {
      sequence: records.length + 1, id, mode, status: 'STARTED',
      requestedModel: 'typellm-latest', reportedModel: null,
      fetchAttempts: 0, wireRequestBytes: null, wireRequestSha256: null,
      proposalUnits: null, proposalBytes: null, proposalSha256: null,
      usageInputTokens: null, usageThinkingTokens: null,
      providerElapsed: null, clientElapsedMs: null, errorCode: null, upstreamStatus: null
    };
    try {
      const captured = snapshotJson(prompt);
      if (!captured || typeof captured !== 'object' || Array.isArray(captured))
        throw new Error('INVALID_PROPOSAL_INPUT');
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
        request: { context: JSON.stringify(captured),
          questions: { proposal: { type: 'string', instructions } } },
        provider, signal
      });
      record.usageInputTokens = generated.usage?.input_tokens ?? null;
      record.usageThinkingTokens = generated.usage?.thinking_tokens ?? null;
      record.providerElapsed = generated.elapsed ?? null;
      const output = generated.result.proposal;
      record.proposalUnits = output.length;
      record.proposalBytes = Buffer.byteLength(output, 'utf8');
      record.proposalSha256 = hash(output);
      let candidate;
      try { candidate = JSON.parse(output); }
      catch { throw new Error('INVALID_PROPOSAL_JSON'); }
      record.status = 'JSON_PARSED';
      return candidate;
    } catch (error) {
      record.status = 'FAILED';
      if (error instanceof TypedProviderError) {
        record.errorCode = error.code;
        record.upstreamStatus = error.upstreamStatus ?? null;
        throw error;
      }
      record.errorCode = error?.message === 'INVALID_PROPOSAL_JSON'
        ? 'INVALID_PROPOSAL_JSON' : 'INVALID_PROPOSAL_INPUT';
      throw new Error(record.errorCode);
    } finally {
      record.clientElapsedMs = Math.max(0, Date.now() - started);
      records.push(Object.freeze(record));
    }
  };
  return Object.freeze({ id, mode, propose, receipts: () => Object.freeze([...records]) });
}
