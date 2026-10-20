import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {loadDevelopment,migrateRetiredConfirmation,repairPayloads} from './regression/development.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('./'+p,import.meta.url)));
test('retired H32 is development with cached evidence, not a fresh evaluation or model retry',()=>{
  const d=loadDevelopment();assert.equal(d.rows.length,32);assert.equal(d.provenance.newModelCalls,0);assert.equal(d.provenance.cachedJudgeQualified,31);
  assert.match(d.role,/never unseen/);assert.equal(d.provenance.originalRunConclusion,'failure');
  assert.deepEqual(d.rows.find(r=>r.id==='confirmation-01').diagnostic,{status:'qualified',diagnosis:'requirement_scope'});
  assert.deepEqual(d.rows.find(r=>r.id==='confirmation-06').diagnostic,{status:'unknown',diagnosis:null});
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
