import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {developmentInput,evaluateDevelopment,developmentProjection} from './counterfactual/runtime.mjs';
const data=JSON.parse(fs.readFileSync(new URL('./counterfactual/development.json',import.meta.url)));
const input=()=>developmentInput(data,'Best',{mode:'test-double'});
const answer=choice=>({choice,model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:1}});
const ask=q=>Promise.resolve(answer(Object.hasOwn(q.criteria,'neither')?'neither':'no'));
test('development is exactly root D24 projected without Gold; a complete run has72 requests',async()=>{
  const i=input();assert.equal(i.rows.length,24);assert.ok(i.rows.every(r=>!Object.hasOwn(r,'gold')));
  let calls=0;const r=await evaluateDevelopment(i,q=>{calls++;return ask(q);});r.actualPosts=calls;
  const p=developmentProjection(i,r);assert.equal(calls,72);assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,true);assert.ok(p.repair);
  assert.ok(!JSON.stringify(p.repair).includes('goldScoring'));
});
test('one rejected judge remains unknown without starving independent target rows or being resent',async()=>{
  const i=input(),events=[];let n=0;
  const r=await evaluateDevelopment(i,q=>{n++;if(n===3)throw Error('bad probability sum');return ask(q);},e=>events.push(e));
  const p=developmentProjection(i,r);assert.equal(n,72);assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,false);
  assert.deepEqual(p.advice[0],{id:i.rows[0].id,status:'unknown',diagnosis:null});assert.ok(p.repair);
  assert.equal(events.filter(e=>e.kind==='attempt'&&e.id===i.rows[0].id+'/judge').length,1);
});
test('one missing target keeps all24 assigned but prevents invented repair input',async()=>{
  let n=0;const i=input(),r=await evaluateDevelopment(i,q=>{if(++n===1)throw Error('transport');return ask(q);});
  const p=developmentProjection(i,r);assert.equal(n,72);assert.equal(p.targetComplete,false);assert.equal(p.outputs.length,24);assert.equal(p.repair,null);
});
test('changed model ends further requests, retains all assigned unknowns and observed trace',async()=>{
  const i=input(),error=Error('changed');error.modelChanged=true;let n=0;
  const r=await evaluateDevelopment(i,()=>{n++;throw error;});assert.equal(n,1);assert.equal(r.rows.length,24);
  assert.equal(developmentProjection(i,r).targetComplete,false);
});
test('model drift on the final judge cannot permit generation despite complete target answers',async()=>{
  const i=input();let n=0;const error=Error('changed');error.modelChanged=true;
  const r=await evaluateDevelopment(i,q=>{if(++n===72)throw error;return ask(q);});const p=developmentProjection(i,r);
  assert.equal(n,72);assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,false);assert.equal(p.modelStable,false);assert.equal(p.repair,null);
});
test('projection rejects modified requests or invented diagnostic and retains independent classification',async()=>{
  const i=input(),r=await evaluateDevelopment(i,ask),changed=structuredClone(r);
  changed.rows[0].target[0].request.text='other';assert.throws(()=>developmentProjection(i,changed));
  r.rows[0].diagnosis={status:'qualified',diagnosis:'both_scope'};assert.throws(()=>developmentProjection(i,r));
});
test('real retained D72 report replays exactly without a new model call or correctness disclosure',()=>{
  const at=p=>JSON.parse(fs.readFileSync(new URL('./results/counterfactual-development-20261020/'+p,import.meta.url),'utf8'));
  assert.deepEqual(developmentProjection(at('input.json'),at('predictions.json')),at('projection.json'));
  const p=at('projection.json');assert.equal(p.targetComplete,true);assert.equal(p.judgeComplete,true);assert.equal(p.modelStable,true);
});
