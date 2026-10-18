import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { plan, judge, report, unquotedGoalText } from './core.mjs';
test('judge results remain reportable across rationale shapes', async t => {
  const cases = [
    ['absent', undefined, true], ['null', null, true], ['text', '  Explanation retained.  ', true],
    ['number', 0, false], ['boolean', false, false], ['object', {}, false], ['array', [], false],
    ['empty', '', false], ['whitespace', ' \t\n', false],
  ];
  for (const [name, rationale, valid] of cases) await t.test(name, async () => {
    const input = {
      schema: 'ops.goal-evaluation.plan.v2',
      request: { goal: { ref: 'g', content: 'Preserve values.' }, observations: [] },
      clauses: [{ id: 'c', kind: 'obligation', ref: 'g', quote: 'Preserve values.' }],
      questions: [{ id: 'q', core: null, question: 'Is the value preserved?',
        criteria: { problem: 'Changed.', ok: 'Preserved.', unknown: 'Not observed.' },
        clauseIds: ['c'], basisRefs: ['g'], requiredRefs: [], needs: [] }],
      missing: [],
    };
    const before = structuredClone(input);
    let calls = 0;
    const result = await judge(input, { id: 'roundtrip-test', mode: 'test-double', which: async () => {
      calls++;
      return { label: 'ok', model: 'test-double', ...(rationale === undefined ? {} : { rationale }) };
    } });
    const view = report(input, result);
    assert.equal(result.judgments[0].status, valid ? 'OBSERVED' : 'EXECUTION_ERROR');
    assert.equal(view.questions[0].result.status, result.judgments[0].status);
    assert.equal(calls, 1);
    assert.equal(result.calls, calls);
    if (valid) {
      assert.equal(result.judgments[0].rationale, rationale ?? null);
      assert.deepEqual(result.missing, []);
    } else {
      assert.deepEqual(result.missing, [{ need: 'q', reason: 'Model operation failed or answer invalid' }]);
    }
    assert.deepEqual(input, before);
    assert.equal(view.goalCoverage, 'NOT_CERTIFIED');
    assert.equal(view.authority, false);
  });
});
// The existing goal-evaluation-unix CI check runs this file; it also runs the preparer tests.
import './prepare.test.mjs';
import { bindJevChoicePort } from './jev-port.mjs';
import { checkPlan } from './core.mjs';
import { bindJev } from '../../packages/jev/src/client.mjs';

function jevPortPlan(needs = []) {
  return checkPlan({
    schema: 'ops.goal-evaluation.plan.v2',
    request: {
      goal: { ref: 'goal', content: 'Retain every record. Exceptions remain unknown. Alternate observations may be supplied.' },
      observations: [
        { ref: 'record', content: 'The recorded count is two.' },
        { ref: 'qualifier', content: 'The unit has not been supplied.' },
      ],
    },
    clauses: [
      { id: 'keep', kind: 'obligation', ref: 'goal', quote: 'Retain every record.' },
      { id: 'exception', kind: 'exception', ref: 'goal', quote: 'Exceptions remain unknown.' },
      { id: 'alternative', kind: 'alternative', ref: 'goal', quote: 'Alternate observations may be supplied.' },
    ],
    questions: [{
      id: 'check', core: null, question: 'Are the record and its qualifier retained?',
      criteria: { problem: 'A supplied part is omitted.', ok: 'Both supplied parts are retained.', unknown: 'Cannot assess the retention.' },
      clauseIds: ['keep', 'exception', 'alternative'], basisRefs: ['goal', 'record', 'qualifier'],
      requiredRefs: ['record', 'qualifier'], needs,
    }],
    missing: [],
  });
}

function jevPortAnswer(label, model = 'observed-response-model') {
  return { model, answers: { answer: { type: 'choice', choice: label, confidence: 0.7,
    probabilities: { problem: 0.2, ok: 0.5, unknown: 0.3 } } } };
}

test('Jev port preserves native input, all three labels and response model through report', async t => {
  for (const label of ['problem', 'ok', 'unknown']) await t.test(label, async () => {
    const plan = jevPortPlan(), before = JSON.stringify(plan), controller = new AbortController();
    let calls = 0;
    const port = bindJevChoicePort({ id: 'named-questions-port', mode: 'test-double', deadlineMs: 100,
      signal: controller.signal, provider: { available: true, post: async (body, options) => {
        calls++;
        assert.deepEqual(body, { model: 'jev-latest', state: JSON.stringify({ ...plan.request, clauses: plan.clauses }),
          questions: { answer: { type: 'choice', instructions: plan.questions[0].question, criteria: plan.questions[0].criteria } } });
        assert.equal(options.deadlineMs, 100);
        assert.equal(options.signal, controller.signal);
        body.questions.answer.criteria.ok = 'Provider-owned copy';
        return jevPortAnswer(label);
      } } });
    assert.ok(Object.isFrozen(port));
    const result = await judge(plan, port, { maxCalls: 1 });
    assert.equal(calls, 1);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.port, { id: 'named-questions-port', mode: 'test-double' });
    assert.deepEqual(result.judgments[0], { id: 'check', status: 'OBSERVED', label,
      model: 'observed-response-model', rationale: null });
    const output = report(plan, result);
    assert.equal(output.goalCoverage, 'NOT_CERTIFIED');
    assert.equal(output.authority, false);
    assert.equal(JSON.stringify(plan), before);
    assert.ok(!JSON.stringify(output).includes('probabilities'));
    assert.ok(!JSON.stringify(output).includes('confidence'));
  });
});

