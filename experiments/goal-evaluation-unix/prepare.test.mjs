import { historicalActionsConfig } from '../../packages/jev-review/tests/historical-actions-config.mjs';
// Network-free checks for prepare.mjs. Every reader here is a test double; nothing here is an actual acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RESULT_PREFIX, REQUEST_PREFIX, parseResultComment, admitIssueCommand, PROVIDED_COMMAND_OBSERVATION, subjectRevision } from '../../packages/jev-review/github-comment.mjs';
import { semlint } from '../../packages/jev-review/semlint.mjs';
import { preparePlan, executeOwnerPlan } from '../../packages/jev-review/semlint-entry.mjs';
import { validateJevBudget, JEV_MODEL } from '../../packages/jev-review/core.mjs';
import { planIssueCommand, postIssueCommand, PULL_REQUEST_QUERY, ISSUE_QUERY, SUBJECT_QUERY, COMMENT_QUERY, CLAIM, EXECUTOR_LOGIN } from '../../packages/jev-review/issue-executor.mjs';
import { plan } from './core.mjs';
import { acquire, executorIdentitySnapshot, project as projectPlan, expectedOrigin, fidelityFromReview, refusalOrigin, budgetRefusalOrigin, refusalIdentitySnapshot,
  issueSubjectIdentitySnapshot, issueRefusalOrigin, issueRefusalSubjectSnapshot } from './prepare.mjs';

// Every fixture plan here supplies the evaluated subject text as the observation 'target' and declares it, as a caller
// must. Tests of the declaration itself call projectPlan directly.
const project = (value, subject, options = {}) => projectPlan(value, subject, { subjectRef: 'target', ...options });

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const repoFile = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
// The reviewed shipped settings, read unchanged, serve only as the admission oracle for this synthetic case.
// These historical PR536 fixtures keep the settings under which their bytes were recorded.
const SETTINGS = (() => {
  const raw = historicalActionsConfig(JSON.parse(repoFile('packages/jev-review/issue-actions.json')));
  const origin = raw.targets.find((t) => t.repository === 'roccho-org/ops' && t.issue === 573);
  origin.issue = 483;
  delete origin.subject;
  raw.runRanges = raw.runRanges.filter((r) => r.target?.issue !== 573);
  raw.providedRequestTargets = [{ repository: 'roccho-org/ops', repositoryId: '1275606595', pullRequest: 536 }];
  return raw;
})();
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
// `body` is the subject text the plan was built on; it must be the text later evaluated.
const goalPlan = async (questions = [question('q1'), question('q2', { clauseIds: ['g-confirm'] })], goal = GOAL, quoted = clauses, options = {}, body = BODY) =>
  plan({ goal, observations: [{ ref: 'target', content: body }] }, { propose: async () => ({ clauses: quoted, questions, missing: [] }), ...options });
const faithful = out => ({ reviewRef: 'test:r-fidelity-record', envelopeSha256: out.envelopeSha256,
  verdicts: Object.fromEntries(out.checks.map(c => [c.id, 'FAITHFUL'])) });

const cliTemp = () => mkdtempSync(join(realpathSync(tmpdir()), 'semlint-prepare-cli-'));
const runPrepareCLI = (input, output) => spawnSync(process.execPath,
  [fileURLToPath(new URL('./prepare.mjs', import.meta.url)), input, output],
  { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4194304, timeout: 15000 });

test('local preparation CLI preserves the full projection and exact optional command without granting posting', async () => {
  const directory = cliTemp(), value = await goalPlan(), subject = await snapshotOf({ mode: 'live' });
  const options = { subjectRef: 'target' }, reviewed = { ...options, fidelity: faithful(projectPlan(value, subject, options)) };
  const needs = await goalPlan([question('q1', { needs: ['destination observation'] })]);
  for (const [name, candidate, selection, emittable, nextAction, suppliedSubject = subject] of [
    ['defaults', value, undefined, false, 'REVIEW_INPUT'], ['unreviewed', value, options, false, 'REVIEW_PROJECTION'],
    ['reviewed', value, reviewed, true, 'REQUIRE_EXPLICIT_GO'], ['needs', needs, options, false, 'REVIEW_INPUT'],
    ['reviewed-double', value, reviewed, false, 'REVIEW_PROJECTION', { ...subject, readerDeclaredLive: false }],
    ['private-cause', value, options, false, 'REVIEW_INPUT', { status: 'HOLD', cause: { private: 'PRIVATE_CAUSE'.repeat(2048) } }],
  ]) {
    const input = join(directory, name + '.json'), output = join(directory, name);
    writeFileSync(input, JSON.stringify({ plan: candidate, subject: suppliedSubject, options: selection }), { flag: 'wx' });
    const expected = projectPlan(candidate, suppliedSubject, selection), execution = runPrepareCLI(input, output);
    assert.equal(execution.status, 0, execution.stderr.toString());
    assert.equal(execution.stderr.length, 0);
    const metadata = JSON.parse(execution.stdout);
    assert.equal(metadata.postingAuthorized, false);
    assert.equal(metadata.emittable, emittable);
    assert.equal(metadata.nextAction, nextAction);
    assert.equal(Object.hasOwn(metadata, 'cause'), false, 'unverified causes stay in the private artifact');
    assert.equal(execution.stdout.includes(Buffer.from('PRIVATE_CAUSE')), false);
    assert.ok(execution.stdout.length < 2048, 'readiness metadata stays bounded');
    const artifact = readFileSync(join(output, 'projection.json'));
    assert.equal(artifact.toString('utf8'), JSON.stringify(expected) + '\n', 'full artifact bytes stay unchanged');
    assert.deepEqual(JSON.parse(artifact), expected, 'needs, withheld fields and fidelity remain available');
    assert.equal(existsSync(join(output, 'command.txt')), emittable);
    if (emittable) assert.equal(readFileSync(join(output, 'command.txt'), 'utf8'), expected.envelope, 'no added newline or serialization');
    const command = emittable ? readFileSync(join(output, 'command.txt')) : null;
    const duplicate = runPrepareCLI(input, output);
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stdout.length, 0);
    assert.equal(JSON.parse(duplicate.stderr).code, 'EEXIST');
    assert.deepEqual(readFileSync(join(output, 'projection.json')), artifact);
    if (command) assert.deepEqual(readFileSync(join(output, 'command.txt')), command);
  }
});

test('local preparation CLI rejects invalid input without leaking its body or creating output', () => {
  const directory = cliTemp(), secret = 'PRIVATE_INPUT_SENTINEL';
  for (const [index, body] of [
    '{"plan":"' + secret,
    JSON.stringify({ plan: null, subject: null, options: {}, extra: secret }),
    JSON.stringify({ plan: null, subject: secret, options: null }),
    JSON.stringify({ plan: null, subject: secret, options: {} }),
  ].entries()) {
    const input = join(directory, index + '.json'), output = join(directory, 'output-' + index);
    writeFileSync(input, body, { flag: 'wx' });
    const execution = runPrepareCLI(input, output);
    assert.equal(execution.status, 1);
    assert.equal(execution.stdout.length, 0);
    assert.deepEqual(JSON.parse(execution.stderr), { status: 'ERROR', cause: 'PREPARATION_FAILED', code: 'INVALID_INPUT' });
    assert.equal(execution.stderr.includes(Buffer.from(secret)), false);
    assert.equal(existsSync(output), false);
  }
});

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

test('the wire statement is the plan problem criterion itself, so true=problem without a question about a question (C2, W3)', async () => {
  const value = await goalPlan();
  const out = project(value, await snapshotOf());
  assert.equal(out.status, 'ELIGIBLE');
  const [check] = out.checks, original = value.questions[0].question;
  assert.equal(check.predicate.question, rubric().problem, 'one affirmative problem sentence is sent as the statement');
  assert.equal(check.predicate.question.includes('Original question'), false);
  assert.equal(check.predicate.question.includes(original), false, 'the ok-phrased plan question stays local');
  assert.deepEqual([check.predicate.true, check.predicate.false], [rubric().problem, rubric().ok]);
  assert.deepEqual(out.mapping[0].notLowered, { unknown: rubric().unknown });
  assert.equal(out.mapping[0].originalQuestion, original);
});

// Each row names one sentence that a fixed rule must refuse. The rules are a necessary filter only; R reviews meaning
// (indirection, agreement of statement and criteria) before sealing.
const REFUSED_STATEMENTS = [
  ['SENTENCE_COUNT', 'The target retries. The target logs.'],
  ['SENTENCE_COUNT', 'The target retries'],
  ['SENTENCE_COUNT', 'Does the target retry?'],
  ['SENTENCE_COUNT', 'The target retries.\nIt logs.'],
  ['COORDINATION', 'The target retries and logs.'],
  ['COORDINATION', 'The target retries or logs.'],
  ['COORDINATION', 'The target retries but drops the state.'],
  ['COORDINATION', 'The target retries, logs, drops the state.'],
  ['CONDITION', 'The target retries unless the job ends.'],
  ['CONDITION', 'The target retries if the job ends.'],
  ['CONDITION', 'The target retries except at night.'],
  ['CONDITION', 'The target retries rather than reading back.'],
  ['PUNCTUATION', 'The target retries; it logs.'],
  ['PUNCTUATION', 'The target retries: twice.'],
  ['PUNCTUATION', 'The target retries/logs.'],
  ['NEGATION', 'The target does not retry.'],
  ['NEGATION', "The target doesn't retry."],
  ['NEGATION', 'The target doesn’t retry.'],
  ['NEGATION', 'The target has no retry.'],
  ['NEGATION', 'The target never retries.'],
  ['NEGATION', 'The target retries without a read-back.'],
  ['NEGATION', 'The target is free of retries.'],
  ['NEGATION', 'The target omits the read-back.'],
  ['NEGATION', 'The target fails to read back.'],
  ['NEGATION', 'The read-back is missing.'],
  ['NEGATION', 'The target lacks a read-back.'],
  ['NEGATION', 'Neither path reads back.'],
  ['NEGATION', 'The read-back is absent.'],
  ['NEGATION', 'The target excludes the read-back.'],
  ['NEGATIVE_PREFIX', 'The read-back is unverified.'],
  ['NEGATIVE_PREFIX', 'The delivery state is unknown.'],
  ['NEGATIVE_PREFIX', 'The read-back is incomplete.'],
  ['NEGATIVE_PREFIX', 'The destination is invalid.'],
  ['NEGATIVE_PREFIX', 'The record is nonexistent.'],
  ['NEGATIVE_PREFIX', 'The record is non-compliant.'],
  ['NEGATIVE_PREFIX', 'None of the attempts read back.'],
  ['CJK', '二回届く。'],
  ['CJK', 'The target sends 二回.'],
  // R's W3 readback bypasses (roccho-org/ops#636): each returned [] on 49fb4ff6.
  ['NEGATION', 'The target cannot retry.'],
  ['COORDINATION', 'The target retries & logs.'],
  ['NON_ASCII', 'The target retries， logs.'],
  ['COORDINATION', 'The target retries， logs.'],
  ['NON_ASCII', 'The target retries； it logs.'],
  ['PUNCTUATION', 'The target retries； it logs.'],
  ['NON_ASCII', 'The target retries a​nd logs.'],
  ['NON_ASCII', 'The target does nоt retry.'],
  ['NON_ASCII', 'The target retries — it logs.'],
  ['NON_ASCII', 'The target retries\tlater.'],
];
const ALLOWED_STATEMENTS = ['The target misses the delivery obligation.', 'The target meets the delivery obligation.',
  'The target waits 2.5 seconds between attempts.', 'The target names a cache e.g. the delivery store.',
  'The target records each attempt in a log i.e. the audit table.', 'The target delivers a notification twice.'];

test('W3 fixed statement rules refuse every listed bypass and accept plain affirmative sentences', async () => {
  const prepare = await import('./prepare.mjs');
  assert.equal(typeof prepare.statementViolations, 'function');
  for (const [rule, sentence] of REFUSED_STATEMENTS) assert.ok(prepare.statementViolations(sentence).includes(rule), `${rule}: ${JSON.stringify(sentence)}`);
  for (const sentence of ALLOWED_STATEMENTS) assert.deepEqual(prepare.statementViolations(sentence), [], sentence);
});

test('W3 a refused problem or ok sentence is not projected, and the refusal names the field and rules', async () => {
  for (const field of ['problem', 'ok']) {
    for (const [rule, sentence] of REFUSED_STATEMENTS.filter(([r]) => r !== 'CJK')) {
      const value = await goalPlan([question('q1', { criteria: { ...rubric(), [field]: sentence } })]);
      const out = project(value, await snapshotOf());
      assert.deepEqual([out.status, out.cause, out.checks.length], ['HOLD', 'NOTHING_PROJECTED', 0], `${field} ${rule}`);
      assert.equal(out.notProjected[0].reason, 'STATEMENT_REFUSED');
      assert.ok(out.notProjected[0].violations.some(v => v.field === field && v.rules.includes(rule)), `${field} ${rule}`);
    }
  }
  // One refused question does not drop another that passes; the unknown label never reaches the wire and is not checked.
  const mixed = project(await goalPlan([question('q1', { criteria: { ...rubric(), problem: 'The target does not retry.' } }),
    question('q2', { clauseIds: ['g-confirm'], criteria: { ...rubric(), unknown: 'The text does not say.' } })]), await snapshotOf());
  assert.deepEqual([mixed.status, mixed.checks.map(c => c.id), mixed.notProjected.map(n => n.id)], ['ELIGIBLE', ['q2'], ['q1']]);
});

