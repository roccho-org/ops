import { historicalActionsConfig } from './historical-actions-config.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JEV_MODEL } from '../core.mjs';
import { semlint } from '../semlint.mjs';
import { ENTRY_LIMITS, preparePlan, runPlan, executeOwnerPlan, snapshotJson } from '../semlint-entry.mjs';
import { REQUEST_PREFIX, RESULT_PREFIX, admitIssueComment, nextIssueEffect, composeResultComment, verifyResultReadback, parseResultComment, deriveIssuePrior,
  admitIssueCommand, subjectRevision, validateActionsConfig, selectActionsTarget, selectRunRange } from '../github-comment.mjs';

const copy = (x) => JSON.parse(JSON.stringify(x));
const hash = (x) => createHash('sha256').update(x).digest('hex');
const roles = ['authorityContract', 'completionContract', 'responsibilityContract', 'requiredContracts',
  'dependencyDescription', 'accountingContract', 'registeredCases', 'qualityContract', 'baselineEvidence'];
// Catalog meanings and rule/question mapping remain in semlint; this test reads them, not a second rubric.
const empty = { schema: 'ops.semlint.input.v1', subject: { kind: 'log-entry', ref: 'fixture:subject', revision: 'r1',
  scope: 'fixture only', content: 'public fixture, not an instruction', sha256: hash('public fixture, not an instruction') }, context: [], checks: [] };
const catalog = (await semlint(empty, () => { throw new Error('must not call'); })).records;
const input = { ...copy(empty), checks: catalog.map((x) => x.rule), context: roles.map((role) => ({ role,
  ref: `fixture:${role}`, revision: 'r1', content: `public ${role}`, sha256: hash(`public ${role}`) })) };
const plan = { schema: 'ops.semlint.real-input.v1', cases: [{ id: 'normal', input }] };
const config = { repository: 'roccho-dev/ops', issue: 483, requesters: ['fixture-requester'],
  executionSource: 'a'.repeat(40), limits: { ...ENTRY_LIMITS } };
const event = { repository: config.repository, issue: config.issue, action: 'created', comment: { id: 10,
  author: 'fixture-requester', revision: '2026-10-04T00:00:00Z', body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: plan.cases }) } };
let calls = 0;
const seen = [];
const answer = async (state, questions, options) => {
  calls++; seen.push({ state, questions, options });
  assert.deepEqual(copy(state), copy((await preparePlan(plan)).plan.cases[0].input));
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(questions));
  assert.equal(Object.keys(questions).length, 6);
  assert.deepEqual(Object.keys(questions), ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, 'noul'); assert.equal(typeof q.instructions, 'string');
    assert.deepEqual(q.criteria, { true: 'The concern is present in the declared state.', false: 'The concern is absent from the declared state.' });
  }
  assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15000);
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map((key, i) => [key, { type: 'noul', noul: i / 10 }])),
    usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, private_detail: 'must not print' } };
};
const prepared = await preparePlan(plan);
assert.equal(calls, 0); assert.equal(prepared.plannedCalls, 1);
const result = await runPlan(prepared, answer);
assert.equal(calls, 1); assert.equal(result.accounting.callbackAttempts, 1);
assert.equal(result.accounting.validatedCalls, 1); assert.equal(result.accounting.providerHttpCalls, null);
assert.deepEqual(result.cases[0].result.records.map((x) => [x.question, x.rule]), catalog.map((x) => [x.question, x.rule]));
assert.deepEqual(result.cases[0].result.records.map((x) => x.noul), [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
assert.deepEqual(result.cases[0].result.accounting.usage, { input_tokens: 12, output_tokens: 6, total_tokens: 18 });
assert.equal(JSON.stringify(result).includes('private_detail'), false);

// Entire plan is validated before any real callback, including a bad later case and oversized state.
const bad = copy(plan); bad.cases.push({ id: 'late', input: { ...copy(input), checks: ['unknown'] } });
await assert.rejects(preparePlan(bad), /INVALID_ENTRY_SEMLINT/); assert.equal(calls, 1);
await assert.rejects(preparePlan({ ...plan, cases: [plan.cases[0], plan.cases[0]] }), /INVALID_ENTRY_CASE/);
const huge = copy(input); huge.subject.content = 'x'.repeat(28000); huge.subject.sha256 = hash(huge.subject.content);
await assert.rejects(preparePlan({ ...plan, cases: [{ id: 'too-large', input: huge }] }), /ENTRY_PREFLIGHT_FAILED/);
await assert.rejects(preparePlan({ ...plan, endpoint: 'https://attacker.invalid' }), /INVALID_ENTRY_PLAN/);
await assert.rejects(preparePlan({ ...plan, cases: [plan.cases[0], { id: 'second', input }] }, { ...ENTRY_LIMITS, maxCalls: 1 }), /ENTRY_CALL_BUDGET_EXCEEDED/);
await assert.rejects(preparePlan(plan, { ...ENTRY_LIMITS, deadlineMs: 0 }), /INVALID_ENTRY_LIMITS/);
let getterCalls = 0;
const getter = { get schema() { getterCalls++; return plan.schema; }, cases: plan.cases };
await assert.rejects(preparePlan(getter), /INVALID_ENTRY_INPUT/); assert.equal(getterCalls, 0);
assert.throws(() => snapshotJson({ toJSON() { getterCalls++; return {}; } }), /INVALID_ENTRY_INPUT/);
const sparse = []; sparse.length = 2; assert.throws(() => snapshotJson(sparse), /INVALID_ENTRY_INPUT/);

const incomplete = copy(plan); incomplete.cases[0].input.context = [];
const incompleteResult = await runPlan(await preparePlan(incomplete), () => { throw new Error('must not call'); });
assert.equal(incompleteResult.accounting.callbackAttempts, 0);
assert.ok(incompleteResult.cases[0].result.records.every((x) => x.status === 'INCOMPLETE' && x.noul === null));
const unselected = { ...plan, cases: [{ id: 'none', input: empty }] };
assert.ok((await runPlan(await preparePlan(unselected), () => { throw new Error('must not call'); })).cases[0].result.records.every((x) => x.status === 'NOT_SELECTED'));
const mismatch = await runPlan(prepared, async () => ({ model: 'wrong', answers: {} }));
assert.ok(mismatch.cases[0].result.records.every((x) => x.status === 'EVIDENCE_INVALID' && x.noul === null));
assert.equal(mismatch.accounting.validatedCalls, 0);
const failed = await runPlan(prepared, async () => { throw new Error('private synthetic diagnostic'); });
assert.equal(JSON.stringify(failed).includes('private synthetic'), false);
assert.ok(failed.cases[0].result.records.every((x) => x.status === 'EXECUTION_ERROR'));
const deadline = await runPlan(prepared, () => { throw new Error('must not call'); }, { now: (() => { let n = 0; return () => n++ ? 60001 : 0; })() });
assert.equal(deadline.accounting.callbackAttempts, 0);
assert.ok(deadline.cases[0].result.records.every((x) => x.status === 'EXECUTION_ERROR'));
await assert.rejects(runPlan(copy(prepared), answer), /ENTRY_NOT_ADMITTED/);

// Case-outer clock reads the injected instants immediately around each whole semlint call.
const clock = (ticks) => { let i = 0; const read = () => ticks[i++]; read.reads = () => i; return read; };
const answerOnce = async (_, questions) => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.3 }])) });
const oneClock = clock([1000, 1003, 1010, 1042.5]); // plan start, case start, deadline read in callback, case end
const timed = await runPlan(prepared, answerOnce, { now: oneClock });
assert.equal(oneClock.reads(), 4); assert.equal(timed.schema, 'ops.semlint.real-result.v3');
assert.equal(timed.cases[0].elapsedMs, 39.5); assert.equal(timed.cases[0].provider, null);
assert.deepEqual(Object.keys(timed.cases[0]), ['id', 'result', 'provider', 'elapsedMs']);
for (const ticks of [[0, 0, 0, NaN], [0, 10, 10, 5], [0, 0, 0, '9'], [0, 0, 0, Infinity]]) {
  await assert.rejects(runPlan(prepared, answerOnce, { now: clock(ticks) }), /ENTRY_CLOCK_INVALID/);
}

// Production wire, pinned source endpoint/model, timeout and redirect guard are exercised only by a fixture fetch.
let fixtureHttp = 0;
const ownerResult = await executeOwnerPlan(prepared, 'synthetic-only-not-a-key', async (url, options) => {
  fixtureHttp++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
  assert.equal(options.method, 'POST'); assert.ok(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body); assert.equal(body.model, JEV_MODEL); assert.deepEqual(body.state, input);
  return new Response(JSON.stringify({ model: JEV_MODEL,
    answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.2 }])) }), { status: 200 });
});
assert.equal(fixtureHttp, 1); assert.equal(ownerResult.accounting.validatedCalls, 1);
assert.equal(ownerResult.schema, 'ops.semlint.real-result.v3');
assert.ok(Number.isFinite(ownerResult.cases[0].elapsedMs) && ownerResult.cases[0].elapsedMs >= 0);
assert.ok(Number.isFinite(ownerResult.cases[0].provider.elapsedMs)); // separate native fetch observation
assert.deepEqual(ownerResult.accounting, { callbackAttempts: 1, validatedCalls: 1, providerHttpCalls: 1,
  completedHttpCalls: 1, validatedResponses: 1, unknownHttpCalls: 0, cost: null });
