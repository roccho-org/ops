import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {loadDevelopment,migrateRetiredConfirmation,repairPayloads,receiveRepairCandidate,collectRepairCandidates} from './regression/development.mjs';
import {targetRequest} from './feedback-improvement.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('./'+p,import.meta.url)));
test('retired H32 is development with cached evidence, not a fresh evaluation or model retry',()=>{
  const d=loadDevelopment();assert.equal(d.rows.length,32);assert.equal(d.provenance.newModelCalls,0);assert.equal(d.provenance.cachedJudgeQualified,31);
  assert.match(d.role,/never unseen/);assert.equal(d.provenance.originalRunConclusion,'failure');
  assert.deepEqual(d.rows.find(r=>r.id==='confirmation-01').diagnostic,{status:'qualified',diagnosis:'requirement_scope'});
  assert.deepEqual(d.rows.find(r=>r.id==='confirmation-06').diagnostic,{status:'unknown',diagnosis:null});
  assert.deepEqual(d.rows.find(r=>r.id==='confirmation-12').diagnostic,{status:'qualified',diagnosis:'evidence_scope'});
  assert.equal(d.rows.find(r=>r.id==='confirmation-12').answer.O,'yes'); // judge false alarm against the now-correct draft, not Gold advice.
});
test('feedback is mechanically against rejected F outputs rather than the retained Best output',()=>{
  const d=loadDevelopment();assert.equal(d.rows[0].answer.E,'yes');assert.equal(d.rows[0].answer.O,'no');
  assert.notEqual(d.best,d.startingDraft);assert.ok(d.startingDraft.startsWith(d.best));
  assert.ok(!JSON.stringify(d.feedback).includes('gold'));assert.ok(!JSON.stringify(d.feedback).includes('basis'));
});
test('same common Best/draft/bodies/answers is used in both arms, and only typed advice differs',()=>{
  const d=loadDevelopment(),p=repairPayloads(d),f=JSON.parse(p.feedback.prompt),n=JSON.parse(p['no-feedback'].prompt);
  assert.deepEqual(f.common,n.common);assert.deepEqual(p.feedback.model,p['no-feedback'].model);
  assert.equal(f.common.cases.length,32);assert.ok(f.common.cases.every(c=>Object.keys(c).sort().join(',')==='answer,body'));
  assert.deepEqual(n.advice,{available:false,rows:[]});assert.equal(f.advice.rows.length,32);
});
test('missing cached targets or a non-stable source cannot become a valid migration',()=>{
  const base='results/counterfactual-confirmation-20261020/',i=read(base+'input.json'),r=read(base+'predictions.json'),p=read(base+'projection.json'),provider=read(base+'provider.json');
  const missing=structuredClone(r);missing.rows[0].configurations.find(c=>c.id==='feedback').target.pop();assert.throws(()=>migrateRetiredConfirmation(i,missing,p,provider,{}));
  assert.throws(()=>migrateRetiredConfirmation(i,r,{...p,modelStable:false},provider,{}));
});
test('new-series parser allows concise full rewriting without weakening JSON or rescuing prose',()=>{
  const d=loadDevelopment(),result=receiveRepairCandidate({data:{text:'{"instructions":"Concise general rules"}'}});
  assert.equal(result.status,'valid');assert.ok(!result.candidate.instructions.startsWith(d.best));
  for(const raw of ['{"instructions":""}','{"instructions":"x","extra":1}','prefix {"instructions":"x"}','```json\n{"instructions":"x"}\n```',JSON.stringify({instructions:'x'.repeat(6001)})])assert.equal(receiveRepairCandidate({data:{text:raw}}).status,'invalid');
  for(const axis of ['E','O']){assert.deepEqual(d.feedback.common.taskContract[axis],targetRequest('fixture',d.best,axis).criteria);assert.equal(d.feedback.common.taskContract.axisInstructions[axis],targetRequest('','',axis).instructions);}
});
test('a failed or missing API arm remains unknown without replacing or losing its valid peer',()=>{
  const valid={data:{text:'{"instructions":"General rules"}'}};
  for(const absent of [null,{}, {data:{text:3}}])assert.equal(receiveRepairCandidate(absent).status,'unknown');
  for(const failed of [undefined,{receipt:{status:null,signal:'SIGTERM'}},{receipt:{status:1},response:valid},{receipt:{status:0}}]){
    const got=collectRepairCandidates({'no-feedback':failed,feedback:{receipt:{status:0},response:valid}});
    assert.equal(got['no-feedback'].status,'unknown');assert.equal(got['no-feedback'].candidate,null);
    assert.equal(got.feedback.status,'valid');assert.equal(got.feedback.candidate.instructions,'General rules');
  }
  const invalid=collectRepairCandidates({'no-feedback':{receipt:{status:0},response:{data:{text:'prose'}}}});
  assert.equal(invalid['no-feedback'].status,'invalid');assert.equal(invalid['no-feedback'].candidate,null);assert.equal(invalid.feedback.status,'unknown');
});
test('retained development and actual two repair inputs exactly replay from the closed evidence',()=>{
  const d=loadDevelopment();assert.deepEqual(read('results/regression-development-20261020/development.json'),d);
  assert.deepEqual(read('results/regression-development-20261020/repair-payloads.json'),repairPayloads(d));
});
