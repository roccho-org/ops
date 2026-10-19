import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {prepare,scoreJudge} from './self-grading.mjs';
const json=n=>JSON.parse(fs.readFileSync(new URL('./results/self-grading-20261020/'+n,import.meta.url),'utf8'));
test('actual eighteen-call pilot replays every blinded request, truth and metric without new inference',()=>{
 const input=json('input.json'),truth=json('truth.json'),p=json('predictions.json'),m=json('measurement.json'),receipt=json('receipt.json');
 const canonical=prepare(undefined,input.execution);
 assert.deepEqual(input,canonical.input);assert.deepEqual(truth,canonical.truth);
 assert.deepEqual(m,scoreJudge(input,truth,p));
 assert.equal(p.execution.mode,'live');assert.equal(p.terminalReceipt,true);assert.equal(p.actualCalls,18);
 assert.equal(p.execution.sourceSha,receipt.activation.sha);assert.equal(p.execution.reviewedSourceSha,receipt.activation.parent);
 assert.equal(receipt.run.head_sha,p.execution.sourceSha);assert.equal(receipt.run.run_attempt,1);
 assert.equal(receipt.run.conclusion,'success');assert.equal(p.rows.length,18);
 assert.ok(p.rows.every(r=>r.status==='ok'&&r.answer.model==='jev-1.13.0'));
 assert.equal(m.measurementStatus,'OBSERVATION_COMPLETE');assert.equal(m.counts.acceptWrong,1);assert.equal(m.counts.rejectCorrect,6);
 assert.equal(m.falseAccept.denominator,4);assert.equal(m.falseReject.denominator,14);
 assert.equal(m.arms.after.falseAccept.value,null);assert.equal(m.qualityAdoptionAuthorized,false);
 const pairs=[...new Set(truth.rows.map(t=>t.caseId))].map(id=>{
   const by=arm=>p.rows.find(r=>r.id===truth.rows.find(t=>t.caseId===id&&t.arm===arm).id);
   return {before:by('before'),after:by('after')};
 });
 const same=pairs.filter(p=>JSON.stringify(p.before.request)===JSON.stringify(p.after.request));
 assert.equal(same.length,5);assert.ok(same.every(p=>p.before.answer.choice===p.after.answer.choice));
 const changed=pairs.filter(p=>!same.includes(p));
 assert.equal(changed.length,4);
 assert.equal(changed.filter(p=>p.before.answer.choice==='reject'&&p.after.answer.choice==='accept').length,2);
 assert.equal(changed.filter(p=>p.before.answer.choice==='accept'&&p.after.answer.choice==='reject').length,1);
 assert.equal(changed.filter(p=>p.before.answer.choice==='reject'&&p.after.answer.choice==='reject').length,1);
});

