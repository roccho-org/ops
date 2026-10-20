import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {scopedDevelopmentProjection,verifyScopedEffects} from './regression/scoped-development.mjs';
import {freshScopedProjection,verifyFreshEffects} from './regression/scoped-fresh.mjs';
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

test('retained S preserves all144 physical observations and freezes the same one configuration before audit',async()=>{
 const at='./results/regression-screen-20261020/',i=read(at+'input.json'),r=read(at+'predictions.json'),events=fs.readFileSync(new URL(at+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const p={...await freshScopedProjection(i,r,read('./regression/screen-gold.json').cases),effectCounts:verifyFreshEffects(i,r,events)};assert.deepEqual(p,read(at+'projection.json'));assert.equal(p.comparison.baselineCorrect,41);assert.equal(p.comparison.candidateCorrect,45);assert.equal(p.comparison.disposition,'FINITE_GAIN');assert.deepEqual(p.comparison.pair.axisRegressed,[]);assert.equal(p.effectCounts.actualPosts,144);
 const selected=read(at+'selection.json');assert.equal(selected.auditAtSelection,'NOT_READ_NOT_RUN');assert.equal(selected.noFurtherCandidateChanges,true);assert.deepEqual(selected.configuration,{bestInstructions:i.best,templateProof:i.templateProof});
});

test('the one actual A64 confirms finite gain without losing prior errors or inventing universal accuracy',async()=>{
 const at='./results/regression-audit-20261020/',i=read(at+'input.json'),r=read(at+'predictions.json'),events=fs.readFileSync(new URL(at+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(x=>JSON.parse(x)),gold=read('./regression/audit-gold.json').cases;
 const p={...await freshScopedProjection(i,r,gold),effectCounts:verifyFreshEffects(i,r,events)};assert.deepEqual(p,read(at+'projection.json'));assert.equal(p.comparison.baselineCorrect,54);assert.equal(p.comparison.candidateCorrect,62);assert.equal(p.comparison.disposition,'FINITE_GAIN');assert.deepEqual(p.comparison.pair.axisRegressed,[]);assert.deepEqual(p.comparison.pair.resolved,['audit-005','audit-013','audit-017','audit-021','audit-037','audit-049','audit-061','audit-063']);assert.equal(p.effectCounts.actualPosts,192);assert.equal(p.effectCounts.unknown,0);
 const remaining=p.rows.filter(r=>r.arm==='scoped').filter(r=>{const g=gold.find(c=>c.id===r.id).gold;return r.E!==g.E||r.O!==g.O;}).map(r=>r.id);assert.deepEqual(remaining,['audit-025','audit-053']);
 assert.deepEqual(i.templateProof,read('./results/regression-screen-20261020/selection.json').configuration.templateProof);assert.equal(read(at+'provider.json').runId,39396123715);assert.equal(read(at+'provider.json').runAttempt,1);
});
test('series accounting counts native physical traces once and keeps missing provider totals and generation internals unknown',()=>{
 const s=read('./results/regression-audit-20261020/series-summary.json');const names=['regression-validation-20261020','regression-scoped-development-20261020','regression-screen-20261020','regression-audit-20261020'];let posts=0,input=0,output=0,answers=0;
 for(const name of names){const at='./results/'+name+'/',events=fs.readFileSync(new URL(at+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(x=>JSON.parse(x)),actual=events.filter(e=>e.kind==='post'),qualified=events.filter(e=>e.kind==='answer');assert.equal(actual.length,read(at+'predictions.json').actualPosts);assert.equal(new Set(actual.map(e=>e.id)).size,actual.length);posts+=actual.length;answers+=qualified.length;for(const e of qualified){input+=e.item.answer.usage.input_tokens;output+=e.item.answer.usage.output_tokens;assert.equal(e.item.answer.usage.total_tokens,undefined);}}
 assert.equal(posts,496);assert.equal(answers,496);assert.equal(s.physicalJevPosts,posts);assert.equal(s.qualifiedAnswers,answers);assert.equal(s.usage.input_tokens.knownSum,input);assert.equal(input,646177);assert.equal(s.usage.output_tokens.knownSum,output);assert.equal(output,15376);assert.equal(s.usage.total_tokens.knownCalls,0);assert.equal(s.usage.total_tokens.unknownCalls,496);assert.equal(s.standardGenerate.publicApiRequests,2);assert.equal(s.standardGenerate.internalProviderAttempts,null);assert.equal(s.standardGenerate.usage,null);assert.equal(s.moneyUSD,null);
});
