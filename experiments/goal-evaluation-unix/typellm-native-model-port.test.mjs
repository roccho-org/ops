import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkPlan, judge, report } from './core.mjs';
import { bindTypeLLMNativeModelPort } from './typellm-native-model-port.mjs';

const LIMIT = 131072;
const labels = ['problem', 'ok', 'unknown'];
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const criteria = () => ({
  problem: 'The supplied observation contradicts the stated limit.',
  ok: 'The supplied observation explicitly preserves the stated limit.',
  unknown: 'The supplied observations do not decide this question.'
});
const question = (changes = {}) => ({
  text: 'Original "quoted" text, backslash \\, newline\nand 日本語 remain unchanged.',
  instructions: 'Does the supplied observation preserve the stated limit?',
  criteria: criteria(),
  ...changes
});
const completed = (label = 'ok', extra = {}) => new Response(JSON.stringify({
  status: 'completed', result: { judgment: label }, ...extra
}), { status: 200, headers: { 'content-type': 'application/json' } });

function harness({ fetchImpl = () => completed(), ...options } = {}) {
  const calls = [];
  const port = bindTypeLLMNativeModelPort({
    id: 'synthetic-native-port', mode: 'test-double',
    apiKey: 'public-synthetic-key', deadlineMs: 1000,
    fetchImpl: (url, init) => {
      calls.push({ url, init, wire: JSON.parse(init.body) });
      return fetchImpl(url, init);
    },
    ...options
  });
  return { port, calls };
}
const rejectsCode = (pending, code) =>
  assert.rejects(pending, error => error.code === code || error.message === code);
function assertUnknownIdentity(receipt) {
  assert.equal(receipt.requestedAlias, 'typellm-latest');
  assert.equal(receipt.reportedModel, null);
  assert.equal(receipt.identityStatus, 'UNREPORTED');
}
function nativePlan(needs = []) {
  return checkPlan({
    schema: 'ops.goal-evaluation.plan.v2',
    request: {
      goal: { ref: 'goal', content: 'Maintain a finite limit.' },
      observations: [{ ref: 'note', content: 'The proposal declares a finite limit.' }]
    },
    clauses: [{ id: 'must', kind: 'obligation', ref: 'goal', quote: 'Maintain a finite limit.' }],
    questions: [{
      id: 'limit-check', core: null,
      question: 'Does the proposal preserve the stated finite limit?',
      criteria: criteria(), clauseIds: ['must'], basisRefs: ['goal', 'note'],
      requiredRefs: ['note'], needs
    }],
    missing: []
  });
}

test('native enum labels roundtrip through Core judge and report with unknown model identity', async () => {
  for (const label of labels) {
    const { port, calls } = harness({
      fetchImpl: () => completed(label, { model: 'unexposed-synthetic-model' })
    });
    const plan = nativePlan();
    const result = await judge(plan, port);
    assert.equal(result.calls, 1);
    assert.equal(result.judgments[0].status, 'OBSERVED');
    assert.equal(result.judgments[0].label, label);
    assert.equal(result.judgments[0].model, 'UNKNOWN');
    assert.equal(result.judgments[0].rationale, null);
    const view = report(plan, result);
    const serialized = JSON.stringify(view);
    assert.ok(serialized.includes('"type":"native-three-label"'));
    assert.ok(serialized.includes('"value":"' + label + '"'));
    assert.ok(serialized.includes('"model":"UNKNOWN"'));
    assert.equal(calls.length, 1);
    const [receipt] = port.receipts();
    assertUnknownIdentity(receipt);
    assert.equal(receipt.status, 'ANSWERED');
    assert.equal(receipt.answerSha256, sha(JSON.stringify({
      label, model: 'UNKNOWN', rationale: null
    })));
    assert.equal(receipt.fetchAttempts, 1);
    assert.equal(result.port.id, receipt.id);
    assert.equal(result.port.mode, receipt.mode);
    assert.ok(!serialized.includes('unexposed-synthetic-model'));
  }
});

test('equal UNKNOWN sentinels do not supply a reported model ID or same-model evidence', async () => {
  const { port } = harness();
  const first = await port.which(question({ text: 'First independent synthetic context.' }));
  const second = await port.which(question({ text: 'Second independent synthetic context.' }));
  assert.equal(first.model, second.model);
  const [a, b] = port.receipts();
  assertUnknownIdentity(a);
  assertUnknownIdentity(b);
  assert.notEqual(a.questionSha256, b.questionSha256);
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  // Equality of the compatibility strings is deliberately not an identity observation.
  assert.equal([a, b].filter(r => r.reportedModel !== null).length, 0);
});

