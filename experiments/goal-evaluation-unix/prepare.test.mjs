// Network-free checks for prepare.mjs. Every reader here is a test double; nothing here is an actual acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RESULT_PREFIX, admitIssueCommand, PROVIDED_COMMAND_OBSERVATION, subjectRevision } from '../../packages/jev-review/github-comment.mjs';
import { semlint } from '../../packages/jev-review/semlint.mjs';
import { planIssueCommand, PULL_REQUEST_QUERY, COMMENT_QUERY } from '../../packages/jev-review/issue-executor.mjs';
import { plan } from './core.mjs';
import { acquire, executorIdentitySnapshot, project, expectedOrigin, fidelityFromReview, refusalOrigin, refusalIdentitySnapshot } from './prepare.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const repoFile = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
// The reviewed shipped settings, read unchanged, serve only as the admission oracle for this synthetic case.
const SETTINGS = JSON.parse(repoFile('packages/jev-review/issue-actions.json'));
const REPO = 'roccho-org/ops', NUMBER = 536, SHA = 'a'.repeat(40), NODE = 'PR_test536';
const TARGET = { repository: REPO, number: NUMBER };
const BODY = 'Adds a retry for the delivery job. The job records each attempt and reads back the final destination state.';
const GOAL = { ref: 'test:goal@1', content: 'Deliver each notification exactly once and confirm the actual destination state after delivery.' };
const EDITS = { lastEditedAt: '2026-10-14T00:00:00Z', includesCreatedEdit: false, userContentEditsTotal: 2 };
const issue = (body = BODY, edits = EDITS) => ({ number: NUMBER, nodeId: NODE, body, ...edits });
const RUN = { id: 77, number: 104, attempt: 1, workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml' };
const EXPECTED = { commandCommentId: 4242, runId: RUN.id, executionSource: SHA };
const command = (body, databaseId = EXPECTED.commandCommentId) => ({ databaseId, nodeId: 'IC_' + databaseId, author: 'roccho-dev', body,
  lastEditedAt: null, includesCreatedEdit: false, userContentEditsTotal: 0 });
const admissionInput = (eventBody, subject = issue(), commandId) => ({ repository: REPO, owner: 'roccho-org', sha: SHA, eventBody, run: RUN,
  issue: subject, command: command(eventBody, commandId), targetKind: 'pull-request',
  context: SETTINGS.context.map(c => ({ role: c.role, path: c.path, content: repoFile(c.path) })) });

// The old-literal request as the existing admission builds it; its identity is what an executor result would carry.
const literal = await admitIssueCommand(admissionInput('/jev-evaluate'), SETTINGS);
const resultComment = (identity = literal.identity, extra = {}) => ({ id: 900, user: { login: 'github-actions[bot]' },
  body: RESULT_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-result.v1', requestDigest: literal.requestDigest, identity, authority: false, result: {}, ...extra }) + '\n' });
const prJson = (body = BODY) => JSON.stringify({ number: NUMBER, node_id: NODE, body, base: { repo: { full_name: REPO } } });
const reader = (pages, mode = 'test-double') => ({ id: 'test-reader', mode, get: async url => {
  const page = pages[url]; if (page instanceof Error) throw page; return page ?? { status: 404, text: 'missing', link: '' }; } });
const URLS = { pr: 'https://api.github.com/repos/roccho-org/ops/pulls/536', comments: 'https://api.github.com/repos/roccho-org/ops/issues/536/comments?per_page=100' };
const receipts = async ({ comments = [resultComment()], body = BODY, mode, prPage, commentsPage } = {}) => {
  const r = reader({ [URLS.pr]: prPage ?? { status: 200, text: prJson(body) },
    [URLS.comments]: commentsPage ?? { status: 200, text: JSON.stringify(comments), link: '' } }, mode);
  const clock = () => '2026-10-15T00:00:00.000Z';
  return { pullRequestReceipt: await acquire({ ref: 'target', url: URLS.pr }, r, clock),
    commentsReceipt: await acquire({ ref: 'results', url: URLS.comments, list: true }, r, clock) };
};
const snapshotOf = async (options, expected = EXPECTED, target = TARGET) => executorIdentitySnapshot({ ...(await receipts(options)), target, expected });

const rubric = () => ({ problem: 'The target misses the delivery obligation.', ok: 'The target meets the delivery obligation.', unknown: 'The target text cannot establish it.' });
const clauses = [{ id: 'g-once', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' },
  { id: 'g-confirm', kind: 'obligation', ref: GOAL.ref, quote: 'confirm the actual destination state after delivery' }];
// Fixture questions are phrased in the ok direction ("satisfy") on purpose: the projection must not invert them.
const question = (id, extra = {}) => ({ id, core: null, question: `Does the change satisfy obligation ${id}?`, criteria: rubric(), clauseIds: ['g-once'],
  basisRefs: [GOAL.ref, 'target'], requiredRefs: ['target'], needs: [], ...extra });
const goalPlan = async (questions = [question('q1'), question('q2', { clauseIds: ['g-confirm'] })], goal = GOAL, quoted = clauses, options = {}) =>
  plan({ goal, observations: [{ ref: 'target', content: BODY }] }, { propose: async () => ({ clauses: quoted, questions, missing: [] }), ...options });
const faithful = out => ({ reviewRef: 'test:r-fidelity-record', envelopeSha256: out.envelopeSha256,
  verdicts: Object.fromEntries(out.checks.map(c => [c.id, 'FAITHFUL'])) });

test('receipts keep time, actual HTTP status and digest; only HTTP 200 with text is OK (N2)', async () => {
  const pages = { ok: { status: 200, text: 'x' }, empty: { status: 200, text: '' }, gone: { status: 404, text: 'Not Found' },
    limited: { status: 403, text: 'rate limit' }, slow: { status: 429, text: '' }, broken: { status: 502, text: 'bad' }, thrown: new Error('timeout') };
  const r = reader(pages), at = () => '2026-10-15T01:02:03.000Z';
  const ok = await acquire({ ref: 'r', url: 'ok' }, r, at);
  assert.deepEqual(ok, { ref: 'r', url: 'ok', reader: { id: 'test-reader', mode: 'test-double' }, observedAt: at(), httpStatus: 200, status: 'OK', bytes: 1, sha256: sha256('x'), content: 'x' });
  const expected = { empty: [200, 'UNKNOWN'], gone: [404, 'NOT_FOUND'], limited: [403, 'UNKNOWN'], slow: [429, 'UNKNOWN'], broken: [502, 'UNKNOWN'], thrown: [null, 'UNKNOWN'] };
  for (const [url, [httpStatus, status]] of Object.entries(expected)) {
    const got = await acquire({ ref: 'r', url }, r, at);
    assert.deepEqual([got.httpStatus, got.status, got.content, got.sha256], [httpStatus, status, null, null], url);
  }
  await assert.rejects(() => acquire({ ref: 'r', url: 'ok' }, { id: 'x', mode: 'replay', get: async () => ({}) }), /INVALID_READER/);
});

test('a list read is OK only when complete: a next page or an unreported Link header is UNKNOWN (C4)', async () => {
  const next = '<https://api.github.com/repositories/1/issues/536/comments?per_page=100&page=2>; rel="next", <…&page=2>; rel="last"';
  const r = reader({ one: { status: 200, text: '[]', link: '' }, more: { status: 200, text: '[]', link: next }, unreported: { status: 200, text: '[]' } });
  const got = async url => { const x = await acquire({ ref: 'c', url, list: true }, r); return [x.status, x.complete, x.content]; };
  assert.deepEqual(await got('one'), ['OK', true, '[]']);
  assert.deepEqual(await got('more'), ['UNKNOWN', false, null]);
  assert.deepEqual(await got('unreported'), ['UNKNOWN', null, null]);
  // A result on a later page, or a duplicate there, can no longer yield a false HOLD-as-verified or hide ambiguity.
  const subject = await snapshotOf({ commentsPage: { status: 200, text: JSON.stringify([resultComment()]), link: next } });
  assert.deepEqual([subject.status, subject.cause], ['HOLD', 'INPUT_UNKNOWN']);
  const bare = await executorIdentitySnapshot({ ...(await receipts()), commentsReceipt: { ...(await receipts()).commentsReceipt, complete: undefined }, target: TARGET, expected: EXPECTED });
  assert.deepEqual([bare.status, bare.cause], ['HOLD', 'INPUT_INCOMPLETE']);
});

test('a non-OK receipt holds: no snapshot, no projection, no envelope (N2)', async () => {
  for (const [options, cause] of [[{ prPage: { status: 403, text: '' } }, 'INPUT_UNKNOWN'], [{ commentsPage: { status: 404, text: '', link: '' } }, 'INPUT_NOT_FOUND'],
    [{ prPage: new Error('timeout') }, 'INPUT_UNKNOWN']]) {
    const subject = await snapshotOf(options);
    assert.deepEqual([subject.status, subject.cause, subject.emittable], ['HOLD', cause, false]);
    const out = project(await goalPlan(), subject);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'envelope')], ['HOLD', cause, false]);
  }
});

test('the executor identity yields the complete revision snapshot, never guessed edit metadata (N1)', async () => {
  const subject = await snapshotOf();
  assert.equal(subject.status, 'VERIFIED');
  assert.deepEqual(subject.snapshot, issue()); assert.deepEqual(subject.target, TARGET);
  assert.deepEqual(subject.origin, { resultCommentId: 900, requestDigest: literal.requestDigest, runId: RUN.id, commandCommentId: EXPECTED.commandCommentId });
  assert.equal(Object.hasOwn(subject, 'emittable'), false, 'a verified snapshot is not itself emittable');
  assert.equal(subject.readerDeclaredLive, false);
  assert.equal((await snapshotOf({ mode: 'live' })).readerDeclaredLive, true, 'a caller declaration only, not evidence of an actual read');
});

test('forged, unmarked, foreign, ambiguous or drifted executor results are refused (N1)', async () => {
  const cases = [
    [{ comments: [{ ...resultComment(), user: { login: 'roccho-dev' } }] }, 'REVISION_UNOBSERVED'],
    [{ comments: [{ ...resultComment(), body: resultComment().body.slice(RESULT_PREFIX.length) }] }, 'REVISION_UNOBSERVED'],
    [{ comments: [] }, 'REVISION_UNOBSERVED'],
    [{ comments: [resultComment(), { ...resultComment(), id: 901 }] }, 'EXECUTOR_RESULT_AMBIGUOUS'],
    [{ comments: [resultComment({ ...literal.identity, repository: 'roccho-org/envs' })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, issue: 511 })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, issueNodeId: 'PR_other' })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, observation: PROVIDED_COMMAND_OBSERVATION })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, run: { ...literal.identity.run, id: 78 } })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, executionSource: 'b'.repeat(40) })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, subjectRevision: literal.identity.subjectRevision + '|x' })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment({ ...literal.identity, subjectRevision: literal.identity.subjectRevision.replace('|2|', '|two|') })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment(literal.identity, { authority: true })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ comments: [resultComment(literal.identity, { provenance: 'executor-identity' })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ body: BODY + ' Edited after the run.' }, 'SUBJECT_DRIFT'],
  ];
  for (const [options, cause] of cases) {
    const subject = await snapshotOf(options);
    assert.deepEqual([subject.status, subject.cause, subject.emittable], ['HOLD', cause, false], cause);
  }
  for (const expected of [{ ...EXPECTED, runId: undefined }, { commandCommentId: 4242, runId: 77 }, { ...EXPECTED, executionSource: 'main' }]) {
    assert.equal((await snapshotOf({}, expected)).cause, 'EXPECTED_ORIGIN_MISSING');
  }
  assert.equal((await snapshotOf({}, { ...EXPECTED, commandCommentId: 4243 })).cause, 'REVISION_UNOBSERVED');
  assert.equal((await snapshotOf({}, EXPECTED, { repository: 'roccho-org/envs', number: NUMBER })).cause, 'PULL_REQUEST_MISMATCH');
});

