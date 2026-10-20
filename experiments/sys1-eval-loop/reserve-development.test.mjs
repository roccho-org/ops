import test from 'node:test';import assert from 'node:assert/strict';
import {retainedDevelopment,prepareDevelopment,assertDevelopmentEffectInput,evaluateDevelopment,verifyDevelopment} from './reserve/development.mjs';
const data=retainedDevelopment(),execution={source:'1'.repeat(40),activation:'2'.repeat(40),runUrl:'https://github.com/roccho-org/ops/actions/runs/1'},input=await prepareDevelopment(data,execution);
async function fixture(mode){const events=[];let id=null,calls=0;const observe=e=>{events.push(e);if(e.kind==='attempt')id=e.id;};const flags=data.history[0].events.find(e=>e.kind==='response-flags');const report=await evaluateDevelopment(input,async()=>{calls++;observe({kind:'post',id});if(mode==='missing'&&calls===1){observe({kind:'failure',id,stage:'provider'});throw Error('test-only missing');}const drift=mode==='drift'&&calls===1;observe({...flags,id,modelMatches:!drift});if(drift){observe({kind:'failure',id,stage:'response-model'});const error=Error('test drift');error.modelChanged=true;throw error;}const i=calls-1,c=data.corpus.cases[i];return {choice:c.gold.O??input.rows[i].aliases.O.choice,model:input.expectedModel,usage:{input_tokens:1,output_tokens:1}};},observe);report.actualPosts=calls;return {events,report};}
test('D preparation replays both original histories and emits only Gold-free fixed new-O assignments',()=>{
 assert.equal(input.rows.length,300);assert.equal(input.maxPosts,300);assert.equal(input.rows[0].aliases.O.repId,1);assert.equal(input.rows[0].aliases.O.runUrl,'https://github.com/roccho-org/ops/actions/runs/39426848156');assert.equal(input.rows[0].aliases.O.source,data.history[0].input.execution.source);assert.ok(input.rows.every(r=>!('gold'in r)&&!('sourceId'in r)));
 const saved=process.env.JEV_API_KEY;try{process.env.JEV_API_KEY='test-only-no-network';assertDevelopmentEffectInput(input,data,execution);}finally{if(saved===undefined)delete process.env.JEV_API_KEY;else process.env.JEV_API_KEY=saved;}
 const bad=structuredClone(input);bad.rows[0].aliases.E.choice=bad.rows[0].aliases.E.choice==='yes'?'no':'yes';assert.throws(()=>assertDevelopmentEffectInput(bad,data,execution));
});
test('all-known-correct test double preserves seven Gold-null cases and passes complete/union guard',async()=>{
 const {events,report}=await fixture('correct'),p=await verifyDevelopment(input,report,events,data);assert.equal(p.guard.unknownGold,7);assert.equal(p.guard.eligible,true);assert.equal(p.effectCounts.qualified,300);assert.equal(p.effectCounts.actualPosts,300);
});
test('missing qualified answer remains UNKNOWN rather than known regression',async()=>{
 const {events,report}=await fixture('missing'),p=await verifyDevelopment(input,report,events,data);assert.equal(p.effectCounts.unknown,1);assert.equal(p.guard.qualificationComplete,false);assert.equal(p.guard.unionAxisRegressed.length,0);assert.equal(p.outcome,'UNKNOWN');
});
test('drift stops the loop and retains 300 assignments with 299 unattempted',async()=>{
 const {events,report}=await fixture('drift'),p=await verifyDevelopment(input,report,events,data);assert.equal(p.guard.modelStable,false);assert.equal(p.effectCounts.actualPosts,1);assert.equal(p.effectCounts.unattempted,299);assert.equal(p.effectCounts.unknown,300);assert.equal(p.outcome,'UNKNOWN');
});
test('new reader rejects forged qualification, failure partition and physical call counts',async()=>{
 const good=await fixture('correct'),bad=structuredClone(good);bad.events.find(e=>e.kind==='response-flags').sumMatches=false;await assert.rejects(()=>verifyDevelopment(input,bad.report,bad.events,data));const count=structuredClone(good);count.report.actualPosts=299;await assert.rejects(()=>verifyDevelopment(input,count.report,count.events,data));const missing=await fixture('missing');missing.events.find(e=>e.kind==='failure').id='not-an-attempt';await assert.rejects(()=>verifyDevelopment(input,missing.report,missing.events,data));
});