test('Jev port leaves malformed or rejected answers as reportable execution errors', async t => {
  const cases = {
    missing: { model: 'response-model', answers: {} },
    extra: { model: 'response-model', answers: { ...jevPortAnswer('ok').answers, extra: { type: 'noul', noul: 1 } } },
    unknownLabel: jevPortAnswer('outside'),
    invalidModel: jevPortAnswer('ok', 7),
    blankModel: jevPortAnswer('ok', ' '),
    rejected: null,
  };
  for (const [name, response] of Object.entries(cases)) await t.test(name, async () => {
    let calls = 0;
    const plan = jevPortPlan(), port = bindJevChoicePort({ id: 'invalid-answer-port', mode: 'test-double', deadlineMs: 100,
      provider: { available: true, post: async () => { calls++; if (response === null) throw Error('REJECTED'); return response; } } });
    const result = await judge(plan, port);
    assert.equal(calls, 1);
    assert.equal(result.calls, 1);
    assert.equal(result.judgments[0].status, 'EXECUTION_ERROR');
    assert.equal(result.missing.length, 1);
    assert.doesNotThrow(() => report(plan, result));
  });
});

test('Jev port does not call a provider when the Plan declares a need', async () => {
  let calls = 0;
  const plan = jevPortPlan(['A further recorded observation is needed.']);
  const port = bindJevChoicePort({ id: 'unused-port', mode: 'test-double', deadlineMs: 100,
    provider: { available: true, post: async () => { calls++; throw Error('UNEXPECTED_CALL'); } } });
  const result = await judge(plan, port);
  assert.equal(calls, 0);
  assert.equal(result.calls, 0);
  assert.equal(result.judgments[0].status, 'INCOMPLETE');
  assert.deepEqual(report(plan, result).nextObservations, ['A further recorded observation is needed.']);
});

test('Jev port requires explicit provenance and a finite per-call deadline before use', () => {
  const valid = { id: 'finite-port', mode: 'test-double', deadlineMs: 100,
    provider: { available: true, post: async () => jevPortAnswer('ok') } };
  for (const override of [{ mode: undefined }, { mode: 'jev' }, { deadlineMs: undefined },
    { deadlineMs: 0 }, { deadlineMs: 2_147_483_648 }, { provider: { available: false } }]) {
    assert.throws(() => bindJevChoicePort({ ...valid, ...override }), /INVALID_JEV_PORT/);
  }
});

test('Jev port passes its deadline to bindJev, including a fetch that never settles', async () => {
  let fetchCalls = 0, transportSignal;
  const provider = bindJev({ apiKey: 'test-double-no-secret', fetch: async (_url, options) => {
    fetchCalls++; transportSignal = options.signal; return new Promise(() => {});
  } });
  const plan = jevPortPlan(), port = bindJevChoicePort({ id: 'timeout-port', mode: 'test-double', provider, deadlineMs: 10 });
  const result = await judge(plan, port);
  assert.equal(fetchCalls, 1);
  assert.equal(transportSignal.aborted, true);
  assert.equal(result.judgments[0].status, 'EXECUTION_ERROR');
  assert.doesNotThrow(() => report(plan, result));
});

test('Jev port passes cancellation to bindJev without starting an aborted fetch', async () => {
  let fetchCalls = 0;
  const controller = new AbortController(); controller.abort();
  const provider = bindJev({ apiKey: 'test-double-no-secret', fetch: async () => { fetchCalls++; throw Error('UNEXPECTED_FETCH'); } });
  const plan = jevPortPlan(), port = bindJevChoicePort({ id: 'cancelled-port', mode: 'test-double', provider,
    signal: controller.signal, deadlineMs: 100 });
  const result = await judge(plan, port);
  assert.equal(fetchCalls, 0);
  assert.equal(result.calls, 1);
  assert.equal(result.judgments[0].status, 'EXECUTION_ERROR');
  assert.doesNotThrow(() => report(plan, result));
});

const clone = value => JSON.parse(JSON.stringify(value));
const request = () => ({ goal: { ref: 'goal:original', content: 'Keep every material condition while shortening this explanation.' },
  observations: [{ ref: 'source:policy', content: 'Approval and actual readback are required. Read-only references need no approval.' },
    { ref: 'target:draft', content: 'Approval is required.' }] });
const rubric = { problem: 'A material original condition was lost.', ok: 'All original conditions and legitimate exceptions remain.', unknown: 'Available observations cannot establish preservation.' };
const clauses = () => [
  { id: 'c-keep', kind: 'obligation', ref: 'goal:original', quote: 'Keep every material condition' },
  { id: 'c-short', kind: 'obligation', ref: 'goal:original', quote: 'shortening this explanation' },
  { id: 'c-readonly', kind: 'exception', ref: 'source:policy', quote: 'Read-only references need no approval.' }];
const question = (id = 'new.meaning-preservation', extra = {}) => ({ id, core: null,
  question: 'Did shortening lose any material condition or exception?', criteria: clone(rubric), clauseIds: ['c-keep', 'c-readonly'],
  basisRefs: ['goal:original', 'source:policy'], requiredRefs: ['source:policy', 'target:draft'], needs: [], ...extra });