test('the wire question asks for the problem criterion, so an ok-phrased question is not inverted (C2)', async () => {
  const value = await goalPlan();
  const out = project(value, await snapshotOf());
  assert.equal(out.status, 'ELIGIBLE');
  const [check] = out.checks, original = value.questions[0].question;
  assert.equal(check.predicate.question, `Does the problem criterion hold for this target, rather than the ok criterion? Original question: ${original}`);
  assert.notEqual(check.predicate.question, original);
  assert.deepEqual([check.predicate.true, check.predicate.false], [rubric().problem, rubric().ok]);
  assert.deepEqual(out.mapping[0].notLowered, { unknown: rubric().unknown });
  assert.equal(out.mapping[0].originalQuestion, original);
});

test('the target comes only from the verified snapshot; a free repository argument is refused (C5)', async () => {
  const subject = await snapshotOf(), value = await goalPlan();
  assert.throws(() => project(value, subject, { repository: 'roccho-org/envs' }), /INVALID_LIMITS/);
  for (const forged of [{ ...subject, target: { repository: 'roccho-org/envs', number: 523 } }, { ...subject, target: { repository: 'not a repo', number: NUMBER } },
    { ...subject, target: undefined }]) assert.equal(project(value, forged).status, 'HOLD');
  const out = project(value, subject);
  assert.match(out.envelope, /"ref":"https:\/\/github\.com\/roccho-org\/ops\/pull\/536"/);
});

test('emittable requires an external fidelity record of all FAITHFUL for the exact envelope bytes (C3)', async () => {
  const value = await goalPlan(), live = await snapshotOf({ mode: 'live' }), double = await snapshotOf();
  const unreviewed = project(value, live);
  assert.deepEqual([unreviewed.emittable, unreviewed.fidelity], [false, { verdicts: { q1: 'UNREVIEWED', q2: 'UNREVIEWED' }, allFaithful: false }]);
  const record = faithful(unreviewed);
  assert.equal(project(value, live, { fidelity: record }).emittable, true);
  assert.equal(project(value, double, { fidelity: faithful(project(value, double)) }).emittable, false, 'test-double readers stay non-emittable');
  assert.equal(project(value, live, { fidelity: { ...record, verdicts: { q1: 'FAITHFUL', q2: 'UNKNOWN' } } }).emittable, false);
  assert.equal(project(value, live, { fidelity: { ...record, verdicts: { q1: 'FAITHFUL', q2: 'UNFAITHFUL' } } }).emittable, false);
  for (const bad of [{ ...record, envelopeSha256: '0'.repeat(64) }, { ...record, verdicts: { q1: 'FAITHFUL' } },
    { ...record, verdicts: { q1: 'FAITHFUL', q2: 'PASS' } }, { ...record, reviewRef: '' }]) {
    assert.throws(() => project(value, live, { fidelity: bad }), /FIDELITY_RECORD_MISMATCH/);
  }
});

test('the projected request is admitted by existing admission and refused after a later edit', async () => {
  const out = project(await goalPlan(), await snapshotOf());
  assert.equal(out.envelopeSha256, sha256(out.envelope));
  const admitted = await admitIssueCommand(admissionInput(out.envelope, issue(), 4300), SETTINGS);
  assert.equal(admitted.status, 'ADMITTED', admitted.cause);
  assert.equal(admitted.identity.observation, PROVIDED_COMMAND_OBSERVATION);
  assert.equal(admitted.identity.subjectRevision, literal.identity.subjectRevision);
  for (const later of [issue(BODY, { ...EDITS, userContentEditsTotal: 3 }), issue(BODY + ' Edited.', EDITS)]) {
    assert.equal((await admitIssueCommand(admissionInput(out.envelope, later, 4301), SETTINGS)).status, 'NOT_ADMITTED');
  }
});

test('needs, limits, missing obligations and unverified subjects are recorded, never silently projected', async () => {
  const subject = await snapshotOf();
  const many = Array.from({ length: 8 }, (_, i) => question('q' + i, i === 0 ? { needs: ['destination log'] } : {}));
  const out = project(await goalPlan(many, GOAL, clauses, { maxQuestions: 8 }), subject, { maxQuestions: 8 });
  assert.equal(out.checks.length, 6);
  assert.deepEqual(out.notProjected, [{ id: 'q0', reason: 'INCOMPLETE', needs: ['destination log'], clauseIds: ['g-once'] },
    { id: 'q7', reason: 'LIMIT', clauseIds: ['g-once'] }]);
  const onlyNeeds = project(await goalPlan([question('q1', { needs: ['destination log'] })]), subject);
  assert.deepEqual([onlyNeeds.status, onlyNeeds.cause, onlyNeeds.notProjected.length, Object.hasOwn(onlyNeeds, 'envelope')], ['HOLD', 'NOTHING_PROJECTED', 1, false]);
  const unclear = project(await goalPlan([], GOAL, []), subject);
  assert.deepEqual([unclear.status, unclear.cause], ['HOLD', 'NEED_CLARIFICATION']);
  const unverified = project(await goalPlan(), { status: 'VERIFIED_BY_LABEL', target: TARGET, snapshot: issue(), readerDeclaredLive: true });
  assert.deepEqual([unverified.status, unverified.emittable, Object.hasOwn(unverified, 'envelope')], ['HOLD', false, false]);
});

test('a plan with no Core check concludes NOTHING_PROJECTED before any subject verification, keeping every record', async () => {
  const needsOnly = await goalPlan([question('q1', { needs: ['destination log'] })]);
  const verified = project(needsOnly, await snapshotOf());
  assert.deepEqual([verified.status, verified.cause, verified.emittable, verified.checks, verified.notProjected],
    ['HOLD', 'NOTHING_PROJECTED', false, [], [{ id: 'q1', reason: 'INCOMPLETE', needs: ['destination log'], clauseIds: ['g-once'] }]]);
  for (const key of ['envelope', 'envelopeSha256', 'target', 'fidelity', 'snapshot']) assert.equal(Object.hasOwn(verified, key), false, key);
  // No subject, a held subject, a label-only claim or a CJK subject: none is awaited or inspected when nothing reaches the wire.
  const cjkSubject = { status: 'VERIFIED', target: TARGET, snapshot: issue('再送を追加する。'), readerDeclaredLive: true };
  for (const subject of [undefined, { status: 'HOLD', cause: 'REVISION_UNOBSERVED' },
    { status: 'VERIFIED_BY_LABEL', target: TARGET, snapshot: issue(), readerDeclaredLive: true }, cjkSubject]) {
    assert.deepEqual(project(needsOnly, subject), verified, subject?.status ?? 'no subject');
  }
  // A Japanese Goal is concluded the same way and stays local: ref, digest and its unquoted span.
  const ja = { ref: GOAL.ref, content: '通知は一度だけ届けること。Deliver each notification exactly once.' };
  const jaNeeds = project(await goalPlan([question('q1', { needs: ['destination log'] })], ja, [clauses[0]]), undefined);
  assert.deepEqual([jaNeeds.status, jaNeeds.cause, jaNeeds.goal, jaNeeds.unquotedGoalText.map(s => s.text)],
    ['HOLD', 'NOTHING_PROJECTED', { ref: GOAL.ref, sha256: sha256(ja.content), onWire: false }, ['通知は一度だけ届けること。']]);
  // Order otherwise unchanged: no obligation is still NEED_CLARIFICATION, a projectable plan still waits for the
  // verified subject, and a CJK subject still makes a projectable case UNSUPPORTED_CJK.
  assert.deepEqual([project(await goalPlan([], GOAL, []), undefined).cause], ['NEED_CLARIFICATION']);
  const projectable = await goalPlan();
  assert.deepEqual([project(projectable, undefined).cause, project(projectable, { status: 'HOLD', cause: 'INPUT_UNKNOWN' }).cause], ['REVISION_UNOBSERVED', 'INPUT_UNKNOWN']);
  assert.equal(project(projectable, cjkSubject).status, 'UNSUPPORTED_CJK');
});