assert.equal(ownerResult.cases[0].provider.validatedModel, JEV_MODEL);
assert.equal(ownerResult.cases[0].provider.statusClass, 'VALIDATED_RESPONSE');
assert.match(ownerResult.cases[0].provider.responseDigest, /^[a-f0-9]{64}$/);
assert.equal(ownerResult.cases[0].provider.usage, null);

const request = await admitIssueComment(event, config);
assert.equal(request.status, 'ADMITTED'); assert.equal(request.prepared.planDigest, prepared.planDigest);
for (const altered of [
  { ...event, issue: 484 }, { ...event, action: 'edited' },
  { ...event, comment: { ...event.comment, author: 'unauthorized' } },
  { ...event, comment: { ...event.comment, body: RESULT_PREFIX + '{}' } },
  { ...event, comment: { ...event.comment, body: '/jev-evaluate' } },
  { ...event, comment: { ...event.comment, body: REQUEST_PREFIX + '{bad-json' } },
  { ...event, comment: { ...event.comment, body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: plan.cases, limits: config.limits }) } },
]) assert.equal((await admitIssueComment(altered, config)).status, 'NOT_ADMITTED');
assert.equal((await admitIssueComment(event, { ...config, endpoint: 'bad' })).status, 'NOT_ADMITTED');
const unpostable = Array.from({ length: 24 }, (_, i) => ({ id: `many-${i}`, input }));
const unpostableRequest = await admitIssueComment({ ...event, comment: { ...event.comment,
  body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: unpostable }) } }, config);
assert.equal(unpostableRequest.status, 'NOT_ADMITTED');
assert.equal(unpostableRequest.cause, 'RESULT_WOULD_EXCEED_COMMENT_CAP');
assert.equal(calls, 1);
const newRevision = await admitIssueComment({ ...event, comment: { ...event.comment, revision: 'new-revision' } }, config);
assert.notEqual(newRevision.requestDigest, request.requestDigest);
const newSource = await admitIssueComment(event, { ...config, executionSource: 'b'.repeat(40) });
assert.notEqual(newSource.requestDigest, request.requestDigest);
const editedPlan = copy(plan); editedPlan.cases[0].input.subject.revision = 'r2';
const changed = await runPlan(await preparePlan(editedPlan), async (_, questions) => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.2 }])) }));
assert.throws(() => composeResultComment(request, changed), /RESULT_IDENTITY_MISMATCH/);
assert.equal(nextIssueEffect(request).effect, 'EVALUATE');
assert.equal(nextIssueEffect(request, { requestDigest: request.requestDigest, state: 'EVALUATED' }).effect, 'APPEND_EXISTING_RESULT');
assert.equal(nextIssueEffect(request, { requestDigest: request.requestDigest, state: 'APPENDED' }).effect, 'READBACK_ONLY');
for (const state of ['STARTED', 'UNKNOWN', 'FAILED', 'anything']) assert.equal(nextIssueEffect(request, { requestDigest: request.requestDigest, state }).effect, 'NONE');
assert.equal(nextIssueEffect(newRevision, { requestDigest: request.requestDigest, state: 'EVALUATED' }).effect, 'NONE');
assert.equal(nextIssueEffect(copy(request)).effect, 'NONE');
const body = composeResultComment(request, result);
const nativeBody = composeResultComment(request, ownerResult);
assert.ok(nativeBody.includes('VALIDATED_RESPONSE'));
assert.equal(nativeBody.includes('synthetic-only-not-a-key'), false);
assert.ok(body.startsWith(RESULT_PREFIX)); assert.equal(JSON.parse(body.slice(RESULT_PREFIX.length)).authority, false);
const observed = { repository: config.repository, issue: config.issue, id: 11, author: 'fixture-poster', body };
assert.deepEqual(parseResultComment(body), JSON.parse(body.slice(RESULT_PREFIX.length)));
assert.equal(deriveIssuePrior(request, { claims: ['fixture-poster'], results: [{ author: 'fixture-poster', body, databaseId: 11 }] }, 'fixture-poster').state, 'APPENDED');
assert.equal(parseResultComment(RESULT_PREFIX + 'not JSON'), null);

assert.equal(verifyResultReadback(request, body, observed, 'fixture-poster', 11), true);
const otherBody = composeResultComment(newRevision, result);
assert.equal(verifyResultReadback(request, otherBody, { ...observed, body: otherBody }, 'fixture-poster', 11), false);
assert.equal(verifyResultReadback(request, RESULT_PREFIX + '{}', { ...observed, body: RESULT_PREFIX + '{}' }, 'fixture-poster', 11), false);
for (const change of [{ issue: 484 }, { body: body + 'edited' }, { author: 'other' }, { id: 0 }, { id: 12 }]) assert.equal(verifyResultReadback(request, body, { ...observed, ...change }, 'fixture-poster', 11), false);
assert.equal(verifyResultReadback(request, body, observed, 'fixture-poster'), false);
const poison = copy(result); poison.cases[0].result.accounting.usage = { credential: 'private' };
assert.throws(() => composeResultComment(request, poison), /RESULT_IDENTITY_MISMATCH/);
const wrongCount = copy(result); wrongCount.cases[0].result.counts.evaluated = 0;
assert.throws(() => composeResultComment(request, wrongCount), /INVALID_RESULT_ACCOUNTING/);
const falseMissing = copy(result); falseMissing.cases[0].result.records[0].status = 'INCOMPLETE';
falseMissing.cases[0].result.records[0].noul = null;
assert.throws(() => composeResultComment(request, falseMissing), /INVALID_RESULT_RECORD/);
const extra = copy(result); extra.cases[0].result.extra = 'private';
assert.throws(() => composeResultComment(request, extra), /RESULT_IDENTITY_MISMATCH/);
const partial = copy(result); partial.cases[0].result.records[0] = { ...partial.cases[0].result.records[0], status: 'EXECUTION_ERROR', cause: 'EVALUATION_FAILED', noul: null };
partial.cases[0].result.counts.evaluated = 5;
assert.throws(() => composeResultComment(request, partial), /INVALID_RESULT_ACCOUNTING/);
const failedValidated = copy(failed); failedValidated.cases[0].result.accounting.validatedCalls = 1;
assert.throws(() => composeResultComment(request, failedValidated), /INVALID_RESULT_ACCOUNTING/);
const noSendRequest = await admitIssueComment({ ...event, comment: { ...event.comment,
  body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: incomplete.cases }) } }, config);
assert.ok(composeResultComment(noSendRequest, incompleteResult).includes('INCOMPLETE'));
const falseCallback = copy(incompleteResult); falseCallback.cases[0].result.accounting.callbackAttempts = 1;
assert.throws(() => composeResultComment(noSendRequest, falseCallback), /INVALID_RESULT_ACCOUNTING/);
assert.ok(composeResultComment(request, mismatch).includes('EVIDENCE_INVALID'));
assert.ok(composeResultComment(request, deadline).includes('EXECUTION_ERROR'));

// Receiver: exactly closed v2 or closed v3; current producer emits v3 only.
assert.ok(body.includes('"elapsedMs":'));
const asV2 = copy(result); asV2.schema = 'ops.semlint.real-result.v2'; delete asV2.cases[0].elapsedMs;
assert.ok(composeResultComment(request, asV2).includes('ops.semlint.real-result.v2'));
const largestClock = copy(result); largestClock.cases[0].elapsedMs = Number.MAX_VALUE;
assert.ok(Buffer.byteLength(composeResultComment(request, largestClock)) < 32768);
for (const alter of [
  (p) => { delete p.cases[0].elapsedMs; }, (p) => { p.cases[0].elapsedMs = -1; }, (p) => { p.cases[0].elapsedMs = '5'; },
  (p) => { p.cases[0].elapsedMs = null; }, (p) => { p.cases[0].clock = 1; }, (p) => { p.schema = 'ops.semlint.real-result.v4'; },
  (p) => { p.schema = 'ops.semlint.real-result.v2'; }, // v2 shape must not carry the v3 clock
]) { const poison = copy(result); alter(poison); assert.throws(() => composeResultComment(request, poison), /RESULT_IDENTITY_MISMATCH/); }
const v2Extra = copy(asV2); v2Extra.cases[0].clock = 1;
assert.throws(() => composeResultComment(request, v2Extra), /RESULT_IDENTITY_MISMATCH/);
const nonFinite = copy(result); nonFinite.cases[0].elapsedMs = NaN;
assert.throws(() => composeResultComment(request, nonFinite), /INVALID_ENTRY_INPUT/);

