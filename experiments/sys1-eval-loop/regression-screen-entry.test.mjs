import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {preparedScreen,retainedScopedDevelopment} from './regression/runtime.mjs';import {evaluateFreshScoped,freshScopedProjection,verifyFreshEffects} from './regression/scoped-fresh.mjs';
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url),'utf8'));
test('real S48 admission requires retained D2 guard and unchanged actual templates, with only Gold-free runtime rows',async()=>{
 const prior=await retainedScopedDevelopment(),i=await preparedScreen({fixture:true});assert.equal(prior.provider.runId,39392227245);assert.equal(i.phase,'screen');assert.equal(i.rows.length,48);assert.equal(i.maxPosts,144);assert.deepEqual(i.templateProof,prior.input.templateProof);assert.equal(i.best,prior.input.best);
 assert.equal(i.dataOrigin.sourceCommit,'718b7774844f615f896c27d3072a43e4518cd41c');assert.ok(!JSON.stringify(i).includes('"gold"'));assert.ok(!JSON.stringify(i).includes('"basis"'));assert.equal(new Set(i.rows.map(c=>c.body)).size,48);
});
test('S data has complete unmodified Gold and no exact body reuse from D, and fake qualified observations can be replayed without HTTP',async()=>{
 const data=read('./regression/screen-gold.json'),old=read('./counterfactual/confirmation-gold.json').cases,i=await preparedScreen({fixture:true});assert.equal(new Set(data.cases.map(c=>c.id)).size,48);assert.deepEqual(data.cases.map(c=>c.id),i.rows.map(c=>c.id));assert.ok(data.cases.every(c=>!old.some(d=>d.body===c.body)));
 const events=[];let id=null;const observe=e=>{if(e.kind==='attempt')id=e.id;events.push(e);};
 const report=await evaluateFreshScoped(i,()=>{observe({kind:'post',id});return {model:'jev-1.13.0',choice:'no'};},observe);report.actualPosts=144;
 const p=await freshScopedProjection(i,report,data.cases);assert.equal(p.comparison.assigned,48);assert.equal(verifyFreshEffects(i,report,events).actualPosts,144);assert.equal(report.rows.flatMap(r=>r.observations).filter(r=>r.key==='sharedO').length,48);
});
