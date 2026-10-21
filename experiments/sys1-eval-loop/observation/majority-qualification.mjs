import assert from 'node:assert/strict';
import {responseFlags} from '../target-loop/loop.mjs';
import {verifyQualificationEvents} from './qualification.mjs';
const NAMES=['presence','absence'],FIELDS=['type','choice','confidence','probabilities'],object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const majorityUsage=raw=>Object.fromEntries(Object.entries(object(raw)?raw:{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));
export function majorityResponseFlags(data,expectedModel){
 const answers=object(data?.answers)?data.answers:{},answerKeys=Object.keys(answers),answerFields=Object.fromEntries(NAMES.map(n=>[n,object(answers[n])?Object.keys(answers[n]):[]]));
 const snapshot={model:data?.model??null,usage:data?.usage===undefined?null:structuredClone(data.usage),answers:Object.fromEntries(NAMES.map(n=>[n,object(answers[n])?structuredClone(Object.fromEntries(FIELDS.filter(k=>Object.hasOwn(answers[n],k)).map(k=>[k,answers[n][k]]))):answers[n]===undefined?null:structuredClone(answers[n])]))};
 const modelReported=typeof data?.model==='string'&&data.model.trim().length>0;
 return{modelReported,modelMatches:data?.model===expectedModel,modelDrift:modelReported&&data.model!==expectedModel,answerKeyMatches:answerKeys.length===2&&NAMES.every(n=>Object.hasOwn(answers,n)),answerKeys,answerFields,majorityNative:snapshot,branches:Object.fromEntries(NAMES.map(n=>[n,responseFlags({model:data?.model,answers:{live:answers[n]}},expectedModel)]))};
}
function assertMajoritySnapshotFlags(flags){
 assert.ok(flags&&object(flags.majorityNative)&&object(flags.majorityNative.answers));assert.deepEqual(Object.keys(flags.majorityNative.answers).sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.branches).sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.answerFields).sort(),[...NAMES].sort());assert.ok(Array.isArray(flags.answerKeys)&&flags.answerKeys.every(k=>typeof k==='string'));assert.equal(new Set(flags.answerKeys).size,flags.answerKeys.length);assert.equal(flags.answerKeyMatches,flags.answerKeys.length===2&&NAMES.every(n=>flags.answerKeys.includes(n)));
 assert.equal(flags.modelReported,typeof flags.majorityNative.model==='string'&&flags.majorityNative.model.trim().length>0);assert.equal(flags.modelMatches,flags.majorityNative.model==='jev-1.13.0');assert.equal(flags.modelDrift,flags.modelReported&&!flags.modelMatches);
 for(const n of NAMES){assert.ok(Array.isArray(flags.answerFields[n])&&flags.answerFields[n].every(k=>typeof k==='string'));assert.equal(new Set(flags.answerFields[n]).size,flags.answerFields[n].length);const a=flags.majorityNative.answers[n];if(!object(a))assert.deepEqual(flags.answerFields[n],[]);else assert.deepEqual(Object.keys(a).sort(),flags.answerFields[n].filter(k=>FIELDS.includes(k)).sort());assert.deepEqual(flags.branches[n],responseFlags({model:flags.majorityNative.model,answers:{live:a}},'jev-1.13.0'));}
}
export function assertMajorityRaw(flags){
 assertMajoritySnapshotFlags(flags);
 assert.ok(flags&&flags.majorityNative);assert.equal(flags.modelReported,true);assert.equal(flags.modelMatches,true);assert.equal(flags.modelDrift,false);assert.equal(flags.majorityNative.model,'jev-1.13.0');assert.equal(flags.answerKeyMatches,true);assert.deepEqual([...flags.answerKeys].sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.majorityNative.answers).sort(),[...NAMES].sort());
 for(const name of NAMES){const a=flags.majorityNative.answers[name];assert.ok(object(a));assert.deepEqual([...flags.answerFields[name]].sort(),[...FIELDS].sort());assert.deepEqual(Object.keys(a).sort(),[...FIELDS].sort());assert.equal(a.type,'choice');assert.ok(['yes','no'].includes(a.choice));assert.ok(Number.isFinite(a.confidence)&&a.confidence>=0&&a.confidence<=1);assert.ok(object(a.probabilities));assert.deepEqual(Object.keys(a.probabilities).sort(),['no','yes']);const values=Object.values(a.probabilities);assert.ok(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1));const sum=values.reduce((n,v)=>n+v,0),max=Math.max(...values);assert.ok(Math.abs(sum-1)<1e-5);assert.ok(a.probabilities[a.choice]>=max-1e-6);const expected=responseFlags({model:flags.majorityNative.model,answers:{live:a}},'jev-1.13.0');assert.deepEqual(flags.branches[name],expected);assert.equal(expected.probabilityCount,2);for(const k of ['modelMatches','answerKeyMatches','probabilitiesFinite','probabilitiesInRange','sumMatches','selectedIsMax'])assert.equal(expected[k],true);}
}
export function assertMajorityNativeAnswer(answer,flags){
 assertMajorityRaw(flags);assert.deepEqual(Object.keys(answer).sort(),['answers','model','usage']);assert.equal(answer.model,flags.majorityNative.model);assert.deepEqual(Object.keys(answer.answers).sort(),[...NAMES].sort());assert.deepEqual(answer.usage,majorityUsage(flags.majorityNative.usage));
 for(const name of NAMES){const a=answer.answers[name],raw=flags.majorityNative.answers[name];assert.deepEqual(Object.keys(a).sort(),['choice','confidence','probabilities']);assert.deepEqual(a,{choice:raw.choice,confidence:raw.confidence,probabilities:raw.probabilities});}
}
// Fixed compound context only. Each named branch is a real native answer;
// calculations of branch flags do not turn this response into a legacy live answer.
function verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,isMajority){
 for(const e of events.filter(e=>e.kind==='failure'&&['response-model','response-answers','response-probabilities','typed-contract'].includes(e.stage)))assert.ok(events.some(f=>f.kind==='response-flags'&&f.id===e.id));
 const binary=events.filter(e=>e.id&&!isMajority(e.id)),binaryFlags=binary.filter(e=>e.kind==='response-flags');
 verifyQualificationEvents({modelDrift:binaryFlags.some(f=>!f.modelMatches)},binary,attempts.filter(id=>!isMajority(id)),posts.filter(id=>!isMajority(id)),answers.filter(id=>!isMajority(id)),failures.filter(id=>!isMajority(id)));
 const flags=events.filter(e=>e.kind==='response-flags'&&isMajority(e.id)),errors=events.filter(e=>e.kind==='failure'&&isMajority(e.id)),index=(kind,id)=>events.findIndex(e=>e.kind===kind&&e.id===id);
 assert.equal(new Set(flags.map(f=>f.id)).size,flags.length);assert.ok(flags.every(f=>posts.includes(f.id)));assert.equal(new Set(errors.map(f=>f.id)).size,errors.length);assert.deepEqual(errors.map(e=>e.id).sort(),failures.filter(isMajority).sort());
 for(const f of flags){assertMajoritySnapshotFlags(f);assert.equal(typeof f.modelMatches,'boolean');assert.ok(index('post',f.id)<index('response-flags',f.id));}
 for(const id of answers.filter(isMajority)){const f=flags.find(f=>f.id===id);assert.ok(f);assertMajorityNativeAnswer(events.find(e=>e.kind==='answer'&&e.id===id)?.item?.answer,f);assert.ok(index('response-flags',id)<index('answer',id));}
 for(const id of failures.filter(isMajority)){const error=errors.find(e=>e.id===id);assert.ok(error&&attempts.includes(id));assert.ok(['local','provider','response-model','response-answers','response-probabilities','typed-contract'].includes(error.stage));assert.ok(index('failure',id)<index('qualification-unknown',id));}
 const drift=events.filter(e=>e.kind==='response-flags'&&(isMajority(e.id)?e.modelDrift:!e.modelMatches));assert.equal(report.modelDrift,drift.length>0);assert.ok(drift.length<=1);if(drift.length){assert.equal(attempts.at(-1),drift[0].id);assert.ok(failures.includes(drift[0].id));assert.equal(events.find(e=>e.kind==='failure'&&e.id===drift[0].id)?.stage,'response-model');}
}

// One closed presence/absence compound context; no caller-supplied predicate.
export function verifyMajorityQualificationEvents(report,events,attempts,posts,answers,failures){return verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,id=>id.endsWith('/majorityE'));}