test('a Japanese Goal stays local as ref and digest; CJK on the wire makes the whole case unsupported (C1)', async () => {
  const subject = await snapshotOf();
  const ja = { ref: GOAL.ref, content: '通知は一度だけ届けること。Deliver each notification exactly once.' };
  const jaPlan = await goalPlan([question('q1')], ja, [{ id: 'g-once', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' }]);
  const out = project(jaPlan, subject);
  assert.equal(out.status, 'ELIGIBLE');
  assert.deepEqual(out.goal, { ref: GOAL.ref, sha256: sha256(ja.content), onWire: false });
  assert.equal(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(out.envelope), false);
  assert.equal((await admitIssueCommand(admissionInput(out.envelope, issue(), 4302), SETTINGS)).status, 'ADMITTED');
  const jaQuote = await goalPlan([question('q1', { clauseIds: ['g-ja'] })], ja, [{ id: 'g-ja', kind: 'obligation', ref: GOAL.ref, quote: '一度だけ届ける' }]);
  assert.equal(project(jaQuote, subject).status, 'ELIGIBLE', 'clause quotes stay in the local mapping');
  const english = project(await goalPlan(), subject);
  assert.deepEqual([english.goal.onWire, JSON.parse(english.envelope.slice(english.envelope.indexOf('\n') + 1)).cases[0].input.context.map(c => c.role)], [true, ['goal']]);
  for (const value of [await goalPlan([question('q1', { question: '一度だけ届くか？' })]),
    await goalPlan([question('q1', { criteria: { ...rubric(), problem: '二回届く。' } })])]) {
    const refused = project(value, subject);
    assert.deepEqual([refused.status, refused.emittable, Object.hasOwn(refused, 'envelope')], ['UNSUPPORTED_CJK', false, false]);
  }
  const jaBody = '再送を追加する。';
  const jaSubject = await snapshotOf({ body: jaBody, comments: [resultComment({ ...literal.identity,
    subjectRevision: literal.identity.subjectRevision.replace(sha256(BODY), sha256(jaBody)) })] });
  assert.equal(jaSubject.status, 'VERIFIED');
  assert.equal(project(await goalPlan(), jaSubject).status, 'UNSUPPORTED_CJK');
});

test('every outcome keeps unprojected clauses, off-wire qualifiers and unquoted Goal text (C6)', async () => {
  const subject = await snapshotOf();
  // A Japanese Goal: none of its text reaches the wire, so these local records are the only place it survives.
  const goal = { ref: GOAL.ref, content: '通知は一度だけ届けること。Deliver each notification exactly once. Confirm the destination state. A dry run needs no delivery.' };
  const g1 = { id: 'g1', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' };
  const g2 = { id: 'g2', kind: 'obligation', ref: GOAL.ref, quote: 'Confirm the destination state' };
  const e1 = { id: 'e1', kind: 'exception', ref: GOAL.ref, quote: 'A dry run needs no delivery' };
  const japanese = [{ start: 0, end: 13, text: '通知は一度だけ届けること。' }];

  const onlyG1 = project(await goalPlan([question('q1', { clauseIds: ['g1'] })], goal, [g1, g2, e1]), subject);
  assert.equal(onlyG1.status, 'ELIGIBLE'); assert.equal(onlyG1.goal.onWire, false);
  assert.deepEqual(onlyG1.mapping.map(m => [m.id, m.clauses.map(c => c.id), m.offWireQualifiers]), [['q1', ['g1'], []]]);
  assert.deepEqual(onlyG1.unprojectedClauses, [{ ...g2, reason: 'NO_QUESTION' }, { ...e1, reason: 'NO_QUESTION' }]);
  assert.deepEqual(onlyG1.unquotedGoalText, japanese);

  const value = await goalPlan([question('q1', { clauseIds: ['g1', 'e1'] }), question('q2', { clauseIds: ['g2'], needs: ['destination log'] })], goal, [g1, g2, e1]);
  const out = project(value, subject);
  assert.deepEqual(out.mapping[0].offWireQualifiers, [e1], 'the exception R must find reflected in the criteria text');
  assert.equal(out.envelope.includes(e1.quote), false, 'qualifier text itself is not on the wire');
  assert.deepEqual(out.notProjected, [{ id: 'q2', reason: 'INCOMPLETE', needs: ['destination log'], clauseIds: ['g2'] }]);
  assert.deepEqual(out.unprojectedClauses, [{ ...g2, reason: 'NOT_PROJECTED: q2 INCOMPLETE' }]);

  // HOLD outcomes keep the same records instead of dropping them.
  const held = project(value, { status: 'HOLD', cause: 'REVISION_UNOBSERVED' });
  assert.deepEqual([held.status, held.cause, held.unprojectedClauses, held.notProjected[0].clauseIds, held.unquotedGoalText],
    ['HOLD', 'REVISION_UNOBSERVED', [{ ...g2, reason: 'NOT_PROJECTED: q2 INCOMPLETE' }], ['g2'], japanese]);
  const nothing = project(await goalPlan([question('q1', { clauseIds: ['g1', 'e1'], needs: ['destination log'] })], goal, [g1, g2, e1]), subject);
  assert.deepEqual([nothing.status, nothing.cause, nothing.unprojectedClauses.map(c => [c.id, c.reason])],
    ['HOLD', 'NOTHING_PROJECTED', [['g1', 'NOT_PROJECTED: q1 INCOMPLETE'], ['g2', 'NO_QUESTION'], ['e1', 'NOT_PROJECTED: q1 INCOMPLETE']]]);
  const unclear = project(await goalPlan([], goal, []), subject);
  assert.deepEqual([unclear.status, unclear.cause, unclear.unquotedGoalText.map(s => s.text)], ['HOLD', 'NEED_CLARIFICATION', [goal.content]]);
});

test('the Plan missing list survives every projection outcome, including the automatic Goal coverage note (C7)', async () => {
  const subject = await snapshotOf(), signOff = { need: 'Owner sign-off record', reason: 'Not supplied with the target.' };
  const withMissing = (questions, quoted = clauses, goal = GOAL) => plan({ goal, observations: [{ ref: 'target', content: BODY }] },
    { propose: async () => ({ clauses: quoted, questions, missing: [signOff] }) });
  const value = await withMissing([question('q1')]);
  const outcomes = {
    ELIGIBLE: project(value, subject),
    HOLD_SUBJECT: project(value, { status: 'HOLD', cause: 'INPUT_UNKNOWN' }),
    NOTHING_PROJECTED: project(await withMissing([question('q1', { needs: ['destination log'] })]), subject),
    UNSUPPORTED_CJK: project(await withMissing([question('q1', { question: '一度だけ届くか？' })]), subject),
  };
  assert.deepEqual(Object.values(outcomes).map(o => [o.status, o.cause ?? null]),
    [['ELIGIBLE', null], ['HOLD', 'INPUT_UNKNOWN'], ['HOLD', 'NOTHING_PROJECTED'], ['UNSUPPORTED_CJK', null]]);
  for (const [name, out] of Object.entries(outcomes)) assert.deepEqual(out.missing, [signOff], name);
  // No clauses and no questions: plan() adds its own Goal coverage need, which projection must keep as well.
  const empty = await plan({ goal: GOAL, observations: [{ ref: 'target', content: BODY }] }, { propose: async () => ({ clauses: [], questions: [], missing: [] }) });
  const unclear = project(empty, subject);
  assert.deepEqual([unclear.status, unclear.cause, unclear.missing], ['HOLD', 'NEED_CLARIFICATION', empty.missing]);
  assert.equal(unclear.missing[0].need, 'Goal coverage');
  const declared = project(await withMissing([], []), subject);
  assert.deepEqual([declared.cause, declared.missing], ['NEED_CLARIFICATION', [signOff]]);
});

// N-a fixtures: synthetic observations shaped like the public REST documents and the executor's printed plan receipt.
const RUN_HEAD = 'c'.repeat(40), WORKFLOW_PATH = '.github/workflows/jev-issue-comment.yml';
// The repository's own workflow text, with its two runtime pins pointed at the synthetic runtime source SHA.
const WORKFLOW = repoFile(WORKFLOW_PATH).replaceAll(/(ref:\s*|runtime_source=)[0-9a-f]{40}/g, `$1${SHA}`);
const ACTIVATION = 'f'.repeat(40);
const APPROVED = { repository: REPO, number: NUMBER, principal: 'roccho-dev', commandBody: '/jev-evaluate', workflowId: RUN.workflowId,
  workflowPath: WORKFLOW_PATH, runRange: { first: 104, last: 105 }, runtimeSource: SHA, activationCommit: ACTIVATION };
const planLine = (extra = {}) => '2026-10-15T00:00:01.0000000Z ' + JSON.stringify({ schema: 'ops.jev.issue-actions-receipt.v1', stage: 'plan',
  outcome: 'PLANNED', cause: null, claimed: true, providerCalls: 0, authority: false, commentId: EXPECTED.commandCommentId,
  run: { id: RUN.id, number: RUN.number, attempt: 1, workflowId: RUN.workflowId }, requestDigest: literal.requestDigest, ...extra });
const planLog = (content = ['2026-10-15T00:00:00.0000000Z ##[group]Run plan', planLine(), '2026-10-15T00:00:02.0000000Z ##[endgroup]'].join('\n'), extra = {}) =>
  ({ ref: 'run-77-job-log', route: 'p-transported-job-log', observedAt: '2026-10-15T00:01:00.000Z', bytes: Buffer.byteLength(content), sha256: sha256(content),
    content, providerDigest: null, ...extra });
const commandJson = (extra = {}) => ({ id: EXPECTED.commandCommentId, user: { login: 'roccho-dev' }, body: '/jev-evaluate',
  issue_url: `https://api.github.com/repos/${REPO}/issues/${NUMBER}`, ...extra });
const runJson = (extra = {}) => ({ id: RUN.id, run_number: RUN.number, run_attempt: 1, workflow_id: RUN.workflowId, path: WORKFLOW_PATH,
  event: 'issue_comment', head_sha: RUN_HEAD, repository: { full_name: REPO }, ...extra });
// By default the approved activation commit carries the same workflow bytes as the run's head_sha.
const originOf = async ({ command = commandJson(), run = runJson(), workflow = WORKFLOW, workflowSha = RUN_HEAD, workflowUrl, log = planLog(), approved = APPROVED,
  posting = { id: EXPECTED.commandCommentId }, commandStatus = 200, activationWorkflow = workflow, activationUrl, activationStatus = 200,
  bind = expectedOrigin, mode } = {}) => {
  const urls = { command: `https://api.github.com/repos/${REPO}/issues/comments/${command.id}`, run: `https://api.github.com/repos/${REPO}/actions/runs/${run.id}`,
    workflow: workflowUrl ?? `https://raw.githubusercontent.com/${REPO}/${workflowSha}/${WORKFLOW_PATH}`,
    activation: activationUrl ?? `https://raw.githubusercontent.com/${REPO}/${ACTIVATION}/${WORKFLOW_PATH}` };
  const r = reader({ [urls.command]: { status: commandStatus, text: JSON.stringify(command) }, [urls.run]: { status: 200, text: JSON.stringify(run) },
    [urls.workflow]: { status: 200, text: workflow }, [urls.activation]: { status: activationStatus, text: activationWorkflow } }, mode);
  const get = async (ref, url) => acquire({ ref, url }, r, () => '2026-10-15T00:01:00.000Z');
  return bind({ approved, postingResponse: posting, commandReceipt: await get('command', urls.command),
    runReceipt: await get('run', urls.run), workflowReceipt: await get('workflow', urls.workflow),
    activationWorkflowReceipt: await get('activation-workflow', urls.activation), planLog: log });
};

test('the old-literal origin binds command, run and runtime only through the executor plan receipt and independent reads (N-a)', async () => {
  const bound = await originOf();
  assert.equal(bound.status, 'BOUND');
  assert.deepEqual(bound.expected, EXPECTED);
  assert.deepEqual(bound.origin, { runNumber: RUN.number, runHeadSha: RUN_HEAD, activationCommit: ACTIVATION, workflowSha256: sha256(WORKFLOW),
    planLogSha256: planLog().sha256, planRequestDigest: literal.requestDigest });
  assert.match(bound.limits[0], /P-transported job log without a provider digest/);
  assert.match(bound.limits[1], /caller-approved fact/);
  // The derived expectation is exactly what executorIdentitySnapshot needs; nothing is taken from the result itself.
  const subject = await snapshotOf({}, bound.expected);
  assert.equal(subject.status, 'VERIFIED');
  // R-A3: a caller can additionally tie the result to this plan through the shared request digest.
  assert.equal(subject.origin.requestDigest, bound.origin.planRequestDigest);
});

test('the workflow must be the approved repository file at the run head, checked out from the approved repository (R-A1, R-A2)', async () => {
  const path = `${RUN_HEAD}/${WORKFLOW_PATH}`;
  for (const workflowUrl of [`https://raw.githubusercontent.com/attacker/ops/${path}`, `https://example.invalid/x/${path}`,
    `https://raw.githubusercontent.com/${REPO}/${path}?token=x`, `https://raw.githubusercontent.com/${REPO}/main/${WORKFLOW_PATH}`]) {
    const out = await originOf({ workflowUrl });
    assert.deepEqual([out.status, out.cause], ['HOLD', 'WORKFLOW_NOT_AT_RUN_HEAD'], workflowUrl);
  }
  const foreign = WORKFLOW.replace(`repository: ${REPO}`, 'repository: attacker/ops');
  assert.notEqual(foreign, WORKFLOW);
  const unbound = WORKFLOW.replace(new RegExp(`^\\s*repository: ${REPO}\\s*\\n`, 'm'), '');
  assert.notEqual(unbound, WORKFLOW);
  const extra = WORKFLOW.replace('extra_nix_config: |', 'repository: attacker/ops\n          extra_nix_config: |');
  assert.notEqual(extra, WORKFLOW);
  for (const workflow of [foreign, unbound, extra]) {
    const out = await originOf({ workflow });
    assert.deepEqual([out.status, out.cause], ['HOLD', 'CHECKOUT_REPOSITORY_MISMATCH']);
  }
  assert.equal((await originOf({ log: planLog(planLine({ requestDigest: undefined })) })).cause, 'PLAN_RECEIPT_NOT_PLANNED');
});

test('the pinned checkout must be the only checkout step in the workflow (R-A6)', async () => {
  const checkout = /^(\s*)- uses: (actions\/checkout@\S+)\s*$/m.exec(WORKFLOW);
  assert.ok(checkout, 'the repository workflow has a checkout step');
  const [, indent, action] = checkout;
  // Insert one more step right after the pinned checkout's with: block.
  const after = text => WORKFLOW.replace(/persist-credentials: false\r?\n/, m => m + text);
  const variants = {
    bareCheckout: after(`\n${indent}- uses: ${action}\n`),
    checkoutToOtherPath: after(`\n${indent}- uses: ${action}\n${indent}  with:\n${indent}    path: other\n`),
    secondPinnedCheckout: after(`\n${indent}- uses: ${action}\n${indent}  with:\n${indent}    repository: ${REPO}\n${indent}    ref: ${SHA}\n${indent}    path: copy\n`),
    pinOnNonCheckoutStep: WORKFLOW.replace(`- uses: ${action}`, '- uses: other/fetch@v1'),
  };
  for (const [name, workflow] of Object.entries(variants)) {
    assert.notEqual(workflow, WORKFLOW, name);
    const out = await originOf({ workflow });
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'expected')], ['HOLD', 'CHECKOUT_STEP_MISMATCH', false], name);
  }
  assert.equal((await originOf()).status, 'BOUND', 'the unmodified repository workflow still binds');
});

test('the run workflow must be byte-identical to the approved activation workflow, so step spellings cannot evade it (R-A7)', async () => {
  const checkout = /^(\s*)- uses: (actions\/checkout@\S+)\s*$/m.exec(WORKFLOW);
  const [, indent, action] = checkout;
  // R's probes: one step appended at the end of the job, after every existing step.
  const append = step => WORKFLOW.replace(/\s*$/, '') + `\n\n${indent}${step}\n`;
  const variants = {
    doubleQuoted: append(`- uses: "${action}"`),
    singleQuoted: append(`- uses: '${action}'`),
    trailingComment: append(`- uses: ${action} # x`),
    otherCase: append('- uses: Actions/Checkout@v4'),
    runCheckout: append('- run: git fetch origin proposals && git checkout FETCH_HEAD'),
    crlfOnly: WORKFLOW.replace(/\n/g, '\r\n'),
  };
  for (const [name, workflow] of Object.entries(variants)) {
    assert.notEqual(workflow, WORKFLOW, name);
    const out = await originOf({ workflow, activationWorkflow: WORKFLOW });
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'expected')], ['HOLD', 'WORKFLOW_DRIFT_FROM_ACTIVATION', false], name);
  }
  // The activation side must itself be a complete, canonical, approved read; nothing is taken from the run or result.
  const activationCases = [
    [{ activationStatus: 404 }, 'INPUT_NOT_FOUND'],
    [{ activationStatus: 403 }, 'INPUT_UNKNOWN'],
    [{ activationUrl: `https://raw.githubusercontent.com/attacker/ops/${ACTIVATION}/${WORKFLOW_PATH}` }, 'ACTIVATION_WORKFLOW_NOT_CANONICAL'],
    [{ activationUrl: `https://raw.githubusercontent.com/${REPO}/${RUN_HEAD}/${WORKFLOW_PATH}` }, 'ACTIVATION_WORKFLOW_NOT_CANONICAL'],
    [{ approved: { ...APPROVED, activationCommit: undefined } }, 'APPROVED_ORIGIN_INVALID'],
    [{ approved: { ...APPROVED, activationCommit: 'proposals' } }, 'APPROVED_ORIGIN_INVALID'],
    [{ approved: (({ activationCommit, ...rest }) => rest)(APPROVED) }, 'APPROVED_ORIGIN_INVALID'],
  ];
  for (const [options, cause] of activationCases) {
    const out = await originOf(options);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'expected')], ['HOLD', cause, false], cause);
  }
  assert.equal((await originOf({ activationWorkflow: WORKFLOW })).status, 'BOUND', 'identical bytes at run head and activation bind');
});

