// Offline artifact/dataflow verification. It makes no semantic or provider calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const load = async path => (await readFile(new URL(path, import.meta.url), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sessions = new Set();
let cases = 0, questions = 0, judged = 0, guarded = 0, generated = 0, reused = 0, cliInvocations = 0, reportedCostUsd = 0;
for (const trial of ['', 'confirmation/']) {
  const prefix = 'results/' + trial;
  const inputPath = trial ? 'fixtures/confirmation-inputs.jsonl' : 'fixtures/inputs.jsonl';
  const inputs = await load(inputPath), plans = await load(prefix + 'plan.jsonl'), outputs = await load(prefix + 'judge.jsonl');
  const producers = await load(prefix + 'provider-plan.jsonl'), evaluators = await load(prefix + 'provider-judge.jsonl');
  assert.deepEqual(plans.map(row => row.id), inputs.map(row => row.id));
  assert.deepEqual(outputs.map(row => row.id), inputs.map(row => row.id));
  assert.equal(producers.length, inputs.length);
  let cursor = 0;
  for (let i = 0; i < plans.length; i++) {
    const { plan, status } = plans[i], result = outputs[i].result;
    assert.equal(status, 'PREPARED');
    assert.deepEqual(producers[i].request.goal, inputs[i].goal);
    assert.deepEqual(producers[i].request.observations, inputs[i].observations);
    assert.deepEqual(Object.keys(producers[i].request).sort(), ['cores', 'goal', 'maxQuestions', 'observations']);
    assert.deepEqual(result.judgments.map(row => row.id), plan.questions.map(row => row.id));
    assert.equal(result.goalCoverage, 'NOT_CERTIFIED'); assert.equal(result.authority, false);
    assert.deepEqual(result.missing.slice(0, plan.missing.length), plan.missing);
    cases++; questions += plan.questions.length;
    for (let j = 0; j < plan.questions.length; j++) {
      const query = plan.questions[j], answer = result.judgments[j];
      if (query.core === null) generated++; else reused++;
      if (answer.status === 'INCOMPLETE') { assert.ok(answer.missingRefs.length); guarded++; continue; }
      assert.equal(answer.status, 'OBSERVED');
      const native = evaluators[cursor++];
      assert.deepEqual(JSON.parse(native.request.text), plan.request);
      assert.equal(native.request.instructions, query.question);
      assert.deepEqual(native.request.criteria, query.criteria);
      assert.equal(native.response.structured_output.label, answer.label); judged++;
    }
  }
  assert.equal(cursor, evaluators.length);
  for (const native of [...producers, ...evaluators]) {
    assert.equal(native.exitCode, 0); assert.equal(native.response.is_error, false);
    assert.ok(native.response.session_id); assert.ok(!sessions.has(native.response.session_id));
    sessions.add(native.response.session_id); cliInvocations++;
    assert.ok(Number.isFinite(native.response.total_cost_usd)); reportedCostUsd += native.response.total_cost_usd;
  }
}
process.stdout.write(JSON.stringify({ cases, questions, judged, guarded, generated, reused, cliInvocations,
  distinctSessions: sessions.size, reportedCostUsd, nativeHttpCalls: null, invoiceCost: null,
  semanticQualityCertified: false, goalCoverageCertified: false }) + '\n');