const proposal = (questions = [question()], missing = [], quoted = clauses()) => ({ clauses: quoted, questions, missing });
const prepare = (candidate = proposal(), options = {}) => plan(request(), { propose: async () => candidate, ...options });
const port = which => ({ id: 'independent-test-double', mode: 'test-double', which });
const reply = async () => ({ label: 'unknown', model: 'independent-test-double' });
const said = label => port(async () => ({ label, model: 'independent-test-double' }));
const recorded = async (path, id) => (await readFile(new URL(path, import.meta.url), 'utf8'))
  .trim().split(/\r?\n/).map(JSON.parse).find(row => row.id === id);
// Test-only reading of a recorded v1 plan under the v2 boundary: supplied refs stay refs, anything else is a need.
const asV2 = (old, quoted, clauseIds) => {
  const supplied = new Set(old.request.observations.map(row => row.ref));
  return { clauses: quoted, missing: old.missing, questions: old.questions.map(({ requires, ...q }) => ({ ...q, clauseIds: clauseIds(q),
    requiredRefs: requires.filter(ref => supplied.has(ref)), needs: requires.filter(ref => !supplied.has(ref)) })) };
};

test('novel generated criterion and its quoted clauses reach model unchanged through independent JSON roundtrip', async () => {
  let seenGoal;
  const value = await plan(request(), { propose: async payload => {
    seenGoal = payload.goal.content; assert.deepEqual(payload.cores, []);
    return proposal();
  } });
  let sent;
  const out = await judge(clone(value), port(async q => { sent = clone(q); return reply(); }));
  assert.equal(seenGoal, request().goal.content);
  assert.deepEqual(JSON.parse(sent.text), { ...request(), clauses: [clauses()[0], clauses()[2]] });
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
  candidate.questions[0].criteria.problem = 'Changed criterion'; candidate.clauses[0].quote = 'Changed quote';
  assert.equal(captured.goal.content, request().goal.content);
  assert.deepEqual(value.request, request()); assert.deepEqual(value.questions[0].criteria, rubric);
  assert.deepEqual(value.clauses, clauses());
  assert.ok(Object.isFrozen(value.request.observations[0])); assert.ok(Object.isFrozen(value.clauses[0]));
});

test('generated authority, goal, budget, expected labels and invalid provenance are refused', async () => {
  for (const key of ['goal', 'authority', 'maxCalls', 'threshold', 'expected']) {
    await assert.rejects(() => prepare({ ...proposal(), [key]: 'generated value' }));
  }
  await assert.rejects(() => prepare(proposal([question('a', { basisRefs: ['source:policy'] })])));
  await assert.rejects(() => prepare(proposal([question('a', { basisRefs: ['goal:original', 'unobserved:source'] })])));
});

test('clause quotes are exact provenance from the Goal or a supplied source', async () => {
  const bad = patch => proposal([question()], [], [{ ...clauses()[0], ...patch }, ...clauses().slice(1)]);
  await assert.rejects(() => prepare(bad({ quote: 'Keep every condition' })), /CLAUSE_QUOTE_NOT_FOUND/);
  await assert.rejects(() => prepare(bad({ ref: 'unobserved:source' })), /INVALID_CLAUSE/);
  await assert.rejects(() => prepare(bad({ kind: 'preference' })), /INVALID_CLAUSE/);
  await assert.rejects(() => prepare(proposal([question()], [], [...clauses(), clauses()[0]])), /CLAUSE_LIMIT_OR_ID/);
});

test('every question serves at least one quoted obligation', async () => {
  await assert.rejects(() => prepare(proposal([question('a', { clauseIds: ['c-readonly'] })])), /INVALID_QUESTION/);
  await assert.rejects(() => prepare(proposal([question('a', { clauseIds: [] })])), /INVALID_QUESTION/);
  await assert.rejects(() => prepare(proposal([question('a', { clauseIds: ['c-keep', 'c-missing'] })])), /INVALID_QUESTION/);
});

test('an unsupplied observation cannot pose as a required ref; it stays a semantic need', async () => {
  const need = 'Result, check and finish records for work-K9';
  await assert.rejects(() => prepare(proposal([question('a', { requiredRefs: [need] })])), /REQUIRED_REF_NOT_SUPPLIED/);
  await assert.rejects(() => prepare(proposal([question('a', { requiredRefs: ['unobserved:inventory'] })])), /REQUIRED_REF_NOT_SUPPLIED/);
  const value = await prepare(proposal([question('missing', { needs: [need] }), question('available')]));
  let calls = 0;
  const out = await judge(clone(value), port(async () => { calls++; return reply(); }));
  assert.equal(calls, 1); assert.equal(out.judgments[0].status, 'INCOMPLETE');
  assert.deepEqual(out.judgments[0].missingNeeds, [need]); assert.equal(Object.hasOwn(out.judgments[0], 'missingRefs'), false);
  assert.equal(out.judgments[1].status, 'OBSERVED'); assert.ok(out.missing.some(row => row.need === 'missing'));
  const view = report(value, out);
  assert.deepEqual(view.nextObservations, [need]);
  assert.deepEqual(view.questions[1].requiredRefs.map(row => row.support), ['NOT_VERIFIED', 'NOT_VERIFIED']);
});

