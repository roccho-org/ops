import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PIN_DIFF_ALLOWED, checkSealOrder, checkPinDiff, extractNumericConstant, checkTheta, summarizeJudgments,
  gitChangedPaths, gitShow,
} from './verify.mjs';

const H = 'b'.repeat(64);
const CASE = 'roccho-org/ops#581';
const RUN = '2026-10-22T03:00:00Z';
const seal = (kind, sealedAt, laneId = ['no-jev', 'sys2-direct', 'with-jev'].includes(kind) ? `l-${kind}` : null) => ({
  schema: 'ops.semlint.g1.seal.v1', caseRef: CASE, kind, laneId, sha256: H, sealedAt,
  evidence: { repository: 'roccho-org/ops', commentId: 10 },
});
const preRun = ['no-jev', 'sys2-direct', 'answer-key', 'deadline', 'rubric'].map((k) => seal(k, '2026-10-22T02:00:00Z'));
const POST = { caseRef: CASE, runStartedAt: RUN, phase: 'post-run' };
const withJev = seal('with-jev', '2026-10-22T04:00:00Z');

test('seal order: every pre-run seal strictly before the run, the with-Jev lane after it', () => {
  assert.deepEqual(checkSealOrder([...preRun, withJev], POST), { ok: true, errors: [] });
});

test('seal order: a seal at or after the run start is refused (equal time is not before)', () => {
  const late = preRun.map((r) => (r.kind === 'no-jev' ? { ...r, sealedAt: RUN } : r));
  const res = checkSealOrder([...late, withJev], POST);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /no-jev.*not before run/);
});

test('seal order: a missing or duplicated pre-run seal is refused, other cases are ignored', () => {
  const res = checkSealOrder([...preRun.filter((r) => r.kind !== 'answer-key'), withJev], POST);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /answer-key.*expected exactly 1, found 0/);
  const dup = checkSealOrder([...preRun, withJev, seal('rubric', '2026-10-22T01:00:00Z')], POST);
  assert.match(dup.errors.join('\n'), /rubric.*found 2/);
  const other = { ...seal('no-jev', '2026-10-22T09:00:00Z'), caseRef: 'roccho-org/ops#999' };
  assert.equal(checkSealOrder([...preRun, withJev, other], POST).ok, true);
});

test('seal order: a with-Jev seal before the run cannot have used the bot output', () => {
  const res = checkSealOrder([...preRun, seal('with-jev', '2026-10-22T02:30:00Z')], POST);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /with-jev.*not after run/);
});

test('seal order: invalid rows or run time are refused rather than skipped', () => {
  assert.equal(checkSealOrder([...preRun, { ...seal('with-jev', 'x') }], POST).ok, false);
  assert.equal(checkSealOrder([...preRun, withJev], { ...POST, runStartedAt: 'yesterday' }).ok, false);
});

// Defect A (W review of 9a4445c4): post-run must require the with-Jev seal; the phase is explicit.
test('seal order A: post-run without the with-Jev seal is refused', () => {
  const res = checkSealOrder(preRun, POST);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /with-jev: expected exactly 1, found 0/);
  assert.match(checkSealOrder([...preRun, withJev, seal('with-jev', '2026-10-22T05:00:00Z')], POST).errors.join('\n'),
    /with-jev: expected exactly 1, found 2/);
});

test('seal order A: the phase must be named; pre-run forbids a with-Jev seal', () => {
  assert.equal(checkSealOrder([...preRun, withJev], { caseRef: CASE, runStartedAt: RUN }).ok, false);
  assert.equal(checkSealOrder(preRun, { ...POST, phase: 'any' }).ok, false);
  assert.deepEqual(checkSealOrder(preRun, { ...POST, phase: 'pre-run' }), { ok: true, errors: [] });
  assert.equal(checkSealOrder([...preRun, withJev], { ...POST, phase: 'pre-run' }).ok, false);
});

