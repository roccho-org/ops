import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {scopedDevelopmentProjection,verifyScopedEffects} from './regression/scoped-development.mjs';
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url),'utf8'));
test('retained D2 is the actual E32 guard pass with historical O and immutable first failed development',async()=>{
 const at='./results/regression-scoped-development-20261020/',input=read(at+'input.json'),report=read(at+'predictions.json');
 const events=fs.readFileSync(new URL(at+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const old='./results/counterfactual-confirmation-20261020/',provider=read(old+'provider.json'),origin={runId:provider.runId,runAttempt:provider.runAttempt,head:provider.head};
 const cached=read(old+'projection.json').physicalRows.filter(r=>r.configuration==='best');
 const p={...await scopedDevelopmentProjection(input,report,read('./counterfactual/confirmation-gold.json').cases,cached,origin),effectCounts:verifyScopedEffects(input,report,events)};
 assert.deepEqual(p,read(at+'projection.json'));assert.equal(p.comparison.correct,31);assert.equal(p.comparison.disposition,'DEVELOPMENT_GUARD_PASS');assert.deepEqual(p.comparison.pair.resolved,['confirmation-17','confirmation-21']);assert.deepEqual(p.comparison.pair.axisRegressed,[]);assert.equal(p.effectCounts.actualPosts,32);
 assert.equal(read(at+'provider.json').runId,39392227245);assert.equal(read(at+'provider.json').runAttempt,1);
 assert.equal(Object.values(read('./results/regression-validation-20261020/projection.json').comparisons).every(c=>c.disposition==='OBSERVED_REGRESSION'),true);
});