// Comment composer binds the exact prepared result edition/projection: semlint result.v1 and v14 only.
// Any other edition, and any v14 case carrying an English auxiliary, is refused at admission, before any paid call.
const unitRow = (row, content) => ({ ...row, content, sha256: hash(content), evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content) } });
const v5Input = { schema: 'ops.semlint.input.v5',
  subject: unitRow({ kind: 'log-entry', ref: 'fixture:v5', revision: 'r1', scope: 'fixture only' }, 'public subject, not an instruction'),
  context: [unitRow({ role: 'authorityContract', ref: 'fixture:grant', revision: 'r1' }, 'public grant text')],
  checks: [{ id: 'fixture.v5', axis: 'Aligned', concern: 'Fixture concern.', requiredRoles: ['authorityContract'], crossLinks: [],
    predicate: { question: 'Does the subject exceed the grant?', true: 'It exceeds the grant.', false: 'It stays within the grant.' } }] };
const ja = '受信記録が必要である。';
const v14Input = { ...copy(v5Input), schema: 'ops.semlint.input.v14',
  subject: { ...v5Input.subject, englishAuxiliary: null }, context: v5Input.context.map((row) => ({ ...row, englishAuxiliary: null })) };
const v14Aux = { ...copy(v14Input), subject: { ...unitRow(v14Input.subject, ja), englishAuxiliary: { text: 'A receipt record is required.', sourceSha256: hash(ja) } } };
const v14ContextAux = copy(v14Input);
v14ContextAux.context[0] = { ...unitRow(v14ContextAux.context[0], ja), englishAuxiliary: { text: 'A receipt record is required.', sourceSha256: hash(ja) } };
const editionRequest = (id, input) => admitIssueComment({ ...event, comment: { ...event.comment, id,
  body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'one', input }] }) } }, config);
let editionFetch = 0;
const v5Admission = await editionRequest(21, v5Input);
// Pure-function admission refusal; the executor-level zero-effect proof is in tests/issue-executor.mjs.
assert.deepEqual([v5Admission.status, v5Admission.cause], ['NOT_ADMITTED', 'RESULT_EDITION_NOT_COMPOSABLE']);
for (const [id, input] of [[23, v14Aux], [24, v14ContextAux]]) {
  const refused = await editionRequest(id, input);
  assert.deepEqual([refused.status, refused.cause], ['NOT_ADMITTED', 'AUDITED_AUXILIARY_REQUIRES_OWNER_ROUTE']); }
const mixed = await admitIssueComment({ ...event, comment: { ...event.comment, id: 25, body: REQUEST_PREFIX
  + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'one', input: copy(input) }, { id: 'two', input: v14Aux }] }) } }, config);
assert.deepEqual([mixed.status, mixed.cause], ['NOT_ADMITTED', 'AUDITED_AUXILIARY_REQUIRES_OWNER_ROUTE']);
for (const [id, schema] of [[26, 'ops.semlint.input.v13'], [27, 'ops.semlint.input.v12'], [28, 'ops.semlint.input.v11'], [29, 'ops.semlint.input.v10'], [30, 'ops.semlint.input.v9']]) {
  const retired = await editionRequest(id, { ...copy(v14Input), schema });
  assert.deepEqual([retired.status, retired.cause], ['NOT_ADMITTED', 'INVALID_REQUEST_OR_ADMISSION']); }
const v14Request = await editionRequest(22, v14Input);
assert.equal(v14Request.status, 'ADMITTED'); assert.equal(v14Request.prepared.expected[0].resultSchema, 'ops.semlint.result.v14');
const v14Output = await executeOwnerPlan(v14Request.prepared, 'synthetic-only-not-a-key', async (_, init) => { editionFetch++;
  const q = JSON.parse(init.body).questions;
  return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul', noul: 0.3 }])),
    usage: { input_tokens: 8, output_tokens: 1 } }), { status: 200 }); });
assert.equal(editionFetch, 1);
assert.ok(composeResultComment(v14Request, v14Output).includes('ops.semlint.result.v14'));
for (const alter of [(o) => { o.cases[0].result.projection.stateDigest = '0'.repeat(64); }, (o) => { delete o.cases[0].result.projection; },
  (o) => { o.cases[0].result.schema = 'ops.semlint.result.v5'; }, (o) => { o.cases[0].result.schema = 'ops.semlint.result.v1'; delete o.cases[0].result.projection; },
  (o) => { o.cases[0].result.schema = 'ops.semlint.result.v13'; }, (o) => { o.cases[0].result.extra = 1; }]) {
  const poison = copy(v14Output); alter(poison); assert.throws(() => composeResultComment(v14Request, poison), /RESULT_IDENTITY_MISMATCH/); }
const v1Spoof = copy(result); v1Spoof.cases[0].result.schema = 'ops.semlint.result.v14';
assert.throws(() => composeResultComment(request, v1Spoof), /RESULT_IDENTITY_MISMATCH/);

// Two actual fixture callbacks: valid first case, malformed later evidence. No lost case or retry.
const two = copy(plan); two.cases.push({ id: 'later', input: copy(input) });
two.cases[1].input.subject.revision = 'r-later';
let twoCalls = 0;
const twoResult = await runPlan(await preparePlan(two), async (state, questions) => {
  twoCalls++;
  assert.equal(state.subject.revision, twoCalls === 1 ? 'r1' : 'r-later');
  return twoCalls === 1 ? { model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.25 }])) }
    : { model: JEV_MODEL, answers: { q0: { type: 'noul', noul: 0.9 } } };
});
assert.equal(twoCalls, 2); assert.equal(twoResult.accounting.callbackAttempts, 2);
assert.equal(twoResult.accounting.validatedCalls, 1);
assert.deepEqual(twoResult.cases.map((x) => x.id), ['normal', 'later']);
assert.ok(twoResult.cases[0].result.records.every((x) => x.status === 'OBSERVED' && x.noul === 0.25));
assert.ok(twoResult.cases[1].result.records.every((x) => x.status === 'EVIDENCE_INVALID' && x.noul === null));
const twoRequest = await admitIssueComment({ ...event, comment: { ...event.comment,
  body: REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: two.cases }) } }, config);
assert.ok(composeResultComment(twoRequest, twoResult).includes('EVIDENCE_INVALID'));
assert.throws(() => composeResultComment(request, twoResult), /RESULT_IDENTITY_MISMATCH/);

// Real executable stdin/error contract: inherited environment is not passed, no key/network fixture.
const entry = fileURLToPath(new URL('../semlint-entry.mjs', import.meta.url));
const child = spawnSync(process.execPath, [entry], { input: JSON.stringify(unselected), encoding: 'utf8', env: { LANG: 'C.UTF-8' }, timeout: 10000 });
assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.equal(JSON.parse(child.stdout).accounting.callbackAttempts, 0);
const badChild = spawnSync(process.execPath, [entry], { input: 'not json private-fixture', encoding: 'utf8', env: { LANG: 'C.UTF-8' }, timeout: 10000 });
assert.equal(badChild.status, 1); assert.equal(badChild.stderr, '');
assert.equal(JSON.parse(badChild.stdout).cause, 'INVALID_ENTRY_JSON'); assert.equal(badChild.stdout.includes('private-fixture'), false);
const compatibility = fileURLToPath(new URL('./run.mjs', import.meta.url));
const runChild = (program, args, stdin) => spawnSync(process.execPath, [program, ...args], {
  input: stdin, encoding: 'utf8', env: { LANG: 'C.UTF-8' }, timeout: 10000,
});
const normalMachine = runChild(compatibility, [], '');
assert.equal(normalMachine.status, 0); assert.equal(normalMachine.stderr, '');
assert.deepEqual(JSON.parse(normalMachine.stdout), { status: 'PASS', core: 'semantic-evaluate', ranking: 'derived',
  cli: 'json-input-jsonl-output-readback', semanticThresholds: 0, semlintCases: 37, semlintCallbacks: 19,
  realProviderCalls: 0, semanticQuality: 'NOT_PROVEN', providedCases: 29, providedCallbacks: 9, bridgeControls: 9,
  projectedControls: 22, atomicControls: 26, structuredControls: 42, choiceControls: 67, v14Controls: 69, v15Controls: 11, v16Controls: 11 });
for (const program of [entry, compatibility]) {
  const argv = program === entry ? [] : ['--semlint-real'];
  for (const [stdin, status, expectedSchema] of [
    [JSON.stringify(unselected), 0, 'ops.semlint.real-result.v3'],
    [JSON.stringify(plan), 0, 'ops.semlint.real-result.v3'], // key missing, no native attempt
    [JSON.stringify(bad), 1, 'ops.semlint.entry-error.v1'],
    ['private invalid json', 1, 'ops.semlint.entry-error.v1'],
  ]) {
    const observed = runChild(program, argv, stdin), value = JSON.parse(observed.stdout);
    assert.equal(observed.status, status); assert.equal(observed.stderr, ''); assert.equal(value.schema, expectedSchema);
    assert.equal(observed.stdout.includes('PASS'), false); assert.equal(observed.stdout.includes('private invalid'), false);
    if (status === 0) {
      assert.equal(value.accounting.providerHttpCalls, 0); assert.equal(value.accounting.unknownHttpCalls, 0);
      assert.equal(value.cases[0].provider.statusClass, 'NOT_RUN');
      if (stdin === JSON.stringify(plan)) assert.ok(value.cases[0].result.records.every((r) => r.status === 'EXECUTION_ERROR'));
    }
  }
}
for (const argv of [['--unknown'], ['--semlint-real', 'extra'], ['--semlint-real=true']]) {
  const refused = runChild(compatibility, argv, JSON.stringify(plan));
  assert.equal(refused.status, 1); assert.equal(refused.stderr, '');
  assert.equal(JSON.parse(refused.stdout).cause, 'INVALID_ENTRY_ARGS'); assert.equal(refused.stdout.includes('PASS'), false);
}
assert.equal(runChild(entry, ['--semlint-real'], JSON.stringify(plan)).status, 1);

