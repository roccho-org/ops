import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {preparedAudit,retainedScreen} from './regression/runtime.mjs';import {evaluateFreshScoped,freshScopedProjection,verifyFreshEffects} from './regression/scoped-fresh.mjs';
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url),'utf8'));
test('A64 input is Gold-free and preserves the exact one selected screen configuration and pre-candidate corpus origin',async()=>{
 const prior=await retainedScreen(),i=await preparedAudit({fixture:true}),data=read('./regression/audit-gold.json');assert.equal(prior.provider.runId,39394190268);assert.equal(i.phase,'audit');assert.equal(i.rows.length,64);assert.equal(i.maxPosts,192);assert.deepEqual(i.templateProof,prior.input.templateProof);assert.equal(i.best,prior.input.best);assert.equal(i.dataOrigin.sourceCommit,'718b7774844f615f896c27d3072a43e4518cd41c');assert.equal(i.dataOrigin.selectionCommit,'f966a47e132acb8c7cd5bc73feeb60ed8a2afb7f');assert.ok(!JSON.stringify(i).includes('"gold"'));assert.ok(!JSON.stringify(i).includes('"basis"'));assert.equal(new Set(data.cases.map(c=>c.body)).size,64);
 const old=[...read('./counterfactual/confirmation-gold.json').cases,...read('./regression/screen-gold.json').cases];assert.ok(data.cases.every(c=>!old.some(d=>d.body===c.body)));assert.deepEqual(i.rows,data.cases.map(({id,family,body})=>({id,family,body})));
});
test('A192 physical events replay with shared O once and no result-conditioned selection or HTTP in this fixture',async()=>{
 const i=await preparedAudit({fixture:true}),events=[];let id=null;const observe=e=>{if(e.kind==='attempt')id=e.id;events.push(e);};const r=await evaluateFreshScoped(i,()=>{observe({kind:'post',id});return {model:'jev-1.13.0',choice:'no'};},observe);r.actualPosts=192;
 const p=await freshScopedProjection(i,r,read('./regression/audit-gold.json').cases);assert.equal(p.comparison.assigned,64);assert.equal(p.comparison.baselineQualified,64);assert.equal(p.comparison.candidateQualified,64);assert.equal(verifyFreshEffects(i,r,events).actualPosts,192);assert.equal(r.rows.flatMap(r=>r.observations).filter(t=>t.key==='sharedO').length,64);
});