test('W3 the PR629 report-acceptance criteria are refused, so that run is not continued under the new rules', async () => {
  // Exact criterion texts shown by the PR629 bot report (ops issue comment 6310719656).
  const pr629 = [
    { problem: 'A specific statement in the supplied target materially conflates a recorded observation or supplied context reference with truth, change authority, actual model use, or evaluation of a caller-local withheld question.',
      ok: 'Within the supplied target, observations, supplied references and unresolved scope are distinguished without a demonstrated material conflation. This does not independently prove runtime behavior or human comprehension.' },
    { problem: 'The supplied target demonstrates a specific missing or inconsistent question, criterion, or supplied reference that prevents identifying the evaluated request from the report itself.',
      ok: 'The report includes the question, both criteria and supplied references needed for identification; retaining full input content at the audit link is allowed. This does not prove reduced human reading effort or future dialogue.' },
  ];
  const prepare = await import('./prepare.mjs');
  for (const c of pr629) {
    assert.notDeepEqual(prepare.statementViolations(c.problem), []);
    assert.notDeepEqual(prepare.statementViolations(c.ok), []);
    const out = project(await goalPlan([question('q1', { criteria: { ...rubric(), ...c } })]), await snapshotOf());
    assert.deepEqual([out.status, out.notProjected[0].reason], ['HOLD', 'STATEMENT_REFUSED']);
  }
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
  assert.equal(out.status, 'ELIGIBLE', out.cause);
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
  assert.equal(project(await goalPlan(undefined, GOAL, clauses, {}, cjkSubject.snapshot.body), cjkSubject).status, 'UNSUPPORTED_CJK');
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
  // The plan question no longer reaches the wire (W3): like a clause quote it stays in the local mapping. A CJK problem
  // sentence is the wire statement itself and is refused before projection.
  const localQuestion = project(await goalPlan([question('q1', { question: '一度だけ届くか？' })]), subject);
  assert.equal(localQuestion.status, 'ELIGIBLE', 'the plan question stays in the local mapping');
  assert.equal(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(localQuestion.envelope), false);
  const refused = project(await goalPlan([question('q1', { criteria: { ...rubric(), problem: '二回届く。' } })]), subject);
  assert.deepEqual([refused.status, refused.cause, refused.emittable, Object.hasOwn(refused, 'envelope'), refused.notProjected[0].reason],
    ['HOLD', 'NOTHING_PROJECTED', false, false, 'STATEMENT_REFUSED']);
  const jaBody = '再送を追加する。';
  const jaSubject = await snapshotOf({ body: jaBody, comments: [resultComment({ ...literal.identity,
    subjectRevision: literal.identity.subjectRevision.replace(sha256(BODY), sha256(jaBody)) })] });
  assert.equal(jaSubject.status, 'VERIFIED');
  assert.equal(project(await goalPlan(undefined, GOAL, clauses, {}, jaBody), jaSubject).status, 'UNSUPPORTED_CJK');
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
  // An unrendered CJK subject body is the remaining UNSUPPORTED_CJK route once the plan question stays local (W3).
  const jaBody = '再送を追加する。';
  const jaSubject = await snapshotOf({ body: jaBody, comments: [resultComment({ ...literal.identity,
    subjectRevision: literal.identity.subjectRevision.replace(sha256(BODY), sha256(jaBody)) })] });
  const jaPlan = await plan({ goal: GOAL, observations: [{ ref: 'target', content: jaBody }] },
    { propose: async () => ({ clauses, questions: [question('q1')], missing: [signOff] }) });
  const outcomes = {
    ELIGIBLE: project(value, subject),
    HOLD_SUBJECT: project(value, { status: 'HOLD', cause: 'INPUT_UNKNOWN' }),
    NOTHING_PROJECTED: project(await withMissing([question('q1', { needs: ['destination log'] })]), subject),
    UNSUPPORTED_CJK: project(jaPlan, jaSubject),
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
// Restore only historical receipt metadata; current workflow admission is tested separately.
const WORKFLOW = (() => {
  let text = repoFile(WORKFLOW_PATH).replaceAll(/(ref:\s*|runtime_source=)[0-9a-f]{40}/g, `$1${SHA}`);
  const historicalMetadata = [
    ["      ((github.event.comment.body == '/jev-evaluate' &&\n      (github.event.issue.pull_request == null || github.event.issue.number == 511 || github.event.issue.number == 606 || github.event.issue.number == 629)) ||", "      (github.event.comment.body == '/jev-evaluate' ||"],
    ['# One PR budget claim across a finite ordinal window; no refill.',
      '# One projected Org slot; no Repository/Environment copy.'],
    ['# Historical grants remain; no rerun spending or automatic ordinal following.',
      '# Initial four-call history plus 200 authorized additions; no rerun spending.'],
    ['# Closed Org origins; PR629 frozen provided phase, at most one actual provider call.',
      '# Guard binds Org Ops483/envs52/PR511/PR522; runtime is published target-bound source.'],
    ["      (github.event.issue.pull_request != null && github.repository == 'roccho-org/ops' &&\n      github.event.issue.number == 629 &&",
      "      (github.event.issue.pull_request != null && github.repository == 'roccho-org/ops' &&\n      github.event.issue.number == 522 &&"],
    ["((github.repository == 'roccho-org/ops' && github.event.issue.number == 573) ||",
      "((github.repository == 'roccho-org/ops' && github.event.issue.number == 483) ||"],
    ['      (github.event.issue.number == 511 || github.event.issue.number == 606 || github.event.issue.number == 629)))',
      '      (github.event.issue.number == 511 || github.event.issue.number == 522)))'],
  ];
  for (const [current, historical] of historicalMetadata) {
    assert.equal(text.split(current).length - 1, 1);
    text = text.replace(current, historical);
  }
  assert.equal(sha256(text), '1c8e905f88e20f326c71b0c3e20230807cc60a3ef11182b7b0947989326cc6bd');
  return text;
})();
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
const budgetObserved = { issueNodeId: NODE, subjectRevision: literal.identity.subjectRevision };
const budgetRefusalLog = (extra = {}) => refusalLog([refusalLine({ cause: 'LITERAL_STATE_BUDGET_EXCEEDED', observed: budgetObserved, ...extra })]);
const budgetRefusedOf = (options = {}) => originOf({ log: budgetRefusalLog(), bind: budgetRefusalOrigin, ...options });
const refusalSnapshotOf = async ({ origin, body = JA_BODY, mode, prPage, target = TARGET } = {}) =>
  refusalIdentitySnapshot({ origin: origin ?? await refusedOf(), pullRequestReceipt: (await receipts({ body, mode, prPage })).pullRequestReceipt, target });
const AUX = { text: 'Adds a retry for the delivery job.', sourceSha256: sha256(JA_BODY) };

test('PR state-budget refusal has a separate bound kind, no evaluation authority, and exact snapshot binding', async () => {
  const origin = await budgetRefusedOf();
  assert.equal(origin.status, 'BOUND', origin.cause);
  assert.equal(origin.kind, 'literal-state-budget-refusal');
  assert.deepEqual(origin.planObservation, budgetObserved);
  assert.equal(Object.hasOwn(origin, 'expected') || Object.hasOwn(origin.origin, 'planRequestDigest'), false);
  assert.match(origin.limits[3], /not an evaluation or admission success/);
  const pr = (await receipts()).pullRequestReceipt;
  const snapshot = refusalIdentitySnapshot({ origin, pullRequestReceipt: pr, target: TARGET });
  assert.equal(snapshot.status, 'VERIFIED', snapshot.cause);
  assert.equal(snapshot.snapshot.body, BODY);
  assert.equal(snapshot.origin.kind, 'literal-state-budget-refusal');
  assert.equal((await originOf({ log: budgetRefusalLog() })).status, 'HOLD');
  assert.equal((await refusedOf({ log: budgetRefusalLog() })).status, 'HOLD');
  assert.equal((await budgetRefusedOf({ log: refusalLog() })).status, 'HOLD');
  assert.equal((await budgetRefusedOf({ log: planLog() })).status, 'HOLD');
  for (const extra of [{ cause: 'INVALID_REQUEST_OR_ADMISSION' }, { cause: 'ENTRY_PREFLIGHT_FAILED' },
    { claimed: true }, { providerCalls: 1 }, { authority: true }, { requestDigest: literal.requestDigest },
    { observed: { ...budgetObserved, body: BODY } }, { outcome: 'PLANNED' }]) {
    assert.equal((await budgetRefusedOf({ log: budgetRefusalLog(extra) })).status, 'HOLD');
  }
  const duplicate = refusalLine({ cause: 'LITERAL_STATE_BUDGET_EXCEEDED', observed: budgetObserved });
  assert.equal((await budgetRefusedOf({ log: refusalLog([duplicate, duplicate]) })).cause, 'PLAN_RECEIPT_AMBIGUOUS');
  assert.equal((await budgetRefusedOf({ log: { ...budgetRefusalLog(), sha256: '0'.repeat(64) } })).cause, 'PLAN_LOG_RECEIPT_INVALID');
  for (const observed of [{ ...budgetObserved, issueNodeId: 'PR_wrong' },
    { ...budgetObserved, subjectRevision: budgetObserved.subjectRevision + '|wrong' }]) {
    const changed = await budgetRefusedOf({ log: budgetRefusalLog({ observed }) });
    assert.equal(refusalIdentitySnapshot({ origin: changed, pullRequestReceipt: pr, target: TARGET }).status, 'HOLD');
  }
  assert.equal(refusalIdentitySnapshot({ origin: { ...origin, kind: 'PLANNED' }, pullRequestReceipt: pr, target: TARGET }).cause, 'ORIGIN_KIND_MISMATCH');
  assert.equal(refusalIdentitySnapshot({ origin, pullRequestReceipt: (await receipts({ body: BODY + ' changed' })).pullRequestReceipt, target: TARGET }).cause, 'SUBJECT_DRIFT');
});
// A plan built on the JA subject text, with the same Goal, clauses, questions, criteria and needs as goalPlan.
const jaGoalPlan = (questions, goal, quoted) => goalPlan(questions, goal, quoted, {}, JA_BODY);
const wireInput = out => JSON.parse(out.envelope.slice(out.envelope.indexOf('\n') + 1)).cases[0].input;
// W3 changed only predicate.question (the plan problem sentence replaces M's wrapper). The byte oracles below were
// recorded on unmodified M with the wrapper, so they are compared after re-applying exactly that wrapper to each check;
// any other difference from M still fails. The recorded hashes are not rewritten.
const M_WRAP = q => `Does the problem criterion hold for this target, rather than the ok criterion? Original question: ${q}`;
const wrapChecksAsM = (checks, mapping) => {
  const original = new Map(mapping.map(m => [m.id, m.originalQuestion]));
  return checks.map(c => ({ ...c, predicate: { ...c.predicate, question: M_WRAP(original.get(c.id)) } }));
};
const inputAsM = (input, mapping) => ({ ...input, checks: wrapChecksAsM(input.checks, mapping) });
const asM = out => {
  if (!Array.isArray(out.checks) || !out.checks.length) return out;
  const copy = { ...out, checks: wrapChecksAsM(out.checks, out.mapping) };
  if (typeof out.envelope === 'string') {
    const body = JSON.parse(out.envelope.slice(REQUEST_PREFIX.length));
    body.cases = body.cases.map(c => ({ ...c, input: inputAsM(c.input, out.mapping) }));
    copy.envelope = REQUEST_PREFIX + JSON.stringify(body);
    copy.envelopeSha256 = sha256(copy.envelope);
  }
  return copy;
};
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
  const subject = await refusalSnapshotOf(), value = await jaGoalPlan();
  assert.equal(project(value, subject).status, 'UNSUPPORTED_CJK', 'without a rendering a CJK subject stays unsupported');
  const out = project(value, subject, { englishAuxiliary: AUX });
  assert.equal(out.status, 'ELIGIBLE');
  const input = wireInput(out);
  assert.deepEqual(input.subject, { kind: 'log-entry', ref: `https://github.com/${REPO}/pull/${NUMBER}`, revision: OBSERVED.subjectRevision,
    scope: 'entire body of the approved pull request at the observed revision', content: JA_BODY, sha256: sha256(JA_BODY),
    evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(JA_BODY) }, englishAuxiliary: AUX });
  assert.deepEqual(input.context.map(c => [c.role, c.englishAuxiliary]), [['goal', null]]);
  assert.equal(await coreAccepts(input), true, 'Core v14 admits the rendered subject');
  // Everything the wire does not carry is the same as for an English subject planned the same way on its own text.
  const english = project(await goalPlan(), await snapshotOf());
  for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], english[key], key);
  assert.deepEqual([out.emittable, out.postingAuthorized], [false, false]);
  // A Japanese Goal stays local as ref and digest with its unquoted span, also beside a rendered subject.
  const ja = { ref: GOAL.ref, content: '通知は一度だけ届けること。Deliver each notification exactly once.' };
  const jaGoal = project(await jaGoalPlan([question('q1')], ja, [clauses[0]]), subject, { englishAuxiliary: AUX });
  assert.deepEqual([jaGoal.status, jaGoal.goal.onWire, wireInput(jaGoal).context, jaGoal.unquotedGoalText.map(s => s.text)], ['ELIGIBLE', false, [], ['通知は一度だけ届けること。']]);
});

test('an invalid or unneeded rendering holds with every record; CJK elsewhere still refuses; the order is unchanged (C1, R3)', async () => {
  const subject = await refusalSnapshotOf(), value = await jaGoalPlan(), ok = project(value, subject, { englishAuxiliary: AUX });
  for (const englishAuxiliary of [null, {}, { text: AUX.text }, { ...AUX, text: ' ' }, { ...AUX, text: '再送を追加する。' }, { ...AUX, sourceSha256: sha256(BODY) },
    { ...AUX, sourceSha256: AUX.sourceSha256.toUpperCase() }, { ...AUX, note: 'x' }, AUX.text]) {
    const out = project(value, subject, { englishAuxiliary });
    assert.deepEqual([out.status, out.cause, out.emittable, Object.hasOwn(out, 'envelope')], ['HOLD', 'AUXILIARY_INVALID', false, false], JSON.stringify(englishAuxiliary));
    for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], ok[key], key);
  }
  // An English body takes no rendering. That is Core v14's rule, shown here by Core itself: it refuses an auxiliary on a
  // unit whose selected text has no CJK and requires one on a unit whose selected text has CJK.
  const englishSubject = await snapshotOf(), englishValue = await goalPlan(), bound = { text: 'Adds a retry.', sourceSha256: sha256(BODY) };
  const unneeded = project(englishValue, englishSubject, { englishAuxiliary: bound });
  assert.deepEqual([unneeded.status, unneeded.cause, Object.hasOwn(unneeded, 'envelope'), unneeded.unprojectedClauses], ['HOLD', 'RENDERING_NOT_NEEDED', false, ok.unprojectedClauses]);
  const plain = wireInput(project(englishValue, englishSubject)), rendered = wireInput(ok);
  assert.deepEqual([await coreAccepts(plain), await coreAccepts({ ...plain, subject: { ...plain.subject, englishAuxiliary: bound } }),
    await coreAccepts({ ...rendered, subject: { ...rendered.subject, englishAuxiliary: null } })], [true, false, false]);
  // CJK outside the original subject content never reaches the wire: a CJK plan question stays local (W3), and a CJK
  // problem sentence, being the wire statement, is refused before projection.
  const localQuestion = project(await jaGoalPlan([question('q1', { question: '一度だけ届くか？' })]), subject, { englishAuxiliary: AUX });
  assert.equal(localQuestion.status, 'ELIGIBLE');
  assert.equal(JSON.stringify(wireInput(localQuestion).checks).includes('一度だけ'), false);
  const refused = project(await jaGoalPlan([question('q1', { criteria: { ...rubric(), problem: '二回届く。' } })]), subject, { englishAuxiliary: AUX });
  assert.deepEqual([refused.status, refused.cause, refused.emittable, Object.hasOwn(refused, 'envelope'), refused.notProjected[0].reason],
    ['HOLD', 'NOTHING_PROJECTED', false, false, 'STATEMENT_REFUSED']);
  // No obligation, then no Core check, conclude before any subject or rendering is inspected; a check still waits for the subject.
  for (const englishAuxiliary of [AUX, null, 'anything']) {
    assert.equal(project(await goalPlan([], GOAL, []), undefined, { englishAuxiliary }).cause, 'NEED_CLARIFICATION');
    assert.equal(project(await goalPlan([question('q1', { needs: ['destination log'] })]), undefined, { englishAuxiliary }).cause, 'NOTHING_PROJECTED');
    assert.equal(project(value, { status: 'HOLD', cause: 'INPUT_UNKNOWN' }, { englishAuxiliary }).cause, 'INPUT_UNKNOWN');
  }
});