test('wire preserves original context and all criteria and binds question, wire and answer digests', async () => {
  const { port, calls } = harness({
    fetchImpl: () => completed('problem', {
      usage: { input_tokens: 17, thinking_tokens: 3 }, elapsed: 0.125
    })
  });
  const input = question();
  const before = clone(input);
  const answer = await port.which(input);
  const [{ url, init, wire }] = calls;
  assert.equal(url, 'https://api.typellm.ai/v1/generate');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(wire.context, before.text);
  assert.deepEqual(wire.questions.judgment.enum, labels);
  assert.equal(wire.questions.judgment.type, 'string');
  assert.ok(wire.questions.judgment.instructions.includes(JSON.stringify({
    question: before.instructions, criteria: before.criteria
  })));
  assert.equal(wire.model, 'typellm-latest');
  const [receipt] = port.receipts();
  assert.equal(receipt.questionSha256, sha(JSON.stringify(before)));
  assert.equal(receipt.wireRequestSha256, sha(init.body));
  assert.equal(receipt.wireRequestBytes, Buffer.byteLength(init.body, 'utf8'));
  assert.equal(receipt.answerSha256, sha(JSON.stringify(answer)));
  assert.equal(receipt.usageInputTokens, 17);
  assert.equal(receipt.usageThinkingTokens, 3);
  assert.equal(receipt.providerElapsed, 0.125);
  assert.ok(Number.isSafeInteger(receipt.clientElapsedMs) && receipt.clientElapsedMs >= 0);
  assert.equal(receipt.errorCode, null);
  assert.equal(receipt.upstreamStatus, null);
  assertUnknownIdentity(receipt);
  assert.ok(!JSON.stringify(receipt).includes('public-synthetic-key'));
  assert.ok(Object.isFrozen(port));
  assert.ok(Object.isFrozen(port.receipts()));
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(answer));
});

test('snapshot survives caller mutation while the fake provider is pending', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { port, calls } = harness({ fetchImpl: () => waiting });
  const input = question();
  const before = clone(input);
  const pending = port.which(input);
  input.text = 'Mutated context must not reach this invocation.';
  input.instructions = 'Mutated question.';
  input.criteria.problem = 'Mutated criterion.';
  input.criteria.extra = 'Unexpected criterion.';
  release(completed('unknown'));
  const answer = await pending;
  assert.equal(answer.label, 'unknown');
  assert.equal(calls[0].wire.context, before.text);
  assert.ok(calls[0].wire.questions.judgment.instructions.includes(JSON.stringify({
    question: before.instructions, criteria: before.criteria
  })));
  assert.equal(port.receipts()[0].questionSha256, sha(JSON.stringify(before)));
});

test('actual encoded HTTP body accepts 131072 bytes and refuses the next byte without fetch', async () => {
  const base = question({ text: 'x' });
  const probe = harness();
  await probe.port.which(base);
  const overhead = probe.calls[0].init.body.length - 1;
  const exact = harness();
  await exact.port.which(question({ text: 'x'.repeat(LIMIT - overhead) }));
  assert.equal(Buffer.byteLength(exact.calls[0].init.body, 'utf8'), LIMIT);
  assert.equal(exact.port.receipts()[0].wireRequestBytes, LIMIT);
  const over = harness();
  await rejectsCode(over.port.which(question({ text: 'x'.repeat(LIMIT - overhead + 1) })), 'input_invalid');
  assert.equal(over.calls.length, 0);
  assert.equal(over.port.receipts()[0].status, 'FAILED');
  assert.equal(over.port.receipts()[0].fetchAttempts, 0);
  assert.equal(over.port.receipts()[0].wireRequestBytes, null);
  assert.equal(over.port.receipts()[0].wireRequestSha256, null);
});

test('HTTP body guard accounts for JSON escaping and UTF8 rather than source character count', async () => {
  for (const text of ['"'.repeat(66000), '界'.repeat(44000)]) {
    assert.ok(text.length < LIMIT);
    const { port, calls } = harness();
    await rejectsCode(port.which(question({ text })), 'input_invalid');
    assert.equal(calls.length, 0);
    assert.equal(port.receipts()[0].fetchAttempts, 0);
  }
});