test('recorded v81: a free-text need was emitted as a missing ref; v2 keeps the expected INCOMPLETE as a need', async () => {
  const old = (await recorded('results/confirmation/plan.jsonl', 'v81')).plan;
  const prior = (await recorded('results/confirmation/judge.jsonl', 'v81')).result;
  const supplied = old.request.observations.map(row => row.ref);
  assert.equal(supplied.includes(old.questions[0].requires[0]), false);
  assert.deepEqual(prior.judgments[0].missingRefs, old.questions[0].requires);
  const goal = old.request.goal;
  const quoted = [{ id: 'g-trace', kind: 'obligation', ref: goal.ref, quote: '後で第三者が既存の記録だけから追跡できる' }];
  const value = await plan(old.request, { propose: async () => asV2(old, quoted, () => ['g-trace']) });
  const out = await judge(clone(value), port(async () => assert.fail('must not call model')));
  assert.equal(out.calls, 0); assert.equal(out.judgments[0].status, 'INCOMPLETE');
  assert.deepEqual(out.judgments[0].missingNeeds, old.questions[0].requires);
  const view = report(value, out);
  assert.deepEqual(view.unassessed.map(c => [c.id, c.reason]), [['g-trace', 'QUESTIONS_NOT_JUDGED: INCOMPLETE']]);
  assert.ok(view.nextObservations.includes(old.questions[0].requires[0]));
});

test('recorded h36: supplied refs remain refs and presence is not reported as semantic support', async () => {
  const old = (await recorded('results/confirmation/plan.jsonl', 'h36')).plan;
  const quoted = [{ id: 'g-trace', kind: 'obligation', ref: old.request.goal.ref, quote: '後で第三者が既存の記録だけから追跡できる' }];
  const value = await plan(old.request, { propose: async () => asV2(old, quoted, () => ['g-trace']) });
  assert.deepEqual(value.questions[0].needs, []);
  const out = await judge(clone(value), said('ok'));
  const view = report(value, out);
  assert.equal(out.calls, 1); assert.deepEqual(view.unassessed, []);
  assert.equal(view.clauses[0].assessment, 'JUDGED_UNVERIFIED');
  assert.ok(view.questions[0].requiredRefs.every(row => row.supplied && row.support === 'NOT_VERIFIED'));
});

test('recorded w42: the shortening clause with no question stays visibly unassessed', async () => {
  const old = (await recorded('results/plan.jsonl', 'w42')).plan;
  const cores = JSON.parse(await readFile(new URL('cores.json', import.meta.url), 'utf8'));
  const source = old.request.observations.find(row => row.ref === 'fixture:policy-source@1');
  const quoted = [{ id: 'g-short', kind: 'obligation', ref: old.request.goal.ref, quote: '短くして' },
    { id: 'g-keep', kind: 'obligation', ref: old.request.goal.ref, quote: '元の判断を変えずに' },
    { id: 's-readback', kind: 'obligation', ref: source.ref, quote: '公開した後は実際の公開先を読み戻して結果を確認する。' },
    { id: 's-readonly', kind: 'exception', ref: source.ref, quote: 'ただし、内容を変更しない参照には承認を要しない。' }];
  const value = await plan(old.request, { cores, propose: async () => asV2(old, quoted, q => q.id === 'q1' ? ['g-keep', 's-readonly'] : ['s-readback']) });
  const out = await judge(clone(value), said('problem'));
  const view = report(value, out);
  assert.deepEqual(view.unassessed, [{ id: 'g-short', kind: 'obligation', quote: '短くして', reason: 'NO_QUESTION' }]);
  assert.equal(view.goalCoverage, 'NOT_CERTIFIED');
});

test('recorded w42: Goal text the planner never quoted stays visible without any semantic judgment', async () => {
  const old = (await recorded('results/plan.jsonl', 'w42')).plan;
  const goal = old.request.goal;
  assert.deepEqual(unquotedGoalText(old.request, []), [{ start: 0, end: goal.content.length, text: goal.content }]);
  const cores = JSON.parse(await readFile(new URL('cores.json', import.meta.url), 'utf8'));
  // The planner drops the shortening clause entirely: no clause, so no UNASSESSED row can name it.
  const quoted = [{ id: 'g-keep', kind: 'obligation', ref: goal.ref, quote: '元の判断を変えずに' }];
  const value = await plan(old.request, { cores, propose: async () => asV2(old, quoted, () => ['g-keep']) });
  const view = report(value, await judge(clone(value), said('problem')));
  assert.deepEqual(view.unassessed, []);
  assert.deepEqual(view.unquotedGoalText.map(span => span.text), ['この運用説明を短くして、', '使える形にしたい。']);
  for (const span of view.unquotedGoalText) assert.equal(goal.content.slice(span.start, span.end), span.text);
});

test('unquoted Goal text ignores source quotes, whitespace and punctuation-only gaps', () => {
  const input = request();
  const spans = unquotedGoalText(input, [...clauses(), { id: 's', kind: 'obligation', ref: 'source:policy', quote: 'Approval' }]);
  assert.deepEqual(spans.map(span => span.text), ['while']);
  assert.deepEqual(unquotedGoalText(input, [{ id: 'all', kind: 'obligation', ref: 'goal:original', quote: input.goal.content }]), []);
});

