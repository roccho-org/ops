import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, judge } from './core.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const request = () => ({ goal: { ref: 'goal:original', content: 'Keep every material condition while shortening this explanation.' },
  observations: [{ ref: 'source:policy', content: 'Approval and actual readback are required. Read-only references need no approval.' },
    { ref: 'target:draft', content: 'Approval is required.' }] });
const rubric = { problem: 'A material original condition was lost.', ok: 'All original conditions and legitimate exceptions remain.', unknown: 'Available observations cannot establish preservation.' };
const question = (id = 'new.meaning-preservation', extra = {}) => ({ id, core: null,
  question: 'Did shortening lose any material condition or exception?', criteria: clone(rubric),
  basisRefs: ['goal:original', 'source:policy'], requires: ['source:policy', 'target:draft'], ...extra });
const proposal = (questions = [question()], missing = []) => ({ questions, missing });
const prepare = (candidate = proposal(), options = {}) => plan(request(), { propose: async () => candidate, ...options });
const reply = async () => ({ label: 'unknown', model: 'independent-test-double' });

test('novel generated criterion reaches model unchanged through independent JSON roundtrip', async () => {
  let seenGoal;
  const value = await plan(request(), { propose: async payload => {
    seenGoal = payload.goal.content; assert.deepEqual(payload.cores, []);
    return proposal();
  } });
  let sent;
  const out = await judge(clone(value), { which: async q => { sent = clone(q); return reply(); } });
  assert.equal(seenGoal, request().goal.content);
  assert.deepEqual(JSON.parse(sent.text), request());
  assert.equal(sent.instructions, question().question);
  assert.deepEqual(sent.criteria, rubric);
  assert.equal(out.judgments[0].label, 'unknown');
  assert.equal(out.calls, 1); assert.equal(out.goalCoverage, 'NOT_CERTIFIED'); assert.equal(out.authority, false);
});

test('request and proposal are snapshotted, deeply frozen and isolated from caller mutation', async () => {
  const input = request(), candidate = proposal(); let release, captured;
  const pending = plan(input, { propose: async payload => {
    captured = payload; await new Promise(resolve => { release = resolve; }); return candidate;
  } });
  input.goal.content = 'Changed goal'; input.observations[0].content = 'Changed source';
  release(); const value = await pending;
  candidate.questions[0].criteria.problem = 'Changed criterion';
  assert.equal(captured.goal.content, request().goal.content);
  assert.deepEqual(value.request, request()); assert.deepEqual(value.questions[0].criteria, rubric);
  assert.ok(Object.isFrozen(value.request.observations[0])); assert.ok(Object.isFrozen(value.questions[0].criteria));
});

test('generated authority, goal, budget, expected labels and invalid provenance are refused', async () => {
  for (const key of ['goal', 'authority', 'maxCalls', 'threshold', 'expected']) {
    await assert.rejects(() => prepare({ ...proposal(), [key]: 'generated value' }));
  }
  await assert.rejects(() => prepare(proposal([question('a', { basisRefs: ['source:policy'] })])));
  await assert.rejects(() => prepare(proposal([question('a', { basisRefs: ['goal:original', 'unobserved:source'] })])));
});

test('known match, new criterion and unresolved Need coexist without coverage certification', async () => {
  const core = { id: 'existing', question: 'Existing trusted question', criteria: clone(rubric) };
  const missing = [{ need: 'An additional Goal obligation', reason: 'Not yet represented by available queries' }];
  const value = await prepare(proposal([question('known', { core: core.id, question: core.question }), question('novel')], missing), { cores: [core] });
  const out = await judge(clone(value), { which: reply });
  assert.equal(out.calls, 2); assert.deepEqual(out.missing, missing); assert.equal(out.goalCoverage, 'NOT_CERTIFIED');
  await assert.rejects(() => prepare(proposal([question('bad', { core: 'unknown-core' })]), { cores: [core] }));
});

