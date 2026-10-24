import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { strictJson, resolvePlan, evaluateRelations, projectRelations } from '../raw-relations.mjs';
import { JEV_MODEL } from '../core.mjs';

export async function runRawRelationsTests({ entryTests = true } = {}) {
  const fixture = fileURLToPath(new URL('./fixtures/raw-relations/', import.meta.url));
  const originalPlan = strictJson(fs.readFileSync(path.join(fixture, 'plan.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(fixture, 'raw.jsonl'));
  const before = Buffer.from(bytes);
  const resolved = resolvePlan(originalPlan, fixture);
  const d = await evaluateRelations(resolved);
  const rows = projectRelations(resolved, d);
  assert.equal(rows.length, 14);
  assert.deepEqual(d.outcomes.map(o => o.assessment), ['POSITIVE', 'POSITIVE', 'POSITIVE', 'POSITIVE', 'NEGATIVE']);
  assert.equal(d.accounting.calls, 0);
  assert.equal(rows[0].raw.annotations.original, true);
  assert.equal(rows[0].raw.evaluation, 'raw-field');
  assert.equal(rows[0].raw.sourceRef, 'raw-field');
  assert.equal(rows[0].evaluation.status, 'INCOMPLETE');
  assert.equal(rows[13].evaluation.status, 'NOT_CANDIDATE');
  assert.equal(rows[13].evaluation.semanticAssessment, 'UNKNOWN');
  assert.equal(d.omissions[0].obligation, 'u-outside');
  assert.equal(rows[5].annotations[0].participants.length, 4);
  assert.equal(rows[11].annotations.length, 0);
  assert.equal(rows[11].evaluation.semanticAssessment, 'NEGATIVE_ON_SUPPLIED_CANDIDATES');
  assert.equal(JSON.stringify(rows), JSON.stringify(projectRelations(resolvePlan(originalPlan, fixture), d)));
  assert.deepEqual(fs.readFileSync(path.join(fixture, 'raw.jsonl')), before);
  for (const row of rows) assert.deepEqual(strictJson(bytes.subarray(row.sourceRef.startByte, row.sourceRef.endByte).toString()), row.raw);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops676-w-public-'));
  // Retain these non-authority public test artifacts; no recursive cleanup.
  fs.writeFileSync(path.join(tmp, 'raw.jsonl'), bytes);
  const p = () => structuredClone(originalPlan);
  const run = async plan => evaluateRelations(resolvePlan(plan, tmp));
  const participants = (...occurrences) => occurrences.map(occurrence => ({ source: 'demo', revision: 'public-fixture-v1', occurrence, role: 'assertion' }));
  const single = (check, ...occurrences) => {
    const plan = p(); plan.obligations = [];
    plan.candidates = [{ id: 'only', check, participants: participants(...occurrences) }]; return plan;
  };
  const writeRaw = raws => fs.writeFileSync(path.join(tmp, 'raw.jsonl'), raws.map(JSON.stringify).join('\n') + '\n');
  const originals = rows.map(row => structuredClone(row.raw));
  const mutate = fn => { const raws = structuredClone(originals); fn(raws); writeRaw(raws); };

  // #676 classes 1, 6, 7: exact text across scope/time/authority is not merged.
  for (const key of ['scope', 'time', 'authority']) {
    mutate(raws => { raws[1][key] = 'different'; });
    assert.equal((await run(single('dup', 1, 2))).outcomes[0].assessment, 'NEGATIVE');
  }
  // Class 2: distinct necessary conditions never receive duplicate credit.
  mutate(raws => { raws[1].content = 'Keep independent evidence.'; });
  assert.equal((await run(single('dup', 1, 2))).outcomes[0].assessment, 'UNKNOWN');
  writeRaw(originals);
  // Class 3: all pairs compatible, complete triple inconsistent.
  for (const pair of [[3, 4], [3, 5], [4, 5]]) assert.equal((await run(single('joint', ...pair))).outcomes[0].assessment, 'NEGATIVE');
  assert.equal((await run(single('joint', 3, 4, 5))).outcomes[0].assessment, 'POSITIVE');
  // Classes 4/5 positive+negative structured relations and retained identities.
  mutate(raws => { raws[8].concept = 'another-concept'; });
  assert.equal((await run(single('angles', 6, 7, 8, 9))).outcomes[0].assessment, 'NEGATIVE');
  writeRaw(originals);
  assert.equal((await run(single('alias', 10, 11))).outcomes[0].assessment, 'POSITIVE');
  assert.equal((await run(single('alias', 12, 13))).outcomes[0].assessment, 'NEGATIVE');
  // Class 9: injected mechanical responses/errors prove accounting, not quality.
  let attempts = 0;
  const failed = await evaluateRelations(resolved, { provider: 'jev', ask: async () => { attempts++; throw Error('fixture-failure'); } });
  assert.equal(attempts, 1); assert.equal(failed.accounting.calls, 1);
  assert.equal(failed.accounting.reportedTokens, null);
  assert.equal(failed.outcomes[0].execution, 'FAILED');
  assert.equal(failed.outcomes[1].execution, 'NOT_RUN');
  assert.equal(projectRelations(resolved, failed)[2].evaluation.semanticAssessment, 'UNKNOWN');
  const fake = (score, usage = { input_tokens: 1, output_tokens: 1 }) => async (_, questions) => ({ model: JEV_MODEL,
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: score }])), usage });
  for (const [score, expected] of [[.65, 'POSITIVE'], [.35, 'NEGATIVE'], [.5, 'UNKNOWN']]) {
    const injected = await evaluateRelations(resolved, { provider: 'jev', ask: fake(score) });
    assert.equal(injected.outcomes[0].assessment, expected);
    assert.equal(injected.accounting.calls, 5);
  }
  const missingUsage = await evaluateRelations(resolved, { provider: 'jev', ask: fake(.7, {}) });
  assert.equal(missingUsage.accounting.calls, 1);
  assert.equal(missingUsage.outcomes[1].execution, 'NOT_RUN');
  const tokenStop = await evaluateRelations(resolved, { provider: 'jev', ask: fake(.7, { total_tokens: 100000 }) });
  assert.equal(tokenStop.accounting.calls, 1);
  const contextMissing = p(); contextMissing.context[0].value = null;
  const notRun = await evaluateRelations(resolvePlan(contextMissing, tmp), { provider: 'jev', ask: async () => { throw Error('MUST_NOT_CALL'); } });
  assert.equal(notRun.accounting.calls, 0);
  assert.ok(notRun.outcomes.every(o => o.basis === 'MISSING_CONTEXT' && o.assessment === 'UNKNOWN'));
  const many = single('dup', 1, 2);
  many.candidates = Array.from({ length: 25 }, (_, i) => ({ id: 'candidate-' + i, check: 'dup',
    participants: participants(1, 2).map(p => ({ ...p, role: 'test-role-' + i })) }));
  const bounded = await evaluateRelations(resolvePlan(many, tmp), { provider: 'jev', ask: fake(.7) });
  assert.equal(bounded.accounting.calls, 24);
  assert.equal(bounded.outcomes[24].execution, 'NOT_RUN');
  // Class 10: every source/context/check/rule/membership dependency is bound.
  for (const change of [plan => { plan.context[0].revision = '2'; }, plan => { plan.checks[0].meaning += ' Changed.'; },
    plan => { plan.candidateRule.version = '2'; }, plan => { plan.candidates[1].participants.pop(); },
    plan => { plan.sources[0].revision = '2'; plan.obligations = []; plan.candidates = []; }]) {
    const plan = p(); change(plan);
    const stale = projectRelations(resolvePlan(plan, tmp), d);
    assert.ok(stale.every(row => !row.annotations.length && row.evaluation.evidenceCurrentness === 'STALE'));
  }
  mutate(raws => { raws.push({ id: 'new', content: 'New potential nary member.' }); });
  assert.ok(projectRelations(resolvePlan(p(), tmp), d).every(row => !row.annotations.length));
  writeRaw(originals);
  const empty = p(); empty.checks = []; empty.obligations = []; empty.candidates = [];
  const emptyResolved = resolvePlan(empty, tmp);
  assert.ok(projectRelations(emptyResolved, await evaluateRelations(emptyResolved)).every(row => row.evaluation.status === 'NOT_SELECTED'));
  const filtered = p(); filtered.filter = { source: 'demo', occurrence: 4 };
  assert.deepEqual(projectRelations(resolvePlan(filtered, fixture), d), [rows[3]]);
  // Invalid JSON/duplicate escaped/nested keys, unsafe numbers, UTF8, identities.
  for (const text of ['{', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":[{"a":1,"a":2}]}', '{"n":1e400}', '{"n":9007199254740993}', '{"s":"\\ud800"}']) assert.throws(() => strictJson(text));
  fs.writeFileSync(path.join(tmp, 'raw.jsonl'), Buffer.from([255, 10]));
  assert.throws(() => resolvePlan(p(), tmp), /INVALID_UTF8/);
  writeRaw([{ id: 'same', content: 'one' }, { id: 'same', content: 'two' }]);
  assert.throws(() => resolvePlan(empty, tmp), /RECORD_IDENTITY_CONFLICT/);
  fs.writeFileSync(path.join(tmp, 'raw.jsonl'), ' {"id":"same","content":"one"}\r\n\n{"id":"same","content":"one"}');
  const occurrences = resolvePlan(empty, tmp);
  assert.deepEqual(occurrences.rows.map(row => row.sourceRef.occurrence), [1, 3]);
  assert.equal(occurrences.rows.length, 2);
  assert.equal(occurrences.rows[0].sourceRef.endByte, Buffer.byteLength(' {"id":"same","content":"one"}\r'));
  const invalidD = structuredClone(d); invalidD.outcomes[0].participants.pop();
  assert.throws(() => projectRelations(resolved, invalidD), /INVALID_D|INVALID_OUTCOME/);
  writeRaw(originals);
  fs.writeFileSync(path.join(tmp, 'plan.json'), JSON.stringify(originalPlan));
  const entry = fileURLToPath(new URL('../bin/jev-review.mjs', import.meta.url));
  const installed = process.env.PATH?.split(path.delimiter).map(dir => path.join(dir, 'jev-review')).find(file => fs.existsSync(file));
  for (const command of entryTests ? [[process.execPath, entry], ...(installed ? [[installed]] : [])] : []) {
    const dFile = path.join(tmp, command.length === 1 ? 'installed-D.json' : 'source-D.json');
    const call = args => spawnSync(command[0], command.slice(1).concat('raw-relations', args), {
      cwd: tmp, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 20000,
    });
    const evaluation = call(['evaluate', path.join(tmp, 'plan.json'), dFile]);
    assert.equal(evaluation.error, undefined, 'native process spawn must be available');
    assert.equal(evaluation.status, 0, evaluation.stderr);
    const projection = call(['project', path.join(tmp, 'plan.json'), dFile]);
    assert.equal(projection.error, undefined, 'native process spawn must be available');
    assert.equal(projection.status, 0, projection.stderr);
    assert.equal(projection.stdout.trim().split('\n').length, 14, JSON.stringify({ command, stdout: projection.stdout.slice(0, 250), stderr: projection.stderr }));
    assert.equal(call(['evaluate', path.join(tmp, 'plan.json'), dFile]).status, 1);
  }
  console.log(JSON.stringify({ check: 'raw-relations', status: 'PASS', classes: 12,
    realProviderCalls: 0, semanticQuality: 'NOT_PROVEN', entryTests, installedEntry: entryTests && Boolean(installed), publicScratch: tmp }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--core-only'));
  await runRawRelationsTests({ entryTests: process.argv[2] !== '--core-only' });
}
