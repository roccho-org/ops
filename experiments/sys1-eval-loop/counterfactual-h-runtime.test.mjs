import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {confirmationInput,evaluateConfirmation,confirmationProjection} from './counterfactual/runtime.mjs';
import {configurationPlan} from './counterfactual/confirmation.mjs';
const data={schema:'ops.sys1.counterfactual-root-corpus.v1',name:'confirmation',cases:Array.from({length:32},(_,n)=>({id:'c'+n,family:'fixture',body:'body '+n,gold:{E:'no',O:'no',basis:'not model input'}}))};
const frozen={plan:configurationPlan({best:'Best',feedback:'F','no-feedback':'N'})};
const input=()=>confirmationInput(data,frozen,{testDouble:true});
const answer=choice=>({choice,model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:1}});
const ask=q=>Promise.resolve(answer(Object.hasOwn(q.criteria,'neither')?'neither':'no'));
test('H physical calls use fixed case rotation and Gold-free inputs, with no alias duplication',async()=>{
  const i=input();assert.equal(i.maxPosts,224);assert.ok(!JSON.stringify(i).includes('basis'));assert.ok(!JSON.stringify(i).includes('gold'));
  let n=0;const r=await evaluateConfirmation(i,q=>{n++;return ask(q);});
  assert.equal(n,224);assert.deepEqual(r.rows.slice(0,3).map(x=>x.order),[['best','feedback','no-feedback'],['feedback','no-feedback','best'],['no-feedback','best','feedback']]);
  const p=confirmationProjection(i,r,data.cases);assert.equal(p.physicalRows.length,96);assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,true);
  assert.equal(p.comparison.A.outcome,'NO_GAIN_OBSERVED');assert.equal(p.comparison.B.outcome,'NO_GAIN_OBSERVED');assert.equal(p.judgeMetrics.correctClassification,32);
});
test('one control failure leaves all assignments and measurable A, with B UNKNOWN',async()=>{
  let n=0;const i=input(),r=await evaluateConfirmation(i,q=>{if(++n===5)throw Error('control unknown');return ask(q);});
  const p=confirmationProjection(i,r,data.cases);assert.equal(n,224);assert.equal(p.physicalRows.length,96);
  assert.equal(p.comparison.A.outcome,'NO_GAIN_OBSERVED');assert.equal(p.comparison.B.outcome,'UNKNOWN');
});
test('a rejected H judge stays unknown and is never used to rewrite the candidates',async()=>{
  let n=0;const i=input(),r=await evaluateConfirmation(i,q=>{if(++n===7)throw Error('bad judge');return ask(q);});
  const p=confirmationProjection(i,r,data.cases);assert.equal(n,224);assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,false);
  assert.equal(p.judgeMetrics.unknown,1);assert.deepEqual(p.diagnoses[0],{id:'c0',status:'unknown',diagnosis:null});
});
test('terminal H judge model drift invalidates both comparisons but preserves observed target scores',async()=>{
  let n=0;const i=input(),error=Error('changed');error.modelChanged=true;
  const r=await evaluateConfirmation(i,q=>{if(++n===224)throw error;return ask(q);});const p=confirmationProjection(i,r,data.cases);
  assert.equal(p.targetComplete,true);assert.equal(p.modelStable,false);assert.equal(p.comparison.A.outcome,'UNKNOWN');assert.equal(p.comparison.B.outcome,'UNKNOWN');
  assert.equal(p.comparison.A.rawOutcome,'NO_GAIN_OBSERVED');
});
test('projection rejects changed execution order, source requests and scoring body',async()=>{
  const i=input(),r=await evaluateConfirmation(i,ask),bad=structuredClone(r);bad.rows[0].order.reverse();assert.throws(()=>confirmationProjection(i,bad,data.cases));
  const wrong=structuredClone(r);wrong.rows[0].configurations[0].target[0].request.text='changed';assert.throws(()=>confirmationProjection(i,wrong,data.cases));
  const gold=structuredClone(data.cases);gold[0].body='changed';assert.throws(()=>confirmationProjection(i,r,gold));
});
test('actual H copy is rooted in frozen corpus and inputs use exact frozen candidate bytes',()=>{
  const corpus=JSON.parse(fs.readFileSync(new URL('./counterfactual/confirmation-gold.json',import.meta.url)));
  const saved=JSON.parse(fs.readFileSync(new URL('./results/counterfactual-repair-20261020/parsed.json',import.meta.url)));
  const i=confirmationInput(corpus,saved,{testDouble:true});assert.equal(i.rows.length,32);assert.equal(i.maxPosts,224);
  for(const arm of ['feedback','no-feedback'])assert.equal(i.plan.configurations.find(c=>c.id===arm).instructions,saved.results[arm].candidate.instructions);
  assert.equal(new Set(i.rows.map(c=>c.body)).size,32);assert.ok(!Object.hasOwn(i.rows[0],'gold'));
});