// Native fetch evidence is independent of callback counters, never paid/live fixture work.
let nativeFixtures = 0;
const canary = 'PRIVATE_NATIVE_CANARY';
const keyMissing = await executeOwnerPlan(prepared, undefined, async () => { throw new Error('must not fetch'); });
assert.equal(keyMissing.accounting.callbackAttempts, 1); assert.equal(keyMissing.accounting.providerHttpCalls, 0);
assert.ok(composeResultComment(request, keyMissing).includes('EXECUTION_ERROR'));
const noSendOwner = await executeOwnerPlan(await preparePlan(incomplete), undefined, async () => { throw new Error('must not fetch'); });
assert.equal(noSendOwner.accounting.providerHttpCalls, 0); assert.equal(noSendOwner.accounting.completedHttpCalls, 0);
assert.ok(composeResultComment(noSendRequest, noSendOwner).includes('INCOMPLETE'));
for (const [mode, completed, validated, unknown] of [
  ['throw', 0, 0, 1], ['http', 1, 0, 0], ['body', 1, 0, 0], ['json', 1, 0, 0],
  ['model', 1, 0, 0], ['answers', 1, 0, 0], ['valid', 1, 1, 0],
]) {
  let reads = 0, nativeBodyText;
  const native = await executeOwnerPlan(prepared, canary, async (url, init) => {
    nativeFixtures++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.ok(init.signal instanceof AbortSignal);
    if (mode === 'throw') throw new Error(canary);
    const response = mode === 'json' ? canary : JSON.stringify({ model: mode === 'model' ? canary : JEV_MODEL,
      answers: mode === 'answers' ? {} : Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((k) => [k, { type: 'noul', noul: 0.4 }])),
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, private: canary } });
    nativeBodyText = response;
    return { status: mode === 'http' ? 503 : 200, ok: mode !== 'http', arrayBuffer: async () => {
      reads++; if (mode === 'body') throw new Error(canary); return Buffer.from(response);
    }, json: () => { throw new Error('original json must not be consumed'); } };
  });
  const receipt = native.cases[0].provider;
  assert.equal(native.accounting.providerHttpCalls, 1); assert.equal(native.accounting.completedHttpCalls, completed);
  assert.equal(native.accounting.validatedResponses, validated); assert.equal(native.accounting.unknownHttpCalls, unknown);
  assert.equal(receipt.validatedModel, validated ? JEV_MODEL : null);
  assert.equal(reads, ['throw', 'http'].includes(mode) ? 0 : 1);
  assert.equal(receipt.responseDigest, ['throw', 'http', 'body'].includes(mode) ? null : hash(nativeBodyText));
  const comment = composeResultComment(request, native);
  assert.equal(comment.includes(canary), false); assert.equal(comment.includes('private'), false);
  assert.ok(Buffer.byteLength(comment) < 32768);
  if (validated) assert.deepEqual(receipt.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  for (const alter of [
    p => { p.cases[0].provider.extra = canary; }, p => { p.cases[0].provider.completedHttpCalls = 2; },
    p => { p.accounting.unknownHttpCalls = 99; }, p => { p.cases[0].provider.responseDigest = [hash('x')]; },
    p => { p.cases[0].provider.usage = { private: canary }; }, p => { p.cases[0].provider = null; },
  ]) { const poison = copy(native); alter(poison); assert.throws(() => composeResultComment(request, poison), /INVALID_PROVIDER_ACCOUNTING/); }
}
let laterNative = 0;
const twoNative = await executeOwnerPlan(await preparePlan(two), canary, async (_, init) => {
  laterNative++;
  return new Response(JSON.stringify({ model: JEV_MODEL,
    answers: laterNative === 1 ? Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((k) => [k, { type: 'noul', noul: 0.1 }])) : {} }), { status: 200 });
});
assert.equal(laterNative, 2); assert.equal(twoNative.accounting.providerHttpCalls, 2); assert.equal(twoNative.accounting.validatedResponses, 1);
assert.ok(composeResultComment(twoRequest, twoNative).includes('EVIDENCE_INVALID'));
const bodyTimeout = await executeOwnerPlan(await preparePlan(plan, { ...ENTRY_LIMITS, timeoutMs: 10 }), canary, async (_, init) => {
  nativeFixtures++;
  return {
  ok: true, status: 200, arrayBuffer: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(init.signal.aborted, true); return Buffer.from('{}');
  },
  };
});
assert.equal(bodyTimeout.accounting.providerHttpCalls, 1); assert.equal(bodyTimeout.accounting.completedHttpCalls, 1);
assert.equal(bodyTimeout.accounting.validatedResponses, 0); assert.equal(bodyTimeout.cases[0].provider.responseDigest, null);
const timeoutRequest = await admitIssueComment(event, { ...config, limits: { ...ENTRY_LIMITS, timeoutMs: 10 } });
assert.ok(composeResultComment(timeoutRequest, bodyTimeout).includes('EXECUTION_ERROR'));
assert.throws(() => composeResultComment(request, bodyTimeout), /RESULT_IDENTITY_MISMATCH/); // limits are bound
let lateInvalidNative = 0;
await assert.rejects(async () => executeOwnerPlan(await preparePlan(bad), canary, async () => { lateInvalidNative++; }), /INVALID_ENTRY_SEMLINT/);
assert.equal(lateInvalidNative, 0);
const source = fs.readFileSync(entry, 'utf8');
assert.equal(/from ['"].*(?:tests|fixtures|gold)/.test(source), false);
assert.equal(source.includes('process.env.JEV_API_URL'), false);
const existingFixtureHttp = fixtureHttp + nativeFixtures + laterNative;
assert.equal(existingFixtureHttp, 11);

// Caller caps: trusted smaller limits reach and constrain the fixed owner entry.
const small = { maxCases: 2, maxCalls: 1, maxInputBytes: 65536, timeoutMs: 5000, deadlineMs: 20000 };
const pureSmall = await preparePlan(plan, small);
assert.deepEqual(copy(pureSmall.plan.limits), small); assert.notEqual(pureSmall.planDigest, prepared.planDigest);
assert.equal((await preparePlan(pureSmall.plan)).planDigest, pureSmall.planDigest); // embedded form is canonical
assert.equal((await preparePlan({ ...plan, limits: { ...ENTRY_LIMITS } })).planDigest, prepared.planDigest);
const reordered = Object.fromEntries(Object.entries(small).reverse());
assert.equal((await preparePlan({ ...plan, limits: reordered })).planDigest, pureSmall.planDigest);
await assert.rejects(preparePlan(pureSmall.plan, { ...small, maxCalls: 1, timeoutMs: 4999 }), /INVALID_ENTRY_LIMITS/);
for (const limits of [{ ...small, maxCalls: 25 }, { ...small, extra: 1 }, { maxCases: 1 }, { ...small, timeoutMs: 0 }, { ...small, deadlineMs: '1' }, null]) {
  await assert.rejects(preparePlan({ ...plan, limits }), /INVALID_ENTRY_(?:LIMITS|INPUT)/);
}
const smallRequest = await admitIssueComment(event, { ...config, limits: small });
assert.equal(smallRequest.status, 'ADMITTED');
assert.deepEqual(copy(smallRequest.prepared.plan.limits), small); assert.deepEqual(copy(smallRequest.prepared.limits), small);
assert.equal(smallRequest.prepared.planDigest, pureSmall.planDigest);
assert.notEqual(smallRequest.identity.planDigest, request.identity.planDigest);
// Issue content still cannot carry or expand limits.
assert.equal((await admitIssueComment({ ...event, comment: { ...event.comment, body: REQUEST_PREFIX
  + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: plan.cases, limits: ENTRY_LIMITS }) } }, { ...config, limits: small })).status, 'NOT_ADMITTED');
const smallTwo = await admitIssueComment({ ...event, comment: { ...event.comment, body: REQUEST_PREFIX
  + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: two.cases }) } }, { ...config, limits: small });
assert.equal(smallTwo.status, 'NOT_ADMITTED'); // two sendable cases exceed maxCalls 1 before any callback

