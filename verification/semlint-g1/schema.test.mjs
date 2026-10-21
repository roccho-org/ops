import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSeal, validateJudgment, validateBurden, validateTheta, parseLedger } from './schema.mjs';

const H = 'a'.repeat(64);
const seal = {
  schema: 'ops.semlint.g1.seal.v1', caseRef: 'roccho-org/ops#581', kind: 'no-jev', laneId: 'l1', sha256: H,
  sealedAt: '2026-10-22T01:00:00Z', evidence: { repository: 'roccho-org/ops', commentId: 1 },
};
const judgment = {
  schema: 'ops.semlint.g1.judgment.v1', caseRef: 'roccho-org/ops#581', scorer: 'R', blindId: 'A', rubricSha256: H,
  counts: { falseFinding: 0, duplicate: 1, inconsistency: 0, omission: 2 }, requiredKept: { kept: 3, required: 4 },
  laneGuess: 'unsure', judgedAt: '2026-10-23T01:00:00Z',
};
const burden = {
  schema: 'ops.semlint.g1.burden.v1', caseRef: 'roccho-org/ops#581', laneId: null, kind: 'reading',
  quantity: { unit: 'seconds', value: null }, evidence: null, observedAt: '2026-10-23T01:00:00Z',
};
const theta = {
  schema: 'ops.semlint.g1.theta.v1', file: 'packages/jev-review/github-comment.mjs', constant: 'SEMLINT_THETA',
  value: 0.5, band: { low: 0.3, high: 0.7 }, recordedAt: '2026-10-22T00:00:00Z',
};

test('valid rows of each kind are accepted', () => {
  assert.deepEqual(validateSeal(seal), []);
  assert.deepEqual(validateJudgment(judgment), []);
  assert.deepEqual(validateBurden(burden), []);
  assert.deepEqual(validateTheta(theta), []);
});

test('rows are closed: sealed content or any extra key is refused', () => {
  assert.notDeepEqual(validateSeal({ ...seal, content: 'lane text' }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, note: 'x' }), []);
  assert.notDeepEqual(validateBurden({ ...burden, extra: 1 }), []);
  assert.notDeepEqual(validateTheta({ ...theta, source: 'x' }), []);
  const { laneId, ...missing } = seal;
  assert.notDeepEqual(validateSeal(missing), []);
});

test('seal: kind, hash, time and evidence are checked', () => {
  assert.notDeepEqual(validateSeal({ ...seal, kind: 'other' }), []);
  assert.notDeepEqual(validateSeal({ ...seal, sha256: 'A'.repeat(64) }), []);
  assert.notDeepEqual(validateSeal({ ...seal, sealedAt: '2026-10-22 01:00' }), []);
  assert.notDeepEqual(validateSeal({ ...seal, evidence: { repository: 'roccho-org/ops', commentId: 0 } }), []);
  // Non-lane seals carry no lane ID; lane seals must carry one.
  assert.deepEqual(validateSeal({ ...seal, kind: 'answer-key', laneId: null }), []);
  assert.notDeepEqual(validateSeal({ ...seal, kind: 'answer-key' }), []);
  assert.notDeepEqual(validateSeal({ ...seal, laneId: null }), []);
});

test('judgment: four nonnegative counts, kept <= required, closed lane guess, scorer R or W', () => {
  assert.notDeepEqual(validateJudgment({ ...judgment, counts: { ...judgment.counts, omission: -1 } }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, counts: { falseFinding: 0, duplicate: 0, inconsistency: 0 } }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, requiredKept: { kept: 5, required: 4 } }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, laneGuess: 'jev' }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, scorer: 'P' }), []);
  for (const g of ['no-jev', 'with-jev', 'sys2-direct', 'unsure']) assert.deepEqual(validateJudgment({ ...judgment, laneGuess: g }), []);
});

test('burden: UNKNOWN is null, never zero-filled; units are closed', () => {
  assert.deepEqual(validateBurden({ ...burden, quantity: { unit: 'count', value: 0 } }), []);
  assert.notDeepEqual(validateBurden({ ...burden, quantity: { unit: 'minutes', value: 1 } }), []);
  assert.notDeepEqual(validateBurden({ ...burden, quantity: { unit: 'bytes', value: 1.5 } }), []);
  assert.notDeepEqual(validateBurden({ ...burden, kind: 'cost' }), []);
});

test('theta: value in [0,1], official band 0.30-0.70, file fixed to the W1 display module', () => {
  assert.notDeepEqual(validateTheta({ ...theta, value: 1.2 }), []);
  assert.notDeepEqual(validateTheta({ ...theta, band: { low: 0.25, high: 0.7 } }), []);
  assert.notDeepEqual(validateTheta({ ...theta, file: 'packages/jev-review/issue-actions.json' }), []);
  assert.notDeepEqual(validateTheta({ ...theta, constant: 'theta' }), []);
});

// Defect C (W review of 9a4445c4): free-text IDs and links could carry sealed content.
test('C: lane and blind IDs are short closed tokens, not free text', () => {
  assert.deepEqual(validateSeal({ ...seal, laneId: 'l-no-jev' }), []);
  assert.notDeepEqual(validateSeal({ ...seal, laneId: 'The report omits the criterion for case 3' }), []);
  assert.notDeepEqual(validateSeal({ ...seal, laneId: 'a'.repeat(33) }), []);
  assert.notDeepEqual(validateSeal({ ...seal, laneId: 'L1' }), []);
  assert.notDeepEqual(validateJudgment({ ...judgment, blindId: 'lane with the bot wording' }), []);
  assert.notDeepEqual(validateBurden({ ...burden, laneId: 'free text lane' }), []);
});

test('C: burden evidence is a GitHub issue, comment, PR or run link only', () => {
  assert.deepEqual(validateBurden({ ...burden, evidence: 'https://github.com/roccho-org/ops/issues/581#issuecomment-123' }), []);
  assert.deepEqual(validateBurden({ ...burden, evidence: 'https://github.com/roccho-org/ops/actions/runs/39583670713' }), []);
  assert.notDeepEqual(validateBurden({ ...burden, evidence: 'https://example.com/?text=the%20sealed%20lane' }), []);
  assert.notDeepEqual(validateBurden({ ...burden, evidence: 'https://github.com/roccho-org/ops/issues/581?q=sealed-text' }), []);
});

test('theta: the constant name is the W1 promise SEMLINT_THETA', () => {
  assert.notDeepEqual(validateTheta({ ...theta, constant: 'OTHER_THETA' }), []);
});

test('ledger: one JSON object per line, each validated, errors carry the line number', () => {
  const ok = parseLedger([JSON.stringify(seal), JSON.stringify(judgment)].join('\n') + '\n');
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.rows.length, 2);
  const bad = parseLedger(JSON.stringify(seal) + '\n{oops\n' + JSON.stringify({ schema: 'unknown' }) + '\n');
  assert.deepEqual(bad.errors.map((e) => e.line), [2, 3]);
});