test('exceptions and alternatives reach the judge with their obligation; unattached ones are reported', async () => {
  const quoted = [...clauses(), { id: 'c-retry', kind: 'alternative', ref: 'source:policy', quote: 'Approval and actual readback are required.' }];
  const value = await prepare(proposal([question()], [], quoted));
  let sent;
  const out = await judge(clone(value), port(async q => { sent = JSON.parse(q.text); return reply(); }));
  assert.deepEqual(sent.clauses.map(c => c.id), ['c-keep', 'c-readonly']);
  assert.deepEqual(report(value, out).unassessed.map(c => [c.id, c.kind, c.reason]),
    [['c-short', 'obligation', 'NO_QUESTION'], ['c-retry', 'alternative', 'NO_QUESTION']]);
});

test('report keeps the native three-label answer, port identity, unverified rationale and failures explicit', async () => {
  const value = await prepare(proposal([question('one'), question('two', { clauseIds: ['c-short'] })]));
  let n = 0;
  const out = await judge(clone(value), port(async () => {
    if (n++) throw new Error('provider failure');
    return { label: 'problem', model: 'independent-test-double', rationale: 'Draft omits readback.' };
  }));
  const view = report(value, out);
  assert.deepEqual(view.port, { id: 'independent-test-double', mode: 'test-double' });
  assert.deepEqual(view.questions[0].result, { status: 'OBSERVED', answer: { type: 'native-three-label', labels: ['problem', 'ok', 'unknown'], value: 'problem' },
    model: 'independent-test-double', rationale: { text: 'Draft omits readback.', verified: false } });
  assert.deepEqual(view.questions[1].result, { status: 'EXECUTION_ERROR' });
  assert.deepEqual(view.unassessed.map(c => [c.id, c.reason]), [['c-short', 'QUESTIONS_NOT_JUDGED: EXECUTION_ERROR']]);
  assert.equal(view.nextDecision, 'CONSUMER_OWNED'); assert.equal(view.authority, false);
  assert.throws(() => report(value, { ...out, judgments: out.judgments.slice(1) }), /RESULT_PLAN_MISMATCH/);
  assert.throws(() => report(value, { ...out, authority: true }), /RESULT_PLAN_MISMATCH/);
});

test('a port must name itself and declare live or test-double before any call', async () => {
  const value = await prepare();
  for (const bad of [{ which: reply }, { id: 'p', which: reply }, { id: 'p', mode: 'replay', which: reply }, { id: ' ', mode: 'live', which: reply }]) {
    await assert.rejects(() => judge(clone(value), bad), /INVALID_PORT/);
  }
});

test('report refuses answers outside the asked labels and results bound to another Plan', async () => {
  const value = await prepare(proposal([question('q1')]));
  const out = await judge(clone(value), said('problem'));
  const forged = clone(out); forged.judgments[0].label = 'banana';
  assert.throws(() => report(value, forged), /RESULT_PLAN_MISMATCH/);
  const otherGoal = request(); otherGoal.goal.content = 'Keep every material condition in a different Goal.';
  const other = await plan(otherGoal, { propose: async () => proposal([question('q1')], [], clauses().filter(c => c.id !== 'c-short')) });
  assert.equal(other.questions[0].id, out.judgments[0].id);
  assert.throws(() => report(other, out), /RESULT_PLAN_MISMATCH/);
  const tampered = clone(out); tampered.planDigest = '0'.repeat(64);
  assert.throws(() => report(value, tampered), /RESULT_PLAN_MISMATCH/);
  const needs = await prepare(proposal([question('q1', { needs: ['inventory'] })]));
  const incomplete = await judge(clone(needs), port(reply));
  const shifted = clone(incomplete); shifted.judgments[0] = { id: 'q1', status: 'OBSERVED', label: 'ok', model: 'm', rationale: null };
  assert.throws(() => report(needs, shifted), /RESULT_PLAN_MISMATCH/);
  assert.doesNotThrow(() => report(clone(value), clone(out)));
});

test('report refuses undefined states, answers without a model and fabricated INCOMPLETE (R6 D-F)', async () => {
  const value = await prepare(proposal([question('q1'), question('q2')]));
  const out = await judge(clone(value), said('ok'));
  const forge = (patch, i = 0) => { const r = clone(out); r.judgments[i] = { id: `q${i + 1}`, ...patch }; return r; };
  for (const bad of [
    forge({ status: 'PASS' }),
    forge({ status: 'OBSERVED', label: 'ok' }),
    forge({ status: 'OBSERVED', label: 'ok', model: '', rationale: null }),
    forge({ status: 'OBSERVED', label: 'ok', model: 'm', rationale: '' }),
    forge({ status: 'INCOMPLETE', missingNeeds: ['made up'] }),
  ]) assert.throws(() => report(value, bad), /RESULT_PLAN_MISMATCH/);
  const silent = clone(out); silent.judgments[0].rationale = null;
  assert.equal(report(value, silent).questions[0].result.rationale, null);
});