// Defect B: the rubric is sealed once for the whole series, not once per case.
test('seal order B: a second rubric sealed under another case is refused; the first one serves every case', () => {
  const CASE2 = 'roccho-org/ops#600';
  const case2 = [...preRun.filter((r) => r.kind !== 'rubric'), withJev].map((r) => ({ ...r, caseRef: CASE2 }));
  // Case 2 uses the rubric sealed under case 1.
  assert.deepEqual(checkSealOrder([...preRun, withJev, ...case2], { ...POST, caseRef: CASE2 }), { ok: true, errors: [] });
  const resealed = { ...seal('rubric', '2026-10-22T02:10:00Z'), caseRef: CASE2, sha256: 'd'.repeat(64) };
  const res = checkSealOrder([...preRun, withJev, ...case2, resealed], { ...POST, caseRef: CASE2 });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /rubric.*found 2/);
});

test('pin diff: only the grant config and the workflow may change between pins', () => {
  assert.deepEqual(PIN_DIFF_ALLOWED, ['.github/workflows/jev-issue-comment.yml', 'packages/jev-review/issue-actions.json']);
  assert.deepEqual(checkPinDiff([]), { ok: true, errors: [] });
  assert.deepEqual(checkPinDiff([...PIN_DIFF_ALLOWED]), { ok: true, errors: [] });
  const res = checkPinDiff(['packages/jev-review/issue-actions.json', 'packages/jev-review/github-comment.mjs',
    'experiments/goal-evaluation-unix/prepare.mjs']);
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, ['outside allowed pin diff: experiments/goal-evaluation-unix/prepare.mjs',
    'outside allowed pin diff: packages/jev-review/github-comment.mjs']);
});

const SRC = "export const OTHER = 1;\nexport const SEMLINT_THETA = 0.5;\nconst x = SEMLINT_THETA > 0;\n";

test('constant extraction: exactly one top-level numeric export, otherwise a closed non-FOUND status', () => {
  assert.deepEqual(extractNumericConstant(SRC, 'SEMLINT_THETA'), { status: 'FOUND', value: 0.5 });
  assert.deepEqual(extractNumericConstant('export const OTHER = 1;\n', 'SEMLINT_THETA'), { status: 'ABSENT' });
  assert.equal(extractNumericConstant(SRC + 'export const SEMLINT_THETA = 0.6;\n', 'SEMLINT_THETA').status, 'AMBIGUOUS');
  assert.equal(extractNumericConstant(SRC.replace('0.5;', 'Number("0.5");'), 'SEMLINT_THETA').status, 'NOT_NUMERIC_LITERAL');
  // A mutable binding or a reassignment elsewhere makes the literal untrustworthy.
  assert.equal(extractNumericConstant('export let SEMLINT_THETA = 0.5;\n', 'SEMLINT_THETA').status, 'NOT_NUMERIC_LITERAL');
  assert.equal(extractNumericConstant(SRC + 'SEMLINT_THETA = 0.9;\n', 'SEMLINT_THETA').status, 'AMBIGUOUS');
});

const THETA = { schema: 'ops.semlint.g1.theta.v1', file: 'packages/jev-review/github-comment.mjs', constant: 'SEMLINT_THETA',
  value: 0.5, band: { low: 0.3, high: 0.7 }, recordedAt: '2026-10-22T00:00:00Z' };

test('theta: the ledger copy must equal the constant in the code at the pinned SHA', () => {
  assert.deepEqual(checkTheta(THETA, SRC), { ok: true, errors: [] });
  const res = checkTheta({ ...THETA, value: 0.55 }, SRC);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /THETA_MISMATCH/);
});

test('theta: until W1 defines the constant, verification fails as THETA_CONSTANT_ABSENT (never a pass)', () => {
  const res = checkTheta(THETA, 'export const OTHER = 1;\n');
  assert.deepEqual(res, { ok: false, errors: ['THETA_CONSTANT_ABSENT: SEMLINT_THETA in packages/jev-review/github-comment.mjs'] });
  assert.equal(checkTheta(THETA, null).ok, false);
  assert.equal(checkTheta({ ...THETA, value: 2 }, SRC).ok, false);
});