// Formal owner path: unchanged programs/argv/stdin, globalThis.fetch replaced by a counting fixture.
// The fixture counts on stderr, separately from the entry's own stdout accounting.
const ownerDeadlineMs = 300;
const fakeFetch = `globalThis.fetch = async (url, init) => {
  process.stderr.write('FIXTURE_FETCH\\n');
  const body = JSON.parse(init.body);
  if (body.state.subject.ref === 'fixture:deadline-hang') {
    // Keep abort dispatch synchronous until the whole plan deadline has elapsed.
    // Plan start precedes fetch start, so this derived barrier needs no timing margin.
    const fetchStart = performance.now();
    const pending = setInterval(() => {}, 1000);
    await new Promise((resolve) => {
      const crossDeadline = () => {
        while (performance.now() - fetchStart <= ${ownerDeadlineMs}) {}
        resolve();
      };
      if (init.signal.aborted) crossDeadline();
      else init.signal.addEventListener('abort', crossDeadline, { once: true });
    });
    clearInterval(pending);
    throw new Error('fixture whole deadline elapsed');
  }
  if (body.state.subject.ref === 'fixture:hang') {
    // Like a pending socket, keep the loop alive; AbortSignal.timeout alone does not.
    const pending = setInterval(() => {}, 1000);
    await new Promise((resolve) => init.signal.addEventListener('abort', resolve, { once: true }));
    clearInterval(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error('fixture aborted');
  }
  return new Response(JSON.stringify({ model: ${JSON.stringify(JEV_MODEL)},
    answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: 0.3 }])) }), { status: 200 });
};`;
const importFlag = '--import=data:text/javascript,' + encodeURIComponent(fakeFetch);
const syntheticKey = 'synthetic-fixture-key-not-a-secret';
let childFixtureHttp = 0;
const ownerChild = (program, stdin) => {
  const argv = program === entry ? [] : ['--semlint-real'];
  const run = spawnSync(process.execPath, [importFlag, program, ...argv], { input: stdin, encoding: 'utf8',
    env: { LANG: 'C.UTF-8', JEV_API_KEY: syntheticKey }, timeout: 20000 });
  const fetches = run.stderr.split('\n').filter((x) => x === 'FIXTURE_FETCH').length;
  assert.equal(run.stderr.replaceAll('FIXTURE_FETCH\n', ''), '');
  assert.equal(run.stdout.includes(syntheticKey), false);
  childFixtureHttp += fetches;
  return { status: run.status, value: JSON.parse(run.stdout), fetches };
};
const hang = copy(input); hang.subject.ref = 'fixture:hang';
const deadlineHang = copy(hang); deadlineHang.subject.ref = 'fixture:deadline-hang';
const deadlinePlan = { schema: 'ops.semlint.real-input.v1', limits: { ...small, maxCalls: 2, timeoutMs: 15000, deadlineMs: ownerDeadlineMs },
  cases: [{ id: 'first', input: deadlineHang }, { id: 'second', input: copy(input) }] };