test('missing, mismatched or self-declared origin evidence holds instead of binding (N-a)', async () => {
  const other = planLine({ commentId: 4243 });
  const cases = [
    [{ posting: { id: 4243 } }, 'COMMAND_MISMATCH'],
    [{ command: commandJson({ id: 4243 }), posting: { id: 4243 } }, 'COMMAND_MISMATCH'],
    [{ log: planLog(other) }, 'COMMAND_MISMATCH'],
    [{ command: commandJson({ user: { login: 'someone-else' } }) }, 'PRINCIPAL_MISMATCH'],
    [{ command: commandJson({ body: '/jev-evaluate\n{}' }) }, 'COMMAND_BODY_MISMATCH'],
    [{ command: commandJson({ issue_url: `https://api.github.com/repos/${REPO}/issues/511` }) }, 'TARGET_MISMATCH'],
    [{ run: runJson({ run_number: 51 }) }, 'RUN_MISMATCH'],
    [{ run: runJson({ run_attempt: 2 }), log: planLog(planLine({ run: { id: RUN.id, number: RUN.number, attempt: 2, workflowId: RUN.workflowId } })) }, 'RUN_MISMATCH'],
    [{ run: runJson({ workflow_id: 1 }) }, 'RUN_MISMATCH'],
    [{ run: runJson({ path: '.github/workflows/other.yml' }) }, 'RUN_MISMATCH'],
    [{ run: runJson({ event: 'workflow_dispatch' }) }, 'RUN_MISMATCH'],
    [{ run: runJson({ repository: { full_name: 'roccho-org/envs' } }) }, 'RUN_MISMATCH'],
    [{ approved: { ...APPROVED, runRange: { first: 60, last: 70 } } }, 'RUN_OUTSIDE_RANGE'],
    [{ workflowSha: 'd'.repeat(40) }, 'WORKFLOW_NOT_AT_RUN_HEAD'],
    [{ workflow: WORKFLOW.replace(SHA, 'e'.repeat(40)) }, 'RUNTIME_PIN_MISMATCH'],
    [{ approved: { ...APPROVED, runtimeSource: 'e'.repeat(40) } }, 'RUNTIME_PIN_MISMATCH'],
    [{ log: planLog('2026-10-15T00:00:00Z no receipt here') }, 'PLAN_RECEIPT_MISSING'],
    [{ log: planLog([planLine(), planLine()].join('\n')) }, 'PLAN_RECEIPT_AMBIGUOUS'],
    [{ log: planLog(planLine({ outcome: 'NONE', cause: 'NO_RANGE' })) }, 'PLAN_RECEIPT_NOT_PLANNED'],
    [{ log: planLog(undefined, { sha256: '0'.repeat(64) }) }, 'PLAN_LOG_RECEIPT_INVALID'],
    [{ log: planLog(undefined, { route: 'public-rest' }) }, 'PLAN_LOG_RECEIPT_INVALID'],
    [{ log: planLog(undefined, { providerDigest: 'sha256:' + '0'.repeat(64) }) }, 'PLAN_LOG_RECEIPT_INVALID'],
    // Actor, time and the final result alone: without the executor's plan receipt nothing is bound.
    [{ log: null }, 'PLAN_LOG_RECEIPT_INVALID'],
    [{ commandStatus: 403 }, 'INPUT_UNKNOWN'],
    [{ posting: {} }, 'POSTING_RESPONSE_MISSING'],
    [{ approved: { ...APPROVED, runtimeSource: 'main' } }, 'APPROVED_ORIGIN_INVALID'],
  ];
  for (const [options, cause] of cases) {
    const out = await originOf(options);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'expected')], ['HOLD', cause, false], cause);
  }
});