test('combined instruction field accepts 8192 UTF16 units and refuses 8193 before fetch', async () => {
  const probe = harness();
  await probe.port.which(question({ instructions: 'q' }));
  const overhead = probe.calls[0].wire.questions.judgment.instructions.length - 1;
  const exact = harness();
  await exact.port.which(question({ instructions: 'q'.repeat(8192 - overhead) }));
  assert.equal(exact.calls[0].wire.questions.judgment.instructions.length, 8192);
  const over = harness();
  await rejectsCode(over.port.which(question({ instructions: 'q'.repeat(8193 - overhead) })), 'input_invalid');
  assert.equal(over.calls.length, 0);
  assert.equal(over.port.receipts()[0].fetchAttempts, 0);
});

test('invalid native questions consume a slot and fail without fabricating an unknown answer', async () => {
  const invalid = [
    { ...question(), text: '' },
    { ...question(), instructions: ' ' },
    { ...question(), criteria: { problem: 'P', ok: 'O' } },
    { ...question(), criteria: { ...criteria(), extra: 'X' } },
    { ...question(), criteria: { ...criteria(), unknown: false } },
    { ...question(), extra: 'Not in native question schema.' }
  ];
  for (const input of invalid) {
    const { port, calls } = harness({ maxCalls: 1 });
    await rejectsCode(port.which(input), 'INVALID_NATIVE_QUESTION');
    const [receipt] = port.receipts();
    assert.equal(receipt.sequence, 1);
    assert.equal(receipt.status, 'FAILED');
    assert.equal(receipt.answerSha256, null);
    assert.equal(receipt.fetchAttempts, 0);
    await rejectsCode(port.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
    assert.equal(port.receipts().length, 1);
    assert.equal(calls.length, 0);
  }
});

test('provider contract violations remain failures with one fetch and no repair or retry', async () => {
  const bodies = [
    { result: { judgment: 'yes' } },
    { result: {} },
    { result: { judgment: 'ok', extra: 'Unrequested answer.' } },
    { status: 'failed', result: { judgment: 'ok' } },
    { skipped: ['judgment'], result: { judgment: 'ok' } },
    { result: { judgment: 'ok' }, usage: { input_tokens: -1, thinking_tokens: 0 } }
  ];
  for (const body of bodies) {
    const { port, calls } = harness({
      fetchImpl: () => new Response(JSON.stringify(body), { status: 200 })
    });
    await rejectsCode(port.which(question()), 'provider_contract_error');
    const [receipt] = port.receipts();
    assert.equal(calls.length, 1);
    assert.equal(receipt.status, 'FAILED');
    assert.equal(receipt.errorCode, 'provider_contract_error');
    assert.equal(receipt.fetchAttempts, 1);
    assert.equal(receipt.answerSha256, null);
    assertUnknownIdentity(receipt);
  }
});

test('malformed and oversized provider bodies are not accepted or retried', async () => {
  for (const body of ['{broken', 'x'.repeat(1024 * 1024 + 1)]) {
    const { port, calls } = harness({ fetchImpl: () => new Response(body, { status: 200 }) });
    await rejectsCode(port.which(question()), 'provider_invalid_response');
    assert.equal(calls.length, 1);
    assert.equal(port.receipts()[0].answerSha256, null);
    assert.equal(port.receipts()[0].errorCode, 'provider_invalid_response');
  }
});

test('HTTP and network failures expose sanitized receipt codes without response or key contents', async () => {
  const marker = 'SYNTHETIC-PRIVATE-ERROR-DETAIL';
  const http = harness({ fetchImpl: () => new Response(marker, { status: 429 }) });
  await rejectsCode(http.port.which(question()), 'provider_http_error');
  assert.equal(http.calls.length, 1);
  assert.equal(http.port.receipts()[0].upstreamStatus, 429);
  assert.equal(http.port.receipts()[0].errorCode, 'provider_http_error');
  assert.ok(!JSON.stringify(http.port.receipts()).includes(marker));
  const network = harness({ fetchImpl: () => Promise.reject(new Error(marker)) });
  await rejectsCode(network.port.which(question()), 'provider_unavailable');
  assert.equal(network.calls.length, 1);
  assert.equal(network.port.receipts()[0].errorCode, 'provider_unavailable');
  assert.ok(!JSON.stringify(network.port.receipts()).includes(marker));
});

test('missing auth and pre-aborted signals consume a slot but never fetch', async () => {
  const noAuth = harness({ apiKey: undefined, maxCalls: 1 });
  await rejectsCode(noAuth.port.which(question()), 'auth_missing');
  assert.equal(noAuth.calls.length, 0);
  assert.equal(noAuth.port.receipts()[0].errorCode, 'auth_missing');
  await rejectsCode(noAuth.port.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
  const controller = new AbortController();
  controller.abort();
  const cancelled = harness({ signal: controller.signal });
  await rejectsCode(cancelled.port.which(question()), 'cancelled');
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.port.receipts()[0].errorCode, 'cancelled');
});

test('SDK deadline settles even when injected fetch ignores abort and never resolves', { timeout: 3000 }, async () => {
  let transportSignal;
  const { port, calls } = harness({
    deadlineMs: 20,
    fetchImpl: (_url, init) => {
      transportSignal = init.signal;
      return new Promise(() => {});
    }
  });
  const started = Date.now();
  await rejectsCode(port.which(question()), 'provider_timeout');
  assert.ok(Date.now() - started < 2500);
  assert.equal(calls.length, 1);
  assert.equal(transportSignal.aborted, true);
  const [receipt] = port.receipts();
  assert.equal(receipt.errorCode, 'provider_timeout');
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.fetchAttempts, 1);
  assert.equal(receipt.answerSha256, null);
});