for (const program of [entry, compatibility]) {
  // Positive control: same mechanism, admitted small plan, fixture actually reached once.
  const normal = ownerChild(program, JSON.stringify(smallRequest.prepared.plan));
  assert.equal(normal.status, 0); assert.equal(normal.fetches, 1);
  assert.equal(normal.value.planDigest, smallRequest.prepared.planDigest);
  assert.deepEqual(normal.value.accounting, { callbackAttempts: 1, validatedCalls: 1, providerHttpCalls: 1,
    completedHttpCalls: 1, validatedResponses: 1, unknownHttpCalls: 0, cost: null });
  // Representative Issue -> formal invocation -> fixture result -> composition at the same limits.
  const composed = composeResultComment(smallRequest, normal.value);
  assert.ok(composed.includes('VALIDATED_RESPONSE')); assert.equal(composed.includes(syntheticKey), false);
  assert.equal(verifyResultReadback(smallRequest, composed, { repository: config.repository, issue: config.issue, id: 21,
    author: 'fixture-poster', body: composed }, 'fixture-poster', 21), true);
  // Binding: a structural-limit or one-value-different run cannot be composed into the small request.
  const structuralRun = ownerChild(program, JSON.stringify(plan));
  assert.equal(structuralRun.status, 0); assert.equal(structuralRun.fetches, 1);
  assert.throws(() => composeResultComment(smallRequest, structuralRun.value), /RESULT_IDENTITY_MISMATCH/);
  const otherTimeout = ownerChild(program, JSON.stringify({ ...plan, limits: { ...small, timeoutMs: 4000 } }));
  assert.equal(otherTimeout.status, 0);
  assert.throws(() => composeResultComment(smallRequest, otherTimeout.value), /RESULT_IDENTITY_MISMATCH/);
  assert.throws(() => composeResultComment(request, normal.value), /RESULT_IDENTITY_MISMATCH/);
  // Over-budget/invalid whole plans refuse before any fixture fetch, with the synthetic key present.
  for (const [stdin, cause] of [
    [{ ...two, limits: { ...small, maxCases: 1 } }, 'INVALID_ENTRY_PLAN'],
    [{ ...two, limits: small }, 'ENTRY_CALL_BUDGET_EXCEEDED'],
    [{ ...plan, limits: { ...small, maxInputBytes: 1000 } }, 'ENTRY_INPUT_TOO_LARGE'],
    [{ ...plan, limits: { ...small, maxCalls: 25 } }, 'INVALID_ENTRY_LIMITS'],
    [{ ...plan, limits: { ...small, extra: 1 } }, 'INVALID_ENTRY_LIMITS'],
    [{ ...plan, limits: { maxCalls: 1 } }, 'INVALID_ENTRY_LIMITS'],
    [{ ...bad, limits: { ...small, maxCalls: 2 } }, 'INVALID_ENTRY_SEMLINT'],
  ]) {
    const refused = ownerChild(program, JSON.stringify(stdin));
    assert.equal(refused.status, 1); assert.equal(refused.fetches, 0);
    assert.equal(refused.value.schema, 'ops.semlint.entry-error.v1'); assert.equal(refused.value.cause, cause);
  }
  // Smaller per-call timeout is actually applied: aborted request stays REQUEST_ERROR/unknown.
  const timed = ownerChild(program, JSON.stringify({ schema: plan.schema, limits: { ...small, timeoutMs: 50 }, cases: [{ id: 'hang', input: hang }] }));
  assert.equal(timed.status, 0); assert.equal(timed.fetches, 1);
  assert.deepEqual(timed.value.accounting, { callbackAttempts: 1, validatedCalls: 0, providerHttpCalls: 1,
    completedHttpCalls: 0, validatedResponses: 0, unknownHttpCalls: 1, cost: null });
  assert.equal(timed.value.cases[0].provider.statusClass, 'REQUEST_ERROR');
  assert.ok(timed.value.cases[0].result.records.every((x) => x.status === 'EXECUTION_ERROR' && x.noul === null));
  // Smaller whole-plan deadline: the later case is refused before its fetch.
  const late = ownerChild(program, JSON.stringify(deadlinePlan));
  assert.equal(late.status, 0); assert.equal(late.fetches, 1);
  assert.equal(late.value.accounting.providerHttpCalls, 1); assert.equal(late.value.accounting.unknownHttpCalls, 1);
  assert.equal(late.value.cases[1].provider.attemptedHttpCalls, 0); assert.equal(late.value.cases[1].provider.statusClass, 'NOT_RUN');
  assert.ok(late.value.cases[1].result.records.every((x) => x.status === 'EXECUTION_ERROR'));
}
// The shipped grant admits one Issue origin and public subject in two separate first-attempt runs; no provider is called.
{
  const shipped = validateActionsConfig(historicalActionsConfig(JSON.parse(fs.readFileSync(new URL('../issue-actions.json', import.meta.url), 'utf8'))));
  const repository = 'roccho-org/ops';
  assert.deepEqual(shipped.providedRequestTargets.map((grant) => ({ ...grant })), [{ repository, repositoryId: '1275606595', issue: 573 }]);
  const target = selectActionsTarget(shipped, repository, 573, 'issue');
  assert.deepEqual({ ...target.subject }, { repository: 'roccho-dev/apps', repositoryId: '1375320803', kind: 'issue', number: 94 });
  const run = { repository, workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml', number: 190, attempt: 1, id: 1 };
  const origin = { kind: 'issue', number: 573 };
  const selected = selectRunRange(shipped, run, origin);
  assert.equal(selected.callsPerRun, 1);
  assert.equal(selected.range.first, selected.range.last);
  assert.deepEqual(selectRunRange(shipped, { ...run, number: 189 }, origin), { cause: 'NO_RANGE' });
  const provided = selectRunRange(shipped, { ...run, number: 191 }, origin);
  assert.equal(provided.callsPerRun, 1);
  assert.equal(provided.range.first, 191);
  assert.equal(provided.range.last, 191);
  assert.deepEqual(selectRunRange(shipped, { ...run, number: 192 }, origin), { cause: 'NO_RANGE' });
  assert.deepEqual(selectRunRange(shipped, { ...run, number: 191, attempt: 2 }, origin), { cause: 'RERUN_NOT_PAID' });
  assert.deepEqual(selectRunRange(shipped, { ...run, number: 191 }, { kind: 'issue', number: 483 }), { cause: 'RANGE_TARGET_MISMATCH' });
  assert.deepEqual(selectRunRange(shipped, { ...run, attempt: 2 }, origin), { cause: 'RERUN_NOT_PAID' });
  assert.deepEqual(selectRunRange(shipped, run, { kind: 'pull-request', number: 573 }), { cause: 'RANGE_TARGET_MISMATCH' });
  assert.deepEqual(selectRunRange(shipped, run, { kind: 'issue', number: 483 }), { cause: 'RANGE_TARGET_MISMATCH' });
  assert.deepEqual(selectRunRange(shipped, run, { kind: 'pull-request', number: 536 }), { cause: 'RANGE_TARGET_MISMATCH' });
  const missingSubject = copy(shipped);
  delete missingSubject.targets.find((t) => t.repository === repository && t.issue === 573).subject;
  assert.throws(() => validateActionsConfig(missingSubject), /INVALID_ACTIONS_CONFIG/);
}
// Legacy PR-grant CJK refusal controls (synthetic subject; no PR body is read): the refusal keeps
// this admission snapshot's identity, exactly {issueNodeId, subjectRevision} and no body text. Every other refusal
// keeps its prior three-key shape, and legacy or English literals are unchanged. Dormant code only: no command runs.
{
  const shipped = historicalActionsConfig(JSON.parse(fs.readFileSync(new URL('../issue-actions.json', import.meta.url), 'utf8')));
  const OPS = 'roccho-org/ops', ENVS = 'roccho-org/envs', WFP = '.github/workflows/jev-issue-comment.yml';
  const legacyOrigin = shipped.targets.find((t) => t.repository === OPS && t.issue === 573);
  legacyOrigin.issue = 483;
  delete legacyOrigin.subject;
  shipped.runRanges = shipped.runRanges.filter((r) => r.target?.issue !== 573);
  shipped.providedRequestTargets = [{ repository: OPS, repositoryId: '1275606595', pullRequest: 536 }];
  const JA = '受信記録だけで完了を確認する。', EN = 'Confirm completion from the delivery receipt alone.';
  const subject = (over = {}) => ({ number: 536, nodeId: 'PR_fixture536', body: JA, lastEditedAt: null, includesCreatedEdit: false,
    userContentEditsTotal: 0, ...over });
  const commandOf = (body, over = {}) => ({ databaseId: 4242, nodeId: 'IC_4242', author: 'roccho-dev', body, lastEditedAt: null,
    includesCreatedEdit: false, userContentEditsTotal: 0, ...over });
  const contextOf = (first = 'public fixture contract') => shipped.context.map((c, i) => ({ role: c.role, path: c.path, content: i ? 'public fixture contract' : first }));
  const literal = (over = {}) => ({ repository: OPS, owner: 'roccho-org', sha: 'a'.repeat(40), eventBody: '/jev-evaluate',
    run: { id: 77, number: 104, attempt: 1, workflowId: 377399991, path: WFP }, issue: subject(), command: commandOf('/jev-evaluate'),
    context: contextOf(), targetKind: 'pull-request', ...over });
  const refusal = (issue) => ({ status: 'NOT_ADMITTED', cause: 'UNSUPPORTED_CJK', authority: false,
    observed: { issueNodeId: issue.nodeId, subjectRevision: subjectRevision(issue) } });
  const first = await admitIssueCommand(literal(), shipped);
  assert.deepEqual(first, refusal(subject()));
  assert.equal(first.observed.subjectRevision.split('|')[0], first.observed.issueNodeId);
  assert.equal(JSON.stringify(first).includes(JA), false);
  // Each edit signal, and an edit reverted to the same text, gives its own complete 5-part tuple over one body SHA.
  const variants = [subject(), subject({ lastEditedAt: '2026-10-15T01:00:00Z', userContentEditsTotal: 1 }), subject({ includesCreatedEdit: true }),
    subject({ lastEditedAt: '2026-10-15T02:00:00Z', userContentEditsTotal: 2 })];
  const revisions = [];
  for (const issue of variants) {
    const refused = await admitIssueCommand(literal({ issue }), shipped);
    assert.deepEqual(refused, refusal(issue)); revisions.push(refused.observed.subjectRevision);
  }
  assert.equal(new Set(revisions).size, variants.length); assert.equal(new Set(revisions.map((r) => r.split('|')[1])).size, 1);
  // Whole-input CJK: CJK only in a context file still refuses, and the observation names the English subject.
  const english = subject({ body: EN });
  assert.deepEqual(await admitIssueCommand(literal({ issue: english, context: contextOf('日本語の契約') }), shipped), refusal(english));
  const admitted = await admitIssueCommand(literal({ issue: english }), shipped);
  assert.equal(admitted.status, 'ADMITTED'); assert.equal(Object.hasOwn(admitted, 'observed'), false);
  // Every other refusal keeps exactly {status, cause, authority}.
  const provided = REQUEST_PREFIX + '{}';
  for (const [input, cause] of [
    [literal({ command: commandOf('/jev-evaluate', { lastEditedAt: '2026-10-15T01:00:00Z', userContentEditsTotal: 1 }) }), 'EDITED'],
    [literal({ command: commandOf('/jev-evaluate ') }), 'COMMAND_DRIFT'],
    [literal({ issue: subject({ number: 999 }) }), 'TARGET_NOT_AUTHORIZED'],
    [literal({ run: { id: 77, number: 50, attempt: 1, workflowId: 377399991, path: WFP } }), 'RANGE_TARGET_MISMATCH'],
    [literal({ run: { id: 77, number: 200, attempt: 1, workflowId: 377399991, path: WFP } }), 'NO_RANGE'],
    [literal({ issue: subject({ number: 511 }), eventBody: provided, command: commandOf(provided),
      run: { id: 77, number: 50, attempt: 1, workflowId: 377399991, path: WFP } }), 'PROVIDED_REQUEST_NOT_AUTHORIZED'],
    [literal({ eventBody: provided, command: commandOf(provided) }), null],
  ]) {
    const refused = await admitIssueCommand(input, shipped);
    assert.deepEqual(Object.keys(refused).sort(), ['authority', 'cause', 'status']);
    assert.equal(refused.status, 'NOT_ADMITTED'); if (cause) assert.equal(refused.cause, cause);
  }
  // Legacy literal targets with CJK keep their behavior (admitted, no observation).
  const legacy = (repository, number, workflowId, kind) => {
    const input = literal({ repository, issue: subject({ number }), run: { id: 77, number: 50, attempt: 1, workflowId, path: WFP } });
    if (kind === 'issue') delete input.targetKind;
    return input;
  };
  for (const input of [legacy(OPS, 483, 377399991, 'issue'), legacy(OPS, 511, 377399991, 'pull-request'), legacy(ENVS, 52, 377400122, 'issue')]) {
    const legacyResult = await admitIssueCommand(input, shipped);
    assert.equal(legacyResult.status, 'ADMITTED', legacyResult.cause); assert.equal(Object.hasOwn(legacyResult, 'observed'), false);
  }
  // Origin-subject split on the shipped settings plus a fixture grant (the shipped file has no subject and no real Apps
  // Issue is read). The origin ops#483 keeps the top-level triple; the CJK subject is evaluated unrendered and named in
  // identity.subject. Without a grant the identity has no subject key and the triple is the evaluated revision.
  const granted = JSON.parse(JSON.stringify(shipped));
  granted.targets.find((t) => t.repository === OPS && t.issue === 483).subject = { repository: 'fixture-user/apps', repositoryId: '321', kind: 'issue', number: 94 };
  granted.runRanges.push({ repository: OPS, workflowId: 377399991, path: WFP, first: 900, last: 900, reservedCallsPerRun: 1, target: { issue: 483 } });
  const originIssue = subject({ number: 483, nodeId: 'I_fixture483', body: EN });
  const apps = { repository: 'fixture-user/apps', repositoryId: '321', isPrivate: false, ...subject({ number: 94, nodeId: 'I_fixture94' }) };
  const split = await admitIssueCommand({ ...legacy(OPS, 483, 377399991, 'issue'), issue: originIssue, subject: apps,
    run: { id: 77, number: 900, attempt: 1, workflowId: 377399991, path: WFP } }, granted);
  assert.equal(split.status, 'ADMITTED', split.cause);
  const evaluated = split.prepared.plan.cases[0].input.subject;
  assert.deepEqual([split.identity.issue, split.identity.issueNodeId, split.identity.subjectRevision], [483, 'I_fixture483', subjectRevision(originIssue)]);
  assert.deepEqual(split.identity.subject, { repository: 'fixture-user/apps', repositoryId: '321', kind: 'issue', number: 94,
    nodeId: 'I_fixture94', revision: subjectRevision(apps) });
  assert.notEqual(split.identity.subjectRevision, split.identity.subject.revision);
  assert.deepEqual([evaluated.ref, evaluated.revision, evaluated.content], ['https://github.com/fixture-user/apps/issues/94', split.identity.subject.revision, JA]);
  const plain = await admitIssueCommand(legacy(OPS, 483, 377399991, 'issue'), shipped);
  assert.equal(Object.hasOwn(plain.identity, 'subject'), false);
  assert.equal(plain.identity.subjectRevision, plain.prepared.plan.cases[0].input.subject.revision);

  // Legacy admission bytes, recorded on unmodified M f7095de4 before the first edit with these exact fixtures: the 2-key
  // PR refusal, PR literal and PR536 provided (plain and rendered), the no-grant Issue literal, the subject-grant literal
  // without an Issue provided grant (passthrough with identity.subject), its provided refusal, and a retired PR grant.
  const h = (x) => hash(JSON.stringify(x));
  const originRun = { id: 77, number: 900, attempt: 1, workflowId: 377399991, path: WFP };
  const issueLiteral = (over = {}) => { const value = literal({ issue: originIssue, run: originRun, ...over }); delete value.targetKind; return value; };
  const appsOf = (over = {}) => ({ repository: 'fixture-user/apps', repositoryId: '321', isPrivate: false, ...subject({ number: 94, nodeId: 'I_fixture94', ...over }) });
  const unit = (fields, content) => ({ ...fields, content, sha256: hash(content), evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content) }, englishAuxiliary: null });
  const check = { id: 'fixture.goal', axis: 'Aligned', concern: 'Goal-derived fixture question.', requiredRoles: [], crossLinks: [],
    predicate: { question: 'Does the subject miss the declared goal?', true: 'It misses the goal.', false: 'It meets the goal.' } };
  const envelope = (ref, revision, scope, body, aux = null) => REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'fixture',
    input: { schema: 'ops.semlint.input.v14', subject: { ...unit({ kind: 'log-entry', ref, revision, scope }, body), englishAuxiliary: aux },
      context: [unit({ role: 'goal', ref: 'fixture:goal', revision: 'r1' }, 'Confirm completion from the delivery receipt.')], checks: [check] } }] });
  const PR_SCOPE = 'entire body of the approved pull request at the observed revision';
  const prProvided = (issue, aux) => { const body = envelope(`https://github.com/${OPS}/pull/536`, subjectRevision(issue), PR_SCOPE, issue.body, aux);
    return literal({ issue, eventBody: body, command: commandOf(body) }); };
  const view = (r) => ({ status: r.status, cause: r.cause ?? null, identity: r.identity ?? null, requestDigest: r.requestDigest ?? null, plan: r.prepared?.plan ?? null });
  const subjectBody = envelope('https://github.com/fixture-user/apps/issues/94', subjectRevision(appsOf({ body: EN })), shipped.subjectScope, EN);
  const retired = copy(shipped); retired.providedRequestTargets = [{ repository: OPS, repositoryId: '1275606595', pullRequest: 511 }];
  assert.deepEqual({
    prRefusal: h(await admitIssueCommand(literal(), shipped)),
    prLiteral: h(view(await admitIssueCommand(literal({ issue: english }), shipped))),
    pr536Provided: h(view(await admitIssueCommand(prProvided(english), shipped))),
    pr536Rendered: h(view(await admitIssueCommand(prProvided(subject(), { text: EN, sourceSha256: hash(JA) }), shipped))),
    noGrantIssueLiteral: h(view(await admitIssueCommand(issueLiteral({ run: { ...originRun, number: 50 } }), shipped))),
    subjectPassthrough: h(view(await admitIssueCommand(issueLiteral({ subject: appsOf() }), granted))),
    subjectPassthroughEnglish: h(view(await admitIssueCommand(issueLiteral({ subject: appsOf({ body: EN }) }), granted))),
    providedWithSubject: h(view(await admitIssueCommand(issueLiteral({ subject: appsOf({ body: EN }), eventBody: subjectBody, command: commandOf(subjectBody) }), granted))),
    retired511: h(view(await admitIssueCommand(literal({ issue: english }), retired))) }, {
    prRefusal: 'a0e7533232963bb332d17d7e86ede6ba3d8bf47ebbb61e02835bd7143b98449e',
    prLiteral: '89b129f0fd85d269677c23a4ac4af3aa10c8c08fffe32d8bc92dd519035099a1',
    pr536Provided: '67b2e455701738ade31bf29159e1b6c534d884a7411dccaaccae50ecba81db80',
    pr536Rendered: '086865d91ce76e719016deb5c9cae6c6cf0b5a4b089a6e9ed8219accf8814112',
    noGrantIssueLiteral: '99b3c1fa7872b4124c2221fc1c5f70aafdaaedea6c762fd5ff1cb37335a71b53',
    subjectPassthrough: '8820daedd7af7ce68702225340790edc3eab8bbbb026ced513af833859f57729',
    subjectPassthroughEnglish: 'f40f467cd65747628e16b76fb3e002ac16ed4dd709570c3fa8d2bdd165cb95aa',
    providedWithSubject: '3aca0ae28dc27f955c637dd60b7ebbe707766946a7111ff6aa5a9f8bfc933d0c',
    retired511: '17f3ae69deefae4ae139f035e519e713bbc08ec9e8efc1e9629dee3a1911115d' });

  // Issue provided grant (fixture only, the shipped file is unchanged): the origin ops#483 with its subject grant and its
  // own scoped range. It is the one provided grant in total, so it replaces the PR536 grant in this fixture.
  const issueGrant = { repository: OPS, repositoryId: '1275606595', issue: 483 };
  const issueGranted = copy(granted); issueGranted.providedRequestTargets = [{ ...issueGrant }];
  const valid = (settings) => { let checked; assert.doesNotThrow(() => { checked = validateActionsConfig(settings); }); return checked; };
  assert.deepEqual(valid(issueGranted).providedRequestTargets.map((g) => ({ ...g })), [issueGrant]);
  // RETIRED_PROVIDED names PR numbers only: an Issue grant whose Issue number is 511 is valid.
  const issue511 = copy(issueGranted);
  issue511.targets.find((t) => t.repository === OPS && t.issue === 483).issue = 511;
  issue511.runRanges.at(-1).target = { issue: 511 }; issue511.providedRequestTargets = [{ ...issueGrant, issue: 511 }];
  assert.equal(valid(issue511).providedRequestTargets[0].issue, 511);
  for (const alter of [
    (c) => { c.providedRequestTargets.push({ repository: OPS, repositoryId: '1275606595', pullRequest: 536 }); }, // two grants in total
    (c) => { c.providedRequestTargets = [{ repository: ENVS, repositoryId: '1391871347', issue: 52 }]; }, // a target without a subject
    (c) => { delete c.targets.find((t) => t.issue === 483).subject; }, // the origin without its subject grant
    (c) => { c.providedRequestTargets[0].issue = 484; }, (c) => { c.providedRequestTargets[0].issue = '483'; },
    (c) => { c.providedRequestTargets[0].repositoryId = '1391871347'; }, (c) => { c.providedRequestTargets[0].subject = { number: 94 }; },
    (c) => { c.providedRequestTargets[0].pullRequest = 536; },
  ]) {
    const bad = copy(issueGranted); alter(bad);
    assert.throws(() => validateActionsConfig(bad), /INVALID_ACTIONS_CONFIG/);
  }

  // Issue-route provided admission: the evaluated subject is the granted Issue (its own ref, revision, whole body) at the
  // configured scope. The origin keeps the top-level triple; its body, revision and digest never stand in for the subject.
  // The subject text differs from the origin's (EN) so that substituting one for the other is observable.
  const SUBJECT_EN = 'Confirm each delivery from its stored destination receipt, not from the send call.';
  const englishApps = appsOf({ body: SUBJECT_EN }), jaApps = appsOf();
  const issueProvided = (body, apps = englishApps) => issueLiteral({ subject: apps, eventBody: body, command: commandOf(body) });
  const subjectRef = 'https://github.com/fixture-user/apps/issues/94';
  const issueBody = envelope(subjectRef, subjectRevision(englishApps), shipped.subjectScope, SUBJECT_EN);
  const accepted = await admitIssueCommand(issueProvided(issueBody), issueGranted);
  assert.equal(accepted.status, 'ADMITTED', accepted.cause);
  assert.deepEqual([accepted.identity.observation, accepted.identity.issue, accepted.identity.issueNodeId, accepted.identity.subjectRevision],
    ['ACTIONS_TRUSTED_PROVIDED_REQUEST', 483, 'I_fixture483', subjectRevision(originIssue)]);
  assert.deepEqual(accepted.identity.subject, { repository: 'fixture-user/apps', repositoryId: '321', kind: 'issue', number: 94, nodeId: 'I_fixture94',
    revision: subjectRevision(englishApps) });
  assert.equal(Object.hasOwn(accepted.identity, 'targetKind'), false);
  assert.deepEqual([accepted.prepared.plan.cases[0].input.subject.ref, accepted.prepared.plan.cases[0].input.subject.content], [subjectRef, SUBJECT_EN]);
  // A rendered JA subject, bound to the subject body, is admitted the same way.
  const renderedBody = envelope(subjectRef, subjectRevision(jaApps), shipped.subjectScope, JA, { text: EN, sourceSha256: hash(JA) });
  assert.equal((await admitIssueCommand(issueProvided(renderedBody, jaApps), issueGranted)).status, 'ADMITTED');
  const originRevision = subjectRevision(originIssue), originBody = originIssue.body, revision = subjectRevision(englishApps), scope = shipped.subjectScope;
  for (const [label, body, apps, cause] of [
    ['PR ref', envelope(`https://github.com/${OPS}/pull/483`, revision, scope, SUBJECT_EN), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['origin ref', envelope(`https://github.com/${OPS}/issues/483`, revision, scope, SUBJECT_EN), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['origin revision', envelope(subjectRef, originRevision, scope, SUBJECT_EN), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['PR scope', envelope(subjectRef, revision, PR_SCOPE, SUBJECT_EN), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['origin body', envelope(subjectRef, revision, scope, originBody), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['other body', envelope(subjectRef, revision, scope, SUBJECT_EN + ' Edited.'), englishApps, 'INVALID_PROVIDED_REQUEST'],
    ['later edit', issueBody, appsOf({ body: SUBJECT_EN, userContentEditsTotal: 1, lastEditedAt: '2026-10-16T01:00:00Z' }), 'INVALID_PROVIDED_REQUEST'],
    ['aux on origin body', envelope(subjectRef, subjectRevision(jaApps), scope, JA, { text: EN, sourceSha256: hash(originBody) }), jaApps, 'INVALID_PROVIDED_REQUEST'],
    ['JA without a rendering (Core refuses)', envelope(subjectRef, subjectRevision(jaApps), scope, JA), jaApps, 'INVALID_REQUEST_OR_ADMISSION'],
  ]) {
    const refused = await admitIssueCommand(issueProvided(body, apps), issueGranted);
    assert.deepEqual([refused.status, refused.cause], ['NOT_ADMITTED', cause], label);
  }
  // Span, digest and a context auxiliary are checked as on the PR route.
  for (const change of [(v) => { v.subject.evaluationSpan.endByte--; }, (v) => { v.subject.sha256 = '0'.repeat(64); },
    (v) => { v.context[0].englishAuxiliary = { text: 'x', sourceSha256: v.context[0].sha256 }; }]) {
    const payload = JSON.parse(issueBody.slice(REQUEST_PREFIX.length)); change(payload.cases[0].input);
    const body = REQUEST_PREFIX + JSON.stringify(payload);
    assert.equal((await admitIssueCommand(issueProvided(body), issueGranted)).cause, 'INVALID_PROVIDED_REQUEST');
  }
  // Without the Issue grant the legacy refusal stays, and the PR536 route has no grant in this fixture.
  assert.equal((await admitIssueCommand(issueProvided(issueBody), granted)).cause, 'PROVIDED_WITH_SUBJECT_UNSUPPORTED');
  assert.equal((await admitIssueCommand(prProvided(english), issueGranted)).cause, 'PROVIDED_REQUEST_NOT_AUTHORIZED');
  assert.equal((await admitIssueCommand(prProvided(english), shipped)).status, 'ADMITTED');

  // Issue-route literal: English stays the admitted passthrough with identity.subject; CJK anywhere in the input is
  // refused before claim with the origin pair plus the evaluated subject's own pair, never a body.
  const englishLiteral = await admitIssueCommand(issueLiteral({ subject: englishApps }), issueGranted);
  assert.deepEqual([englishLiteral.status, englishLiteral.identity.observation, englishLiteral.identity.subject.revision],
    ['ADMITTED', 'ACTIONS_TRUSTED_LITERAL_COMMAND', subjectRevision(englishApps)]);
  const issueRefusal = (apps) => ({ status: 'NOT_ADMITTED', cause: 'UNSUPPORTED_CJK', authority: false,
    observed: { issueNodeId: 'I_fixture483', subjectRevision: originRevision, subject: { nodeId: apps.nodeId, revision: subjectRevision(apps) } } });
  const jaRefused = await admitIssueCommand(issueLiteral({ subject: jaApps }), issueGranted);
  assert.deepEqual(jaRefused, issueRefusal(jaApps));
  assert.notEqual(jaRefused.observed.subject.revision, jaRefused.observed.subjectRevision);
  assert.equal(JSON.stringify(jaRefused).includes(JA) || JSON.stringify(jaRefused).includes(EN), false);
  assert.deepEqual(await admitIssueCommand(issueLiteral({ subject: englishApps, context: contextOf('日本語の契約') }), issueGranted), issueRefusal(englishApps));
  // A subject grant alone keeps the exact legacy passthrough (no refusal, no observation), as the M bytes above show.
  const passthrough = await admitIssueCommand(issueLiteral({ subject: jaApps }), granted);
  assert.deepEqual([passthrough.status, Object.hasOwn(passthrough, 'observed')], ['ADMITTED', false]);

  // The Issue grant binds its origin repository, not only the Issue number (R's finding A1 on #559). A valid config with two
  // origins numbered 483, Ops and envs, each with its own subject grant and scoped range; only Ops holds the Issue grant.
  const twoOrigins = copy(issueGranted);
  Object.assign(twoOrigins.targets.find((t) => t.repository === ENVS), { issue: 483,
    subject: { repository: 'fixture-user/apps', repositoryId: '321', kind: 'issue', number: 94 } });
  twoOrigins.runRanges.push({ repository: ENVS, workflowId: 377400122, path: WFP, first: 900, last: 900, reservedCallsPerRun: 1, target: { issue: 483 } });
  assert.deepEqual(valid(twoOrigins).providedRequestTargets.map((g) => ({ ...g })), [issueGrant]);
  const envsInput = (over) => issueLiteral({ repository: ENVS, issue: subject({ number: 483, nodeId: 'I_fixtureEnvs483', body: EN }),
    run: { ...originRun, workflowId: 377400122 }, ...over });
  // Positive controls on the granted Ops origin, under the same two-origin config.
  const supplied = await admitIssueCommand(issueProvided(issueBody), twoOrigins);
  assert.equal(supplied.status, 'ADMITTED');
  const suppliedResult = await runPlan(supplied.prepared, async (_, questions) => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: 0.2 }])) }));
  const suppliedView = composeResultComment(supplied, suppliedResult);
  const oldReadable = suppliedView.replace("Jev supplies the model observations shown here; semlint formats and posts this report. The tool that prepared the checks is not recorded here. See the linked request for the questions and conditions.\n\n", '');
  const saved = { author: 'fixture-poster', body: oldReadable, databaseId: 11 };
  const oldPrior = deriveIssuePrior(supplied, { claims: ['fixture-poster'], results: [saved] }, 'fixture-poster');
  assert.equal(oldPrior.state, 'APPENDED'); assert.equal(nextIssueEffect(supplied, oldPrior).effect, 'READBACK_ONLY');
  assert.equal(verifyResultReadback(supplied, oldReadable, { repository: supplied.identity.repository, issue: supplied.identity.issue, id: 11, author: saved.author, body: oldReadable }, 'fixture-poster', 11), true);
  assert.deepEqual(await admitIssueCommand(issueLiteral({ subject: jaApps }), twoOrigins), issueRefusal(jaApps));
  // The ungranted envs origin: its provided request keeps the legacy refusal, and its CJK literal the legacy passthrough.
  assert.deepEqual(await admitIssueCommand(envsInput({ subject: englishApps, eventBody: issueBody, command: commandOf(issueBody) }), twoOrigins),
    { status: 'NOT_ADMITTED', cause: 'PROVIDED_WITH_SUBJECT_UNSUPPORTED', authority: false });
  const envsLiteral = await admitIssueCommand(envsInput({ subject: jaApps }), twoOrigins);
  assert.deepEqual([envsLiteral.status, Object.hasOwn(envsLiteral, 'observed'), envsLiteral.identity?.repository, envsLiteral.identity?.subject?.revision],
    ['ADMITTED', false, ENVS, subjectRevision(jaApps)], envsLiteral.cause);
}