// N-e fixtures: an R review on this PR carrying one marked, closed fidelity block for the exact envelope.
const fidelityBody = (digest, verdicts, prefix = 'R fidelity review.\n') => prefix + '<!-- semlint-fidelity-v1 -->\n```json\n'
  + JSON.stringify({ schema: 'ops.goal-evaluation.fidelity.v1', envelopeSha256: digest, verdicts }) + '\n```\n';
const APPROVED_REVIEW = { repository: REPO, number: 539, reviewId: 7001, rOrigin: { session: 'cfaf506a-cc48-41d8-b6cb-74178a7d100a', goRef: 'test:go-record' } };
const reviewOf = async (review, status = 200) => acquire({ ref: 'review', url: 'review' }, reader({ review: { status, text: JSON.stringify(review) } }));
const reviewJson = (body, extra = {}) => ({ id: 7001, user: { login: 'roccho-dev' }, pull_request_url: `https://api.github.com/repos/${REPO}/pulls/539`, body, ...extra });

test('a fidelity record comes only from the approved review and its exact marked block, and still grants no posting (N-e)', async () => {
  const live = await snapshotOf({ mode: 'live' }), value = await goalPlan();
  const unreviewed = project(value, live), ids = unreviewed.checks.map(c => c.id);
  const verdicts = Object.fromEntries(ids.map(id => [id, 'FAITHFUL']));
  const got = fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(reviewJson(fidelityBody(unreviewed.envelopeSha256, verdicts))),
    envelopeSha256: unreviewed.envelopeSha256, checkIds: ids });
  assert.equal(got.status, 'RECORDED');
  assert.deepEqual(got.record, { reviewRef: `https://github.com/${REPO}/pull/539#pullrequestreview-7001`, envelopeSha256: unreviewed.envelopeSha256, verdicts });
  assert.deepEqual(got.rOriginDeclared, APPROVED_REVIEW.rOrigin);
  assert.match(got.limits[0], /shared GitHub author/);
  const reviewed = project(value, live, { fidelity: got.record });
  assert.deepEqual([reviewed.emittable, reviewed.postingAuthorized], [true, false]);
  const mixed = fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(reviewJson(fidelityBody(unreviewed.envelopeSha256, { ...verdicts, q2: 'UNFAITHFUL' }))),
    envelopeSha256: unreviewed.envelopeSha256, checkIds: ids });
  assert.equal(project(value, live, { fidelity: mixed.record }).emittable, false);
});

test('wrong, unmarked, duplicated, mismatched or label-only reviews hold; the shared author proves nothing (N-e)', async () => {
  const value = await goalPlan(), out = project(value, await snapshotOf()), ids = out.checks.map(c => c.id), digest = out.envelopeSha256;
  const ok = Object.fromEntries(ids.map(id => [id, 'FAITHFUL']));
  const cases = [
    [reviewJson(fidelityBody(digest, ok), { id: 7002 }), 'REVIEW_MISMATCH'],
    [reviewJson(fidelityBody(digest, ok), { pull_request_url: `https://api.github.com/repos/${REPO}/pulls/538` }), 'REVIEW_MISMATCH'],
    [reviewJson('R says FAITHFUL for everything. provenance: R'), 'FIDELITY_MARKER_MISSING'],
    [reviewJson(fidelityBody(digest, ok) + fidelityBody(digest, ok, '')), 'FIDELITY_MARKER_DUPLICATE'],
    [reviewJson(fidelityBody(digest, ok).replace('ops.goal-evaluation.fidelity.v1', 'other')), 'FIDELITY_BLOCK_INVALID'],
    [reviewJson(fidelityBody(digest, ok).replace('"verdicts"', '"role":"R","verdicts"')), 'FIDELITY_BLOCK_INVALID'],
    [reviewJson(fidelityBody('0'.repeat(64), ok)), 'FIDELITY_DIGEST_MISMATCH'],
    [reviewJson(fidelityBody(digest, { q1: 'FAITHFUL' })), 'FIDELITY_CHECKS_MISMATCH'],
    [reviewJson(fidelityBody(digest, { ...ok, q3: 'FAITHFUL' })), 'FIDELITY_CHECKS_MISMATCH'],
    [reviewJson(fidelityBody(digest, { ...ok, q1: 'PASS' })), 'FIDELITY_CHECKS_MISMATCH'],
  ];
  for (const [review, cause] of cases) {
    const got = fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(review), envelopeSha256: digest, checkIds: ids });
    assert.deepEqual([got.status, got.cause, Object.hasOwn(got, 'record')], ['HOLD', cause, false], cause);
  }
  const good = reviewJson(fidelityBody(digest, ok));
  assert.equal(fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(good, 403), envelopeSha256: digest, checkIds: ids }).cause, 'INPUT_UNKNOWN');
  for (const approved of [{ ...APPROVED_REVIEW, rOrigin: { session: '', goRef: 'x' } }, { repository: REPO, number: 539, reviewId: 7001 }]) {
    assert.equal(fidelityFromReview({ approved, reviewReceipt: await reviewOf(good), envelopeSha256: digest, checkIds: ids }).cause, 'APPROVED_REVIEW_INVALID');
  }
  // The author login is never evidence of R: changing it does not change the result either way.
  const other = fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf({ ...good, user: { login: 'someone-else' } }), envelopeSha256: digest, checkIds: ids });
  assert.equal(other.status, 'RECORDED');
  assert.equal(fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(good), envelopeSha256: 'x', checkIds: ids }).cause, 'PROJECTION_INVALID');
});

