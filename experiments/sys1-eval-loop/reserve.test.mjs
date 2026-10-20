import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {targetRequest} from './feedback-improvement.mjs';import {wireTemplate} from './regression/scoped-request.mjs';
import {observationRequest,observationTemplates,OBSERVATION_SCOPE} from './observation/request.mjs';
import {reserveRequest,reserveTemplateProof,RESERVE_O_SCOPE} from './reserve/request.mjs';import {developmentGuard,reserveIdentifiers} from './reserve/guard.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url),'utf8')),corpus=read('./observation/corpus.json'),sampling=read('./observation/sampling.json'),input=read('./results/observation-pass1-20261020/input.json'),best=input.best;
const h1=read('./results/observation-pass1-20261020/projection.json').measured.rows.map(r=>({id:r.id,...r.best})),h2=read('./results/observation-pass2-20261020/projection.json').measured.rows.map(r=>({id:r.id,...r.best}));
const counts={qualified:300,modelStable:true};
test('shared request default preserves every legacy full wire template exactly',async()=>{
 assert.deepEqual(await observationTemplates(best),input.templateProof);
 for(const axis of ['E','O']){const original=targetRequest('fixed body for request identity only',best,axis),legacy=axis==='E'?original:{...original,criteria:Object.fromEntries(Object.entries(original.criteria).map(([k,v])=>[k,v+OBSERVATION_SCOPE]))};assert.deepEqual(await wireTemplate(observationRequest('fixed body for request identity only',best,axis)),await wireTemplate(legacy));}
});
test('new treatment changes only symmetric O criteria and all retired D wires fit the unchanged client limit',async()=>{
 const proof=await reserveTemplateProof(best);assert.deepEqual(proof.templates.bestE,proof.templates.scopedE);assert.notDeepEqual(proof.templates.scopedO,input.templateProof.templates.scopedO);
 for(const c of corpus.cases){assert.deepEqual(reserveRequest(c.body,best,'sharedE'),targetRequest(c.body,best,'E'));const original=targetRequest(c.body,best,'O'),fresh=reserveRequest(c.body,best,'scopedO');assert.deepEqual({...fresh,criteria:original.criteria},original);for(const k of ['yes','no'])assert.equal(fresh.criteria[k],original.criteria[k]+RESERVE_O_SCOPE);const wire=await wireTemplate(fresh);assert.deepEqual(JSON.parse(wire.state),{body:c.body});assert.ok(Buffer.byteLength(JSON.stringify(wire))<24000);}
});
test('historical H1 anchor retains 220 known joint correct and seven unresolved cases',()=>{
 const score=developmentGuard(corpus.cases,h1,h2,h1,counts);assert.equal(score.baselineCorrect,220);assert.equal(score.candidateCorrect,220);assert.equal(score.unknownGold,7);assert.equal(score.positiveKnownCompleteGain,false);assert.equal(score.eligible,false);
});
test('synthetic E-wrong history: positive O-only gain is not joint improvement',()=>{
 const cs=Array.from({length:300},(_,i)=>({id:'d'+i,gold:{E:'yes',O:'yes'}})),a=cs.map(c=>({id:c.id,E:'no',O:'no'})),b=structuredClone(a),candidate=structuredClone(a);candidate[0].O='yes';const s=developmentGuard(cs,a,b,candidate,counts);assert.equal(s.positiveKnownCompleteGain,false);assert.equal(s.eligible,false);
});
test('missing protected answers stay unknown while a simultaneous known regression remains visible',()=>{
 const candidate=h1.map((r,i)=>({...r,O:corpus.cases[i].gold.O??r.O})),protectedIndices=corpus.cases.flatMap((c,i)=>c.gold.O!==null&&(h1[i].O===c.gold.O||h2[i].O===c.gold.O)?[i]:[]),[missing,broken]=protectedIndices;
 candidate[missing].O=null;candidate[broken].O=corpus.cases[broken].gold.O==='yes'?'no':'yes';const s=developmentGuard(corpus.cases,h1,h2,candidate,{qualified:299,modelStable:true});assert.deepEqual(s.unknownProtectedAxes,[{id:corpus.cases[missing].id,axis:'O'}]);assert.deepEqual(s.unionAxisRegressed,[{id:corpus.cases[broken].id,axis:'O'}]);assert.ok(!s.regressed.includes(corpus.cases[missing].id));assert.equal(s.eligible,false);
});
test('positive joint gain cannot hide a newly broken axis correct only in historical H2',()=>{
 const candidate=h1.map((r,i)=>({...r,O:corpus.cases[i].gold.O??r.O})),s=developmentGuard(corpus.cases,h1,h2,candidate,counts);assert.equal(s.positiveKnownCompleteGain,true);assert.equal(s.eligible,true);
 const i=corpus.cases.findIndex((c,i)=>c.gold.O!==null&&h1[i].O!==c.gold.O&&h2[i].O===c.gold.O);assert.ok(i>=0);candidate[i].O=h1[i].O;const rejected=developmentGuard(corpus.cases,h1,h2,candidate,counts);assert.equal(rejected.positiveKnownCompleteGain,true);assert.equal(rejected.noUnionAxisRegression,false);assert.ok(rejected.unionAxisRegressed.some(r=>r.id===corpus.cases[i].id&&r.axis==='O'));assert.equal(rejected.eligible,false);
});
test('qualification, drift, historical E alias and row identity are separate hard guards',()=>{
 const candidate=h1.map((r,i)=>({...r,O:corpus.cases[i].gold.O??r.O}));assert.equal(developmentGuard(corpus.cases,h1,h2,candidate,{qualified:300,modelStable:false}).eligible,false);const missing=structuredClone(candidate);missing[0].O=null;assert.equal(developmentGuard(corpus.cases,h1,h2,missing,{qualified:299,modelStable:true}).eligible,false);assert.throws(()=>developmentGuard(corpus.cases,h1,h2,candidate,{qualified:299,modelStable:true}));
 const bad=structuredClone(candidate);bad[0].E=bad[0].E==='yes'?'no':'yes';assert.throws(()=>developmentGuard(corpus.cases,h1,h2,bad,counts));assert.throws(()=>developmentGuard(corpus.cases,h1,h2,[...candidate].reverse(),counts));
});
test('reserve projection retains the original complement order and conditional census denominator',()=>{
 const p=reserveIdentifiers(sampling);assert.deepEqual(p.sourceIds,sampling.reserveIds);assert.equal(p.frameSize,23);assert.equal(p.originFrameSize,323);assert.equal(p.totalPosts,138);assert.equal(p.tailAlpha.denominator,1600);
 for(const mutate of [x=>x.reserveIds.reverse(),x=>x.reserveIds[0]=x.selectedIds[0],x=>x.draws[0].index=999,x=>x.frameNativeCommit='0'.repeat(40)]){const bad=structuredClone(sampling);mutate(bad);assert.throws(()=>reserveIdentifiers(bad));}
});
