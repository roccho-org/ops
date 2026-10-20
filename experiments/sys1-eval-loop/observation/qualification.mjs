import assert from 'node:assert/strict';

// Shared by the closed three-template comparison and the next O-only D reader.
// Kept independent of endpoints, credentials, Gold and round-specific admission.
export function verifyQualificationEvents(report,events,attempts,posts,answers,failures){
 const flags=events.filter(e=>e.kind==='response-flags'),errors=events.filter(e=>e.kind==='failure');assert.equal(new Set(flags.map(e=>e.id)).size,flags.length);assert.ok(flags.every(e=>posts.includes(e.id)));assert.equal(new Set(errors.map(e=>e.id)).size,errors.length);assert.deepEqual(errors.map(e=>e.id).sort(),[...failures].sort());
 const index=(kind,id)=>events.findIndex(e=>e.kind===kind&&e.id===id);
 for(const e of flags){assert.equal(typeof e.modelMatches,'boolean');assert.ok(index('post',e.id)<index('response-flags',e.id));}
 for(const id of answers){const f=flags.find(e=>e.id===id);assert.ok(f);for(const key of ['modelMatches','answerKeyMatches','probabilitiesFinite','probabilitiesInRange','sumMatches','selectedIsMax'])assert.equal(f[key],true);assert.equal(f.probabilityCount,2);assert.ok(Number.isFinite(f.probabilitySum)&&Math.abs(f.probabilitySum-1)<1e-5);assert.ok(Number.isFinite(f.selectedProbability)&&f.selectedProbability>=0&&f.selectedProbability<=1);assert.ok(Number.isFinite(f.maxProbability)&&f.maxProbability>=f.probabilitySum/2&&f.maxProbability<=Math.min(1,f.probabilitySum));assert.ok(f.selectedProbability<=f.maxProbability&&f.selectedProbability>=f.maxProbability-1e-6);assert.ok(index('response-flags',id)<index('answer',id));}
 for(const id of failures){const e=errors.find(e=>e.id===id);assert.ok(attempts.includes(id));assert.ok(['local','provider','response-model','response-answers','response-probabilities','typed-contract'].includes(e.stage));assert.ok(index('failure',id)<index('qualification-unknown',id));}
 const drift=flags.filter(e=>!e.modelMatches);assert.equal(report.modelDrift,drift.length>0);assert.ok(drift.length<=1);if(drift.length){assert.equal(attempts.at(-1),drift[0].id);assert.ok(failures.includes(drift[0].id));assert.equal(errors.find(e=>e.id===drift[0].id).stage,'response-model');}
}
