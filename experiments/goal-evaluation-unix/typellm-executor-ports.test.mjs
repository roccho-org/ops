import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { plan, judge, report } from './core.mjs';
import { bindTypeLLMExecutorPorts } from './typellm-executor-ports.mjs';
import { bindTypeLLMProposalPort, buildTypeLLMProposalRequest } from './typellm-port.mjs';
import { bindTypeLLMNativeModelPort, buildTypeLLMNativeQuestionRequest } from './typellm-native-model-port.mjs';
import { TypedProviderError } from '../../packages/typellm/src/typellm.mjs';

const RUN = '75bb2b32-55e5-4bfb-80c8-f70745488d63';
const BINDING = 'd'.repeat(64);
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const criteria = () => ({
  problem: 'The supplied note contradicts the stated limit.',
  ok: 'The supplied note explicitly preserves the stated limit.',
  unknown: 'The supplied observations do not decide this question.'
});
const question = (changes = {}) => ({
  text: 'Original "quote", backslash \\, newline\nand 日本語 are preserved.',
  instructions: 'Does the supplied note preserve the stated limit?',
  criteria: criteria(), ...changes
});
const request = () => ({
  goal: { ref: 'goal', content: 'Maintain a finite limit.' },
  observations: [{ ref: 'note', content: 'The proposal declares a finite limit.' }]
});
const candidate = () => ({
  clauses: [{ id: 'must', kind: 'obligation', ref: 'goal', quote: 'Maintain a finite limit.' }],
  questions: [{
    id: 'limit-check', core: null,
    question: 'Does the proposal preserve the stated finite limit?',
    criteria: criteria(), clauseIds: ['must'], basisRefs: ['goal', 'note'],
    requiredRefs: ['note'], needs: []
  }],
  missing: []
});
const prompt = () => ({ ...request(), cores: [], maxQuestions: 4, maxClauses: 16 });
const normalized = (input, label = 'ok', extra = {}) => ({
  result: Object.hasOwn(input.questions, 'judgment')
    ? { judgment: label } : { proposal: JSON.stringify(candidate()) },
  ...extra
});
function harness({ executeTyped = input => normalized(input), ...options } = {}) {
  const calls = [];
  const ports = bindTypeLLMExecutorPorts({
    id: 'synthetic-core-executor', mode: 'test-double',
    executorId: 'declared-synthetic-fixed-cli', bindingSha256: BINDING,
    runId: RUN, deadlineMs: 1000,
    executeTyped: (input, metadata) => {
      calls.push({ input, metadata });
      return executeTyped(input, metadata);
    },
    ...options
  });
  return { ports, calls };
}
const rejectsCode = (pending, code) =>
  assert.rejects(pending, error => error.code === code || error.message === code);