// Validate today's operative settings separately from the frozen historical controls below.
{
  const active = validateActionsConfig(JSON.parse(fs.readFileSync(new URL('../issue-actions.json', import.meta.url), 'utf8')));
  assert.deepEqual(active.providedRequestTargets.map(grant => ({ ...grant })), []);
  assert.equal(active.targets.some(t => t.pullRequest === 536), false);
  const run = { repository: 'roccho-org/ops', workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml', number: 333, attempt: 1, id: 1 };
  for (const number of [333, 364]) {
    const selected = selectRunRange(active, { ...run, number }, { kind: 'pull-request', number: 625 });
    assert.equal(selected.callsPerRun, 1); assert.equal(selected.range.first, 333); assert.equal(selected.range.last, 364);
    assert.equal(selected.range.budgetClaimCommentId, 6305451060);
  }
  for (const number of [332, 365]) assert.deepEqual(selectRunRange(active, { ...run, number }, { kind: 'pull-request', number: 625 }), { cause: 'NO_RANGE' });
  assert.deepEqual(selectRunRange(active, { ...run, attempt: 2 }, { kind: 'pull-request', number: 625 }), { cause: 'RERUN_NOT_PAID' });
}

console.log(JSON.stringify({ status: 'PASS', check: 'jev-comment-functional', realProviderCalls: 0,
  githubEffects: 0, fixtureNativeHttp: existingFixtureHttp + childFixtureHttp, existingFixtureHttp, childFixtureHttp,
  claim: 'SOURCE_FIXTURE_ONLY_NOT_REAL_ISSUE_COMPLETION' }));