// C1 fixtures: a hand-written plan receipt in the shape the #547 executor prints for a literal CJK refusal (with its own
// subject observation), followed by its post-stage echo. These tests pin this caller's parsing and bindings, including
// shapes the producer never prints; the composition test at the end feeds the caller the producer's actual receipt.
const JA_BODY = '配信ジョブに再送を追加する。Adds a retry for the delivery job.';
const JA_ISSUE = issue(JA_BODY);
const OBSERVED = { issueNodeId: NODE, subjectRevision: subjectRevision(JA_ISSUE) };
const refusalLine = (extra = {}, stage = 'plan') => '2026-10-15T00:00:01.0000000Z ' + JSON.stringify({ schema: 'ops.jev.issue-actions-receipt.v1', stage,
  outcome: 'NONE', cause: 'UNSUPPORTED_CJK', claimed: false, providerCalls: 0, authority: false, commentId: EXPECTED.commandCommentId,
  run: { id: RUN.id, number: RUN.number, attempt: 1, workflowId: RUN.workflowId }, observed: OBSERVED, ...extra });
const refusalLog = (lines = [refusalLine(), refusalLine({}, 'post')]) => planLog(['2026-10-15T00:00:00.0000000Z ##[group]Run plan', ...lines].join('\n'));
const refusedOf = (options = {}) => originOf({ log: refusalLog(), bind: refusalOrigin, ...options });
const refusalSnapshotOf = async ({ origin, body = JA_BODY, mode, prPage, target = TARGET } = {}) =>
  refusalIdentitySnapshot({ origin: origin ?? await refusedOf(), pullRequestReceipt: (await receipts({ body, mode, prPage })).pullRequestReceipt, target });
const AUX = { text: 'Adds a retry for the delivery job.', sourceSha256: sha256(JA_BODY) };
const wireInput = out => JSON.parse(out.envelope.slice(out.envelope.indexOf('\n') + 1)).cases[0].input;
// Core v14 itself, given a model port that never answers: reaching the port means Core admitted the input.
const coreAccepts = async input => { let asked = 0;
  await semlint(input, async () => { asked++; throw new Error('NOT_ANSWERED'); }).catch(() => {});
  return asked > 0; };
const fidelityV2Body = (digest, verdicts, renderingVerdict, extra = {}) => 'R fidelity review.\n<!-- semlint-fidelity-v1 -->\n```json\n'
  + JSON.stringify({ schema: 'ops.goal-evaluation.fidelity.v2', envelopeSha256: digest, verdicts, renderingVerdict, ...extra }) + '\n```\n';

test('a literal CJK refusal binds through the same receipts and yields the executor-observed snapshot (C1)', async () => {
  const refused = await refusedOf();
  assert.equal(refused.status, 'BOUND', refused.cause);
  assert.deepEqual([refused.kind, refused.target, refused.planObservation, refused.readerDeclaredLive], ['literal-cjk-refusal', TARGET, OBSERVED, false]);
  assert.deepEqual(refused.origin, { commandCommentId: EXPECTED.commandCommentId, runId: RUN.id, runNumber: RUN.number, runHeadSha: RUN_HEAD,
    executionSource: SHA, activationCommit: ACTIVATION, workflowSha256: sha256(WORKFLOW), planLogSha256: refusalLog().sha256 });
  for (const key of ['expected', 'planRequestDigest', 'requestDigest']) assert.equal(Object.hasOwn(refused, key) || Object.hasOwn(refused.origin, key), false, key);
  assert.deepEqual(refused.limits.slice(0, 2), (await originOf()).limits);
  assert.match(refused.limits[2], /not a later read/);
  assert.match(refused.limits[3], /does not show that the body is CJK/);
  const subject = await refusalSnapshotOf({ origin: refused });
  assert.equal(subject.status, 'VERIFIED', subject.cause);
  assert.deepEqual([subject.target, subject.snapshot, subject.readerDeclaredLive], [TARGET, JA_ISSUE, false]);
  assert.deepEqual(subject.origin, { kind: 'literal-cjk-refusal', ...refused.origin });
  // The edit signals are the observation's own, never guessed: another observed edit state yields exactly that state.
  const unedited = issue(JA_BODY, { lastEditedAt: null, includesCreatedEdit: true, userContentEditsTotal: 0 });
  const other = await refusalSnapshotOf({ origin: { ...refused, planObservation: { issueNodeId: NODE, subjectRevision: subjectRevision(unedited) } } });
  assert.deepEqual([other.status, other.snapshot], ['VERIFIED', unedited]);
  // readerDeclaredLive repeats the public reader-port declarations on both sides only; the job log is never counted as live.
  const live = await refusedOf({ mode: 'live' });
  assert.equal(live.readerDeclaredLive, true);
  assert.deepEqual([(await refusalSnapshotOf({ origin: live, mode: 'live' })).readerDeclaredLive, (await refusalSnapshotOf({ origin: live })).readerDeclaredLive,
    (await refusalSnapshotOf({ origin: refused, mode: 'live' })).readerDeclaredLive], [true, false, false]);
  assert.deepEqual([refusalLog().route, refusalLog().providerDigest], ['p-transported-job-log', null]);
});

test('only the exact closed refusal receipt binds; echoes, digests, claims and receipts without an observation hold (C1)', async () => {
  const cases = [
    [{ log: refusalLog([refusalLine({}, 'post')]) }, 'PLAN_RECEIPT_MISSING'],
    [{ log: refusalLog([refusalLine(), refusalLine()]) }, 'PLAN_RECEIPT_AMBIGUOUS'],
    [{ log: refusalLog([refusalLine({ requestDigest: literal.requestDigest })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ claimResponse: { status: 201 } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ observed: undefined })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ observed: { ...OBSERVED, body: JA_BODY } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ observed: { ...OBSERVED, issueNodeId: '' } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ outcome: 'PLANNED' })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ cause: 'NO_RANGE' })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ claimed: true })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ providerCalls: 1 })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ authority: true })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: refusalLog([refusalLine({ run: { id: RUN.id, number: RUN.number, attempt: 1, workflowId: RUN.workflowId, path: WORKFLOW_PATH } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: planLog() }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    [{ log: { ...refusalLog(), sha256: '0'.repeat(64) } }, 'PLAN_LOG_RECEIPT_INVALID'],
    [{ log: { ...refusalLog(), providerDigest: 'sha256:' + '0'.repeat(64) } }, 'PLAN_LOG_RECEIPT_INVALID'],
    // The same N-a bindings as the old-literal origin, through the shared helper.
    [{ posting: { id: 4243 } }, 'COMMAND_MISMATCH'],
    [{ log: refusalLog([refusalLine({ commentId: 4243 })]) }, 'COMMAND_MISMATCH'],
    [{ command: commandJson({ user: { login: 'someone-else' } }) }, 'PRINCIPAL_MISMATCH'],
    [{ command: commandJson({ body: '/jev-evaluate\n{}' }) }, 'COMMAND_BODY_MISMATCH'],
    [{ command: commandJson({ issue_url: `https://api.github.com/repos/${REPO}/issues/511` }) }, 'TARGET_MISMATCH'],
    [{ run: runJson({ id: 78 }) }, 'RUN_MISMATCH'],
    [{ run: runJson({ run_attempt: 2 }), log: refusalLog([refusalLine({ run: { id: RUN.id, number: RUN.number, attempt: 2, workflowId: RUN.workflowId } })]) }, 'RUN_MISMATCH'],
    [{ run: runJson({ path: '.github/workflows/other.yml' }) }, 'RUN_MISMATCH'],
    [{ approved: { ...APPROVED, runRange: { first: 60, last: 70 } } }, 'RUN_OUTSIDE_RANGE'],
    [{ workflowSha: 'd'.repeat(40) }, 'WORKFLOW_NOT_AT_RUN_HEAD'],
    [{ workflow: WORKFLOW.replace(/\n/g, '\r\n'), activationWorkflow: WORKFLOW }, 'WORKFLOW_DRIFT_FROM_ACTIVATION'],
    [{ workflow: WORKFLOW.replace(SHA, 'e'.repeat(40)) }, 'RUNTIME_PIN_MISMATCH'],
    [{ commandStatus: 403 }, 'INPUT_UNKNOWN'],
    // A provided request is never the origin of a literal refusal, even when its own readback is consistent.
    [{ approved: { ...APPROVED, commandBody: '/jev-evaluate\n{}' }, command: commandJson({ body: '/jev-evaluate\n{}' }) }, 'COMMAND_NOT_LITERAL'],
  ];
  for (const [options, cause] of cases) {
    const out = await refusedOf(options);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'planObservation')], ['HOLD', cause, false], cause);
  }
  // The old-literal origin keeps accepting only PLANNED receipts.
  assert.equal((await originOf({ log: refusalLog() })).cause, 'PLAN_RECEIPT_NOT_PLANNED');
});