test('with a rendering, emitting also needs R\'s separate renderingVerdict FAITHFUL in a v2 record; without one, v2 is refused (C1)', async () => {
  const live = await refusalSnapshotOf({ origin: await refusedOf({ mode: 'live' }), mode: 'live' }), value = await jaGoalPlan();
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
  const plainLive = await snapshotOf({ mode: 'live' }), plainValue = await goalPlan(), plain = project(plainValue, plainLive);
  assert.throws(() => project(plainValue, plainLive, { fidelity: { ...faithful(plain), renderingVerdict: 'FAITHFUL' } }), /FIDELITY_RECORD_MISMATCH/);
  assert.equal(project(plainValue, plainLive, { fidelity: faithful(plain) }).emittable, true);
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
  const value = await jaGoalPlan([question('subject.englishAuxiliary'), question('q2', { clauseIds: ['g-confirm'] })]);
  const out = project(value, live, { englishAuxiliary: AUX });
  assert.equal(out.status, 'ELIGIBLE', out.cause);
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
  const value = await jaGoalPlan(), out = project(value, subject, { englishAuxiliary: AUX }), english = project(await goalPlan(), await snapshotOf());
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

// Declared-support carriage. The wire carries the subject text and, when CJK-free, the Goal; no other observation.
// These are the plans of the witness recorded on unmodified M da100ed3 (W 5541128091, summary 038a0dd1). M's project()
// had no subjectRef; the M hashes below were captured with that old call and are the byte oracle for unaffected plans.
const K1 = 'Runbook K1: a delivery counts as confirmed only after the destination API returns the stored record id.';
const W_RUBRIC = { problem: 'The target misses the obligation.', ok: 'The target meets the obligation.', unknown: 'The text cannot establish it.' };
const G1 = { id: 'g1', kind: 'obligation', ref: GOAL.ref, quote: 'Deliver each notification exactly once' };
const wq = (id, requiredRefs, extra = {}) => ({ id, core: null, question: `Does the change satisfy obligation ${id}?`, criteria: W_RUBRIC,
  clauseIds: ['g1'], basisRefs: [GOAL.ref, ...requiredRefs], requiredRefs, needs: [], ...extra });
const witnessPlan = (questions, { goal = GOAL, quoted = [G1], ...options } = {}) =>
  plan({ goal, observations: [{ ref: 'target', content: BODY }, { ref: 'k1', content: K1 }] }, { propose: async () => ({ clauses: quoted, questions, missing: [] }), ...options });
const WITNESS_SUBJECT = { status: 'VERIFIED', target: TARGET, readerDeclaredLive: false,
  snapshot: { number: NUMBER, nodeId: NODE, body: BODY, lastEditedAt: null, includesCreatedEdit: false, userContentEditsTotal: 0 } };
const outputSha256 = out => sha256(JSON.stringify(out));
const M_OUTPUTS = {
  noRef: { output: 'fa01d53859a1452c3cf323499cd8ab58b3f58ac3d7c486009fe0945bd23ca5af', envelope: '7882593108809afadaaa543f1a10f77ef79955ac564bc68f1dabc008fb8cc1ab' },
  subjectOnly: { output: '4317440903a67223e4b77af92ff57f91caef8d70f2309e30ea93b5bdffd9679a', envelope: '9ce093591df11158002d6634f1d761afac0943ee113f93f2cae8aca9c9ec78a3' },
  allNeeds: { output: '1b41ca9dc13af08e8820d8067fa8cd9297b3e774816d747c45aca9583e0d094a' },
  // The old bug: these outputs put K-dependent checks on the wire without K.
  mixed: { output: '71f21e2ec9e0c714d24e4f81646c892c0d787e1e8a7d88779a9c71486fe9441c', envelope: '7796bcd47b09a00a6dec6c6b49dbec13d143bd287d342e640578e218b0d0acfa' },
  allK: { output: 'a699ee22f0355691d2efe778dafaab9420dcfb3ecf232fe1a82c52ee25b7b63b', envelope: '9285a73ca16d9f1e67253a6a4a5394ac9180d6b24eeb5cbf92882def16d685ff' },
};
const withheld = (id, requiredRefs, notCarried, clauseIds = ['g1']) => ({ id, reason: 'REQUIRED_CONTEXT_NOT_CARRIED', requiredRefs, notCarried, clauseIds });

test('plans that need only the subject text keep the bytes recorded on unmodified M (declared-support controls)', async () => {
  const noRef = await witnessPlan([wq('q0', [])]), subjectOnly = await witnessPlan([wq('qS', ['target'])]);
  const allNeeds = await witnessPlan([wq('qN', ['target'], { needs: ['destination API record id'] })]);
  for (const options of [{}, { subjectRef: 'target' }]) {
    const out = asM(projectPlan(noRef, WITNESS_SUBJECT, options));
    assert.deepEqual([outputSha256(out), out.envelopeSha256], [M_OUTPUTS.noRef.output, M_OUTPUTS.noRef.envelope], JSON.stringify(options));
    for (const subject of [WITNESS_SUBJECT, undefined]) assert.equal(outputSha256(asM(projectPlan(allNeeds, subject, options))), M_OUTPUTS.allNeeds.output);
  }
  const declared = asM(projectPlan(subjectOnly, WITNESS_SUBJECT, { subjectRef: 'target' }));
  assert.deepEqual([outputSha256(declared), declared.envelopeSha256], [M_OUTPUTS.subjectOnly.output, M_OUTPUTS.subjectOnly.envelope]);
  // Migration: without the declaration nothing is known to be carried, so the same plan is withheld (fails closed).
  const undeclared = projectPlan(subjectOnly, undefined);
  assert.deepEqual([undeclared.status, undeclared.cause, undeclared.checks, undeclared.notProjected],
    ['HOLD', 'NOTHING_PROJECTED', [], [withheld('qS', ['target'], ['target'])]]);
});

test('a question requiring an observation the wire does not carry is withheld, never projected without it (declared-support gate)', async () => {
  // The M witness, now inverted: qK required k1, and M put it on the wire without k1.
  const mixed = projectPlan(await witnessPlan([wq('qS', ['target']), wq('qK', ['target', 'k1'])]), WITNESS_SUBJECT, { subjectRef: 'target' });
  assert.deepEqual([mixed.status, mixed.checks.map(c => c.id), mixed.mapping.map(m => m.id), mixed.notProjected, mixed.unprojectedClauses],
    ['ELIGIBLE', ['qS'], ['qS'], [withheld('qK', ['target', 'k1'], ['k1'])], []]);
  assert.equal(mixed.envelope.includes(K1), false);
  // A partial projection: only the subject-only check reaches the wire, so its envelope is exactly the subject-only one.
  assert.equal(asM(mixed).envelopeSha256, M_OUTPUTS.subjectOnly.envelope);
  assert.notEqual(outputSha256(mixed), M_OUTPUTS.mixed.output);
  // All-K concludes Core0 without a subject, so no paid result or command is needed to learn that nothing is carried.
  const allK = await witnessPlan([wq('qK', ['target', 'k1']), wq('qKonly', ['k1'])]);
  const early = projectPlan(allK, undefined, { subjectRef: 'target' });
  assert.deepEqual([early.status, early.cause, early.checks, early.notProjected, Object.hasOwn(early, 'envelope')],
    ['HOLD', 'NOTHING_PROJECTED', [], [withheld('qK', ['target', 'k1'], ['k1']), withheld('qKonly', ['k1'], ['k1'])], false]);
  assert.deepEqual(projectPlan(allK, WITNESS_SUBJECT, { subjectRef: 'target' }), early, 'the subject is not inspected');
  assert.notEqual(outputSha256(early), M_OUTPUTS.allK.output);
  // Every local record survives: a clause only a withheld question covered is reported with that reason.
  const g2 = { id: 'g2', kind: 'obligation', ref: GOAL.ref, quote: 'confirm the actual destination state after delivery' };
  const split = projectPlan(await witnessPlan([wq('qS', ['target']), wq('qK', ['k1'], { clauseIds: ['g2'] })], { quoted: [G1, g2] }), WITNESS_SUBJECT, { subjectRef: 'target' });
  assert.deepEqual([split.status, split.unprojectedClauses, split.unquotedGoalText.map(s => s.text), split.missing, split.goal],
    ['ELIGIBLE', [{ ...g2, reason: 'NOT_PROJECTED: qK REQUIRED_CONTEXT_NOT_CARRIED' }], ['and'], [], { ref: GOAL.ref, sha256: sha256(GOAL.content), onWire: true }]);
  // A CJK Goal keeps its own carriage rule (local ref and digest only) and the gate is the same.
  const jaGoal = { ref: 'test:goal-ja@1', content: '各通知を一度だけ配信し、配信後に宛先の実際の状態を確認する。' };
  const cjk = projectPlan(await witnessPlan([wq('qS', ['target'], { basisRefs: [jaGoal.ref, 'target'] }), wq('qK', ['target', 'k1'], { basisRefs: [jaGoal.ref, 'target', 'k1'] })],
    { goal: jaGoal, quoted: [{ ...G1, ref: jaGoal.ref, quote: '各通知を一度だけ配信し' }] }), WITNESS_SUBJECT, { subjectRef: 'target' });
  assert.deepEqual([cjk.status, cjk.checks.map(c => c.id), cjk.notProjected, cjk.goal.onWire, wireInput(cjk).context],
    ['ELIGIBLE', ['qS'], [withheld('qK', ['target', 'k1'], ['k1'])], false, []]);
});

test('needs come first, then the carriage gate, then the six-check limit; basisRefs are not a carriage declaration', async () => {
  const qs = Array.from({ length: 7 }, (_, i) => wq('qS' + i, ['target']));
  const out = projectPlan(await witnessPlan([wq('qK', ['k1']), ...qs], { maxQuestions: 8 }), WITNESS_SUBJECT, { subjectRef: 'target', maxQuestions: 8 });
  assert.deepEqual([out.checks.length, out.notProjected], [6, [withheld('qK', ['k1'], ['k1']), { id: 'qS6', reason: 'LIMIT', clauseIds: ['g1'] }]],
    'a withheld question does not use one of the six slots');
  const sixThenK = projectPlan(await witnessPlan([...qs.slice(0, 6), wq('qK', ['k1'])], { maxQuestions: 8 }), WITNESS_SUBJECT, { subjectRef: 'target', maxQuestions: 8 });
  assert.deepEqual([sixThenK.checks.length, sixThenK.notProjected], [6, [withheld('qK', ['k1'], ['k1'])]], 'after six checks a K question is still withheld, not LIMIT');
  const needy = projectPlan(await witnessPlan([wq('qK', ['k1'], { needs: ['owner sign-off'] }), wq('qS', ['target'])]), WITNESS_SUBJECT, { subjectRef: 'target' });
  assert.deepEqual(needy.notProjected, [{ id: 'qK', reason: 'INCOMPLETE', needs: ['owner sign-off'], clauseIds: ['g1'] }]);
  // Only requiredRefs are gated: K named only as a basis is not detected (a planner and R fidelity responsibility).
  const basisOnly = projectPlan(await witnessPlan([wq('qS', ['target'], { basisRefs: [GOAL.ref, 'target', 'k1'] })]), WITNESS_SUBJECT, { subjectRef: 'target' });
  assert.deepEqual([basisOnly.status, basisOnly.checks.map(c => c.id), basisOnly.notProjected], ['ELIGIBLE', ['qS'], []]);
});

test('the subject declaration is checked before any question or subject and binds the whole case to the evaluated text', async () => {
  const subjectOnly = await witnessPlan([wq('qS', ['target'])]), noRef = await witnessPlan([wq('q0', [])]);
  const needsOnly = await witnessPlan([wq('qN', ['target'], { needs: ['destination API record id'] })]);
  for (const subjectRef of [1, null, '', [], {}, GOAL.ref, 'missing', 'TARGET']) {
    for (const value of [subjectOnly, needsOnly]) assert.throws(() => projectPlan(value, undefined, { subjectRef }), /INVALID_SUBJECT_REF/, JSON.stringify(subjectRef));
  }
  // An invalid plan still fails as before, before the declaration is read.
  assert.throws(() => projectPlan({ schema: 'x' }, undefined, { subjectRef: 1 }), /INVALID_PLAN/);
  // A false declaration holds the whole case before any rendering or CJK check, also when no check requires it.
  const qKonly = await witnessPlan([wq('qKonly', ['k1'])]);
  for (const [value, subjectRef] of [[qKonly, 'k1'], [noRef, 'k1'], [subjectOnly, 'k1']]) {
    const pre = projectPlan(value, undefined, { subjectRef });
    const out = projectPlan(value, WITNESS_SUBJECT, { subjectRef });
    assert.deepEqual([out.status, out.cause, out.emittable, Object.hasOwn(out, 'envelope')],
      value === subjectOnly ? ['HOLD', 'NOTHING_PROJECTED', false, false] : ['HOLD', 'SUBJECT_OBSERVATION_MISMATCH', false, false], subjectRef);
    for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], pre[key], key);
  }
  // Text drift between the plan and the verified snapshot holds the same way; no trim, normalisation or partial match.
  for (const body of [BODY + ' Edited.', BODY + ' ', BODY.slice(0, -1)]) {
    const drifted = { ...WITNESS_SUBJECT, snapshot: { ...WITNESS_SUBJECT.snapshot, body } };
    assert.equal(projectPlan(subjectOnly, drifted, { subjectRef: 'target' }).cause, 'SUBJECT_OBSERVATION_MISMATCH', JSON.stringify(body));
  }
  // The original C1 pair (a plan built on the English BODY, evaluated against JA_BODY) is kept as the negative it is.
  const subject = await refusalSnapshotOf(), english = await goalPlan(), faithfulOut = project(await jaGoalPlan(), subject, { englishAuxiliary: AUX });
  for (const options of [{}, { englishAuxiliary: AUX }, { englishAuxiliary: {} }]) {
    const out = project(english, subject, options);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'envelope')], ['HOLD', 'SUBJECT_OBSERVATION_MISMATCH', false], JSON.stringify(options));
    for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], faithfulOut[key], key);
  }
});

// Raw wire budget. The runtime refuses a v14 input over 28000 raw bytes before any claim (semlint validateJevBudget, run by
// preparePlan in admission). This is its first check only; its second, on the model-facing state, is a residual below. W1-W3 are W's witnesses recorded on unmodified M 9c270086 with its own API before the change
// (development fixtures, not Gold): project returned ELIGIBLE for inputs the runtime could never admit.
const FILLER = 'Adds a retry for the delivery job and records each attempt before reading back the destination state. ';
const longBody = n => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);
const UNEDITED = { lastEditedAt: null, includesCreatedEdit: false, userContentEditsTotal: 0 };
const verifiedBody = body => ({ status: 'VERIFIED', target: TARGET, readerDeclaredLive: false, snapshot: issue(body, UNEDITED) });
const BUDGET_KEYS = ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal'];
const BIG = longBody(31500), W3_BODY = longBody(26818), SMALL = longBody(20000);
const M_BUDGET = {
  W1: { output: 'c95ce1f84730300f1fab10204ad9d4209d6d369894f9d92b6f3c3e5197c2f338', raw: 'ae36412373e5a831ec63fdcf110d98c8ba1797237b099988ffc7c2bdfeb7169b', rawBytes: 32735 },
  W2: { output: '7dd352e70fff830f9b73571cc35fb6f0b3a0b1ac2835e0914fc2767db6b71067', raw: '4b11b81db37fccc90485e1840a1fd4822ff9e3ef76aa8cfb8076a7592a160926', rawBytes: 33105 },
  W3: { output: 'd0195f817a114ed925ef25d51c6f1f022996428ca0283a689f85b23a51013bac', raw: '324e7f354d9eaefffa6b26022b28bf496531c56e200328f6988bbc465b21752e', rawBytes: 28423 },
  control: { output: '33dda4be1ea5a13f9c5237e2dc483b837344c26c35f66672d1733a65bd0802f9', envelope: '9322185c4417499012575b66578bd69993fa2ed8bad352ca6d92a8105b7ee00b' },
};
// The would-be wire of an oversized case: the eligible wire of a budget-valid twin (same plan questions) with only the
// subject's body-dependent fields replaced. It is checked byte-for-byte against M's recorded wire, so it is not a model.
const swapBody = (input, body) => ({ ...input, subject: { ...input.subject, revision: subjectRevision(issue(body, UNEDITED)), content: body,
  sha256: sha256(body), evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(body) } } });
