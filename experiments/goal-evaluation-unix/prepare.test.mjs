// Network-free checks for prepare.mjs. Every reader here is a test double; nothing here is an actual acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RESULT_PREFIX, admitIssueCommand, PROVIDED_COMMAND_OBSERVATION } from '../../packages/jev-review/github-comment.mjs';
import { plan } from './core.mjs';
import { acquire, executorIdentitySnapshot, project } from './prepare.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const repoFile = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
// The reviewed shipped settings, read unchanged, serve only as the admission oracle for this synthetic case.
const SETTINGS = JSON.parse(repoFile('packages/jev-review/issue-actions.json'));
const REPO = 'roccho-org/ops', NUMBER = 522, SHA = 'a'.repeat(40), NODE = 'PR_test522';
const TARGET = { repository: REPO, number: NUMBER };
const BODY = 'Adds a retry for the delivery job. The job records each attempt and reads back the final destination state.';
const GOAL = { ref: 'test:goal@1', content: 'Deliver each notification exactly once and confirm the actual destination state after delivery.' };
const EDITS = { lastEditedAt: '2026-10-14T00:00:00Z', includesCreatedEdit: false, userContentEditsTotal: 2 };
const issue = (body = BODY, edits = EDITS) => ({ number: NUMBER, nodeId: NODE, body, ...edits });
const RUN = { id: 77, number: 50, attempt: 1, workflowId: 377399991, path: '.github/workflows/jev-issue-comment.yml' };
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
  const page = pages[url]; if (page instanceof Error) throw page; return page ?? { status: 404, text: 'missing' }; } });
const URLS = { pr: 'https://api.github.com/repos/roccho-org/ops/pulls/522', comments: 'https://api.github.com/repos/roccho-org/ops/issues/522/comments' };
const receipts = async ({ comments = [resultComment()], body = BODY, mode, prPage, commentsPage } = {}) => {
  const r = reader({ [URLS.pr]: prPage ?? { status: 200, text: prJson(body) }, [URLS.comments]: commentsPage ?? { status: 200, text: JSON.stringify(comments) } }, mode);
  const clock = () => '2026-10-15T00:00:00.000Z';
  return { pullRequestReceipt: await acquire({ ref: 'target', url: URLS.pr }, r, clock), commentsReceipt: await acquire({ ref: 'results', url: URLS.comments }, r, clock) };
};
const snapshotOf = async (options, expected = EXPECTED) => executorIdentitySnapshot({ ...(await receipts(options)), target: TARGET, expected });

const rubric = (n = '') => ({ problem: `The target misses the delivery obligation${n}.`, ok: `The target meets the delivery obligation${n}.`, unknown: 'The target text cannot establish it.' });
const clauses = [{ id: 'g-once', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' },
  { id: 'g-confirm', kind: 'obligation', ref: GOAL.ref, quote: 'confirm the actual destination state after delivery' }];
const question = (id, extra = {}) => ({ id, core: null, question: `Does the change satisfy obligation ${id}?`, criteria: rubric(), clauseIds: ['g-once'],
  basisRefs: [GOAL.ref, 'target'], requiredRefs: ['target'], needs: [], ...extra });
const goalPlan = async (questions = [question('q1'), question('q2', { clauseIds: ['g-confirm'] })], goal = GOAL, quoted = clauses, options = {}) =>
  plan({ goal, observations: [{ ref: 'target', content: BODY }] }, { propose: async () => ({ clauses: quoted, questions, missing: [] }), ...options });

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

test('a non-OK receipt holds: no snapshot, no projection, no envelope (N2)', async () => {
  for (const [options, cause] of [[{ prPage: { status: 403, text: '' } }, 'INPUT_UNKNOWN'], [{ commentsPage: { status: 404, text: '' } }, 'INPUT_NOT_FOUND'],
    [{ prPage: new Error('timeout') }, 'INPUT_UNKNOWN']]) {
    const subject = await snapshotOf(options);
    assert.deepEqual([subject.status, subject.cause, subject.emittable], ['HOLD', cause, false]);
    const out = project(await goalPlan(), subject, { repository: REPO });
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'envelope')], ['HOLD', cause, false]);
  }
});

test('the executor identity yields the complete revision snapshot, never guessed edit metadata (N1)', async () => {
  const subject = await snapshotOf();
  assert.equal(subject.status, 'VERIFIED');
  assert.deepEqual(subject.snapshot, issue());
  assert.deepEqual(subject.origin, { resultCommentId: 900, requestDigest: literal.requestDigest, runId: RUN.id, commandCommentId: EXPECTED.commandCommentId });
  assert.equal(subject.emittable, false, 'test-double readers never make a snapshot emittable');
  assert.equal((await snapshotOf({ mode: 'live' })).emittable, true, 'only caller-declared live readers; still not evidence of an actual acquisition');
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
});

