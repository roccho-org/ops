import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInput,score} from './run.mjs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const input=loadInput(fileURLToPath(new URL('./candidates/baseline.json',import.meta.url)),
  fileURLToPath(new URL('./suites/role-boundaries/',import.meta.url)));
const gold=read('./suites/role-boundaries/expected.jsonl').trim().split('\n').map(JSON.parse);
const baseline=JSON.parse(read('./results/closure-20261019/baseline.json'));
test('retained live baseline re-scores exactly, with all three errors and costs unknown',()=>{
  const calculated=score(input,gold,{
    ...baseline,schema:'ops.sys1.predictions.v1',
    modelAlias:input.contract.modelAlias
  });
  assert.deepEqual(calculated,baseline);
  assert.equal(calculated.correct,5);assert.equal(calculated.actualCalls,8);
  assert.equal(calculated.falsePositives,1);assert.equal(calculated.falseNegatives,2);
  assert.equal(calculated.cost,null);assert.equal(calculated.goldAuthorIndependent,false);
  assert.equal(calculated.qualityAdoptionAuthorized,false);
});
