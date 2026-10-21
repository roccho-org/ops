// R2: independent test of the W1 display (roccho-dev/adrs#635 F0 seal 6314172215; W1 is roccho-org/ops#637).
// Oracle: the real PR629 bot comment (ops issue comment 6310719656, stored byte-exact as JSON). parseResultComment
// re-renders an envelope and accepts a body only if it is byte-identical, so a v3 body derived here from the F0 rules
// (θ 0.70 with ">", band 0.30-0.70 with both ends, closer side at 0.5) is accepted only if W1 renders the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTheta, extractNumericConstant } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMENT_FILE = path.resolve(here, '../../packages/jev-review/github-comment.mjs');
const comment = await import(pathToFileURL(COMMENT_FILE).href);
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'pr629-bot-6310719656.json'), 'utf8'));
const V2_BODY = fixture.body;

const THETA = 0.7, LOW = 0.3, HIGH = 0.7;
const code = (value) => '<code>' + String(value).replace(/[^A-Za-z0-9 .-]/gu, (c) => '&#' + c.codePointAt(0) + ';') + '</code>';
const records = (env) => env.result.cases.flatMap((row) => row.result.records.map((record) => ({ row, record })));
const nameOf = ({ row, record }) => `${code(row.id)} / ${code(record.rule)}`;
const tableRow = ({ row, record }, noul) =>
  `| ${nameOf({ row, record })} | ${code(record.question)} | ${code(record.status)} | ${code(noul ?? 'not observed')} |`;
const closer = (v) => (v > 0.5 ? 'the problem criterion (true)' : v < 0.5 ? 'the ok criterion (false)' : 'neither criterion (0.5)');
const side = (v) => (v > HIGH ? 'above the uncertain band' : v < LOW ? 'below the uncertain band' : 'in the uncertain band');

// The θ section as the F0 rules define it; the wording is W1's fixed text.
function thetaSection(env) {
  const rows = records(env).map((r) => ({ name: nameOf(r), value: r.record.noul }));
  const list = (picked, none) => (picked.length ? picked.map((r) => `- ${r.name}: ${code(r.value)}`).join('\n') : none);
  return '### Jev value against θ\n\n'
    + `θ is ${code(THETA)}, fixed before any result; a value above θ is listed below. The uncertain band is ${code(LOW)} through ${code(HIGH)}, both ends included. `
    + 'A check that is not listed above θ is not shown to hold or to be acceptable.\n\n'
    + 'Above θ:\n\n' + list(rows.filter((r) => r.value > THETA), 'No recorded value is above θ.') + '\n\n'
    + 'In the uncertain band:\n\n' + list(rows.filter((r) => r.value >= LOW && r.value <= HIGH), 'No recorded value is in the uncertain band.') + '\n\n'
    + 'Each recorded value:\n\n'
    + rows.map((r) => `- ${r.name}: ${code(r.value)}, closer to ${closer(r.value)}, ${side(r.value)}`).join('\n') + '\n\n';
}

// A v3 body derived from the real v2 body: new values in the table and evidence, the θ section before the observations.
function v3Body(values) {
  const v2 = comment.parseResultComment(V2_BODY);
  const env = structuredClone(v2);
  env.schema = 'ops.jev.issue-result.v3';
  records(env).forEach((r, i) => { r.record.noul = values[i]; });
  let body = V2_BODY.replace(JSON.stringify(v2), JSON.stringify(env));
  records(v2).forEach((r, i) => { body = body.replace(tableRow(r, r.record.noul), tableRow(r, values[i])); });
  body = body.replace('### Model observations\n\n', thetaSection(env) + '### Model observations\n\n');
  return { env, body };
}

test('R2: the fixture is the unedited PR629 bot comment', () => {
  assert.deepEqual([fixture.id, fixture.user, fixture.created_at === fixture.updated_at], [6310719656, 'github-actions[bot]', true]);
  assert.equal(Buffer.byteLength(V2_BODY, 'utf8'), 9205);
});

test('R2: the real PR629 v2 comment still reads back byte-exact, without a θ section', () => {
  const env = comment.parseResultComment(V2_BODY);
  assert.ok(env, 'v2 body must be accepted');
  assert.equal(env.schema, 'ops.jev.issue-result.v2');
  assert.deepEqual(records(env).map((r) => r.record.noul), [0.12, 0.11]);
  assert.equal(V2_BODY.includes('Jev value against θ'), false);
});

test('R2: θ is the single exported literal 0.7 and matches the sealed ledger copy (R1)', () => {
  const source = fs.readFileSync(COMMENT_FILE, 'utf8');
  assert.equal(comment.SEMLINT_THETA, 0.7);
  assert.deepEqual(extractNumericConstant(source, 'SEMLINT_THETA'), { status: 'FOUND', value: 0.7 });
  const row = { schema: 'ops.semlint.g1.theta.v1', file: 'packages/jev-review/github-comment.mjs', constant: 'SEMLINT_THETA',
    value: 0.7, band: { low: 0.3, high: 0.7 }, recordedAt: '2026-10-21T10:52:29Z' };
  assert.deepEqual(checkTheta(row, source), { ok: true, errors: [] });
});

test('R2: mixed values render exactly as the F0 rules derive them (">" θ, inclusive band, closer side)', () => {
  for (const values of [[0.71, 0.7], [0.3, 0.29], [0.5, 0.12], [0.72, 0.71], [0.12, 0.11]]) {
    const { body } = v3Body(values);
    const parsed = comment.parseResultComment(body);
    assert.ok(parsed, `W1 must render the derived v3 body for ${values}`);
    assert.equal(parsed.schema, 'ops.jev.issue-result.v3');
  }
});

test('R2: a v3 body that breaks one F0 rule is refused (the oracle is not vacuous)', () => {
  const { body } = v3Body([0.7, 0.29]);
  // 0.7 listed above θ (>= instead of >), or 0.29 placed in the band, must not match W1's rendering.
  const wrongTheta = body.replace('No recorded value is above θ.', `- ${code('pull-request')} / ${code('observation-not-instruction')}: ${code(0.7)}`);
  const wrongBand = body.replace(', below the uncertain band', ', in the uncertain band');
  for (const bad of [wrongTheta, wrongBand]) assert.notEqual(bad, body);
  for (const bad of [wrongTheta, wrongBand]) assert.equal(comment.parseResultComment(bad), null);
  assert.ok(comment.parseResultComment(body));
});

test('R2: the comprehension rule N equals the number of rows listed above θ', () => {
  for (const [values, n] of [[[0.71, 0.7], 1], [[0.72, 0.71], 2], [[0.7, 0.3], 0]]) {
    const { body } = v3Body(values);
    assert.ok(comment.parseResultComment(body));
    const above = body.slice(body.indexOf('Above θ:\n\n') + 'Above θ:\n\n'.length, body.indexOf('\n\nIn the uncertain band:'));
    const listed = above === 'No recorded value is above θ.' ? 0 : above.split('\n').length;
    assert.equal(listed, n, String(values));
    assert.equal(values.filter((v) => v > THETA).length, n);
  }
});
