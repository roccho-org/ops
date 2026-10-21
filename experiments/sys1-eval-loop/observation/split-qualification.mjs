import assert from 'node:assert/strict';
import {responseFlags} from '../target-loop/loop.mjs';
import {verifyQualificationEvents} from './qualification.mjs';
const NAMES=['declaration','request'],FIELDS=['type','choice','confidence','probabilities'],object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const splitUsage=raw=>Object.fromEntries(Object.entries(object(raw)?raw:{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));
export function splitResponseFlags(data,expectedModel){
 const answers=object(data?.answers)?data.answers:{},answerKeys=Object.keys(answers),answerFields=Object.fromEntries(NAMES.map(n=>[n,object(answers[n])?Object.keys(answers[n]):[]]));
 const snapshot={model:data?.model??null,usage:data?.usage===undefined?null:structuredClone(data.usage),answers:Object.fromEntries(NAMES.map(n=>[n,object(answers[n])?structuredClone(Object.fromEntries(FIELDS.filter(k=>Object.hasOwn(answers[n],k)).map(k=>[k,answers[n][k]]))):null]))};
 const modelReported=typeof data?.model==='string'&&data.model.trim().length>0;
 return{modelReported,modelMatches:data?.model===expectedModel,modelDrift:modelReported&&data.model!==expectedModel,answerKeyMatches:answerKeys.length===2&&NAMES.every(n=>Object.hasOwn(answers,n)),answerKeys,answerFields,splitNative:snapshot,branches:Object.fromEntries(NAMES.map(n=>[n,responseFlags({model:data?.model,answers:{live:answers[n]}},expectedModel)]))};
}
function assertSplitSnapshotFlags(flags){
 assert.ok(flags&&object(flags.splitNative)&&object(flags.splitNative.answers));assert.deepEqual(Object.keys(flags.splitNative.answers).sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.branches).sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.answerFields).sort(),[...NAMES].sort());assert.ok(Array.isArray(flags.answerKeys)&&flags.answerKeys.every(k=>typeof k==='string'));assert.equal(new Set(flags.answerKeys).size,flags.answerKeys.length);assert.equal(flags.answerKeyMatches,flags.answerKeys.length===2&&NAMES.every(n=>flags.answerKeys.includes(n)));
 assert.equal(flags.modelReported,typeof flags.splitNative.model==='string'&&flags.splitNative.model.trim().length>0);assert.equal(flags.modelMatches,flags.splitNative.model==='jev-1.13.0');assert.equal(flags.modelDrift,flags.modelReported&&!flags.modelMatches);
 for(const n of NAMES){assert.ok(Array.isArray(flags.answerFields[n])&&flags.answerFields[n].every(k=>typeof k==='string'));assert.equal(new Set(flags.answerFields[n]).size,flags.answerFields[n].length);const a=flags.splitNative.answers[n];assert.ok(a===null||object(a));if(a===null)assert.deepEqual(flags.answerFields[n],[]);else assert.deepEqual(Object.keys(a).sort(),flags.answerFields[n].filter(k=>FIELDS.includes(k)).sort());assert.deepEqual(flags.branches[n],responseFlags({model:flags.splitNative.model,answers:{live:a}},'jev-1.13.0'));}
}
export function assertSplitRaw(flags){
 assertSplitSnapshotFlags(flags);
 assert.ok(flags&&flags.splitNative);assert.equal(flags.modelReported,true);assert.equal(flags.modelMatches,true);assert.equal(flags.modelDrift,false);assert.equal(flags.splitNative.model,'jev-1.13.0');assert.equal(flags.answerKeyMatches,true);assert.deepEqual([...flags.answerKeys].sort(),[...NAMES].sort());assert.deepEqual(Object.keys(flags.splitNative.answers).sort(),[...NAMES].sort());
 for(const name of NAMES){const a=flags.splitNative.answers[name];assert.ok(object(a));assert.deepEqual([...flags.answerFields[name]].sort(),[...FIELDS].sort());assert.deepEqual(Object.keys(a).sort(),[...FIELDS].sort());assert.equal(a.type,'choice');assert.ok(['yes','no'].includes(a.choice));assert.ok(Number.isFinite(a.confidence)&&a.confidence>=0&&a.confidence<=1);assert.ok(object(a.probabilities));assert.deepEqual(Object.keys(a.probabilities).sort(),['no','yes']);const values=Object.values(a.probabilities);assert.ok(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1));const sum=values.reduce((n,v)=>n+v,0),max=Math.max(...values);assert.ok(Math.abs(sum-1)<1e-5);assert.ok(a.probabilities[a.choice]>=max-1e-6);const expected=responseFlags({model:flags.splitNative.model,answers:{live:a}},'jev-1.13.0');assert.deepEqual(flags.branches[name],expected);assert.equal(expected.probabilityCount,2);for(const k of ['modelMatches','answerKeyMatches','probabilitiesFinite','probabilitiesInRange','sumMatches','selectedIsMax'])assert.equal(expected[k],true);}
}
export function assertSplitNativeAnswer(answer,flags){
 assertSplitRaw(flags);assert.deepEqual(Object.keys(answer).sort(),['answers','model','usage']);assert.equal(answer.model,flags.splitNative.model);assert.deepEqual(Object.keys(answer.answers).sort(),[...NAMES].sort());assert.deepEqual(answer.usage,splitUsage(flags.splitNative.usage));
 for(const name of NAMES){const a=answer.answers[name],raw=flags.splitNative.answers[name];assert.deepEqual(Object.keys(a).sort(),['choice','confidence','probabilities']);assert.deepEqual(a,{choice:raw.choice,confidence:raw.confidence,probabilities:raw.probabilities});}
}
// Fixed compound context only. Each named branch is a real native answer;
// calculations of branch flags do not turn this response into a legacy live answer.
function verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,isSplit){
 const binary=events.filter(e=>e.id&&!isSplit(e.id)),binaryFlags=binary.filter(e=>e.kind==='response-flags');
 verifyQualificationEvents({modelDrift:binaryFlags.some(f=>!f.modelMatches)},binary,attempts.filter(id=>!isSplit(id)),posts.filter(id=>!isSplit(id)),answers.filter(id=>!isSplit(id)),failures.filter(id=>!isSplit(id)));
 const flags=events.filter(e=>e.kind==='response-flags'&&isSplit(e.id)),errors=events.filter(e=>e.kind==='failure'&&isSplit(e.id)),index=(kind,id)=>events.findIndex(e=>e.kind===kind&&e.id===id);
 assert.equal(new Set(flags.map(f=>f.id)).size,flags.length);assert.ok(flags.every(f=>posts.includes(f.id)));assert.equal(new Set(errors.map(f=>f.id)).size,errors.length);assert.deepEqual(errors.map(e=>e.id).sort(),failures.filter(isSplit).sort());
 for(const f of flags){assertSplitSnapshotFlags(f);assert.equal(typeof f.modelMatches,'boolean');assert.ok(index('post',f.id)<index('response-flags',f.id));}
 for(const id of answers.filter(isSplit)){const f=flags.find(f=>f.id===id);assert.ok(f);assertSplitNativeAnswer(events.find(e=>e.kind==='answer'&&e.id===id)?.item?.answer,f);assert.ok(index('response-flags',id)<index('answer',id));}
 for(const id of failures.filter(isSplit)){const error=errors.find(e=>e.id===id);assert.ok(error&&attempts.includes(id));assert.ok(['local','provider','response-model','response-answers','response-probabilities','typed-contract'].includes(error.stage));assert.ok(index('failure',id)<index('qualification-unknown',id));}
 const drift=events.filter(e=>e.kind==='response-flags'&&(isSplit(e.id)?e.modelDrift:!e.modelMatches));assert.equal(report.modelDrift,drift.length>0);assert.ok(drift.length<=1);if(drift.length){assert.equal(attempts.at(-1),drift[0].id);assert.ok(failures.includes(drift[0].id));assert.equal(events.find(e=>e.kind==='failure'&&e.id===drift[0].id)?.stage,'response-model');}
}

// Three fixed native named2 contexts only; no caller-supplied key or predicate.
export function verifySplitQualificationEvents(report,events,attempts,posts,answers,failures){return verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,id=>id.endsWith('/splitE'));}
export function verifyPartitionQualificationEvents(report,events,attempts,posts,answers,failures){return verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,id=>id.endsWith('/partitionE'));}

export function verifyLinesQualificationEvents(report,events,attempts,posts,answers,failures){return verifyNamedTwoQualificationEvents(report,events,attempts,posts,answers,failures,id=>id.endsWith('/linesE'));}
