import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {prepareDevelopment,evaluateDevelopment,verifyDevelopment,assertDevelopmentEffectInput} from './observation/development.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url),'utf8'));
const corpus=read('./real-cases/corpus.json'),historical={input:read('./results/real-case-pass1-20261020/input.json'),report:read('./results/real-case-pass1-20261020/predictions.json'),events:fs.readFileSync(new URL('./results/real-case-pass1-20261020/events.jsonl',import.meta.url),'utf8').trim().split('\n').map(x=>JSON.parse(x))};
const input=await prepareDevelopment(corpus,historical,{mode:'keyless test double'});
async function simulate(choose){const events=[];let n=0,active=null;const observe=e=>{if(e.kind==='attempt')active=e.id;events.push(e);};const report=await evaluateDevelopment(input,async request=>{const index=n++;observe({kind:'post',id:active});return choose(index,request);},observe);report.actualPosts=n;return {report,events};}
const answer=choice=>({model:'jev-1.13.0',choice,usage:{input_tokens:1,output_tokens:1}});
test('development reuses only first-pass exact historical E/O and removes Gold from model input',()=>{
 assert.equal(input.rows.length,118);assert.equal(input.maxPosts,118);assert.ok(input.rows.every(r=>!Object.hasOwn(r,'gold')&&!Object.hasOwn(r,'sourceId')));assert.ok(input.rows.every(r=>r.aliases.E.repId===1&&r.aliases.O.key==='sharedO'));assert.equal(input.execution.mode,'keyless test double');
});
test('credential-safe effect validation needs no keyless wire capture and rejects altered historical inputs',()=>{
 assert.ok(!process.env.JEV_API_KEY);process.env.JEV_API_KEY='synthetic-unit-test-sentinel-not-a-credential';try{assertDevelopmentEffectInput(input,historical,input.execution);}finally{delete process.env.JEV_API_KEY;}
 for(const mutate of [x=>x.rows[0].body+=' changed',x=>x.rows[0].aliases.O.choice=x.rows[0].aliases.O.choice==='yes'?'no':'yes',x=>x.best+=' changed',x=>x.execution.source='changed']){const bad=structuredClone(input);mutate(bad);assert.throws(()=>assertDevelopmentEffectInput(bad,historical,input.execution));}
});
test('keyless all-correct double passes known development guard while preserving null four',async()=>{
 const {report,events}=await simulate(i=>answer(corpus.cases[i].gold.O??'no')),p=await verifyDevelopment(input,report,events,corpus);
 assert.equal(p.effectCounts.actualPosts,118);assert.equal(p.guard.eligible,true);assert.equal(p.summary.unknown,4);assert.equal(p.summary.axes.O.regressions,0);assert.equal(p.summary.axes.O.b,35);assert.equal(p.summary.axes.O.c,0);
});
test('qualified negative and transport unknown remain distinct; failures cannot be forged',async()=>{
 const flat=await simulate(i=>answer(input.rows[i].aliases.O.choice)),negative=await verifyDevelopment(input,flat.report,flat.events,corpus);assert.equal(negative.outcome,'DEVELOPMENT_GUARD_FAIL');assert.equal(negative.guard.positiveKnownGain,false);
 const partial=await simulate(i=>{if(i===0)throw Error('test failure');return answer(corpus.cases[i].gold.O??'no');}),p=await verifyDevelopment(input,partial.report,partial.events,corpus);assert.equal(p.outcome,'UNKNOWN');assert.equal(p.effectCounts.unknown,1);assert.equal(p.effectCounts.actualPosts,118);
 const forged=structuredClone(partial.events);forged.find(e=>e.kind==='qualification-unknown').id='not-an-attempt/scopedO';await assert.rejects(()=>verifyDevelopment(input,partial.report,forged,corpus));
});
test('drift stops subsequent effects and all unattempted assignments stay unknown',async()=>{
 const {report,events}=await simulate(()=>({model:'different-model',choice:'yes'})),p=await verifyDevelopment(input,report,events,corpus);
 assert.equal(p.outcome,'UNKNOWN');assert.equal(p.effectCounts.actualPosts,1);assert.equal(p.effectCounts.unattempted,117);assert.equal(p.effectCounts.unknown,118);
});
test('historical aliases cannot silently use pass2 or changed bodies/counts',async()=>{
 const wrong=structuredClone(historical);wrong.input.repId=2;await assert.rejects(()=>prepareDevelopment(corpus,wrong,{}));const data=structuredClone(corpus);data.cases[0].body+=' changed';await assert.rejects(()=>prepareDevelopment(data,historical,{}));
 const {report,events}=await simulate(i=>answer(input.rows[i].aliases.O.choice));report.actualPosts=117;await assert.rejects(()=>verifyDevelopment(input,report,events,corpus));
});
test('net gain cannot hide destruction of a previously correct O axis',async()=>{
 const firstCorrect=corpus.cases.findIndex((c,i)=>c.gold.O!==null&&c.gold.O===input.rows[i].aliases.O.choice);
 const {report,events}=await simulate(i=>answer(i===firstCorrect?(corpus.cases[i].gold.O==='yes'?'no':'yes'):(corpus.cases[i].gold.O??'no'))),p=await verifyDevelopment(input,report,events,corpus);
 assert.equal(p.guard.positiveKnownGain,true);assert.equal(p.guard.noKnownRegression,false);assert.equal(p.guard.eligible,false);assert.equal(p.outcome,'DEVELOPMENT_GUARD_FAIL');assert.equal(p.summary.axes.O.regressions,1);
});
