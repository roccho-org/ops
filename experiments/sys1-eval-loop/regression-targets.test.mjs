import test from 'node:test';import assert from 'node:assert/strict';
import {developmentPlan,evaluateTargets,developmentProjection,verifyEffects} from './regression/targets.mjs';
const data={best:'Best',rows:Array.from({length:32},(_,i)=>({id:'c'+i,body:'body '+i}))};
const result=s=>({status:'valid',candidate:{instructions:s}}),results={feedback:result('F'),'no-feedback':result('N')};
const input=(r=results)=>{const plan=developmentPlan(data,r);return {rows:data.rows,plan,maxPosts:plan.maxPosts,expectedModel:'fixed'};};
const gold=data.rows.map(r=>({...r,gold:{E:'no',O:'no'}})),cached=data.rows.map(r=>({id:r.id,status:'qualified',model:'fixed',E:'no',O:'no'}));
const ask=async()=>({choice:'no',model:'fixed',usage:{input_tokens:1,output_tokens:1}});
test('D uses cached Best and only new unique candidate targets, with case rotation and no judge',async()=>{
 const i=input();assert.equal(i.maxPosts,128);let n=0;const r=await evaluateTargets(i,q=>{n++;assert.ok(!q.text.includes('gold'));return ask();});
 assert.equal(n,128);assert.deepEqual(r.rows.slice(0,2).map(r=>r.order),[['feedback','no-feedback'],['no-feedback','feedback']]);
 const p=developmentProjection(i,r,gold,cached);assert.equal(p.physical.length,64);assert.equal(p.rows.length,96);assert.ok(Object.values(p.comparisons).every(r=>r.eligible));
});
test('identical candidates use one trace and identical Best uses no new trace or improvement treatment',async()=>{
 let i=input({feedback:result('F'),'no-feedback':result('F')});assert.equal(i.maxPosts,64);let n=0;const r=await evaluateTargets(i,()=>{n++;return ask();});assert.equal(n,64);
 const p=developmentProjection(i,r,gold,cached);assert.equal(p.rows.find(r=>r.arm==='no-feedback').observationOrigin,'native configuration alias');
 i=input({feedback:result('Best'),'no-feedback':{status:'unknown',candidate:null}});assert.equal(i.maxPosts,0);const z=developmentProjection(i,await evaluateTargets(i,()=>assert.fail('no requests')),gold,cached);
 assert.equal(z.comparisons.feedback.disposition,'IDENTICAL_CONFIGURATION_NO_TREATMENT');assert.equal(z.comparisons['no-feedback'].disposition,'INVALID_CANDIDATE_UNKNOWN');
});
test('a failed target leaves full denominator and peer results while model drift invalidates all guards',async()=>{
 let n=0,i=input(),r=await evaluateTargets(i,()=>{if(++n===2)throw Error('unknown');return ask();}),p=developmentProjection(i,r,gold,cached);
 assert.equal(n,128);assert.equal(p.comparisons.feedback.disposition,'UNKNOWN');assert.equal(p.comparisons['no-feedback'].eligible,true);
 n=0;const e=Error('model');e.modelChanged=true;r=await evaluateTargets(i,()=>{if(++n===128)throw e;return ask();});p=developmentProjection(i,r,gold,cached);
 assert.equal(p.modelStable,false);assert.ok(Object.values(p.comparisons).every(r=>!r.eligible));
});
test('projection rejects changed request, row order or Gold body instead of silently rescoring',async()=>{
 const i=input(),r=await evaluateTargets(i,ask);const bad=structuredClone(r);bad.rows[0].configurations[0].target[0].request.text='other';assert.throws(()=>developmentProjection(i,bad,gold,cached));
 const g=structuredClone(gold);g[0].body='other';assert.throws(()=>developmentProjection(i,r,g,cached));
});
test('effect counts are tied to explicit attempts and posts rather than unverified summary numbers',async()=>{
 const i=input(),events=[];let active=null;const observe=e=>{if(e.kind==='attempt')active=e.id;events.push(e);};
 const r=await evaluateTargets(i,()=>{observe({kind:'post',id:active});return ask();},observe);r.actualPosts=128;
 assert.deepEqual(verifyEffects(i,r,events),{assignedPosts:128,attempted:128,actualPosts:128,qualified:128,unknown:0,unattempted:0});
 assert.throws(()=>verifyEffects(i,{...r,actualPosts:127},events));assert.throws(()=>verifyEffects({...i,maxPosts:127},r,events));
 assert.throws(()=>verifyEffects(i,r,[...events,{kind:'post',id:events[0].id}]));
 const failedEvents=[];let id=null;const observeFailed=e=>{if(e.kind==='attempt')id=e.id;failedEvents.push(e);};let n=0;
 const failed=await evaluateTargets(i,()=>{observeFailed({kind:'post',id});if(++n===1)throw Error('unknown');return ask();},observeFailed);failed.actualPosts=128;
 assert.equal(verifyEffects(i,failed,failedEvents).unknown,1);
 const swapped=structuredClone(failedEvents);swapped.find(e=>e.kind==='qualification-unknown').id='unassigned/E';assert.throws(()=>verifyEffects(i,failed,swapped));
});