const envelopeOf = input => REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'pull-request', input }] });
const preflight = input => preparePlan({ schema: 'ops.semlint.real-input.v1', cases: [{ id: 'pull-request', input }] }, { ...SETTINGS.limits, maxCases: 1, maxCalls: 1 })
  .then(() => 'PREPARED', error => error.message);
const withinBudget = input => { try { validateJevBudget(input, {}); return true; } catch { return false; } };
const heldForBudget = (out, label) => {
  assert.deepEqual([out.status, out.cause, out.emittable], ['HOLD', 'WIRE_BUDGET_EXCEEDED', false], label);
  for (const key of ['envelope', 'envelopeSha256', 'fidelity', 'postingAuthorized']) assert.equal(Object.hasOwn(out, key), false, `${label}: ${key}`);
};

test('a wire input over the runtime raw budget holds locally instead of looking eligible (W1-W3 recorded on M)', async () => {
  const w1Plan = await goalPlan([question('q1', { requiredRefs: [], basisRefs: [GOAL.ref] })], GOAL, clauses, {}, 'not the subject');
  const cases = [
    ['W1', w1Plan, projectPlan(w1Plan, verifiedBody(SMALL)), BIG, () => projectPlan(w1Plan, verifiedBody(BIG))],
    ['W2', await goalPlan(undefined, GOAL, clauses, { maxBytes: 60000 }, BIG), project(await goalPlan(undefined, GOAL, clauses, {}, SMALL), verifiedBody(SMALL)), BIG,
      async () => project(await goalPlan(undefined, GOAL, clauses, { maxBytes: 60000 }, BIG), verifiedBody(BIG), { maxBytes: 60000 })],
    ['W3', await goalPlan(undefined, GOAL, clauses, {}, W3_BODY), project(await goalPlan(undefined, GOAL, clauses, {}, SMALL), verifiedBody(SMALL)), W3_BODY,
      async () => project(await goalPlan(undefined, GOAL, clauses, {}, W3_BODY), verifiedBody(W3_BODY))],
  ];
  assert.equal(Buffer.byteLength(JSON.stringify(cases[2][1])), 28000, 'W3 is a default-limits plan at exactly the Plan cap');
  let id = 4400;
  for (const [name, value, twin, body, run] of cases) {
    assert.equal(twin.status, 'ELIGIBLE', `${name}: the budget-valid twin`);
    const wire = swapBody(wireInput(twin), body), raw = JSON.stringify(swapBody(inputAsM(wireInput(twin), twin.mapping), body));
    assert.deepEqual([sha256(raw), Buffer.byteLength(raw)], [M_BUDGET[name].raw, M_BUDGET[name].rawBytes], `${name}: the same wire M emitted`);
    // The runtime refuses it before any claim: the existing preflight and the real provided admission.
    assert.equal(withinBudget(wire), false, name);
    assert.equal(await preflight(wire), 'ENTRY_PREFLIGHT_FAILED', name);
    const admitted = await admitIssueCommand(admissionInput(envelopeOf(wire), issue(body, UNEDITED), id++), SETTINGS);
    assert.deepEqual([admitted.status, admitted.cause], ['NOT_ADMITTED', 'INVALID_REQUEST_OR_ADMISSION'], name);
    // project now holds it, with every local record and no envelope; M's ELIGIBLE output changes on purpose.
    const out = await run();
    heldForBudget(out, name);
    assert.notEqual(sha256(JSON.stringify(out)), M_BUDGET[name].output, name);
    const unverified = projectPlan(value, undefined, name === 'W1' ? {} : { subjectRef: 'target', ...(name === 'W2' ? { maxBytes: 60000 } : {}) });
    for (const key of BUDGET_KEYS) assert.deepEqual(out[key], unverified[key], `${name}: ${key}`);
  }
  // The budget-valid control keeps M's bytes and is admitted.
  const control = project(await goalPlan(undefined, GOAL, clauses, {}, SMALL), verifiedBody(SMALL));
  assert.deepEqual([sha256(JSON.stringify(asM(control))), asM(control).envelopeSha256], [M_BUDGET.control.output, M_BUDGET.control.envelope]);
  assert.equal(await preflight(wireInput(control)), 'PREPARED');
  assert.equal((await admitIssueCommand(admissionInput(control.envelope, issue(SMALL, UNEDITED), 4409), SETTINGS)).status, 'ADMITTED');
});

test('the raw boundary is the runtime\'s first check: 28000 raw UTF-8 bytes stay eligible, one more byte holds (English and rendered CJK)', async () => {
  // Fit a body so the wire is exactly 28000 bytes, then replace its last ASCII character with a 2-byte one: the same
  // JavaScript length, one more UTF-8 byte. The Goal context unit and, in the second case, the English rendering are counted.
  // PREPARED at exactly 28000 bytes holds for these few-piece fixtures only, not in general (see the residual test below).
  const fit = async (prefix, options) => {
    // The probe already has a 5-digit span end, so adding filler moves the wire size byte for byte.
    const probe = prefix + 'a'.repeat(20000), at = project(await goalPlan(undefined, GOAL, clauses, {}, probe), verifiedBody(probe), options(probe));
    assert.equal(at.status, 'ELIGIBLE', 'the probe is within budget');
    const body =prefix + 'a'.repeat(20000 + 28000 - Buffer.byteLength(JSON.stringify(wireInput(at))));
    return [body, body.slice(0, -1) + 'é'];
  };
  const english = () => ({});
  const rendered = body => ({ englishAuxiliary: { text: AUX.text, sourceSha256: sha256(body) } });
  for (const [label, prefix, options] of [['English', 'Adds a retry. ', english], ['CJK with rendering', JA_BODY, rendered]]) {
    const [fits, over] = await fit(prefix, options);
    assert.equal(fits.length, over.length);
    assert.equal(Buffer.byteLength(over), Buffer.byteLength(fits) + 1);
    const inBudget = project(await goalPlan(undefined, GOAL, clauses, {}, fits), verifiedBody(fits), options(fits));
    assert.equal(inBudget.status, 'ELIGIBLE', label);
    const wire = wireInput(inBudget);
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), 28000, label);
    assert.equal(wire.context[0].role, 'goal', label);
    assert.deepEqual([withinBudget(wire), await preflight(wire)], [true, 'PREPARED'], label);
    const overWire = swapBody(wire, over);
    if (label !== 'English') overWire.subject.englishAuxiliary = { text: AUX.text, sourceSha256: sha256(over) };
    assert.equal(Buffer.byteLength(JSON.stringify(overWire)), 28001, label);
    assert.deepEqual([withinBudget(overWire), await preflight(overWire)], [false, 'ENTRY_PREFLIGHT_FAILED'], label);
    heldForBudget(project(await goalPlan(undefined, GOAL, clauses, {}, over), verifiedBody(over), options(over)), label);
  }
});

test('residual, not closed here: a raw-valid ELIGIBLE can still be refused by the runtime\'s budget on its larger model-facing state', async () => {
  // The runtime applies the same budget again to the state it builds for the model (the subject split into pieces, with
  // per-piece indices), before any call. project only mirrors the raw check, so sentence-rich text can look eligible here.
  const sentences = n => 'Adds a retry. '.repeat(n).trimEnd();
  const eligible = async body => {
    const out = project(await goalPlan(undefined, GOAL, clauses, {}, body), verifiedBody(body));
    assert.equal(out.status, 'ELIGIBLE');
    return out;
  };
  const run = async wire => {
    const states = [];
    const result = await semlint(wire, async state => { states.push(Buffer.byteLength(JSON.stringify(state))); throw new Error('NO_CALL_IN_TEST'); });
    return { states, attempts: result.accounting.callbackAttempts, causes: result.records.map(r => r.cause) };
  };
  // 1270 sentences: the model-facing state reaches the callback and is over 8000 bytes larger than the raw input.
  const fits = wireInput(await eligible(sentences(1270))), fitsRaw = Buffer.byteLength(JSON.stringify(fits)), seen = await run(fits);
  assert.deepEqual([seen.attempts, seen.states.length], [1, 1]);
  assert.ok(seen.states[0] <= 28000 && seen.states[0] - fitsRaw > 8000, `${fitsRaw} raw, ${seen.states[0]} state`);
  // 1300 sentences: under 20000 raw bytes and ELIGIBLE here, yet refused before any call, by the preflight and admission.
  const body = sentences(1300), out = await eligible(body), wire = wireInput(out);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 20000 && withinBudget(wire));
  assert.deepEqual(await run(wire), { states: [], attempts: 0, causes: ['EVALUATION_PREFLIGHT_FAILED', 'EVALUATION_PREFLIGHT_FAILED'] });
  assert.equal(await preflight(wire), 'ENTRY_PREFLIGHT_FAILED');
  const admitted = await admitIssueCommand(admissionInput(out.envelope, issue(body, UNEDITED), 4410), SETTINGS);
  assert.deepEqual([admitted.status, admitted.cause], ['NOT_ADMITTED', 'INVALID_REQUEST_OR_ADMISSION']);
});

test('earlier outcomes keep priority over the budget, and an oversized fidelity record no longer throws', async () => {
  const big = { maxBytes: 60000 }, plan60k = body => goalPlan(undefined, GOAL, clauses, big, body);
  const jaBig = JA_BODY + 'a'.repeat(31000);
  const cases = [
    ['NEED_CLARIFICATION', project(await goalPlan([], GOAL, [], big, BIG), verifiedBody(BIG), big)],
    ['NOTHING_PROJECTED', project(await goalPlan([question('q1', { needs: ['destination log'] })], GOAL, clauses, big, BIG), verifiedBody(BIG), big)],
    ['REVISION_UNOBSERVED', project(await plan60k(BIG), undefined, big)],
    ['INPUT_UNKNOWN', project(await plan60k(BIG), { status: 'HOLD', cause: 'INPUT_UNKNOWN' }, big)],
    ['SUBJECT_OBSERVATION_MISMATCH', project(await plan60k(BIG), verifiedBody(BIG + ' Edited.'), big)],
    ['AUXILIARY_INVALID', project(await plan60k(jaBig), verifiedBody(jaBig), { ...big, englishAuxiliary: {} })],
    ['RENDERING_NOT_NEEDED', project(await plan60k(BIG), verifiedBody(BIG), { ...big, englishAuxiliary: { text: 'Adds a retry.', sourceSha256: sha256(BIG) } })],
    ['UNSUPPORTED_CJK', project(await plan60k(jaBig), verifiedBody(jaBig), big)],
  ];
  for (const [cause, out] of cases) assert.equal(out.cause ?? out.status, cause, cause);
  // A supplied fidelity record, well-formed or not, is not evaluated for an oversized input (it used to throw
  // FIDELITY_RECORD_MISMATCH after an ELIGIBLE-looking envelope). Budget-valid fidelity behaviour is tested above unchanged.
  const w3 = await goalPlan(undefined, GOAL, clauses, {}, W3_BODY);
  for (const fidelity of [{ reviewRef: 'test:r', envelopeSha256: '0'.repeat(64), verdicts: { q1: 'FAITHFUL', q2: 'FAITHFUL' } }, { reviewRef: '' }]) {
    heldForBudget(project(w3, verifiedBody(W3_BODY), { fidelity }), JSON.stringify(fidelity));
  }
});

// Selected English K context. The caller may publish chosen English observations as existing v14 context units; Core and
// the provided admission are unchanged. M_CONTEXT was recorded on unmodified M eebafb32 before the first edit, with the
// contextRefs key omitted (development fixtures, not Gold). On M any explicit contextRefs key, even undefined or [], threw
// INVALID_LIMITS, so M is never asked for a keyed output; accepting the key is the intended migration.
const K_RUNBOOK = '  Runbook: Adds a retry for the delivery job. Confirm the destination state after each send.\n';
const K_OBS = [{ ref: 'target', content: BODY }, { ref: 'k1', content: K_RUNBOOK }, { ref: 'k2', content: 'An English note no question requires.' },
  { ref: 'k3', content: 'An English note named only as basis.' }];
const kPlan = (questions, observations = K_OBS, options = {}) =>
  plan({ goal: GOAL, observations }, { propose: async () => ({ clauses, questions, missing: [] }), ...options });
const kq = (id, requiredRefs, extra = {}) => question(id, { requiredRefs, basisRefs: [GOAL.ref, ...requiredRefs], ...extra });
const CONTROL = () => kPlan([question('q1'), question('q2', { clauseIds: ['g-confirm'], basisRefs: [GOAL.ref, 'target', 'k3'] }), kq('qK', ['target', 'k1'])]);
const M_CONTEXT = { keyedError: 'INVALID_LIMITS',
  eligible: { output: '7a7ba3d77a999fec12e385074b5d3e02967ced2d846c62d2382ecc3977f33485', envelope: 'c3fae1f9daf7edad6ac52e2c8b70de86212d5b01a7ead59456712e4160218d39' },
  hold: '03336c5716afe9b3007974907d8e81673fcc98c2b98c4dd1611c6ecae35628b3' };
// The expected unit, written out here rather than taken from the code under test.
const kUnit = (ref, content) => ({ role: 'observation:' + ref, ref, revision: 'sha256:' + sha256(content), content, sha256: sha256(content),
  evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content, 'utf8') }, englishAuxiliary: null });
const withEnvelope = (input, change) => { const next = structuredClone(input); change(next); return envelopeOf(next); };

test('an explicit contextRefs key is accepted; absent, undefined, [] and refs no question requires keep M\'s key-omitted bytes', async () => {
  const value = await CONTROL();
  // k2 is required by no question and k3 is named only in basisRefs, so neither is carried and nothing new is reported.
  for (const extra of [{}, { contextRefs: undefined }, { contextRefs: [] }, { contextRefs: ['k2'] }, { contextRefs: ['k3'] }, { contextRefs: ['k2', 'k3'] }]) {
    const label = JSON.stringify(extra);
    let eligible;
    assert.doesNotThrow(() => { eligible = project(value, verifiedBody(BODY), extra); }, label);
    assert.deepEqual([sha256(JSON.stringify(asM(eligible))), asM(eligible).envelopeSha256], [M_CONTEXT.eligible.output, M_CONTEXT.eligible.envelope], label);
    assert.equal(sha256(JSON.stringify(asM(project(value, undefined, extra)))), M_CONTEXT.hold, label);
  }
  // Every other unknown option still fails as the keyed calls did on M.
  for (const extra of [{ contextRef: [] }, { contextrefs: ['k1'] }]) assert.throws(() => project(value, verifiedBody(BODY), extra), { message: M_CONTEXT.keyedError });
  // The selection is checked after the Plan and the subject declaration, before any question; names are not trimmed.
  for (const contextRefs of ['k1', null, {}, [1], [''], ['k1', 'k1'], [GOAL.ref], ['nope'], ['target'], [' k1']]) {
    assert.throws(() => project(value, verifiedBody(BODY), { contextRefs }), { message: 'INVALID_CONTEXT_REF' }, JSON.stringify(contextRefs));
  }
  assert.throws(() => projectPlan(value, verifiedBody(BODY), { subjectRef: 'nope', contextRefs: 'k1' }), { message: 'INVALID_SUBJECT_REF' });
  assert.throws(() => project({}, verifiedBody(BODY), { contextRefs: 'k1' }), error => error.message !== 'INVALID_CONTEXT_REF');
});

