import assert from 'node:assert/strict';

// Shared by the closed three-template comparison and the next O-only D reader.
// Kept independent of endpoints, credentials, Gold and round-specific admission.
function verifyEvents(role4,report,events,attempts,posts,answers,failures){
 const flags=events.filter(e=>e.kind==='response-flags'),errors=events.filter(e=>e.kind==='failure');assert.equal(new Set(flags.map(e=>e.id)).size,flags.length);assert.ok(flags.every(e=>posts.includes(e.id)));assert.equal(new Set(errors.map(e=>e.id)).size,errors.length);assert.deepEqual(errors.map(e=>e.id).sort(),[...failures].sort());
 const index=(kind,id)=>events.findIndex(e=>e.kind===kind&&e.id===id);
 for(const e of flags){assert.equal(typeof e.modelMatches,'boolean');assert.ok(index('post',e.id)<index('response-flags',e.id));}
 for(const id of answers){const f=flags.find(e=>e.id===id);assert.ok(f);for(const key of ['modelMatches','answerKeyMatches','probabilitiesFinite','probabilitiesInRange','sumMatches','selectedIsMax'])assert.equal(f[key],true);const count=role4&&id.endsWith('/role4')?4:2;assert.equal(f.probabilityCount,count);assert.ok(Number.isFinite(f.probabilitySum)&&Math.abs(f.probabilitySum-1)<1e-5);assert.ok(Number.isFinite(f.selectedProbability)&&f.selectedProbability>=0&&f.selectedProbability<=1);assert.ok(Number.isFinite(f.maxProbability)&&f.maxProbability>=f.probabilitySum/count&&f.maxProbability<=Math.min(1,f.probabilitySum));assert.ok(f.selectedProbability<=f.maxProbability&&f.selectedProbability>=f.maxProbability-1e-6);assert.ok(index('response-flags',id)<index('answer',id));}
 for(const id of failures){const e=errors.find(e=>e.id===id);assert.ok(attempts.includes(id));assert.ok(['local','provider','response-model','response-answers','response-probabilities','typed-contract'].includes(e.stage));assert.ok(index('failure',id)<index('qualification-unknown',id));}
 const drift=flags.filter(e=>!e.modelMatches);assert.equal(report.modelDrift,drift.length>0);assert.ok(drift.length<=1);if(drift.length){assert.equal(attempts.at(-1),drift[0].id);assert.ok(failures.includes(drift[0].id));assert.equal(errors.find(e=>e.id===drift[0].id).stage,'response-model');}
}

export function verifyQualificationEvents(report,events,attempts,posts,answers,failures){return verifyEvents(false,report,events,attempts,posts,answers,failures);}
// Named closed role4 context only: BestE/sharedO remain binary. No caller option count.
export function verifyRole4QualificationEvents(report,events,attempts,posts,answers,failures){verifyEvents(true,report,events,attempts,posts,answers,failures);for(const id of answers)if(id.endsWith('/role4')){const item=events.find(e=>e.kind==='answer'&&e.id===id)?.item;assertRole4NativeAnswer(item?.answer,events.find(e=>e.kind==='response-flags'&&e.id===id));}}
const ROLE4_KEYS=['E_ONLY','O_ONLY','BOTH','NEITHER'];
export function isRole4Criteria(criteria){return !!criteria&&JSON.stringify(Object.keys(criteria))===JSON.stringify(ROLE4_KEYS);}
export function assertRole4NativeAnswer(answer,flags){
 assert.ok(answer&&flags&&flags.role4Native);assert.ok(ROLE4_KEYS.includes(answer.choice));assert.ok(Number.isFinite(answer.confidence)&&answer.confidence>=0&&answer.confidence<=1);
 const p=answer.probabilities;assert.ok(p&&typeof p==='object'&&!Array.isArray(p));assert.deepEqual(Object.keys(p).sort(),[...ROLE4_KEYS].sort());const values=Object.values(p);assert.ok(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1));const sum=values.reduce((s,v)=>s+v,0),max=Math.max(...values);assert.ok(Math.abs(sum-1)<1e-5);assert.ok(p[answer.choice]>=max-1e-6);
 assert.deepEqual(flags.role4Native,{type:'choice',choice:answer.choice,confidence:answer.confidence,probabilities:p});assert.equal(flags.probabilityCount,4);assert.equal(flags.probabilitySum,sum);assert.equal(flags.maxProbability,max);assert.equal(flags.selectedProbability,p[answer.choice]);
}