test('the refusal snapshot binds node, body and target to the public PR; drift, malformed revisions and mixed origins hold (C1, R4)', async () => {
  const refused = await refusedOf();
  // R4 first and alone: a refusal-shaped origin of any other kind carries the approved target and a valid observation,
  // so only the kind check refuses it (R N1).
  for (const kind of [undefined, 'old-literal-result']) {
    const got = await refusalSnapshotOf({ origin: { ...refused, kind } });
    assert.deepEqual([got.status, got.cause, Object.hasOwn(got, 'snapshot')], ['HOLD', 'ORIGIN_KIND_MISMATCH', false], String(kind));
  }
  const withObserved = observed => ({ ...refused, planObservation: { ...OBSERVED, ...observed } });
  const otherNode = { status: 200, text: JSON.stringify({ number: NUMBER, node_id: 'PR_other', body: JA_BODY, base: { repo: { full_name: REPO } } }) };
  const cases = [
    [{ body: JA_BODY + ' Edited after the refusal.' }, 'SUBJECT_DRIFT'],
    [{ prPage: otherNode }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ origin: withObserved({ issueNodeId: 'PR_other' }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ origin: withObserved({ subjectRevision: OBSERVED.subjectRevision.replace(NODE, 'PR_other') }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ origin: withObserved({ subjectRevision: OBSERVED.subjectRevision.replace('|2|', '|two|') }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ origin: withObserved({ subjectRevision: OBSERVED.subjectRevision + '|x' }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ origin: withObserved({ subjectRevision: 1 }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    [{ target: { repository: REPO, number: 511 } }, 'TARGET_MISMATCH'],
    [{ origin: { ...refused, target: { repository: 'roccho-org/envs', number: NUMBER } } }, 'TARGET_MISMATCH'],
    [{ prPage: { status: 403, text: '' } }, 'INPUT_UNKNOWN'],
    // R4: an old-literal or held origin is not a refusal origin either.
    [{ origin: await originOf() }, 'ORIGIN_KIND_MISMATCH'],
    [{ origin: await refusedOf({ commandStatus: 403 }) }, 'ORIGIN_KIND_MISMATCH'],
  ];
  for (const [options, cause] of cases) {
    const got = await refusalSnapshotOf(options);
    assert.deepEqual([got.status, got.cause, Object.hasOwn(got, 'snapshot')], ['HOLD', cause, false], cause);
  }
  // R4, the other way: the result path takes no refusal origin in place of its expected command, run and runtime.
  for (const expected of [refused.expected, refused.origin, refused]) {
    assert.equal(executorIdentitySnapshot({ ...(await receipts()), target: TARGET, expected }).cause, 'EXPECTED_ORIGIN_MISSING');
  }
});

test('a supplied English rendering projects a CJK subject only, bound to the whole body, and keeps every local record (C1)', async () => {
  const subject = await refusalSnapshotOf(), value = await goalPlan();
  assert.equal(project(value, subject).status, 'UNSUPPORTED_CJK', 'without a rendering a CJK subject stays unsupported');
  const out = project(value, subject, { englishAuxiliary: AUX });
  assert.equal(out.status, 'ELIGIBLE');
  const input = wireInput(out);
  assert.deepEqual(input.subject, { kind: 'log-entry', ref: `https://github.com/${REPO}/pull/${NUMBER}`, revision: OBSERVED.subjectRevision,
    scope: 'entire body of the approved pull request at the observed revision', content: JA_BODY, sha256: sha256(JA_BODY),
    evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(JA_BODY) }, englishAuxiliary: AUX });
  assert.deepEqual(input.context.map(c => [c.role, c.englishAuxiliary]), [['goal', null]]);
  assert.equal(await coreAccepts(input), true, 'Core v14 admits the rendered subject');
  // Everything the wire does not carry is the same as for an English subject.
  const english = project(value, await snapshotOf());
  for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], english[key], key);
  assert.deepEqual([out.emittable, out.postingAuthorized], [false, false]);
  // A Japanese Goal stays local as ref and digest with its unquoted span, also beside a rendered subject.
  const ja = { ref: GOAL.ref, content: '通知は一度だけ届けること。Deliver each notification exactly once.' };
  const jaGoal = project(await goalPlan([question('q1')], ja, [clauses[0]]), subject, { englishAuxiliary: AUX });
  assert.deepEqual([jaGoal.status, jaGoal.goal.onWire, wireInput(jaGoal).context, jaGoal.unquotedGoalText.map(s => s.text)], ['ELIGIBLE', false, [], ['通知は一度だけ届けること。']]);
});

test('an invalid or unneeded rendering holds with every record; CJK elsewhere still refuses; the order is unchanged (C1, R3)', async () => {
  const subject = await refusalSnapshotOf(), value = await goalPlan(), ok = project(value, subject, { englishAuxiliary: AUX });
  for (const englishAuxiliary of [null, {}, { text: AUX.text }, { ...AUX, text: ' ' }, { ...AUX, text: '再送を追加する。' }, { ...AUX, sourceSha256: sha256(BODY) },
    { ...AUX, sourceSha256: AUX.sourceSha256.toUpperCase() }, { ...AUX, note: 'x' }, AUX.text]) {
    const out = project(value, subject, { englishAuxiliary });
    assert.deepEqual([out.status, out.cause, out.emittable, Object.hasOwn(out, 'envelope')], ['HOLD', 'AUXILIARY_INVALID', false, false], JSON.stringify(englishAuxiliary));
    for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], ok[key], key);
  }
  // An English body takes no rendering. That is Core v14's rule, shown here by Core itself: it refuses an auxiliary on a
  // unit whose selected text has no CJK and requires one on a unit whose selected text has CJK.
  const englishSubject = await snapshotOf(), bound = { text: 'Adds a retry.', sourceSha256: sha256(BODY) };
  const unneeded = project(value, englishSubject, { englishAuxiliary: bound });
  assert.deepEqual([unneeded.status, unneeded.cause, Object.hasOwn(unneeded, 'envelope'), unneeded.unprojectedClauses], ['HOLD', 'RENDERING_NOT_NEEDED', false, ok.unprojectedClauses]);
  const plain = wireInput(project(value, englishSubject)), rendered = wireInput(ok);
  assert.deepEqual([await coreAccepts(plain), await coreAccepts({ ...plain, subject: { ...plain.subject, englishAuxiliary: bound } }),
    await coreAccepts({ ...rendered, subject: { ...rendered.subject, englishAuxiliary: null } })], [true, false, false]);
  // CJK outside the original subject content still makes the case unsupported.
  for (const other of [await goalPlan([question('q1', { question: '一度だけ届くか？' })]), await goalPlan([question('q1', { criteria: { ...rubric(), problem: '二回届く。' } })])]) {
    const refused = project(other, subject, { englishAuxiliary: AUX });
    assert.deepEqual([refused.status, refused.emittable, Object.hasOwn(refused, 'envelope')], ['UNSUPPORTED_CJK', false, false]);
  }
  // No obligation, then no Core check, conclude before any subject or rendering is inspected; a check still waits for the subject.
  for (const englishAuxiliary of [AUX, null, 'anything']) {
    assert.equal(project(await goalPlan([], GOAL, []), undefined, { englishAuxiliary }).cause, 'NEED_CLARIFICATION');
    assert.equal(project(await goalPlan([question('q1', { needs: ['destination log'] })]), undefined, { englishAuxiliary }).cause, 'NOTHING_PROJECTED');
    assert.equal(project(value, { status: 'HOLD', cause: 'INPUT_UNKNOWN' }, { englishAuxiliary }).cause, 'INPUT_UNKNOWN');
  }
});

test('with a rendering, emitting also needs R\'s separate renderingVerdict FAITHFUL in a v2 record; without one, v2 is refused (C1)', async () => {
  const live = await refusalSnapshotOf({ origin: await refusedOf({ mode: 'live' }), mode: 'live' }), value = await goalPlan();
  const unreviewed = project(value, live, { englishAuxiliary: AUX }), ids = unreviewed.checks.map(c => c.id);
  assert.deepEqual([unreviewed.emittable, unreviewed.fidelity], [false, { verdicts: { q1: 'UNREVIEWED', q2: 'UNREVIEWED' }, renderingVerdict: 'UNREVIEWED', allFaithful: false }]);
  const all = Object.fromEntries(ids.map(id => [id, 'FAITHFUL']));
  const record = { reviewRef: 'test:r-fidelity-record', envelopeSha256: unreviewed.envelopeSha256, verdicts: all, renderingVerdict: 'FAITHFUL' };
  const emitted = project(value, live, { englishAuxiliary: AUX, fidelity: record });
  assert.deepEqual([emitted.emittable, emitted.postingAuthorized, emitted.fidelity.renderingVerdict], [true, false, 'FAITHFUL']);
  for (const renderingVerdict of ['UNFAITHFUL', 'UNKNOWN']) assert.equal(project(value, live, { englishAuxiliary: AUX, fidelity: { ...record, renderingVerdict } }).emittable, false);
  assert.equal(project(value, live, { englishAuxiliary: AUX, fidelity: { ...record, verdicts: { ...all, q2: 'UNKNOWN' } } }).emittable, false);
  assert.equal(project(value, await refusalSnapshotOf(), { englishAuxiliary: AUX, fidelity: record }).emittable, false, 'test-double readers stay non-emittable');
  const { renderingVerdict, ...checkOnly } = record;
  for (const bad of [checkOnly, { ...record, renderingVerdict: 'PASS' }, { ...record, envelopeSha256: '0'.repeat(64) }]) {
    assert.throws(() => project(value, live, { englishAuxiliary: AUX, fidelity: bad }), /FIDELITY_RECORD_MISMATCH/);
  }
  // Without a rendering the v1 record is unchanged and a renderingVerdict is refused.
  const plainLive = await snapshotOf({ mode: 'live' }), plain = project(value, plainLive);
  assert.throws(() => project(value, plainLive, { fidelity: { ...faithful(plain), renderingVerdict: 'FAITHFUL' } }), /FIDELITY_RECORD_MISMATCH/);
  assert.equal(project(value, plainLive, { fidelity: faithful(plain) }).emittable, true);
  // From the approved review: the v2 block only when a rendering is required, the v1 block only when it is not.
  const read = async (body, rendering) => fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(reviewJson(body)),
    envelopeSha256: unreviewed.envelopeSha256, checkIds: ids, rendering });
  const got = await read(fidelityV2Body(unreviewed.envelopeSha256, all, 'FAITHFUL'), true);
  assert.equal(got.status, 'RECORDED');
  assert.deepEqual(got.record, { reviewRef: `https://github.com/${REPO}/pull/539#pullrequestreview-7001`, envelopeSha256: unreviewed.envelopeSha256, verdicts: all, renderingVerdict: 'FAITHFUL' });
  assert.equal(project(value, live, { englishAuxiliary: AUX, fidelity: got.record }).emittable, true);
  const cases = [
    [fidelityBody(unreviewed.envelopeSha256, all), true, 'FIDELITY_BLOCK_INVALID'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, 'FAITHFUL'), false, 'FIDELITY_BLOCK_INVALID'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, undefined), true, 'FIDELITY_BLOCK_INVALID'],
    // The schema label decides even when the key set alone would match the other shape (R B1).
    [fidelityV2Body(unreviewed.envelopeSha256, all, 'FAITHFUL', { schema: 'ops.goal-evaluation.fidelity.v1' }), true, 'FIDELITY_BLOCK_INVALID'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, undefined), false, 'FIDELITY_BLOCK_INVALID'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, 'FAITHFUL', { englishSha256: sha256(AUX.text) }), true, 'FIDELITY_BLOCK_INVALID'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, 'PASS'), true, 'FIDELITY_RENDERING_INVALID'],
    [fidelityV2Body('0'.repeat(64), all, 'FAITHFUL'), true, 'FIDELITY_DIGEST_MISMATCH'],
    [fidelityV2Body(unreviewed.envelopeSha256, { ...all, 'subject.englishAuxiliary': 'FAITHFUL' }, 'FAITHFUL'), true, 'FIDELITY_CHECKS_MISMATCH'],
    [fidelityV2Body(unreviewed.envelopeSha256, all, 'FAITHFUL'), 'yes', 'PROJECTION_INVALID'],
  ];
  for (const [body, rendering, cause] of cases) {
    const out = await read(body, rendering);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'record')], ['HOLD', cause, false], cause);
  }
});