test('selected English K travels as one full unit per required ref with exact roles; every projected mapping records the shared context', async () => {
  const K4 = 'Delivery log format: one line per attempt.';
  const value = await kPlan([question('q0'), kq('qK', ['target', 'k4', 'k1']), kq('qK2', ['target', 'k1'], { clauseIds: ['g-confirm'] })],
    [...K_OBS, { ref: 'k4', content: K4 }]);
  const out = project(value, verifiedBody(BODY), { contextRefs: ['k1', 'k4', 'k2'] }), wire = wireInput(out);
  assert.equal(out.status, 'ELIGIBLE');
  assert.equal(Object.hasOwn(out, 'contextNotCarried'), false);
  // First projected use decides the order; k1 is needed twice but sent once; the unused k2 is not sent.
  assert.equal(wire.context[0].role, 'goal');
  assert.deepEqual(wire.context.slice(1), [kUnit('k4', K4), kUnit('k1', K_RUNBOOK)]);
  assert.deepEqual(wire.checks.map(c => [c.id, c.requiredRoles]), [['q0', []], ['qK', ['observation:k4', 'observation:k1']], ['qK2', ['observation:k1']]]);
  for (const c of wire.checks) assert.deepEqual(Object.keys(c), ['id', 'axis', 'concern', 'requiredRoles', 'crossLinks', 'predicate']);
  // Every projected check, q0 included, is evaluated next to the same context; the mapping says so as its last key.
  for (const m of out.mapping) {
    assert.equal(Object.keys(m).at(-1), 'sharedContextRefs', m.id);
    assert.deepEqual(m.sharedContextRefs, [GOAL.ref, 'k4', 'k1'], m.id);
  }
  // The real admission with the shipped settings: the full request is admitted, a missing required unit and a duplicated
  // unit are refused. Roles removed or an unused unit added are still admitted, so only the assertions above catch them.
  const admit = async (envelope, id) => { const r = await admitIssueCommand(admissionInput(envelope, issue(BODY, UNEDITED), id), SETTINGS); return r.cause ?? r.status; };
  assert.equal(await admit(out.envelope, 4501), 'ADMITTED');
  assert.equal(await admit(withEnvelope(wire, w => { w.context.splice(2, 1); }), 4502), 'PROVIDED_CONTEXT_INCOMPLETE');
  assert.equal(await admit(withEnvelope(wire, w => { w.context.push(structuredClone(w.context[2])); }), 4503), 'INVALID_REQUEST_OR_ADMISSION');
  assert.equal(await admit(withEnvelope(wire, w => { for (const c of w.checks) c.requiredRoles = []; }), 4504), 'ADMITTED');
  assert.equal(await admit(withEnvelope(wire, w => { w.context.push(kUnit('k2', K_OBS[2].content)); }), 4505), 'ADMITTED');
  // R's fidelity record must cover every check of the exact envelope, not only those that declared K.
  assert.throws(() => project(value, verifiedBody(BODY), { contextRefs: ['k1', 'k4'], fidelity: { ...faithful(out), verdicts: { qK: 'FAITHFUL', qK2: 'FAITHFUL' } } }),
    { message: 'FIDELITY_RECORD_MISMATCH' });
  assert.equal(project(value, verifiedBody(BODY), { contextRefs: ['k1', 'k4'], fidelity: faithful(out) }).fidelity.allFaithful, true);
  // The model-facing state, captured network-free: one call carries every question; q0 sees K although its record lists
  // no context, and K changes which subject pieces count as unmatched. Availability, not verified support or use.
  const capture = async input => {
    const seen = [];
    const result = await semlint(input, async (state, questions) => { seen.push({ state, questions: Object.keys(questions) }); throw new Error('NO_CALL_IN_TEST'); });
    return { seen, records: result.records };
  };
  const withK = await capture(wire), withoutK = await capture(wireInput(project(value, verifiedBody(BODY))));
  assert.deepEqual(withK.seen.map(s => s.questions), [['q0', 'q1', 'q2']]);
  assert.deepEqual(withK.seen[0].state.context.map(row => row.role), ['goal', 'observation:k4', 'observation:k1']);
  assert.deepEqual(withK.records.map(r => r.contextRefs.map(c => c.ref)), [[], ['k4', 'k1'], ['k1']]);
  assert.deepEqual([withK.seen[0].state.subject.contextUnmatchedPieces, withoutK.seen[0].state.subject.contextUnmatchedPieces], [[1], [0, 1]]);
});

test('withheld K stays local: a missing alias or CJK name/content is reported once at the top level, and notCarried keeps M\'s full list', async () => {
  const OBS = [...K_OBS, { ref: 'kja', content: '配信ジョブの再送を記録する。' }, { ref: '手順', content: 'Check the delivery log.' },
    { ref: 'kja2', content: '宛先の状態を確認する。' }, { ref: 'u1', content: 'An undeclared English note.' }];
  const questions = [kq('qN', ['target', 'kja2'], { needs: ['operator note'] }), kq('qA', ['target', 'k1']), kq('qB', ['target', 'kja']),
    kq('qC', ['target', '手順']), kq('qM', ['target', 'k1', 'u1']), kq('qB2', ['target', 'kja'], { clauseIds: ['g-confirm'] })];
  const big = { maxQuestions: 8 }, value = await kPlan(questions, OBS, big), selection = { ...big, contextRefs: ['k1', 'kja', '手順', 'kja2'] };
  const out = project(value, verifiedBody(BODY), selection), plain = project(value, verifiedBody(BODY), big);
  assert.equal(out.status, 'ELIGIBLE');
  // Needs come first (qN reports nothing about kja2); u1 was never selected; k1 was carried, so it is not reported.
  assert.deepEqual(out.contextNotCarried, [{ ref: 'kja', reason: 'CJK_CONTEXT_NOT_ADMITTED' }, { ref: '手順', reason: 'CJK_CONTEXT_NOT_ADMITTED' }]);
  assert.deepEqual(wireInput(out).context.map(row => row.ref), [GOAL.ref, 'k1']);
  // The withheld records keep M's shape and full lists, even for qM while k1 is on the wire for qA.
  const entry = (o, id) => o.notProjected.find(n => n.id === id);
  for (const id of ['qN', 'qB', 'qC', 'qM', 'qB2']) assert.deepEqual(entry(out, id), entry(plain, id), id);
  assert.deepEqual(entry(out, 'qM').notCarried, ['k1', 'u1']);
  // The same report on every returned outcome, never as an empty key.
  for (const held of [project(value, undefined, selection), project(value, verifiedBody(BODY + ' Edited.'), selection)]) {
    assert.deepEqual([held.status, held.contextNotCarried], ['HOLD', out.contextNotCarried], held.cause);
  }
  const jaValue = await kPlan([question('qA'), kq('qB', ['target', 'kja'])], [{ ref: 'target', content: JA_BODY }, OBS[4]]);
  const unsupported = project(jaValue, verifiedBody(JA_BODY), { contextRefs: ['kja'] });
  assert.deepEqual([unsupported.status, unsupported.contextNotCarried], ['UNSUPPORTED_CJK', [{ ref: 'kja', reason: 'CJK_CONTEXT_NOT_ADMITTED' }]]);
  // Without an alias nothing is carried and the missing alias is reported first, even for a CJK name. q0 stays as on M.
  const loose = await kPlan([question('q0', { requiredRefs: [], basisRefs: [GOAL.ref] }), kq('qK', ['k1']), kq('qC', ['手順'])], OBS);
  let unbound;
  assert.doesNotThrow(() => { unbound = projectPlan(loose, verifiedBody(BODY), { contextRefs: ['k1', '手順'] }); });
  const { contextNotCarried, ...rest } = unbound;
  assert.deepEqual(contextNotCarried, [{ ref: 'k1', reason: 'SUBJECT_REF_REQUIRED' }, { ref: '手順', reason: 'SUBJECT_REF_REQUIRED' }]);
  assert.deepEqual(rest, projectPlan(loose, verifiedBody(BODY)));
  // An all-needs plan concludes before any subject, with no report, no throw and M's bytes.
  const needsOnly = await kPlan([kq('qK', ['target', 'k1'], { needs: ['operator note'] })]);
  assert.deepEqual(projectPlan(needsOnly, undefined, { contextRefs: ['k1'] }), projectPlan(needsOnly, undefined));
});