function identityAndTransportUnknown(receipt) {
  assert.equal(receipt.executorId, 'declared-synthetic-fixed-cli');
  assert.equal(receipt.bindingSha256, BINDING);
  assert.equal(receipt.bindingAuthority, 'DECLARED_ONLY');
  assert.equal(receipt.requestedAlias, 'typellm-latest');
  assert.equal(receipt.reportedModel, null);
  assert.equal(receipt.identityStatus, 'UNREPORTED');
  assert.equal(receipt.httpFetchAttempts, null);
  assert.equal(receipt.wireRequestSha256, null);
}
function httpHarness() {
  const calls = [];
  const fetchImpl = (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, raw: init.body });
    return new Response(JSON.stringify({
      result: Object.hasOwn(body.questions, 'judgment')
        ? { judgment: 'unknown' } : { proposal: JSON.stringify(candidate()) }
    }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('synthetic normalized capability connects proposal, Core plan, native judgment and report', async () => {
  const { ports, calls } = harness({
    executeTyped: input => normalized(input, 'problem', {
      usage: { input_tokens: 17, thinking_tokens: 2 }, elapsed: 0.25
    })
  });
  const fixed = await plan(request(), { propose: ports.propose });
  const result = await judge(fixed, ports);
  const view = report(fixed, result);
  assert.equal(result.calls, 1);
  assert.equal(result.judgments[0].label, 'problem');
  assert.equal(result.judgments[0].model, 'UNKNOWN');
  assert.equal(result.judgments[0].rationale, null);
  assert.ok(JSON.stringify(view).includes('"type":"native-three-label"'));
  assert.ok(JSON.stringify(view).includes('"value":"problem"'));
  assert.equal(calls.length, 2);
  const receipts = [...ports.receipts()].sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(receipts.map(r => [r.kind, r.status]), [
    ['proposal', 'JSON_PARSED'], ['judgment', 'ANSWERED']
  ]);
  for (const r of receipts) {
    identityAndTransportUnknown(r);
    assert.equal(r.executorInvocations, 1);
    assert.equal(r.executorStatus, 'RETURNED');
    assert.equal(r.remoteEffects, 'UNKNOWN');
    assert.equal(r.usageInputTokens, 17);
    assert.equal(r.usageThinkingTokens, 2);
    assert.equal(r.providerElapsed, 0.25);
  }
});

test('frozen callback request and offwire callId bind typed and normalized JSON digests', async () => {
  let returned;
  const { ports, calls } = harness({
    executeTyped: input => {
      assert.ok(Object.isFrozen(input));
      assert.ok(Object.isFrozen(input.questions));
      assert.ok(Object.isFrozen(input.questions.judgment));
      assert.ok(Object.isFrozen(input.questions.judgment.enum));
      returned = normalized(input, 'unknown');
      return returned;
    }
  });
  const original = question();
  const before = clone(original);
  const pending = ports.which(original);
  original.text = 'Mutation must not replace the captured source.';
  original.criteria.problem = 'Mutated criterion.';
  const answer = await pending;
  const [{ input, metadata }] = calls;
  assert.equal(input.context, before.text);
  assert.ok(input.questions.judgment.instructions.includes(JSON.stringify({
    question: before.instructions, criteria: before.criteria
  })));
  assert.ok(metadata.signal instanceof AbortSignal);
  assert.equal(metadata.callId, RUN + '/judgment/1');
  assert.ok(!JSON.stringify(input).includes(RUN));
  assert.ok(!Object.hasOwn(input, 'apiKey'));
  const [r] = ports.receipts();
  assert.equal(r.callId, metadata.callId);
  assert.equal(r.typedRequestBytes, Buffer.byteLength(JSON.stringify(input), 'utf8'));
  assert.equal(r.typedRequestSha256, sha(JSON.stringify(input)));
  assert.equal(r.normalizedResponseBytes, Buffer.byteLength(JSON.stringify(returned), 'utf8'));
  assert.equal(r.normalizedResponseSha256, sha(JSON.stringify(returned)));
  assert.equal(r.answerSha256, sha(JSON.stringify(answer)));
  identityAndTransportUnknown(r);
  assert.ok(Object.isFrozen(answer));
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(ports.receipts()));
  const held = JSON.stringify(r);
  returned.result.judgment = 'problem';
  assert.equal(JSON.stringify(ports.receipts()[0]), held);
});

test('pure builders preserve the existing HTTP request and return behavior', async () => {
  const proposalInput = prompt(), nativeInput = question();
  const pBuilt = buildTypeLLMProposalRequest(proposalInput);
  const qBuilt = buildTypeLLMNativeQuestionRequest(nativeInput);
  assert.equal(pBuilt.request.context, JSON.stringify(proposalInput));
  assert.equal(qBuilt.request.context, nativeInput.text);
  assert.deepEqual(qBuilt.request.questions.judgment.enum, ['problem', 'ok', 'unknown']);
  const oldHTTP = httpHarness();
  const pPort = bindTypeLLMProposalPort({
    id: 'legacy-proposal-regression', mode: 'test-double',
    apiKey: 'public-synthetic-only', fetchImpl: oldHTTP.fetchImpl, deadlineMs: 1000
  });
  const qPort = bindTypeLLMNativeModelPort({
    id: 'legacy-judgment-regression', mode: 'test-double',
    apiKey: 'public-synthetic-only', fetchImpl: oldHTTP.fetchImpl, deadlineMs: 1000
  });
  assert.deepEqual(await pPort.propose(proposalInput), candidate());
  assert.deepEqual(await qPort.which(nativeInput), { label: 'unknown', model: 'UNKNOWN', rationale: null });
  for (const [i, built] of [pBuilt, qBuilt].entries()) {
    const key = Object.keys(built.request.questions)[0];
    assert.deepEqual(oldHTTP.calls[i].body, {
      context: built.request.context,
      questions: { [key]: { ...built.request.questions[key], thinking: false } },
      model: 'typellm-latest', options: { temperature: 0 }, timeout: 30
    });
    assert.equal([pPort, qPort][i].receipts()[0].wireRequestSha256, sha(oldHTTP.calls[i].raw));
    assert.equal([pPort, qPort][i].receipts()[0].fetchAttempts, 1);
  }
  await rejectsCode(pPort.propose(proposalInput), 'PROPOSAL_ALREADY_CONSUMED');
  assert.equal(oldHTTP.calls.length, 2);
  proposalInput.goal.content = 'Changed later.';
  nativeInput.criteria.unknown = 'Changed later.';
  assert.notEqual(pBuilt.request.context, JSON.stringify(proposalInput));
  assert.ok(!qBuilt.request.questions.judgment.instructions.includes('Changed later.'));
});

test('identical concurrent requests have distinct offwire callIds and retain the correct answer binding', async () => {
  const releases = [];
  const { ports, calls } = harness({
    maxCalls: 2,
    executeTyped: (_input, metadata) => new Promise(resolve => releases.push({ resolve, metadata }))
  });
  const a = ports.which(question()), b = ports.which(question());
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].metadata.callId, calls[1].metadata.callId);
  assert.equal(JSON.stringify(calls[0].input), JSON.stringify(calls[1].input));
  releases[1].resolve({ result: { judgment: 'problem' } });
  releases[0].resolve({ result: { judgment: 'ok' } });
  assert.deepEqual((await Promise.all([a, b])).map(x => x.label), ['ok', 'problem']);
  const rs = [...ports.receipts()].sort((x, y) => x.sequence - y.sequence);
  assert.deepEqual(rs.map(x => x.callId), calls.map(x => x.metadata.callId));
  assert.equal(rs[0].answerSha256, sha(JSON.stringify({ label: 'ok', model: 'UNKNOWN', rationale: null })));
  assert.equal(rs[1].answerSha256, sha(JSON.stringify({ label: 'problem', model: 'UNKNOWN', rationale: null })));
});