test('inflight caller cancellation is finite without another fetch', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  let transportSignal;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { port, calls } = harness({
    signal: controller.signal, deadlineMs: 1000,
    fetchImpl: (_url, init) => {
      transportSignal = init.signal;
      entered();
      return new Promise(() => {});
    }
  });
  const pending = port.which(question());
  await started;
  controller.abort();
  await rejectsCode(pending, 'cancelled');
  assert.equal(transportSignal.aborted, true);
  assert.equal(calls.length, 1);
  assert.equal(port.receipts()[0].errorCode, 'cancelled');
});

test('consumed slots are bounded across failures and concurrent calls, and refusals append no receipt', async () => {
  const serial = harness({ maxCalls: 2 });
  await rejectsCode(serial.port.which(question({ text: '' })), 'INVALID_NATIVE_QUESTION');
  await serial.port.which(question());
  const existing = serial.port.receipts();
  await rejectsCode(serial.port.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
  assert.equal(serial.calls.length, 1);
  assert.deepEqual(serial.port.receipts().map(r => [r.sequence, r.status]), [
    [1, 'FAILED'], [2, 'ANSWERED']
  ]);
  assert.equal(existing.length, 2);
  assert.equal(serial.port.receipts().length, 2);
  let release;
  const concurrent = harness({
    maxCalls: 1,
    fetchImpl: () => new Promise(resolve => { release = resolve; })
  });
  const first = concurrent.port.which(question());
  await rejectsCode(concurrent.port.which(question()), 'NATIVE_MODEL_CALL_LIMIT');
  release(completed('ok'));
  await first;
  assert.equal(concurrent.calls.length, 1);
  assert.equal(concurrent.port.receipts().length, 1);
  assert.equal(concurrent.port.receipts()[0].sequence, 1);
});

test('Core semantic needs remain INCOMPLETE with no port invocation or transport receipt', async () => {
  const { port, calls } = harness();
  const plan = nativePlan(['Observe the missing independent fact.']);
  const result = await judge(plan, port);
  assert.equal(result.calls, 0);
  assert.equal(result.judgments[0].status, 'INCOMPLETE');
  assert.equal(calls.length, 0);
  assert.equal(port.receipts().length, 0);
  assert.doesNotThrow(() => report(plan, result));
});

test('factory rejects nonfinite contracts and requires explicit fake transport in test-double mode', () => {
  const valid = {
    id: 'synthetic', mode: 'test-double', apiKey: 'public-synthetic-key',
    fetchImpl: () => completed(), deadlineMs: 100
  };
  for (const changes of [
    { id: '' }, { mode: 'jev' }, { deadlineMs: 0 }, { deadlineMs: 95001 },
    { deadlineMs: NaN }, { deadlineMs: 1.5 }, { maxCalls: 0 }, { maxCalls: 5 },
    { maxCalls: 1.5 }, { fetchImpl: undefined }
  ]) {
    assert.throws(() => bindTypeLLMNativeModelPort({ ...valid, ...changes }), {
      message: 'INVALID_TYPELLM_NATIVE_PORT'
    });
  }
  assert.doesNotThrow(() => bindTypeLLMNativeModelPort({ ...valid, deadlineMs: 1, maxCalls: 1 }));
  assert.doesNotThrow(() => bindTypeLLMNativeModelPort({ ...valid, deadlineMs: 95000, maxCalls: 4 }));
});