test('a check named subject.englishAuxiliary stays a check: rendering and check verdicts cannot collide (C1)', async () => {
  const live = await refusalSnapshotOf({ origin: await refusedOf({ mode: 'live' }), mode: 'live' });
  const value = await goalPlan([question('subject.englishAuxiliary'), question('q2', { clauseIds: ['g-confirm'] })]);
  const out = project(value, live, { englishAuxiliary: AUX });
  assert.deepEqual([out.checks.map(c => c.id), out.fidelity.verdicts], [['subject.englishAuxiliary', 'q2'], { 'subject.englishAuxiliary': 'UNREVIEWED', q2: 'UNREVIEWED' }]);
  const record = (check, renderingVerdict) => ({ reviewRef: 'test:r', envelopeSha256: out.envelopeSha256,
    verdicts: { 'subject.englishAuxiliary': check, q2: 'FAITHFUL' }, renderingVerdict });
  assert.deepEqual([['FAITHFUL', 'UNKNOWN'], ['UNKNOWN', 'FAITHFUL'], ['FAITHFUL', 'FAITHFUL']]
    .map(([check, rendering]) => project(value, live, { englishAuxiliary: AUX, fidelity: record(check, rendering) }).emittable), [false, false, true]);
});

// Composition on this tree: the real L2 executor plans a literal command on a CJK PR body with the shipped settings and
// stub ports (no network), its receipt is printed in the executor's JSON.stringify form behind a fixture runner
// timestamp, and the caller and the real L1 provided admission consume it. This proves the functions compose, not a
// workflow run, an actual acquisition, a rendering or an effect.
test('the real L2 refusal receipt reaches the caller and the real L1 provided admission (composition)', async () => {
  const target = SETTINGS.targets.find(t => t.repository === REPO && t.pullRequest === NUMBER);
  const org = SETTINGS.provider.receipt.target;
  const event = { comment: { id: EXPECTED.commandCommentId, node_id: 'IC_' + EXPECTED.commandCommentId, body: '/jev-evaluate', user: { login: 'roccho-dev' } },
    issue: { number: NUMBER, pull_request: {} },
    repository: { full_name: REPO, id: Number(target.repositoryId), owner: { login: org.organization, id: Number(org.organization_id), type: 'Organization' } } };
  const calls = [];
  const deps = {
    github: async (method, route) => {
      calls.push(`${method} ${route}`);
      if (method !== 'GET') return { status: 500, json: null };
      if (route === `repos/${REPO}/actions/runs/${RUN.id}`) return { status: 200, json: { id: RUN.id, repository: { full_name: REPO }, workflow_id: RUN.workflowId,
        path: WORKFLOW_PATH, run_number: RUN.number, run_attempt: 1, head_sha: RUN_HEAD } };
      if (route === `repos/${REPO}/actions/workflows/${RUN.workflowId}`) return { status: 200, json: { id: RUN.workflowId, state: 'active' } };
      return { status: 404, json: null };
    },
    graphql: async query => query === PULL_REQUEST_QUERY
      ? { data: { repository: { pullRequest: { id: NODE, number: NUMBER, body: JA_BODY, lastEditedAt: EDITS.lastEditedAt,
        includesCreatedEdit: EDITS.includesCreatedEdit, userContentEdits: { totalCount: EDITS.userContentEditsTotal } } } } }
      : query === COMMENT_QUERY ? { data: { node: { id: event.comment.node_id, fullDatabaseId: String(event.comment.id), author: { login: 'roccho-dev' },
        body: event.comment.body, lastEditedAt: null, includesCreatedEdit: false, userContentEdits: { totalCount: 0 }, reactions: { totalCount: 0, nodes: [] } } } }
      : { errors: ['unexpected query'] },
    readFile: path => repoFile(path),
  };
  const planned = await planIssueCommand({ repository: REPO, sha: RUN_HEAD, executionSource: SHA, runId: RUN.id, runAttempt: 1, event }, SETTINGS, deps);
  // The producer refuses before any claim, owner run, provider call or write, and keeps its own exact observation.
  assert.deepEqual(planned.receipt, { schema: 'ops.jev.issue-actions-receipt.v1', stage: 'plan', outcome: 'NONE', cause: 'UNSUPPORTED_CJK', claimed: false,
    providerCalls: 0, authority: false, commentId: EXPECTED.commandCommentId, run: { id: RUN.id, number: RUN.number, attempt: 1, workflowId: RUN.workflowId },
    observed: { issueNodeId: NODE, subjectRevision: subjectRevision(JA_ISSUE) } });
  assert.equal(Object.hasOwn(planned, 'plan'), false);
  assert.deepEqual(calls.filter(c => !c.startsWith('GET ')), []);
  const log = planLog(['2026-10-15T00:00:00.0000000Z ##[group]Run plan', '2026-10-15T00:00:01.0000000Z ' + JSON.stringify(planned.receipt)].join('\n'));
  const origin = await originOf({ log, bind: refusalOrigin });
  assert.deepEqual([origin.status, origin.kind, origin.planObservation], ['BOUND', 'literal-cjk-refusal', planned.receipt.observed], origin.cause);
  const subject = await refusalSnapshotOf({ origin });
  assert.deepEqual([subject.status, subject.snapshot], ['VERIFIED', JA_ISSUE], subject.cause);
  const value = await goalPlan(), out = project(value, subject, { englishAuxiliary: AUX }), english = project(value, await snapshotOf());
  assert.equal(out.status, 'ELIGIBLE');
  const input = wireInput(out);
  assert.deepEqual([input.subject.content, input.subject.revision, input.subject.evaluationSpan, input.subject.englishAuxiliary],
    [JA_BODY, planned.receipt.observed.subjectRevision, { startByte: 0, endByte: Buffer.byteLength(JA_BODY) }, AUX]);
  for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], english[key], key);
  assert.deepEqual([out.fidelity.renderingVerdict, out.emittable, out.postingAuthorized], ['UNREVIEWED', false, false]);
  assert.throws(() => project(value, subject, { englishAuxiliary: AUX, fidelity: faithful(out) }), /FIDELITY_RECORD_MISMATCH/, 'a check-only record cannot stand in for renderingVerdict');
  const admitted = await admitIssueCommand(admissionInput(out.envelope, JA_ISSUE, 4300), SETTINGS);
  assert.deepEqual([admitted.status, admitted.identity?.observation, admitted.identity?.subjectRevision],
    ['ADMITTED', PROVIDED_COMMAND_OBSERVATION, planned.receipt.observed.subjectRevision], admitted.cause);
  // A later executor read with a changed body, or with the same body after an edit and a revert (new edit count), refuses.
  for (const later of [issue(JA_BODY + ' Edited.'), issue(JA_BODY, { ...EDITS, userContentEditsTotal: EDITS.userContentEditsTotal + 1 })]) {
    assert.equal((await admitIssueCommand(admissionInput(out.envelope, later, 4301), SETTINGS)).status, 'NOT_ADMITTED');
  }
  // A tampered rendering hash refuses too. Only the status is asserted: L1's hash check and Core v14's auxiliary() both catch it.
  const tampered = JSON.parse(out.envelope.slice(out.envelope.indexOf('\n') + 1));
  tampered.cases[0].input.subject.englishAuxiliary.sourceSha256 = '0'.repeat(64);
  const tamperedEnvelope = out.envelope.slice(0, out.envelope.indexOf('\n') + 1) + JSON.stringify(tampered);
  assert.equal((await admitIssueCommand(admissionInput(tamperedEnvelope, JA_ISSUE, 4302), SETTINGS)).status, 'NOT_ADMITTED');
});