test('missing context preserves other observations and refuses only the missing query', async () => {
  const value = await prepare(proposal([question('missing', { requires: ['unobserved:inventory'] }), question('available')]));
  let calls = 0;
  const out = await judge(clone(value), { which: async () => { calls++; return reply(); } });
  assert.equal(calls, 1); assert.equal(out.judgments[0].status, 'INCOMPLETE');
  assert.deepEqual(out.judgments[0].missingRefs, ['unobserved:inventory']);
  assert.equal(out.judgments[1].status, 'OBSERVED'); assert.ok(out.missing.some(row => row.need === 'missing'));
});

test('empty question stream is zero calls and explicit unresolved Goal coverage', async () => {
  const value = await prepare(proposal([]));
  const out = await judge(clone(value), { which: async () => assert.fail('must not call model') });
  assert.equal(out.calls, 0); assert.ok(out.missing.length); assert.equal(out.goalCoverage, 'NOT_CERTIFIED');
});

test('question and byte ceilings are enforced before model invocation', async () => {
  await assert.rejects(() => prepare(proposal([question('one'), question('two')]), { maxQuestions: 1 }));
  await assert.rejects(() => prepare(proposal(), { maxBytes: 20 }));
  const value = await prepare(proposal([question('one'), question('two')])); let calls = 0;
  await assert.rejects(() => judge(clone(value), { which: async () => { calls++; return reply(); } }, { maxQuestions: 1 }));
  assert.equal(calls, 0);
  const limited = await judge(clone(value), { which: reply }, { maxCalls: 1 });
  assert.equal(limited.calls, 1); assert.equal(limited.judgments[1].status, 'NOT_RUN'); assert.ok(limited.missing.length);
});

test('model failure and invalid label retain execution failure, never semantic ok', async () => {
  const value = await prepare();
  for (const which of [async () => { throw new Error('provider failure'); }, async () => ({ label: 'invented', model: 'test' })]) {
    const out = await judge(clone(value), { which });
    assert.equal(out.calls, 1); assert.equal(out.judgments[0].status, 'EXECUTION_ERROR');
    assert.equal(Object.hasOwn(out.judgments[0], 'label'), false); assert.ok(out.missing.length);
  }
});

test('trusted criteria value equality is independent of JSON key order', async () => {
  const core = { id: 'existing', question: 'Existing trusted question', criteria: clone(rubric) };
  const reordered = Object.fromEntries(Object.entries(rubric).reverse());
  const value = await prepare(proposal([question('known', { core: core.id, question: core.question, criteria: reordered })]), { cores: [core] });
  assert.deepEqual(value.questions[0].criteria, core.criteria);
});

test('actual model question stays inside host byte ceiling after JSON escaping', async () => {
  const input = request(); input.observations[0].content = '\\'.repeat(1000);
  const candidate = proposal();
  const raw = { schema: 'ops.goal-evaluation.plan.v1', request: input, ...candidate };
  const maxBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 10;
  const value = await plan(input, { propose: async () => candidate, maxBytes });
  let oversizedSent = false, sentBytes = null;
  await judge(clone(value), { which: async q => {
    sentBytes = Buffer.byteLength(JSON.stringify(q), 'utf8'); oversizedSent = sentBytes > maxBytes; return reply();
  } }, { maxBytes });
  assert.equal(oversizedSent, false, `actual model question ${sentBytes} bytes exceeds host ceiling ${maxBytes}`);
});

test('automatic missing-coverage annotation also fits the emitted Plan byte ceiling', async () => {
  const input = request(), candidate = proposal([]);
  const raw = { schema: 'ops.goal-evaluation.plan.v1', request: input, ...candidate };
  const maxBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 10;
  let value;
  try {
    value = await plan(input, { propose: async () => candidate, maxBytes });
  } catch (error) {
    assert.equal(error.message, 'BYTE_LIMIT'); return;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes, 'emitted Plan must obey its own host ceiling');
});