test('one proposal plus four judgments are the complete default dispatch budget', async () => {
  const { ports, calls } = harness();
  await ports.propose(prompt());
  for (let i = 0; i < 4; i++) await ports.which(question());
  const held = ports.receipts();
  assert.equal(calls.length, 5);
  assert.equal(held.length, 5);
  assert.equal(new Set(calls.map(x => x.metadata.callId)).size, 5);
  await rejectsCode(ports.propose(prompt()), 'PROPOSAL_ALREADY_CONSUMED');
  await rejectsCode(ports.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
  assert.equal(calls.length, 5);
  assert.equal(ports.receipts().length, 5);
  assert.equal(held.length, 5);
});

test('validation consumes each proposal and judgment slot before any executor dispatch', async () => {
  const { ports, calls } = harness({ maxCalls: 1 });
  await rejectsCode(ports.propose(null), 'INVALID_PROPOSAL_INPUT');
  await rejectsCode(ports.propose(prompt()), 'PROPOSAL_ALREADY_CONSUMED');
  await rejectsCode(ports.which(question({ criteria: { problem: 'P', ok: 'O' } })), 'INVALID_NATIVE_QUESTION');
  await rejectsCode(ports.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
  assert.equal(calls.length, 0);
  assert.equal(ports.receipts().length, 2);
  for (const r of ports.receipts()) {
    assert.equal(r.status, 'FAILED');
    assert.equal(r.executorInvocations, 0);
    assert.equal(r.executorStatus, 'NOT_INVOKED');
    assert.equal(r.remoteEffects, 'NOT_DISPATCHED_BY_PORT');
    assert.equal(r.normalizedResponseSha256, null);
  }
});

test('SDK encoded-body limits are retained before the typed executor is called', async () => {
  const legacy = httpHarness();
  const old = bindTypeLLMNativeModelPort({
    id: 'size-baseline', mode: 'test-double', apiKey: 'public-synthetic-only',
    fetchImpl: legacy.fetchImpl, deadlineMs: 1000
  });
  await old.which(question({ text: 'x' }));
  const overhead = Buffer.byteLength(legacy.calls[0].raw) - 1;
  const exact = harness();
  await exact.ports.which(question({ text: 'x'.repeat(131072 - overhead) }));
  assert.equal(exact.calls.length, 1);
  const tooLarge = harness();
  await rejectsCode(tooLarge.ports.which(question({ text: 'x'.repeat(131073 - overhead) })), 'input_invalid');
  assert.equal(tooLarge.calls.length, 0);
  assert.equal(tooLarge.ports.receipts()[0].executorInvocations, 0);
  assert.equal(tooLarge.ports.receipts()[0].remoteEffects, 'NOT_DISPATCHED_BY_PORT');
  for (const text of ['"'.repeat(66000), '界'.repeat(44000)]) {
    const escaped = harness();
    await rejectsCode(escaped.ports.which(question({ text })), 'input_invalid');
    assert.equal(escaped.calls.length, 0);
  }
});

test('SDK instruction limit remains 8192 combined UTF16 units before dispatch', async () => {
  const legacy = httpHarness();
  const old = bindTypeLLMNativeModelPort({
    id: 'instruction-baseline', mode: 'test-double', apiKey: 'public-synthetic-only',
    fetchImpl: legacy.fetchImpl, deadlineMs: 1000
  });
  await old.which(question({ instructions: 'q' }));
  const overhead = legacy.calls[0].body.questions.judgment.instructions.length - 1;
  const exact = harness();
  await exact.ports.which(question({ instructions: 'q'.repeat(8192 - overhead) }));
  assert.equal(exact.calls[0].input.questions.judgment.instructions.length, 8192);
  const over = harness();
  await rejectsCode(over.ports.which(question({ instructions: 'q'.repeat(8193 - overhead) })), 'input_invalid');
  assert.equal(over.calls.length, 0);
});

test('normalized executor output has exact top-level keys and a one MiB JSON cap', async () => {
  const invalid = [
    null, [], 'not normalized', {},
    { usage: { input_tokens: 0, thinking_tokens: 0 } },
    { result: { judgment: 'ok' }, status: 'completed' },
    { result: { judgment: 'ok' }, model: 'unrequested-model' },
    { result: { judgment: 'x'.repeat(1024 * 1024 + 1) } }
  ];
  for (const output of invalid) {
    const { ports, calls } = harness({ executeTyped: () => output });
    await rejectsCode(ports.which(question()), 'executor_contract_error');
    assert.equal(calls.length, 1);
    const [r] = ports.receipts();
    assert.equal(r.errorCode, 'executor_contract_error');
    assert.equal(r.remoteEffects, 'UNKNOWN');
    assert.equal(r.normalizedResponseBytes, null);
    assert.equal(r.normalizedResponseSha256, null);
    assert.equal(r.answerSha256, null);
  }
});

test('SDK still validates enum answers, usage and elapsed from the normalized capability', async () => {
  const invalid = [
    { result: { judgment: 'yes' } },
    { result: {} },
    { result: { judgment: 'ok', extra: 'unrequested' } },
    { result: { judgment: 'ok' }, usage: { input_tokens: -1, thinking_tokens: 0 } },
    { result: { judgment: 'ok' }, usage: { input_tokens: 1 } },
    { result: { judgment: 'ok' }, elapsed: -1 }
  ];
  for (const output of invalid) {
    const { ports, calls } = harness({ executeTyped: () => output });
    await rejectsCode(ports.which(question()), 'provider_contract_error');
    assert.equal(calls.length, 1);
    const [r] = ports.receipts();
    assert.equal(r.status, 'FAILED');
    assert.equal(r.errorCode, 'provider_contract_error');
    assert.equal(r.normalizedResponseSha256, null);
    assert.equal(r.remoteEffects, 'UNKNOWN');
    identityAndTransportUnknown(r);
  }
});

test('proposal JSON is parsed once without repair and Core retains shape validation', async () => {
  for (const proposal of ['{broken', '~~~json\n{}\n~~~']) {
    const { ports, calls } = harness({ executeTyped: () => ({ result: { proposal } }) });
    await rejectsCode(ports.propose(prompt()), 'INVALID_PROPOSAL_JSON');
    assert.equal(calls.length, 1);
    assert.equal(ports.receipts()[0].status, 'FAILED');
    assert.ok(ports.receipts()[0].normalizedResponseSha256);
    await rejectsCode(ports.propose(prompt()), 'PROPOSAL_ALREADY_CONSUMED');
    assert.equal(calls.length, 1);
  }
  const invalidShape = harness({ executeTyped: () => ({ result: { proposal: '{"notAPlan":true}' } }) });
  await assert.rejects(plan(request(), { propose: invalidShape.ports.propose }), /INVALID_PROPOSAL/);
  assert.equal(invalidShape.calls.length, 1);
  assert.equal(invalidShape.ports.receipts()[0].status, 'JSON_PARSED');
  const over = harness({ executeTyped: () => ({ result: { proposal: 'x'.repeat(2049) } }) });
  await rejectsCode(over.ports.propose(prompt()), 'provider_contract_error');
  assert.equal(over.calls.length, 1);
});

test('callback failures are sanitized and do not become fake unknown answers or HTTP observations', async () => {
  const marker = 'SYNTHETIC-SENSITIVE-CALLBACK-DETAIL';
  const generic = harness({ executeTyped: () => { throw new Error(marker); } });
  await rejectsCode(generic.ports.which(question()), 'executor_failed');
  assert.equal(generic.calls.length, 1);
  const [r] = generic.ports.receipts();
  assert.equal(r.status, 'FAILED');
  assert.equal(r.executorStatus, 'FAILED');
  assert.equal(r.errorCode, 'executor_failed');
  assert.equal(r.remoteEffects, 'UNKNOWN');
  assert.equal(r.answerSha256, null);
  assert.ok(!JSON.stringify(r).includes(marker));
  identityAndTransportUnknown(r);
  const reported = harness({
    executeTyped: () => { throw new TypedProviderError('provider_http_error', 429); }
  });
  await rejectsCode(reported.ports.which(question()), 'provider_http_error');
  assert.equal(reported.ports.receipts()[0].upstreamStatus, 429);
  assert.equal(reported.ports.receipts()[0].httpFetchAttempts, null);
});

test('pre-abort dispatches no executor while consuming the invocation slot', async () => {
  const controller = new AbortController();
  controller.abort();
  const { ports, calls } = harness({ signal: controller.signal, maxCalls: 1 });
  await rejectsCode(ports.which(question()), 'cancelled');
  assert.equal(calls.length, 0);
  const [r] = ports.receipts();
  assert.equal(r.executorInvocations, 0);
  assert.equal(r.remoteEffects, 'NOT_DISPATCHED_BY_PORT');
  assert.equal(r.answerSha256, null);
  await rejectsCode(ports.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
});

test('deadline bounds local waiting and late results cannot overwrite the failed UNKNOWN receipt', { timeout: 3000 }, async () => {
  let release, executorSignal;
  const { ports, calls } = harness({
    deadlineMs: 20,
    executeTyped: (_input, metadata) => {
      executorSignal = metadata.signal;
      return new Promise(resolve => { release = resolve; });
    }
  });
  const started = Date.now();
  await rejectsCode(ports.which(question()), 'executor_timeout');
  assert.ok(Date.now() - started < 2500);
  assert.equal(calls.length, 1);
  assert.equal(executorSignal.aborted, true);
  const [r] = ports.receipts();
  assert.equal(r.status, 'FAILED');
  assert.equal(r.executorStatus, 'TIMED_OUT');
  assert.equal(r.errorCode, 'executor_timeout');
  assert.equal(r.remoteEffects, 'UNKNOWN');
  assert.equal(r.normalizedResponseSha256, null);
  const original = JSON.stringify(r);
  release({ result: { judgment: 'ok' } });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(ports.receipts()[0]), original);
  assert.equal(ports.receipts().length, 1);
  assert.equal(calls.length, 1);
});

test('inflight cancellation signals the callback but retains UNKNOWN remote effects', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  let entered, childSignal;
  const ready = new Promise(resolve => { entered = resolve; });
  const { ports, calls } = harness({
    signal: controller.signal,
    executeTyped: (_input, metadata) => {
      childSignal = metadata.signal;
      entered();
      return new Promise(() => {});
    }
  });
  const pending = ports.which(question());
  await ready;
  controller.abort();
  await rejectsCode(pending, 'cancelled');
  assert.equal(childSignal.aborted, true);
  assert.equal(calls.length, 1);
  const [r] = ports.receipts();
  assert.equal(r.executorStatus, 'CANCELLED');
  assert.equal(r.remoteEffects, 'UNKNOWN');
  assert.equal(r.answerSha256, null);
});

test('equal declared metadata across factories does not establish global deduplication or target identity', async () => {
  const first = harness(), second = harness();
  await first.ports.which(question());
  await second.ports.which(question());
  const a = first.ports.receipts()[0], b = second.ports.receipts()[0];
  assert.equal(a.callId, b.callId);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  identityAndTransportUnknown(a);
  identityAndTransportUnknown(b);
  // Cross-factory runId admission and duplicate refusal belong to the real transport ledger.
  assert.equal(a.bindingAuthority, 'DECLARED_ONLY');
  assert.equal(b.bindingAuthority, 'DECLARED_ONLY');
});

test('factory rejects unbounded contracts, credentials and HTTP fetch options before execution', () => {
  const valid = {
    id: 'synthetic', mode: 'test-double', executeTyped: input => normalized(input),
    executorId: 'declared-synthetic-fixed-cli', bindingSha256: BINDING,
    runId: RUN, deadlineMs: 1000
  };
  for (const changes of [
    { id: '' }, { mode: 'jev' }, { executeTyped: null }, { executorId: '' },
    { bindingSha256: 'not-a-sha256' }, { runId: 'not-a-uuid' },
    { deadlineMs: 0 }, { deadlineMs: 95001 }, { deadlineMs: 1.5 },
    { maxCalls: 0 }, { maxCalls: 5 }, { signal: {} },
    { apiKey: 'public-synthetic-only' }, { fetch: () => {} }, { fetchImpl: () => {} }
  ]) {
    assert.throws(() => bindTypeLLMExecutorPorts({ ...valid, ...changes }), {
      message: 'INVALID_TYPELLM_EXECUTOR_PORT'
    });
  }
  assert.doesNotThrow(() => bindTypeLLMExecutorPorts({ ...valid, deadlineMs: 1, maxCalls: 1 }));
  assert.doesNotThrow(() => bindTypeLLMExecutorPorts({ ...valid, deadlineMs: 95000, maxCalls: 4 }));
});