test('the intended new-option deltas: LIMIT slots, carried K checks in HOLD records, and the budgets K enlarges', async () => {
  const six = [1, 2, 3, 4, 5, 6].map(n => question('q' + n)), big = { maxQuestions: 7 };
  // A carriable K question after six checks is LIMIT, not REQUIRED_CONTEXT_NOT_CARRIED; nothing about K reaches the wire.
  const late = await kPlan([...six, kq('qK', ['target', 'k1'])], K_OBS, big);
  const lateK = project(late, verifiedBody(BODY), { ...big, contextRefs: ['k1'] }), lateM = project(late, verifiedBody(BODY), big);
  assert.deepEqual([lateK.notProjected.at(-1).reason, lateM.notProjected.at(-1).reason], ['LIMIT', 'REQUIRED_CONTEXT_NOT_CARRIED']);
  assert.equal(lateK.envelope, lateM.envelope);
  // A carried K question first takes a slot, so the sixth subject-only check M projected becomes LIMIT.
  const early = await kPlan([kq('qK', ['target', 'k1']), ...six], K_OBS, big);
  const earlyK = project(early, verifiedBody(BODY), { ...big, contextRefs: ['k1'] }), earlyM = project(early, verifiedBody(BODY), big);
  assert.deepEqual([earlyK.checks.map(c => c.id), earlyM.checks.map(c => c.id)], [['qK', 'q1', 'q2', 'q3', 'q4', 'q5'], ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']]);
  assert.deepEqual(earlyK.notProjected, [{ id: 'q6', reason: 'LIMIT', clauseIds: ['g-once'] }]);
  // HOLD records before the envelope now list the carried K check, with its roles and without sharedContextRefs.
  const value = await CONTROL();
  for (const held of [project(value, undefined, { contextRefs: ['k1'] }), project(value, verifiedBody(BODY + ' Edited.'), { contextRefs: ['k1'] })]) {
    assert.deepEqual([held.status, held.checks.map(c => c.requiredRoles)], ['HOLD', [[], [], ['observation:k1']]], held.cause);
    assert.equal(held.mapping.some(m => Object.hasOwn(m, 'sharedContextRefs')), false, held.cause);
    assert.equal(Object.hasOwn(held, 'envelope'), false, held.cause);
  }
  // The one raw budget counts the full K: oversized K holds, with nothing truncated or sent.
  const huge = 'The destination log keeps one line per attempt. '.repeat(700), wide = { maxBytes: 70000 };
  const hugeValue = await kPlan([question('q0'), kq('qK', ['target', 'kBig'])], [...K_OBS, { ref: 'kBig', content: huge }], wide);
  const held = project(hugeValue, verifiedBody(BODY), { ...wide, contextRefs: ['kBig'] });
  heldForBudget(held, 'oversized K');
  assert.equal(held.mapping.some(m => Object.hasOwn(m, 'sharedContextRefs')), false);
  // Residual, not closed: K also enlarges the model-facing state. With the same raw-valid sentence-rich subject, a 5000 B K
  // is prepared and a 6500 B K is refused by the real preflight before any call; project only mirrors the raw check.
  const body = 'Adds a retry. '.repeat(1000).trimEnd();
  const residual = async length => {
    const k = 'The destination log keeps one line per delivery attempt and its final state'.repeat(Math.ceil(length / 76)).slice(0, length);
    const kValue = await kPlan([question('q0'), kq('qK', ['target', 'k1'])], [{ ref: 'target', content: body }, { ref: 'k1', content: k }]);
    const kOut = project(kValue, verifiedBody(body), { contextRefs: ['k1'] });
    assert.equal(kOut.status, 'ELIGIBLE', String(length));
    return wireInput(kOut);
  };
  const fits = await residual(5000), over = await residual(6500);
  assert.deepEqual([withinBudget(fits), await preflight(fits)], [true, 'PREPARED']);
  assert.ok(Buffer.byteLength(JSON.stringify(over)) < 23000 && withinBudget(over));
  assert.equal(await preflight(over), 'ENTRY_PREFLIGHT_FAILED');
  const attempts = (await semlint(over, async () => { throw new Error('NO_CALL_IN_TEST'); })).accounting.callbackAttempts;
  assert.equal(attempts, 0);
});

// The PR route's outputs, recorded on unmodified M f7095de4 before the first edit with these exact fixtures (development
// fixtures, not Gold). The Issue route below adds a closed variant; none of these gains a key.
test('PR snapshots, origins, projections, fidelity and admission keep the bytes recorded on unmodified M f7095de4', async () => {
  const h = x => sha256(JSON.stringify(x));
  const value = await goalPlan(), english = project(value, await snapshotOf());
  const refused = await refusedOf(), refusalSubject = await refusalSnapshotOf({ origin: refused });
  const rendered = project(await jaGoalPlan(), refusalSubject, { englishAuxiliary: AUX });
  const live = await snapshotOf({ mode: 'live' }), unreviewed = project(value, live), ids = unreviewed.checks.map(c => c.id);
  // The fidelity record and admission are not changed by W3; they are fed M's envelope (asM) to compare with M's bytes.
  const mSha = asM(unreviewed).envelopeSha256;
  const fid = fidelityFromReview({ approved: APPROVED_REVIEW, reviewReceipt: await reviewOf(reviewJson(fidelityBody(mSha,
    Object.fromEntries(ids.map(id => [id, 'FAITHFUL']))))), envelopeSha256: mSha, checkIds: ids });
  const kOut = project(await CONTROL(), verifiedBody(BODY), { contextRefs: ['k1'] });
  const admitted = await admitIssueCommand(admissionInput(asM(english).envelope, issue(), 4300), SETTINGS);
  const admittedW3 = await admitIssueCommand(admissionInput(english.envelope, issue(), 4301), SETTINGS);
  assert.deepEqual([english.status, rendered.status, admitted.status, admittedW3.status], ['ELIGIBLE', 'ELIGIBLE', 'ADMITTED', 'ADMITTED']);
  assert.deepEqual({ executorSnapshot: h(await snapshotOf()), expectedOrigin: h(await originOf()), refusalOrigin: h(refused),
    refusalSnapshot: h(refusalSubject), english: h(asM(english)), rendered: h(asM(rendered)), fidelity: h(fid), contextK: h(asM(kOut)),
    admitted: h({ status: admitted.status, identity: admitted.identity, requestDigest: admitted.requestDigest, plan: admitted.prepared.plan }) }, {
    executorSnapshot: '67c6dd446781f0a136b53b9f02e4c57cad6e54b11b312b60a685a19092bd51b8',
    expectedOrigin: '363c65ca3287a680dab0c7c512246b809475113009904f85e2f7d272c9f752fe',
    refusalOrigin: '05c2d7e92e19b0851a7cd778874cc3781d0edd60298ab122663c830c1c6cd54a',
    refusalSnapshot: '9fb5fdd526b852938794b22cd4407acf8a3b3cf127f333334e5766e2d7bad421',
    english: '3dd86aa21b3716f517b96709a3345f8d13c22eeaaf69e0fea2f76303114e8faf',
    rendered: 'a9e71937aa94e41e7d743a9a8eb4883c563213a3528966e25650dd8899e807d4',
    fidelity: '367750ac30e9509b18e97a76efd6bf51d15fc10156b7d5186394d30bec6bb797',
    contextK: '4014523fcde9062ba8112c883c2ae73523461deb7b64ab894dd880f7b20a85d9',
    admitted: '32c7e8d5d63c3f1af79f14aedd262a2774119b618b64a13d87a8636d0f56d1de' });
  for (const pr of [await snapshotOf(), refusalSubject]) assert.equal(Object.hasOwn(pr, 'subjectKind'), false);
});

// The Issue route. The invocation origin ops#483 holds the command, run, claim and result sink; a separately approved
// public subject Issue is evaluated. Fixture settings only: the shipped settings plus a subject grant, its scoped range and
// an Issue provided grant, which as the one provided grant replaces PR536's here. Nothing on disk changes.
const ORIGIN_NUMBER = 483, SUBJECT_REPO = 'fixture-user/apps', SUBJECT_NUMBER = 94, ORIGIN_NODE = 'I_test483', SUBJECT_NODE = 'I_test94';
const ORIGIN = { repository: REPO, number: ORIGIN_NUMBER }, SUBJECT = { repository: SUBJECT_REPO, repositoryId: '321', number: SUBJECT_NUMBER };
const ISSUE_SCOPE = 'entire body of the approved Issue at the observed revision';
const ORIGIN_BODY = 'Invocation origin for the delivery review. The evaluated text is the approved subject Issue, not this body.';
const ORIGIN_EDITS = { lastEditedAt: '2026-10-13T00:00:00Z', includesCreatedEdit: true, userContentEditsTotal: 1 };
const originIssue = (body = ORIGIN_BODY, edits = ORIGIN_EDITS) => ({ number: ORIGIN_NUMBER, nodeId: ORIGIN_NODE, body, ...edits });
const subjectIssue = (body = BODY, edits = EDITS) => ({ number: SUBJECT_NUMBER, nodeId: SUBJECT_NODE, body, ...edits });
const ISSUE_SETTINGS = (() => {
  const settings = structuredClone(SETTINGS), origin = settings.targets.find(t => t.repository === REPO && t.issue === ORIGIN_NUMBER);
  origin.subject = { repository: SUBJECT_REPO, repositoryId: SUBJECT.repositoryId, kind: 'issue', number: SUBJECT_NUMBER };
  settings.runRanges.push({ repository: REPO, workflowId: RUN.workflowId, path: RUN.path, first: 900, last: 900, reservedCallsPerRun: 1, target: { issue: ORIGIN_NUMBER } });
  settings.providedRequestTargets = [{ repository: REPO, repositoryId: origin.repositoryId, issue: ORIGIN_NUMBER }];
  return settings;
})();
const issueAdmissionInput = (eventBody, subject = subjectIssue(), commandId, origin = originIssue()) => ({ repository: REPO, owner: 'roccho-org', sha: SHA,
  eventBody, run: { ...RUN, number: 900 }, issue: origin, command: command(eventBody, commandId),
  context: SETTINGS.context.map(c => ({ role: c.role, path: c.path, content: repoFile(c.path) })),
  subject: { repository: SUBJECT_REPO, repositoryId: SUBJECT.repositoryId, isPrivate: false, ...subject } });
// The English literal on the Issue route, as the existing admission builds it: a passthrough whose identity names the
// origin at the top level and the evaluated subject in identity.subject.
const issueLiteral = await admitIssueCommand(issueAdmissionInput('/jev-evaluate'), ISSUE_SETTINGS);
const issueResult = (identity = issueLiteral.identity, extra = {}) => ({ id: 910, user: { login: 'github-actions[bot]' },
  body: RESULT_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-result.v1', requestDigest: issueLiteral.requestDigest, identity, authority: false, result: {}, ...extra }) + '\n' });
const ISSUE_URLS = { origin: `https://api.github.com/repos/${REPO}/issues/${ORIGIN_NUMBER}`, subject: `https://api.github.com/repos/${SUBJECT_REPO}/issues/${SUBJECT_NUMBER}`,
  comments: `https://api.github.com/repos/${REPO}/issues/${ORIGIN_NUMBER}/comments?per_page=100` };
const issueJson = (number, nodeId, body, repository, extra = {}) => JSON.stringify({ number, node_id: nodeId, body,
  repository_url: `https://api.github.com/repos/${repository}`, ...extra });
// Receipts for the comments list and both Issues. `pages` adds or replaces reader pages; `urls` chooses what each receipt reads.
const issueReceipts = async ({ comments = [issueResult()], originBody = ORIGIN_BODY, subjectBody = BODY, mode, pages = {}, urls = {} } = {}) => {
  const r = reader({ [ISSUE_URLS.origin]: { status: 200, text: issueJson(ORIGIN_NUMBER, ORIGIN_NODE, originBody, REPO) },
    [ISSUE_URLS.subject]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, subjectBody, SUBJECT_REPO) },
    [ISSUE_URLS.comments]: { status: 200, text: JSON.stringify(comments), link: '' }, ...pages }, mode);
  const clock = () => '2026-10-16T00:00:00.000Z', at = { ...ISSUE_URLS, ...urls };
  return { commentsReceipt: await acquire({ ref: 'results', url: at.comments, list: true }, r, clock),
    originIssueReceipt: await acquire({ ref: 'origin', url: at.origin }, r, clock), subjectIssueReceipt: await acquire({ ref: 'subject', url: at.subject }, r, clock) };
};
const issueSnapshotOf = async (options, { expected = EXPECTED, originTarget = ORIGIN, subjectTarget = SUBJECT } = {}) =>
  issueSubjectIdentitySnapshot({ ...(await issueReceipts(options)), originTarget, subjectTarget, expected });
const withSubject = over => ({ ...issueLiteral.identity, subject: { ...issueLiteral.identity.subject, ...over } });
// The Issue route's refusal: the #547 receipt shape with the subject's own pair as a third observed key, at run 900.
const JA_SUBJECT = subjectIssue(JA_BODY);
const ISSUE_OBSERVED = { issueNodeId: ORIGIN_NODE, subjectRevision: subjectRevision(originIssue()), subject: { nodeId: SUBJECT_NODE, revision: subjectRevision(JA_SUBJECT) } };
const ISSUE_APPROVED = { ...APPROVED, number: ORIGIN_NUMBER, runRange: { first: 900, last: 900 } };
const issueRefusalLine = (extra = {}, stage = 'plan') => refusalLine({ run: { id: RUN.id, number: 900, attempt: 1, workflowId: RUN.workflowId }, observed: ISSUE_OBSERVED, ...extra }, stage);
const issueRefusedOf = (options = {}) => originOf({ approved: ISSUE_APPROVED, command: commandJson({ issue_url: ISSUE_URLS.origin }), run: runJson({ run_number: 900 }),
  log: refusalLog([issueRefusalLine(), issueRefusalLine({}, 'post')]), bind: issueRefusalOrigin, ...options });
const issueRefusalSnapshotOf = async ({ origin, subjectBody = JA_BODY, subjectTarget = SUBJECT, ...options } = {}) => {
  const { originIssueReceipt, subjectIssueReceipt } = await issueReceipts({ subjectBody, ...options });
  return issueRefusalSubjectSnapshot({ origin: origin ?? await issueRefusedOf(), originIssueReceipt, subjectIssueReceipt, subjectTarget });
};
// A closed Issue-route snapshot for projection-only tests (projection does not re-verify its provenance).
const issueVerifiedBody = body => ({ status: 'VERIFIED', subjectKind: 'issue', originTarget: { ...ORIGIN, nodeId: ORIGIN_NODE },
  target: { repository: SUBJECT_REPO, number: SUBJECT_NUMBER }, snapshot: subjectIssue(body, UNEDITED), readerDeclaredLive: false,
  provenance: { kind: 'literal-result', originRevision: subjectRevision(originIssue()), subjectTarget: { ...SUBJECT }, origin: {}, limits: [] } });
const READER_NOTE = /not evidence that an actual read happened/;

test('Issue route, English N1: a literal result yields the closed Issue snapshot, origin and subject bound separately (S1-S5)', async () => {
  assert.equal(ISSUE_SETTINGS.subjectScope, ISSUE_SCOPE, 'the caller supports only the shipped subject scope');
  assert.deepEqual([issueLiteral.status, issueLiteral.identity.observation], ['ADMITTED', 'ACTIONS_TRUSTED_LITERAL_COMMAND'], issueLiteral.cause);
  const got = await issueSnapshotOf();
  assert.equal(got.status, 'VERIFIED', got.cause);
  assert.deepEqual(Object.keys(got), ['status', 'subjectKind', 'originTarget', 'target', 'snapshot', 'readerDeclaredLive', 'provenance']);
  assert.deepEqual([got.subjectKind, got.originTarget, got.target, got.snapshot, got.readerDeclaredLive],
    ['issue', { ...ORIGIN, nodeId: ORIGIN_NODE }, { repository: SUBJECT_REPO, number: SUBJECT_NUMBER }, subjectIssue(), false]);
  const { limits, ...provenance } = got.provenance;
  assert.deepEqual(provenance, { kind: 'literal-result', originRevision: subjectRevision(originIssue()), subjectTarget: SUBJECT,
    origin: { resultCommentId: 910, requestDigest: issueLiteral.requestDigest, runId: RUN.id, commandCommentId: EXPECTED.commandCommentId } });
  assert.deepEqual([limits.length, READER_NOTE.test(limits[0])], [1, true]);
  // The origin revision is provenance only; the evaluated snapshot is the subject's.
  assert.notEqual(got.provenance.originRevision, subjectRevision(got.snapshot));
  // readerDeclaredLive needs every used public receipt declared live; it repeats declarations, nothing more.
  const live = await issueReceipts({ mode: 'live' }), double = await issueReceipts();
  const snap = receipts => issueSubjectIdentitySnapshot({ ...receipts, originTarget: ORIGIN, subjectTarget: SUBJECT, expected: EXPECTED }).readerDeclaredLive;
  assert.deepEqual([snap(live), snap({ ...live, commentsReceipt: double.commentsReceipt }), snap({ ...live, originIssueReceipt: double.originIssueReceipt }),
    snap({ ...live, subjectIssueReceipt: double.subjectIssueReceipt })], [true, false, false, false]);
  // Bodies pass exactly as observed: leading and trailing whitespace is not trimmed.
  const padded = '  ' + BODY + '\n';
  const exactBytes = await issueSnapshotOf({ subjectBody: padded, comments: [issueResult(withSubject({ revision: subjectRevision(subjectIssue(padded)) }))] });
  assert.deepEqual([exactBytes.status, exactBytes.snapshot?.body], ['VERIFIED', padded]);
});

test('Issue route, English N1: origin-only or subject-only tampering, missing bodies, readers and targets hold (S2-S4)', async () => {
  const origin = subjectRevision(originIssue()), id = issueLiteral.identity;
  const { subject: _subject, ...withoutSubject } = id;
  const cases = [
    // Origin pair: node, digest and malformed revisions; and an edited public origin body.
    ['origin node', { comments: [issueResult({ ...id, issueNodeId: 'I_other' })] }, 'ORIGIN_IDENTITY_MISMATCH'],
    ['origin digest', { comments: [issueResult({ ...id, subjectRevision: origin.replace(sha256(ORIGIN_BODY), sha256('other')) })] }, 'ORIGIN_DRIFT'],
    ['origin revision node', { comments: [issueResult({ ...id, subjectRevision: origin.replace(ORIGIN_NODE, 'I_other') })] }, 'ORIGIN_IDENTITY_MISMATCH'],
    ['origin malformed', { comments: [issueResult({ ...id, subjectRevision: origin.replace('|1|', '|one|') })] }, 'ORIGIN_IDENTITY_MISMATCH'],
    ['origin extra part', { comments: [issueResult({ ...id, subjectRevision: origin + '|x' })] }, 'ORIGIN_IDENTITY_MISMATCH'],
    ['origin edited', { originBody: ORIGIN_BODY + ' Edited.' }, 'ORIGIN_DRIFT'],
    // Subject pair: the origin pair standing in for it, another node, an edited public subject body.
    ['origin revision as subject', { comments: [issueResult(withSubject({ revision: origin }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['origin node as subject', { comments: [issueResult(withSubject({ nodeId: ORIGIN_NODE }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['subject edited', { subjectBody: BODY + ' Edited.' }, 'SUBJECT_DRIFT'],
    // identity.subject must be the approved subject, exactly; a top-level-only (no-grant) or PR identity is refused.
    ['no identity.subject', { comments: [issueResult(withoutSubject)] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['other repository id', { comments: [issueResult(withSubject({ repositoryId: '999' }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['other number', { comments: [issueResult(withSubject({ number: 95 }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['other kind', { comments: [issueResult(withSubject({ kind: 'pull-request' }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['extra subject key', { comments: [issueResult(withSubject({ body: BODY }))] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['targetKind', { comments: [issueResult({ ...id, targetKind: 'pull-request' })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['provided observation', { comments: [issueResult({ ...id, observation: PROVIDED_COMMAND_OBSERVATION })] }, 'EXECUTOR_IDENTITY_MISMATCH'],
    // S3: a null, empty or non-text body holds, on either side; nothing is coerced.
    ...[null, '', 5].flatMap(body => [[`origin body ${JSON.stringify(body)}`, { originBody: body }, 'ORIGIN_BODY_UNOBSERVED'],
      [`subject body ${JSON.stringify(body)}`, { subjectBody: body }, 'SUBJECT_BODY_UNOBSERVED']]),
    // S3: exact canonical receipt URL and repository_url; an Issue payload with its own pull_request key is not an Issue.
    ...[`https://api.github.com/repos/x/${SUBJECT_REPO}/issues/${SUBJECT_NUMBER}`, `${ISSUE_URLS.subject}?per_page=1`, ISSUE_URLS.subject.replace('https:', 'http:'),
      `https://api.github.com/repos/${SUBJECT_REPO}/issues/0${SUBJECT_NUMBER}`].map(url => [url, { urls: { subject: url },
      pages: { [url]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, BODY, SUBJECT_REPO) } } }, 'ISSUE_MISMATCH']),
    ['fork repository_url', { pages: { [ISSUE_URLS.subject]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, BODY, SUBJECT_REPO + '-fork') } } }, 'ISSUE_MISMATCH'],
    ['other number in body', { pages: { [ISSUE_URLS.subject]: { status: 200, text: issueJson(95, SUBJECT_NODE, BODY, SUBJECT_REPO) } } }, 'ISSUE_MISMATCH'],
    ['subject is a pull request', { pages: { [ISSUE_URLS.subject]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, BODY, SUBJECT_REPO, { pull_request: { url: 'x' } }) } } }, 'NOT_AN_ISSUE'],
    ['pull_request key null', { pages: { [ISSUE_URLS.subject]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, BODY, SUBJECT_REPO, { pull_request: null }) } } }, 'NOT_AN_ISSUE'],
    ['origin is a pull request', { pages: { [ISSUE_URLS.origin]: { status: 200, text: issueJson(ORIGIN_NUMBER, ORIGIN_NODE, ORIGIN_BODY, REPO, { pull_request: {} }) } } }, 'NOT_AN_ISSUE'],
    ['subject 404', { pages: { [ISSUE_URLS.subject]: { status: 404, text: 'Not Found' } } }, 'INPUT_NOT_FOUND'],
    ['origin 403', { pages: { [ISSUE_URLS.origin]: { status: 403, text: 'rate limit' } } }, 'INPUT_UNKNOWN'],
  ];
  for (const [label, options, cause] of cases) {
    const got = await issueSnapshotOf(options);
    assert.deepEqual([got.status, got.cause, Object.hasOwn(got, 'snapshot')], ['HOLD', cause, false], label);
  }
  // S4 inputs: exact 2-field origin target and exact 3-field subject target; the caller's expected origin is required.
  for (const [targets, cause] of [[{ originTarget: { ...ORIGIN, nodeId: ORIGIN_NODE } }, 'TARGET_INVALID'], [{ subjectTarget: { repository: SUBJECT_REPO, number: SUBJECT_NUMBER } }, 'TARGET_INVALID'],
    [{ subjectTarget: { ...SUBJECT, repositoryId: 321 } }, 'TARGET_INVALID'], [{ subjectTarget: { ...SUBJECT, repositoryId: '0321' } }, 'TARGET_INVALID'],
    [{ subjectTarget: { ...SUBJECT, repositoryId: '322' } }, 'EXECUTOR_IDENTITY_MISMATCH'], [{ originTarget: { repository: 'roccho-org/envs', number: 52 } }, 'ISSUE_MISMATCH'],
    [{ expected: { ...EXPECTED, runId: undefined } }, 'EXPECTED_ORIGIN_MISSING']]) {
    assert.equal((await issueSnapshotOf({}, targets)).cause, cause, JSON.stringify(targets));
  }
  // The PR API takes no Issue receipt in place of its PR read.
  const { commentsReceipt, subjectIssueReceipt } = await issueReceipts();
  assert.equal(executorIdentitySnapshot({ commentsReceipt, pullRequestReceipt: subjectIssueReceipt, target: TARGET, expected: EXPECTED }).status, 'HOLD');
});

test('Issue route, JA N1: only the exact 3-key refusal binds, and only its subject pair becomes the snapshot (S1-S5)', async () => {
  const refused = await issueRefusedOf();
  assert.equal(refused.status, 'BOUND', refused.cause);
  assert.deepEqual([refused.kind, refused.target, refused.planObservation], ['literal-cjk-refusal-issue-subject', ORIGIN, ISSUE_OBSERVED]);
  // The same N-a bindings and origin record as the PR refusal origin, with the same limits.
  const prRefused = await refusedOf();
  assert.deepEqual([Object.keys(refused), Object.keys(refused.origin), refused.limits], [Object.keys(prRefused), Object.keys(prRefused.origin), prRefused.limits]);
  const got = await issueRefusalSnapshotOf({ origin: refused });
  assert.equal(got.status, 'VERIFIED', got.cause);
  assert.deepEqual([got.subjectKind, got.originTarget, got.target, got.snapshot, got.readerDeclaredLive],
    ['issue', { ...ORIGIN, nodeId: ORIGIN_NODE }, { repository: SUBJECT_REPO, number: SUBJECT_NUMBER }, JA_SUBJECT, false]);
  assert.deepEqual(got.provenance, { kind: 'literal-cjk-refusal-issue-subject', originRevision: ISSUE_OBSERVED.subjectRevision, subjectTarget: SUBJECT,
    origin: refused.origin, limits: [...refused.limits, got.provenance.limits.at(-1)] });
  assert.match(got.provenance.limits.at(-1), READER_NOTE);
  assert.match(got.provenance.limits.join(' '), /P-transported job log without a provider digest/);
  assert.match(got.provenance.limits.join(' '), /cannot see an edit that restores the same body/);
  // readerDeclaredLive: every public receipt on both sides; the job log never counts as live.
  const live = await issueRefusedOf({ mode: 'live' });
  assert.deepEqual([(await issueRefusalSnapshotOf({ origin: live, mode: 'live' })).readerDeclaredLive, (await issueRefusalSnapshotOf({ origin: live })).readerDeclaredLive,
    (await issueRefusalSnapshotOf({ origin: refused, mode: 'live' })).readerDeclaredLive], [true, false, false]);
  // Each route accepts only its own observation shape; echoes, duplicates, digests and a dropped observation hold.
  const { subject: _subject, ...twoKeys } = ISSUE_OBSERVED;
  for (const [label, options, cause] of [
    ['2-key on the Issue route', { log: refusalLog([issueRefusalLine({ observed: twoKeys })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['dropped observation', { log: refusalLog([issueRefusalLine({ observed: undefined })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['extra subject key', { log: refusalLog([issueRefusalLine({ observed: { ...ISSUE_OBSERVED, subject: { ...ISSUE_OBSERVED.subject, body: JA_BODY } } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['empty subject revision', { log: refusalLog([issueRefusalLine({ observed: { ...ISSUE_OBSERVED, subject: { nodeId: SUBJECT_NODE, revision: '' } } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['fourth key', { log: refusalLog([issueRefusalLine({ observed: { ...ISSUE_OBSERVED, repositoryId: '321' } })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['request digest', { log: refusalLog([issueRefusalLine({ requestDigest: literal.requestDigest })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['claimed', { log: refusalLog([issueRefusalLine({ claimed: true })]) }, 'PLAN_RECEIPT_NOT_REFUSED_CJK'],
    ['post echo only', { log: refusalLog([issueRefusalLine({}, 'post')]) }, 'PLAN_RECEIPT_MISSING'],
    ['duplicate plan', { log: refusalLog([issueRefusalLine(), issueRefusalLine()]) }, 'PLAN_RECEIPT_AMBIGUOUS'],
    ['provided command', { approved: { ...ISSUE_APPROVED, commandBody: '/jev-evaluate\n{}' }, command: commandJson({ issue_url: ISSUE_URLS.origin, body: '/jev-evaluate\n{}' }) }, 'COMMAND_NOT_LITERAL'],
    ['wrong origin', { command: commandJson() }, 'TARGET_MISMATCH'],
  ]) {
    const out = await issueRefusedOf(options);
    assert.deepEqual([out.status, out.cause, Object.hasOwn(out, 'planObservation')], ['HOLD', cause, false], label);
  }
  // The PR route still accepts 2 keys only: the Issue receipt is refused there, and the PR receipt binds there as before.
  assert.equal((await refusedOf({ log: refusalLog([refusalLine({ observed: ISSUE_OBSERVED })]) })).cause, 'PLAN_RECEIPT_NOT_REFUSED_CJK');
  assert.equal((await refusedOf()).status, 'BOUND');
});

test('Issue route, JA N1: the snapshot binds each pair to its own public Issue; swapped, mixed or drifted pairs hold (S2, S3)', async () => {
  const refused = await issueRefusedOf(), observed = over => ({ ...refused, planObservation: { ...ISSUE_OBSERVED, ...over } });
  const cases = [
    ['PR refusal origin', { origin: await refusedOf() }, 'ORIGIN_KIND_MISMATCH'],
    ['English result kind', { origin: { ...refused, kind: 'literal-result' } }, 'ORIGIN_KIND_MISMATCH'],
    ['held origin', { origin: await issueRefusedOf({ commandStatus: 403 }) }, 'ORIGIN_KIND_MISMATCH'],
    ['no subject pair', { origin: { ...refused, planObservation: { issueNodeId: ORIGIN_NODE, subjectRevision: ISSUE_OBSERVED.subjectRevision } } }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['origin pair as subject', { origin: observed({ subject: { nodeId: ORIGIN_NODE, revision: ISSUE_OBSERVED.subjectRevision } }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['origin revision as subject', { origin: observed({ subject: { nodeId: SUBJECT_NODE, revision: ISSUE_OBSERVED.subjectRevision } }) }, 'EXECUTOR_IDENTITY_MISMATCH'],
    ['subject pair of another read', { origin: observed({ subject: { nodeId: SUBJECT_NODE, revision: subjectRevision(subjectIssue(JA_BODY + '追記')) } }) }, 'SUBJECT_DRIFT'],
    ['origin digest', { origin: observed({ subjectRevision: ISSUE_OBSERVED.subjectRevision.replace(sha256(ORIGIN_BODY), sha256('other')) }) }, 'ORIGIN_DRIFT'],
    ['origin node', { origin: observed({ issueNodeId: 'I_other' }) }, 'ORIGIN_IDENTITY_MISMATCH'],
    ['origin edited', { originBody: ORIGIN_BODY + ' Edited.' }, 'ORIGIN_DRIFT'],
    ['subject edited', { subjectBody: JA_BODY + ' 追記' }, 'SUBJECT_DRIFT'],
    ['origin body null', { originBody: null }, 'ORIGIN_BODY_UNOBSERVED'],
    ['subject body empty', { subjectBody: '' }, 'SUBJECT_BODY_UNOBSERVED'],
    ['subject is a pull request', { pages: { [ISSUE_URLS.subject]: { status: 200, text: issueJson(SUBJECT_NUMBER, SUBJECT_NODE, JA_BODY, SUBJECT_REPO, { pull_request: {} }) } } }, 'NOT_AN_ISSUE'],
    ['subject target without id', { subjectTarget: { repository: SUBJECT_REPO, number: SUBJECT_NUMBER } }, 'TARGET_INVALID'],
  ];
  for (const [label, options, cause] of cases) {
    const got = await issueRefusalSnapshotOf(options);
    assert.deepEqual([got.status, got.cause, Object.hasOwn(got, 'snapshot')], ['HOLD', cause, false], label);
  }
  // The PR snapshot takes no Issue refusal origin either.
  assert.equal((await refusalSnapshotOf({ origin: refused })).cause, 'ORIGIN_KIND_MISMATCH');
});

test('Issue route projection: /issues/ ref, the Issue scope and case id issue; unknown markers or shapes hold after Core0 (S4)', async () => {
  const subject = await issueSnapshotOf(), value = await goalPlan(), out = project(value, subject);
  assert.equal(out.status, 'ELIGIBLE');
  const payload = JSON.parse(out.envelope.slice(REQUEST_PREFIX.length)), input = payload.cases[0].input;
  assert.equal(payload.cases[0].id, 'issue', 'a caller convention only: admission does not check the case id');
  assert.deepEqual(input.subject, { kind: 'log-entry', ref: `https://github.com/${SUBJECT_REPO}/issues/${SUBJECT_NUMBER}`, revision: subjectRevision(subjectIssue()),
    scope: ISSUE_SCOPE, content: BODY, sha256: sha256(BODY), evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(BODY) }, englishAuxiliary: null });
  // Everything the wire does not carry equals the PR route's for the same plan and text.
  const pr = project(value, await snapshotOf());
  assert.equal(pr.status, 'ELIGIBLE', pr.cause);
  for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(out[key], pr[key], key);
  assert.deepEqual(input.checks, wireInput(pr).checks);
  const admitted = await admitIssueCommand(issueAdmissionInput(out.envelope, subjectIssue(), 4300), ISSUE_SETTINGS);
  assert.deepEqual([admitted.status, admitted.identity?.subject?.revision, admitted.identity?.subjectRevision],
    ['ADMITTED', issueLiteral.identity.subject.revision, issueLiteral.identity.subjectRevision], admitted.cause);
  // The PR ref, the PR scope or the origin's revision on this route are refused by the real admission.
  for (const change of [s => { s.ref = `https://github.com/${SUBJECT_REPO}/pull/${SUBJECT_NUMBER}`; }, s => { s.scope = 'entire body of the approved pull request at the observed revision'; },
    s => { s.revision = subjectRevision(originIssue()); }]) {
    const changed = structuredClone(payload); change(changed.cases[0].input.subject);
    const r = await admitIssueCommand(issueAdmissionInput(REQUEST_PREFIX + JSON.stringify(changed), subjectIssue(), 4301), ISSUE_SETTINGS);
    assert.deepEqual([r.status, r.cause], ['NOT_ADMITTED', 'INVALID_PROVIDED_REQUEST']);
  }
  // Unknown markers and non-exact Issue shapes hold at the subject step with every local record; PR snapshots carry no marker.
  const { provenance: _provenance, ...noProvenance } = subject;
  for (const [label, bad] of [['pull-request marker', { ...subject, subjectKind: 'pull-request' }], ['repository marker', { ...subject, subjectKind: 'repository' }],
    ['null marker', { ...subject, subjectKind: null }], ['extra outer key', { ...subject, origin: {} }], ['missing provenance', noProvenance],
    ['extra provenance key', { ...subject, provenance: { ...subject.provenance, expected: EXPECTED } }],
    ['unknown provenance kind', { ...subject, provenance: { ...subject.provenance, kind: 'literal-cjk-refusal' } }],
    ['extra originTarget key', { ...subject, originTarget: { ...subject.originTarget, repositoryId: '1275606595' } }],
    ['provenance names another subject', { ...subject, provenance: { ...subject.provenance, subjectTarget: { ...SUBJECT, number: 95 } } }],
    ['extra snapshot key', { ...subject, snapshot: { ...subject.snapshot, repository: SUBJECT_REPO } }],
    ['marker on a PR snapshot', { ...(await snapshotOf()), subjectKind: 'pull-request' }], ['issue marker on a PR snapshot', { ...(await snapshotOf()), subjectKind: 'issue' }]]) {
    const held = project(value, bad);
    assert.deepEqual([held.status, held.cause, Object.hasOwn(held, 'envelope')], ['HOLD', 'SUBJECT_KIND_UNSUPPORTED', false], label);
    for (const key of ['checks', 'mapping', 'notProjected', 'unprojectedClauses', 'unquotedGoalText', 'missing', 'goal']) assert.deepEqual(held[key], out[key], `${label}: ${key}`);
  }
  // Core0 and NEED_CLARIFICATION still conclude first, without looking at the subject.
  const needsOnly = await goalPlan([question('q1', { needs: ['destination log'] })]);
  assert.equal(project(needsOnly, { ...subject, subjectKind: 'pull-request' }).cause, 'NOTHING_PROJECTED');
  assert.equal(project(await goalPlan([], GOAL, []), { ...subject, subjectKind: 'pull-request' }).cause, 'NEED_CLARIFICATION');
});

test('Issue route projection keeps English K, withholds JA K, refuses a context aux and keeps both budget rules (C4)', async () => {
  const kObs = (body, extra = []) => [{ ref: 'target', content: body }, K_OBS[1], ...extra];
  // Selected English K: one full unit per required ref, shared context recorded, admitted by the real admission.
  const value = await kPlan([question('q1'), kq('qK', ['target', 'k1'])], kObs(BODY));
  const out = project(value, issueVerifiedBody(BODY), { contextRefs: ['k1'] }), wire = wireInput(out);
  assert.equal(out.status, 'ELIGIBLE');
  assert.deepEqual(wire.context.slice(1), [kUnit('k1', K_RUNBOOK)]);
  assert.deepEqual(out.mapping.map(m => m.sharedContextRefs), [[GOAL.ref, 'k1'], [GOAL.ref, 'k1']]);
  const admit = async (envelope, id, subject = subjectIssue(BODY, UNEDITED)) => {
    const r = await admitIssueCommand(issueAdmissionInput(envelope, subject, id), ISSUE_SETTINGS); return r.cause ?? r.status; };
  assert.equal(await admit(out.envelope, 4601), 'ADMITTED');
  assert.equal(await admit(withEnvelope(wire, w => { w.context[1].englishAuxiliary = { text: 'x', sourceSha256: w.context[1].sha256 }; }), 4602), 'INVALID_PROVIDED_REQUEST');
  // JA K is withheld and reported, never translated.
  const ja = await kPlan([question('q1'), kq('qJ', ['target', 'kja'])], kObs(BODY, [{ ref: 'kja', content: '配信ジョブの再送を記録する。' }]));
  const withheld = project(ja, issueVerifiedBody(BODY), { contextRefs: ['kja'] });
  assert.deepEqual([withheld.status, withheld.contextNotCarried, wireInput(withheld).context.map(c => c.ref)], ['ELIGIBLE', [{ ref: 'kja', reason: 'CJK_CONTEXT_NOT_ADMITTED' }], [GOAL.ref]]);
  // The raw budget holds locally; the model-state budget is still the offline preparePlan's (step B), refused before any call.
  heldForBudget(project(await goalPlan(undefined, GOAL, clauses, { maxBytes: 60000 }, BIG), issueVerifiedBody(BIG), { maxBytes: 60000 }), 'Issue raw budget');
  const sentences = 'Adds a retry. '.repeat(1300).trimEnd(), dense = project(await goalPlan(undefined, GOAL, clauses, {}, sentences), issueVerifiedBody(sentences));
  assert.equal(dense.status, 'ELIGIBLE');
  assert.deepEqual([withinBudget(wireInput(dense)), await preflight(wireInput(dense))], [true, 'ENTRY_PREFLIGHT_FAILED']);
  assert.equal(await admit(dense.envelope, 4603, subjectIssue(sentences, UNEDITED)), 'INVALID_REQUEST_OR_ADMISSION');
});

// Stub GitHub ports for the real executor on the Issue route: run and workflow, the origin and subject GraphQL reads, the
// command comments with their claim reactions, and create-then-read of result comments on the origin. No network.
function issueWorld({ subjectBody = BODY } = {}) {
  const target = ISSUE_SETTINGS.targets.find(t => t.repository === REPO && t.issue === ORIGIN_NUMBER), org = ISSUE_SETTINGS.provider.receipt.target;
  const commands = new Map(), posted = [], calls = [];
  const node = i => ({ id: i.nodeId, number: i.number, body: i.body, lastEditedAt: i.lastEditedAt, includesCreatedEdit: i.includesCreatedEdit,
    userContentEdits: { totalCount: i.userContentEditsTotal } });
  const deps = {
    github: async (method, route, body) => {
      calls.push(`${method} ${route}`);
      let m;
      if (method === 'GET' && route === `repos/${REPO}/actions/runs/${RUN.id}`) return { status: 200, json: { id: RUN.id, repository: { full_name: REPO },
        workflow_id: RUN.workflowId, path: WORKFLOW_PATH, run_number: 900, run_attempt: 1, head_sha: RUN_HEAD } };
      if (method === 'GET' && route === `repos/${REPO}/actions/workflows/${RUN.workflowId}`) return { status: 200, json: { id: RUN.workflowId, state: 'active' } };
      if (method === 'POST' && (m = /^repos\/roccho-org\/ops\/issues\/comments\/(\d+)\/reactions$/.exec(route))) {
        commands.get(Number(m[1])).claims.push(EXECUTOR_LOGIN); return { status: 201, json: { user: { login: EXECUTOR_LOGIN }, content: 'eyes' } };
      }
      if (method === 'POST' && route === `repos/${REPO}/issues/${ORIGIN_NUMBER}/comments`) {
        posted.push({ id: 9100 + posted.length, user: { login: EXECUTOR_LOGIN }, body: body.body }); return { status: 201, json: { id: posted.at(-1).id } };
      }
      if (method === 'GET' && (m = /^repos\/roccho-org\/ops\/issues\/comments\/(\d+)$/.exec(route))) {
        const c = posted.find(p => p.id === Number(m[1])); return c ? { status: 200, json: { ...c, issue_url: ISSUE_URLS.origin } } : { status: 404, json: null };
      }
      return { status: 404, json: null };
    },
    graphql: async (query, vars) => {
      if (query === ISSUE_QUERY) return { data: { repository: { issue: node(originIssue()) } } };
      if (query === SUBJECT_QUERY) return { data: { repository: { databaseId: Number(SUBJECT.repositoryId), nameWithOwner: SUBJECT_REPO, isPrivate: false,
        issue: node(subjectIssue(subjectBody)) } } };
      if (query === COMMENT_QUERY) {
        const c = [...commands.values()].find(x => x.nodeId === vars.id);
        return { data: { node: { id: c.nodeId, fullDatabaseId: String(c.id), author: { login: 'roccho-dev' }, body: c.body, lastEditedAt: null, includesCreatedEdit: false,
          userContentEdits: { totalCount: 0 }, reactions: { totalCount: c.claims.length, nodes: c.claims.map(login => ({ content: CLAIM.graphql, user: { login } })) } } } };
      }
      return { errors: ['unexpected query'] };
    },
    readFile: path => repoFile(path),
  };
  const ctx = (id, body) => {
    commands.set(id, { id, nodeId: 'IC_' + id, body, claims: [] });
    return { repository: REPO, sha: RUN_HEAD, executionSource: SHA, runId: RUN.id, runAttempt: 1, event: { comment: { id, node_id: 'IC_' + id, body, user: { login: 'roccho-dev' } },
      issue: { number: ORIGIN_NUMBER }, repository: { full_name: REPO, id: Number(target.repositoryId), owner: { login: org.organization, id: Number(org.organization_id), type: 'Organization' } } } };
  };
  return { deps, ctx, posted, calls };
}
const timestamped = receipt => planLog(['2026-10-16T00:00:00.0000000Z ##[group]Run plan', '2026-10-16T00:00:01.0000000Z ' + JSON.stringify(receipt)].join('\n'));

// Composition, English branch, on this tree: the real executor plans, runs (fixture provider) and posts a literal command
// at the origin; the caller binds its plan receipt and result comment; the projection with English K is admitted by the
// real admission and planned again by the real executor. Not a workflow run, an actual acquisition or an effect.
test('Issue route composition, English: executor literal result -> expectedOrigin -> Issue snapshot -> project with K -> admission and executor plan', async () => {
  const world = issueWorld(), cmd = world.ctx(EXPECTED.commandCommentId, '/jev-evaluate');
  const planned = await planIssueCommand(cmd, ISSUE_SETTINGS, world.deps);
  assert.equal(planned.receipt.outcome, 'PLANNED', planned.receipt.cause);
  const prepared = await preparePlan(planned.plan);
  const result = await executeOwnerPlan(prepared, 'synthetic-fixture-key', async (url, init) => new Response(JSON.stringify({ model: JEV_MODEL,
    answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(k => [k, { type: 'noul', noul: 0.4 }])) }), { status: 200 }));
  const posted = await postIssueCommand(JSON.parse(JSON.stringify(planned.state)), { status: 0, stdout: JSON.stringify(result) + '\n' }, ISSUE_SETTINGS, world.deps);
  assert.deepEqual([posted.receipt.outcome, posted.receipt.cause], ['APPENDED', 'READBACK_EXACT']);
  // The result sink is the origin only; nothing is written to the subject's repository.
  assert.deepEqual(world.calls.filter(c => c.startsWith('POST ')), [`POST repos/${REPO}/issues/comments/${EXPECTED.commandCommentId}/reactions`, `POST repos/${REPO}/issues/${ORIGIN_NUMBER}/comments`]);
  const origin = await originOf({ approved: ISSUE_APPROVED, command: commandJson({ issue_url: ISSUE_URLS.origin }), run: runJson({ run_number: 900 }), log: timestamped(planned.receipt) });
  assert.equal(origin.status, 'BOUND', origin.cause);
  const subject = issueSubjectIdentitySnapshot({ ...(await issueReceipts({ comments: world.posted })), originTarget: ORIGIN, subjectTarget: SUBJECT, expected: origin.expected });
  assert.equal(subject.status, 'VERIFIED', subject.cause);
  const identity = parseResultComment(world.posted[0].body).identity;
  assert.deepEqual([subject.snapshot, subject.provenance.originRevision, subjectRevision(subject.snapshot), subject.provenance.origin.requestDigest],
    [subjectIssue(), identity.subjectRevision, identity.subject.revision, origin.origin.planRequestDigest]);
  const value = await kPlan([question('q1'), kq('qK', ['target', 'k1'])], [{ ref: 'target', content: BODY }, K_OBS[1]]);
  const out = project(value, subject, { contextRefs: ['k1'] }), wire = wireInput(out);
  assert.equal(out.status, 'ELIGIBLE');
  assert.deepEqual([wire.subject.ref, wire.subject.revision, wire.context.map(c => c.role), wire.checks.map(c => c.requiredRoles)],
    [`https://github.com/${SUBJECT_REPO}/issues/${SUBJECT_NUMBER}`, identity.subject.revision, ['goal', 'observation:k1'], [[], ['observation:k1']]]);
  assert.deepEqual(out.mapping.map(m => m.sharedContextRefs), [[GOAL.ref, 'k1'], [GOAL.ref, 'k1']]);
  const admitted = await admitIssueCommand(issueAdmissionInput(out.envelope, subjectIssue(), 4300), ISSUE_SETTINGS);
  assert.deepEqual([admitted.status, admitted.identity?.observation, admitted.identity?.subject?.revision, admitted.identity?.subjectRevision],
    ['ADMITTED', PROVIDED_COMMAND_OBSERVATION, identity.subject.revision, identity.subjectRevision], admitted.cause);
  const providedPlan = await planIssueCommand(world.ctx(4300, out.envelope), ISSUE_SETTINGS, world.deps);
  assert.equal(providedPlan.receipt.outcome, 'PLANNED', providedPlan.receipt.cause);
  assert.equal(JSON.stringify(providedPlan.plan.cases), JSON.stringify(JSON.parse(out.envelope.slice(REQUEST_PREFIX.length)).cases));
  // Without the Issue provided grant the same envelope is the legacy refusal; a later subject edit is refused.
  const { providedRequestTargets: _grant, ...subjectOnly } = ISSUE_SETTINGS;
  assert.equal((await admitIssueCommand(issueAdmissionInput(out.envelope, subjectIssue(), 4301), subjectOnly)).cause, 'PROVIDED_WITH_SUBJECT_UNSUPPORTED');
  assert.equal((await admitIssueCommand(issueAdmissionInput(out.envelope, subjectIssue(BODY, { ...EDITS, userContentEditsTotal: 3 }), 4302), ISSUE_SETTINGS)).status, 'NOT_ADMITTED');
});

// Composition, JA branch, on this tree: the real executor refuses a literal command on a CJK subject before any claim,
// with its own 3-key observation; the caller binds it and the supplied rendering projects; the real admission admits it
// and the real executor plans it. Provider calls for the refusal: 0. Not a rendering, R fidelity or an effect.
test('Issue route composition, JA: executor 3-key refusal -> issueRefusalOrigin -> refusal snapshot -> project with aux and K -> admission', async () => {
  const world = issueWorld({ subjectBody: JA_BODY });
  const planned = await planIssueCommand(world.ctx(EXPECTED.commandCommentId, '/jev-evaluate'), ISSUE_SETTINGS, world.deps);
  assert.deepEqual(planned.receipt, { schema: 'ops.jev.issue-actions-receipt.v1', stage: 'plan', outcome: 'NONE', cause: 'UNSUPPORTED_CJK', claimed: false,
    providerCalls: 0, authority: false, commentId: EXPECTED.commandCommentId, run: { id: RUN.id, number: 900, attempt: 1, workflowId: RUN.workflowId }, observed: ISSUE_OBSERVED });
  assert.deepEqual(world.calls.filter(c => !c.startsWith('GET ')), []);
  const origin = await issueRefusedOf({ log: timestamped(planned.receipt) });
  assert.deepEqual([origin.status, origin.kind, origin.planObservation], ['BOUND', 'literal-cjk-refusal-issue-subject', planned.receipt.observed], origin.cause);
  const subject = await issueRefusalSnapshotOf({ origin });
  assert.deepEqual([subject.status, subject.snapshot], ['VERIFIED', JA_SUBJECT], subject.cause);
  const value = await kPlan([question('q1'), kq('qK', ['target', 'k1'])], [{ ref: 'target', content: JA_BODY }, K_OBS[1]]);
  const out = project(value, subject, { englishAuxiliary: AUX, contextRefs: ['k1'] }), wire = wireInput(out);
  assert.equal(out.status, 'ELIGIBLE');
  assert.deepEqual([wire.subject.content, wire.subject.revision, wire.subject.englishAuxiliary, wire.subject.scope, wire.context.map(c => c.ref)],
    [JA_BODY, planned.receipt.observed.subject.revision, AUX, ISSUE_SCOPE, [GOAL.ref, 'k1']]);
  assert.deepEqual([out.fidelity.renderingVerdict, out.emittable, out.postingAuthorized], ['UNREVIEWED', false, false]);
  const admitted = await admitIssueCommand(issueAdmissionInput(out.envelope, JA_SUBJECT, 4300), ISSUE_SETTINGS);
  assert.deepEqual([admitted.status, admitted.identity?.subject?.revision, admitted.identity?.subjectRevision],
    ['ADMITTED', planned.receipt.observed.subject.revision, planned.receipt.observed.subjectRevision], admitted.cause);
  const providedPlan = await planIssueCommand(world.ctx(4300, out.envelope), ISSUE_SETTINGS, world.deps);
  assert.equal(providedPlan.receipt.outcome, 'PLANNED', providedPlan.receipt.cause);
  // A rendering bound to the origin body, or a later subject edit, is refused.
  const toOrigin = project(value, subject, { englishAuxiliary: { ...AUX, sourceSha256: sha256(ORIGIN_BODY) }, contextRefs: ['k1'] });
  assert.equal(toOrigin.cause, 'AUXILIARY_INVALID');
  const tampered = JSON.parse(out.envelope.slice(REQUEST_PREFIX.length)); tampered.cases[0].input.subject.englishAuxiliary.sourceSha256 = sha256(ORIGIN_BODY);
  assert.equal((await admitIssueCommand(issueAdmissionInput(REQUEST_PREFIX + JSON.stringify(tampered), JA_SUBJECT, 4301), ISSUE_SETTINGS)).status, 'NOT_ADMITTED');
  assert.equal((await admitIssueCommand(issueAdmissionInput(out.envelope, subjectIssue(JA_BODY, { ...EDITS, userContentEditsTotal: 3 }), 4302), ISSUE_SETTINGS)).status, 'NOT_ADMITTED');
});

test('importing prepare from eval with its path in argv does not execute the CLI', () => {
  const directory = cliTemp(), module = fileURLToPath(new URL('./prepare.mjs', import.meta.url));
  const code = "const { pathToFileURL } = await import('node:url'); await import(pathToFileURL(process.argv[1]));";
  for (const [name, evaluation] of [['short', ['-e', code]], ['long', ['--eval', code]], ['joined', ['--eval=' + code]]]) {
    const output = join(directory, name);
    const execution = spawnSync(process.execPath, ['--input-type=module', ...evaluation, module, join(directory, 'absent.json'), output],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4194304, timeout: 15000 });
    assert.equal(execution.status, 0, execution.stderr.toString());
    assert.equal(execution.stdout.length, 0);
    assert.equal(execution.stderr.length, 0);
    assert.equal(existsSync(output), false);
  }
});