const vote = (scorer, blindId, counts, kept, laneGuess) => ({
  schema: 'ops.semlint.g1.judgment.v1', caseRef: CASE, scorer, blindId, rubricSha256: H,
  counts, requiredKept: { kept, required: 4 }, laneGuess, judgedAt: '2026-10-23T00:00:00Z',
});
const c = (falseFinding, duplicate, inconsistency, omission) => ({ falseFinding, duplicate, inconsistency, omission });
const votes = [
  vote('R', 'A', c(0, 1, 0, 2), 3, 'no-jev'), vote('W', 'A', c(0, 1, 0, 1), 3, 'with-jev'),
  vote('R', 'B', c(1, 0, 0, 0), 4, 'with-jev'), vote('W', 'B', c(1, 0, 0, 0), 4, 'unsure'),
];
const unblind = { A: 'no-jev', B: 'with-jev' };
const rubricSeal = seal('rubric', '2026-10-22T02:00:00Z');
const J = { caseRef: CASE, unblind, seals: [rubricSeal] };

test('judgments: two votes per blind ID give agreement, disagreements and lane-guess hit rate', () => {
  const s = summarizeJudgments(votes, J);
  assert.equal(s.ok, true);
  assert.deepEqual(s.agreement, { items: 10, agreed: 9, rate: 0.9 });
  assert.deepEqual(s.disagreements, [{ blindId: 'A', item: 'omission', R: 1 + 1, W: 1 }]);
  assert.deepEqual(s.guess, { R: { hits: 2, misses: 0, unsure: 0 }, W: { hits: 0, misses: 1, unsure: 1 } });
});

test('judgments: a missing vote, a third vote, mixed rubric hashes or a non-blinded ID are incomplete', () => {
  assert.equal(summarizeJudgments(votes.slice(1), J).ok, false);
  assert.equal(summarizeJudgments([...votes, vote('R', 'A', c(0, 0, 0, 0), 4, 'unsure')], J).ok, false);
  assert.equal(summarizeJudgments(votes.map((v, i) => (i === 0 ? { ...v, rubricSha256: 'c'.repeat(64) } : v)), J).ok, false);
  assert.equal(summarizeJudgments(votes, { ...J, unblind: { A: 'no-jev' } }).ok, false);
});

// Defect B: votes must use the sealed rubric, and there is exactly one rubric seal in the series.
test('judgments B: votes on a rubric hash other than the sealed one are refused', () => {
  const other = votes.map((v) => ({ ...v, rubricSha256: 'e'.repeat(64) }));
  const res = summarizeJudgments(other, J);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /rubric/);
});

test('judgments B: no rubric seal, or two rubric seals across cases, is refused', () => {
  assert.equal(summarizeJudgments(votes, { caseRef: CASE, unblind }).ok, false);
  assert.equal(summarizeJudgments(votes, { ...J, seals: [] }).ok, false);
  const second = { ...rubricSeal, caseRef: 'roccho-org/ops#600', sha256: 'f'.repeat(64) };
  assert.equal(summarizeJudgments(votes, { ...J, seals: [rubricSeal, second] }).ok, false);
});

test('git readers: rename shows both paths; show returns null for a missing file at a SHA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semlint-g1-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { encoding: 'utf8' }).trim();
  try {
    g('init', '-q');
    fs.mkdirSync(path.join(dir, 'packages/jev-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/jev-review/issue-actions.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'x\n');
    g('add', '-A'); g('commit', '-qm', 'one');
    const one = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'packages/jev-review/issue-actions.json'), '{"a":1}\n');
    fs.renameSync(path.join(dir, 'a.mjs'), path.join(dir, 'b.mjs'));
    g('add', '-A'); g('commit', '-qm', 'two');
    const two = g('rev-parse', 'HEAD');
    assert.deepEqual(gitChangedPaths(dir, one, two), ['a.mjs', 'b.mjs', 'packages/jev-review/issue-actions.json']);
    assert.equal(checkPinDiff(gitChangedPaths(dir, one, two)).ok, false);
    assert.equal(gitShow(dir, one, 'packages/jev-review/github-comment.mjs'), null);
    assert.equal(gitShow(dir, two, 'packages/jev-review/issue-actions.json'), '{"a":1}\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