test('report re-derives missing rows and call count from the Plan and judgments (R7)', async () => {
  const missing = [{ need: 'Planned need', reason: 'Declared by the planner' }];
  const value = await prepare(proposal([question('q1'), question('q2', { needs: ['inventory'] }), question('q3')], missing));
  let n = 0;
  const out = await judge(clone(value), port(async () => { if (n++) throw new Error('provider failure'); return reply(); }));
  assert.deepEqual(out.missing.map(row => row.need), ['Planned need', 'q2', 'q3']); assert.equal(out.calls, 2);
  assert.deepEqual(report(value, out).missing, out.missing);
  const forged = [
    r => { r.missing.push({ need: 'fake', reason: 'fake' }); },
    r => { r.missing = r.missing.slice(1); },
    r => { r.missing[1].reason = 'Call limit'; },
    r => { r.missing[2].need = 'q1'; },
    r => { r.missing = 'none'; },
    r => { r.calls = 99; },
    r => { r.calls = 1; },
  ];
  for (const mutate of forged) { const r = clone(out); mutate(r); assert.throws(() => report(value, r), /RESULT_PLAN_MISMATCH/); }
  const limited = await judge(clone(value), port(reply), { maxCalls: 1 });
  assert.deepEqual(limited.judgments.map(j => j.status), ['OBSERVED', 'INCOMPLETE', 'NOT_RUN']);
  assert.doesNotThrow(() => report(value, limited));
});

test('known match, new criterion and unresolved Need coexist without coverage certification', async () => {
  const core = { id: 'existing', question: 'Existing trusted question', criteria: clone(rubric) };
  const missing = [{ need: 'An additional Goal obligation', reason: 'Not yet represented by available queries' }];
  const value = await prepare(proposal([question('known', { core: core.id, question: core.question }), question('novel')], missing), { cores: [core] });
  const out = await judge(clone(value), port(reply));
  assert.equal(out.calls, 2); assert.deepEqual(out.missing, missing); assert.equal(out.goalCoverage, 'NOT_CERTIFIED');
  await assert.rejects(() => prepare(proposal([question('bad', { core: 'unknown-core' })]), { cores: [core] }));
});

test('empty question stream is zero calls and explicit unresolved Goal coverage', async () => {
  const value = await prepare(proposal([]));
  const out = await judge(clone(value), port(async () => assert.fail('must not call model')));
  assert.equal(out.calls, 0); assert.ok(out.missing.length); assert.equal(out.goalCoverage, 'NOT_CERTIFIED');
  assert.equal(report(value, out).unassessed.length, clauses().length);
});

test('question, clause and byte ceilings are enforced before model invocation', async () => {
  await assert.rejects(() => prepare(proposal([question('one'), question('two')]), { maxQuestions: 1 }));
  await assert.rejects(() => prepare(proposal(), { maxClauses: 2 }), /CLAUSE_LIMIT_OR_ID/);
  await assert.rejects(() => prepare(proposal(), { maxBytes: 20 }));
  const value = await prepare(proposal([question('one'), question('two')])); let calls = 0;
  await assert.rejects(() => judge(clone(value), port(async () => { calls++; return reply(); }), { maxQuestions: 1 }));
  assert.equal(calls, 0);
  const limited = await judge(clone(value), port(reply), { maxCalls: 1 });
  assert.equal(limited.calls, 1); assert.equal(limited.judgments[1].status, 'NOT_RUN'); assert.ok(limited.missing.length);
});