test('projection is faithful problem->true / ok->false, keeps unknown unlowered and is admitted by existing admission', async () => {
  const subject = await snapshotOf();
  const value = await goalPlan();
  const out = project(value, subject, { repository: REPO });
  assert.equal(out.status, 'ELIGIBLE'); assert.equal(out.emittable, false); assert.equal(out.postingAuthorized, false); assert.equal(out.fidelity, 'UNREVIEWED');
  assert.deepEqual(out.checks[0].predicate, { question: value.questions[0].question, true: rubric().problem, false: rubric().ok });
  assert.deepEqual(out.mapping[0].notLowered, { unknown: rubric().unknown });
  assert.deepEqual(out.mapping.map(m => m.clauses.map(c => c.id)), [['g-once'], ['g-confirm']]);
  assert.equal(out.envelopeSha256, sha256(out.envelope));
  const admitted = await admitIssueCommand(admissionInput(out.envelope, issue(), 4300), SETTINGS);
  assert.equal(admitted.status, 'ADMITTED', admitted.cause);
  assert.equal(admitted.identity.observation, PROVIDED_COMMAND_OBSERVATION);
  assert.equal(admitted.identity.subjectRevision, literal.identity.subjectRevision);
  // If the target was edited after the old-literal run, the executor's own snapshot differs and admission refuses.
  for (const later of [issue(BODY, { ...EDITS, userContentEditsTotal: 3 }), issue(BODY + ' Edited.', EDITS)]) {
    assert.equal((await admitIssueCommand(admissionInput(out.envelope, later, 4301), SETTINGS)).status, 'NOT_ADMITTED');
  }
});

test('needs, limits, missing obligations and unverified subjects are recorded, never silently projected', async () => {
  const subject = await snapshotOf();
  const many = Array.from({ length: 8 }, (_, i) => question('q' + i, i === 0 ? { needs: ['destination log'] } : {}));
  const out = project(await goalPlan(many, GOAL, clauses, { maxQuestions: 8 }), subject, { repository: REPO, maxQuestions: 8 });
  assert.equal(out.checks.length, 6);
  assert.deepEqual(out.notProjected, [{ id: 'q0', reason: 'INCOMPLETE', needs: ['destination log'] }, { id: 'q7', reason: 'LIMIT' }]);
  const onlyNeeds = project(await goalPlan([question('q1', { needs: ['destination log'] })]), subject, { repository: REPO });
  assert.deepEqual([onlyNeeds.status, onlyNeeds.cause, onlyNeeds.notProjected.length, Object.hasOwn(onlyNeeds, 'envelope')], ['HOLD', 'NOTHING_PROJECTED', 1, false]);
  const unclear = project(await goalPlan([], GOAL, []), subject, { repository: REPO });
  assert.deepEqual([unclear.status, unclear.cause], ['HOLD', 'NEED_CLARIFICATION']);
  const unverified = project(await goalPlan(), { status: 'VERIFIED_BY_LABEL', snapshot: issue(), emittable: true }, { repository: REPO });
  assert.deepEqual([unverified.status, unverified.emittable, Object.hasOwn(unverified, 'envelope')], ['HOLD', false, false]);
});

test('CJK anywhere in the case makes the whole case unsupported, without translation', async () => {
  const subject = await snapshotOf();
  const ja = { ref: GOAL.ref, content: '通知を一度だけ届けたい。Deliver each notification exactly once.' };
  const jaClauses = [{ id: 'g-once', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' }];
  for (const value of [await goalPlan([question('q1')], ja, jaClauses), await goalPlan([question('q1', { question: '一度だけ届くか？' })])]) {
    const out = project(value, subject, { repository: REPO });
    assert.deepEqual([out.status, out.emittable, Object.hasOwn(out, 'envelope')], ['UNSUPPORTED_CJK', false, false]);
  }
  const jaBody = '再送を追加する。';
  const jaSubject = await snapshotOf({ body: jaBody, comments: [resultComment({ ...literal.identity,
    subjectRevision: literal.identity.subjectRevision.replace(sha256(BODY), sha256(jaBody)) })] });
  assert.equal(jaSubject.status, 'VERIFIED');
  assert.equal(project(await goalPlan(), jaSubject, { repository: REPO }).status, 'UNSUPPORTED_CJK');
});