test('model failure and invalid label retain execution failure, never semantic ok', async () => {
  const value = await prepare();
  for (const which of [async () => { throw new Error('provider failure'); }, async () => ({ label: 'invented', model: 'test' })]) {
    const out = await judge(clone(value), port(which));
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
  const input = request(); input.observations[0].content = '\\'.repeat(1000) + input.observations[0].content;
  const candidate = proposal();
  const raw = { schema: 'ops.goal-evaluation.plan.v2', request: input, ...candidate };
  const maxBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 10;
  const value = await plan(input, { propose: async () => candidate, maxBytes });
  let oversizedSent = false, sentBytes = null;
  const out = await judge(clone(value), port(async q => {
    sentBytes = Buffer.byteLength(JSON.stringify(q), 'utf8'); oversizedSent = sentBytes > maxBytes; return reply();
  }), { maxBytes });
  assert.equal(oversizedSent, false, `actual model question ${sentBytes} bytes exceeds host ceiling ${maxBytes}`);
  assert.deepEqual(out.missing.at(-1), { need: question().id, reason: 'Model question byte limit' });
  assert.equal(report(value, out, { maxBytes }).questions[0].result.status, 'NOT_RUN');
});

test('automatic missing-coverage annotation also fits the emitted Plan byte ceiling', async () => {
  const input = request(), candidate = proposal([]);
  const raw = { schema: 'ops.goal-evaluation.plan.v2', request: input, ...candidate };
  const maxBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 10;
  let value;
  try {
    value = await plan(input, { propose: async () => candidate, maxBytes });
  } catch (error) {
    assert.equal(error.message, 'BYTE_LIMIT'); return;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes, 'emitted Plan must obey its own host ceiling');
});

import { test as typedProposalTest } from 'node:test';
import typedProposalAssert from 'node:assert/strict';
import { plan as planViaTypeLLM } from './core.mjs';
import { bindTypeLLMProposalPort } from './typellm-port.mjs';

const typedProposalRequest = () => ({
  goal: { ref: 'goal', content: 'Keep the next action with the consumer.' },
  observations: [{ ref: 'evidence', content: 'The consumer can receive an action.' }]
});
const typedProposalCandidate = () => ({
  clauses: [{ id: 'obligation-1', kind: 'obligation', ref: 'goal',
    quote: 'Keep the next action with the consumer.' }],
  questions: [{ id: 'question-1', core: null, question: 'Does the action remain available?',
    criteria: { problem: 'It is unavailable.', ok: 'It is available.', unknown: 'Evidence is insufficient.' },
    clauseIds: ['obligation-1'], basisRefs: ['goal', 'evidence'], requiredRefs: ['evidence'], needs: [] }],
  missing: []
});
const typedProposalResponse = (proposal, extra = {}) => new Response(JSON.stringify({
  status: 'completed', result: { proposal }, ...extra
}), { status: 200, headers: { 'content-type': 'application/json' } });
const typedProposalPort = fetchImpl => bindTypeLLMProposalPort({
  id: 'synthetic-proposal', mode: 'test-double', apiKey: 'synthetic-test-key', deadlineMs: 1000, fetchImpl
});

typedProposalTest('TypeLLM proposal port connects the typed string to native Core validation', async () => {
  let calls = 0;
  let wire;
  const port = typedProposalPort(async (url, init) => {
    calls++;
    typedProposalAssert.equal(url, 'https://api.typellm.ai/v1/generate');
    typedProposalAssert.equal(init.redirect, 'error');
    wire = JSON.parse(init.body);
    return typedProposalResponse(JSON.stringify(typedProposalCandidate()), {
      usage: { input_tokens: 11, thinking_tokens: 0 }, elapsed: 0.1
    });
  });
  const result = await planViaTypeLLM(typedProposalRequest(), { propose: port.propose });
  typedProposalAssert.equal(calls, 1);
  typedProposalAssert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  typedProposalAssert.ok(Object.isFrozen(result));
  typedProposalAssert.deepEqual(JSON.parse(wire.context), {
    ...typedProposalRequest(), cores: [], maxQuestions: 4, maxClauses: 16
  });
  typedProposalAssert.equal(wire.model, 'typellm-latest');
  typedProposalAssert.deepEqual(Object.keys(wire.questions), ['proposal']);
  typedProposalAssert.equal(wire.questions.proposal.type, 'string');
  typedProposalAssert.equal(wire.questions.proposal.thinking, false);
  const receipt = port.receipts()[0];
  typedProposalAssert.equal(receipt.status, 'JSON_PARSED');
  typedProposalAssert.equal(receipt.fetchAttempts, 1);
  typedProposalAssert.equal(receipt.wireRequestBytes, Buffer.byteLength(JSON.stringify(wire)));
  typedProposalAssert.match(receipt.wireRequestSha256, /^[a-f0-9]{64}$/);
  typedProposalAssert.equal(receipt.usageInputTokens, 11);
  typedProposalAssert.equal(receipt.usageThinkingTokens, 0);
  typedProposalAssert.equal(receipt.providerElapsed, 0.1);
  typedProposalAssert.equal(receipt.requestedModel, 'typellm-latest');
  typedProposalAssert.equal(receipt.reportedModel, null);
  typedProposalAssert.ok(Object.isFrozen(port.receipts()) && Object.isFrozen(receipt));
  typedProposalAssert.ok(Object.values(receipt).every(v => v === null || ['string', 'number'].includes(typeof v)));
  typedProposalAssert.ok(!JSON.stringify(receipt).includes('synthetic-test-key'));
});

typedProposalTest('TypeLLM proposal port does not strip fences, repair JSON, or retry', async () => {
  for (const output of ['private malformed output', '\u0060\u0060\u0060json\n{}\n\u0060\u0060\u0060']) {
    let calls = 0;
    const port = typedProposalPort(async () => {
      calls++;
      return typedProposalResponse(output);
    });
    await typedProposalAssert.rejects(port.propose({ input: 'synthetic' }),
      error => error.message === 'INVALID_PROPOSAL_JSON');
    typedProposalAssert.equal(calls, 1);
    const receipt = port.receipts()[0];
    typedProposalAssert.equal(receipt.errorCode, 'INVALID_PROPOSAL_JSON');
    typedProposalAssert.equal(receipt.proposalUnits, output.length);
    typedProposalAssert.equal(receipt.proposalBytes, Buffer.byteLength(output));
    typedProposalAssert.ok(!JSON.stringify(receipt).includes(output));
  }
});

typedProposalTest('TypeLLM parsed JSON does not bypass native Plan shape validation', async () => {
  let calls = 0;
  const port = typedProposalPort(async () => {
    calls++;
    return typedProposalResponse(JSON.stringify({ clauses: [], questions: [], missing: [], extra: true }));
  });
  await typedProposalAssert.rejects(planViaTypeLLM(typedProposalRequest(), { propose: port.propose }),
    /INVALID_PROPOSAL/);
  typedProposalAssert.equal(calls, 1);
  typedProposalAssert.equal(port.receipts()[0].status, 'JSON_PARSED');
});

typedProposalTest('TypeLLM string limit counts UTF-16 units without clipping UTF-8 content', async () => {
  const candidate = { clauses: [], questions: [], missing: [{ need: 'evidence', reason: '' }] };
  const overhead = JSON.stringify(candidate).length;
  candidate.missing[0].reason = '漢'.repeat(2048 - overhead);
  const output = JSON.stringify(candidate);
  typedProposalAssert.equal(output.length, 2048);
  typedProposalAssert.ok(Buffer.byteLength(output) > 2048);
  const accepted = typedProposalPort(async () => typedProposalResponse(output));
  const result = await planViaTypeLLM(typedProposalRequest(), { propose: accepted.propose });
  typedProposalAssert.equal(result.missing[0].reason, candidate.missing[0].reason);
  typedProposalAssert.equal(accepted.receipts()[0].proposalUnits, 2048);
  typedProposalAssert.equal(accepted.receipts()[0].proposalBytes, Buffer.byteLength(output));
  const rejected = typedProposalPort(async () => typedProposalResponse(output + ' '));
  await typedProposalAssert.rejects(rejected.propose({ input: 'synthetic' }),
    error => error.code === 'provider_contract_error');
  typedProposalAssert.equal(rejected.receipts()[0].fetchAttempts, 1);
  typedProposalAssert.equal(rejected.receipts()[0].proposalUnits, null);
});

typedProposalTest('TypeLLM missing auth and pre-abort consume no HTTP attempt', async () => {
  const unexpectedFetch = async () => { throw new Error('UNEXPECTED_FETCH'); };
  const missing = bindTypeLLMProposalPort({
    id: 'no-auth', mode: 'test-double', deadlineMs: 100, fetchImpl: unexpectedFetch
  });
  await typedProposalAssert.rejects(missing.propose({ input: 'synthetic' }),
    error => error.code === 'auth_missing');
  typedProposalAssert.equal(missing.receipts()[0].fetchAttempts, 0);
  const controller = new AbortController();
  controller.abort();
  const aborted = bindTypeLLMProposalPort({
    id: 'aborted', mode: 'test-double', apiKey: 'synthetic-test-key',
    deadlineMs: 100, signal: controller.signal, fetchImpl: unexpectedFetch
  });
  await typedProposalAssert.rejects(aborted.propose({ input: 'synthetic' }),
    error => error.code === 'cancelled');
  typedProposalAssert.equal(aborted.receipts()[0].fetchAttempts, 0);
});

typedProposalTest('TypeLLM transport deadline is mandatory and bounds a pending fetch', async () => {
  for (const deadlineMs of [undefined, 0, 95001, 1.5]) {
    typedProposalAssert.throws(() => bindTypeLLMProposalPort({
      id: 'invalid', mode: 'test-double', deadlineMs, fetchImpl: async () => {}
    }), /INVALID_TYPELLM_PROPOSAL_PORT/);
  }
  typedProposalAssert.throws(() => bindTypeLLMProposalPort({
    id: 'no-fake', mode: 'test-double', apiKey: 'synthetic-test-key', deadlineMs: 100
  }), /INVALID_TYPELLM_PROPOSAL_PORT/);
  let calls = 0;
  let transportSignal;
  const port = bindTypeLLMProposalPort({
    id: 'timeout', mode: 'test-double', apiKey: 'synthetic-test-key', deadlineMs: 10,
    fetchImpl: async (url, init) => {
      calls++;
      transportSignal = init.signal;
      return new Promise(() => {});
    }
  });
  await typedProposalAssert.rejects(port.propose({ input: 'synthetic' }),
    error => error.code === 'provider_timeout');
  typedProposalAssert.equal(calls, 1);
  typedProposalAssert.equal(transportSignal.aborted, true);
  typedProposalAssert.equal(port.receipts()[0].usageInputTokens, null);
  typedProposalAssert.equal(port.receipts()[0].reportedModel, null);
});

typedProposalTest('TypeLLM HTTP and transport errors preserve generic classification without body reflection', async () => {
  const http = typedProposalPort(async () => new Response('PRIVATE_PROVIDER_ERROR_BODY', { status: 429 }));
  await typedProposalAssert.rejects(http.propose({ input: 'synthetic' }),
    error => error.code === 'provider_http_error' && error.upstreamStatus === 429
      && !error.message.includes('PRIVATE_PROVIDER_ERROR_BODY'));
  typedProposalAssert.equal(http.receipts()[0].upstreamStatus, 429);
  typedProposalAssert.equal(http.receipts()[0].fetchAttempts, 1);
  const network = typedProposalPort(async () => { throw new Error('PRIVATE_TRANSPORT_ERROR'); });
  await typedProposalAssert.rejects(network.propose({ input: 'synthetic' }),
    error => error.code === 'provider_unavailable' && !error.message.includes('PRIVATE_TRANSPORT_ERROR'));
  typedProposalAssert.equal(network.receipts()[0].fetchAttempts, 1);
});

typedProposalTest('TypeLLM proposal port consumes one attempt before awaiting and cannot be reused', async () => {
  let complete;
  let calls = 0;
  const port = typedProposalPort((url, init) => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  });
  const first = port.propose({ input: 'synthetic' });
  await typedProposalAssert.rejects(port.propose({ input: 'other' }), /PROPOSAL_ALREADY_CONSUMED/);
  complete(typedProposalResponse(JSON.stringify({ clauses: [], questions: [], missing: [] })));
  await first;
  typedProposalAssert.equal(calls, 1);
  typedProposalAssert.equal(port.receipts().length, 1);
  await typedProposalAssert.rejects(port.propose({ input: 'again' }), /PROPOSAL_ALREADY_CONSUMED/);
  typedProposalAssert.equal(calls, 1);
});
import './typellm-native-model-port.test.mjs';
import './typellm-executor-ports.test.mjs';
import './typellm-ssh-executor.test.mjs';
import './typellm-structured-proposal.test.mjs';
