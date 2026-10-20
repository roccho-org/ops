import assert from 'node:assert/strict';import {digest} from '../run.mjs';
import {observationPhysicalRequest,observationTemplates} from './request.mjs';import {wireTemplate} from '../regression/scoped-request.mjs';
export const OBSERVATION_KEYS=Object.freeze(['bestO','scopedO','sharedE']);
const order=i=>[...OBSERVATION_KEYS.slice(i%3),...OBSERVATION_KEYS.slice(0,i%3)];
export async function prepareObservationMeasurement(cases,selection,repId,execution){
 assert.ok(repId===1||repId===2);assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.adopted,false);const {best,templateProof}=selection.configuration;assert.deepEqual(templateProof,await observationTemplates(best));
 assert.ok(cases.length>0&&cases.length<=300);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 const rows=cases.map(({id,body})=>{assert.ok(typeof id==='string'&&id&&!id.includes('/'));assert.ok(typeof body==='string'&&body.trim());return {id,body};});
 for(const r of rows)for(const key of OBSERVATION_KEYS)assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(observationPhysicalRequest(r.body,best,key))))<24000);
 return {schema:'ops.sys1.observation-measurement.v1',repId,rows,best,templateProof,expectedModel:'jev-1.13.0',maxPosts:3*rows.length,execution};
}
function planned(input){assert.equal(input.schema,'ops.sys1.observation-measurement.v1');assert.ok(input.repId===1||input.repId===2);assert.ok(input.rows.length>0&&input.rows.length<=300);assert.equal(input.maxPosts,3*input.rows.length);assert.equal(new Set(input.rows.map(r=>r.id)).size,input.rows.length);return input.rows.flatMap((r,i)=>order(i).map(k=>`rep${input.repId}/${r.id}/${k}`));}
function verifyQualificationEvents(report,events,attempts,posts,answers,failures){
 const flags=events.filter(e=>e.kind==='response-flags'),errors=events.filter(e=>e.kind==='failure');assert.equal(new Set(flags.map(e=>e.id)).size,flags.length);assert.ok(flags.every(e=>posts.includes(e.id)));assert.equal(new Set(errors.map(e=>e.id)).size,errors.length);assert.deepEqual(errors.map(e=>e.id).sort(),[...failures].sort());
 const index=(kind,id)=>events.findIndex(e=>e.kind===kind&&e.id===id);
 for(const e of flags){assert.equal(typeof e.modelMatches,'boolean');assert.ok(index('post',e.id)<index('response-flags',e.id));}
 for(const id of answers){const f=flags.find(e=>e.id===id);assert.ok(f);for(const key of ['modelMatches','answerKeyMatches','probabilitiesFinite','probabilitiesInRange','sumMatches','selectedIsMax'])assert.equal(f[key],true);assert.equal(f.probabilityCount,2);assert.ok(Number.isFinite(f.probabilitySum)&&Math.abs(f.probabilitySum-1)<1e-5);assert.ok(Number.isFinite(f.selectedProbability)&&f.selectedProbability>=0&&f.selectedProbability<=1);assert.ok(Number.isFinite(f.maxProbability)&&f.maxProbability>=f.probabilitySum/2&&f.maxProbability<=Math.min(1,f.probabilitySum));assert.ok(f.selectedProbability<=f.maxProbability&&f.selectedProbability>=f.maxProbability-1e-6);assert.ok(index('response-flags',id)<index('answer',id));}
 for(const id of failures){const e=errors.find(e=>e.id===id);assert.ok(attempts.includes(id));assert.ok(['local','provider','response-model','response-answers','response-probabilities','typed-contract'].includes(e.stage));assert.ok(index('failure',id)<index('qualification-unknown',id));}
 const drift=flags.filter(e=>!e.modelMatches);assert.equal(report.modelDrift,drift.length>0);assert.ok(drift.length<=1);if(drift.length){assert.equal(attempts.at(-1),drift[0].id);assert.ok(failures.includes(drift[0].id));assert.equal(errors.find(e=>e.id===drift[0].id).stage,'response-model');}
}
export async function evaluateObservationMeasurement(input,ask,observe=()=>{}){
 planned(input);const rows=[];let stopped=false;
 for(const [index,c]of input.rows.entries()){
  const row={id:c.id,order:order(index),observations:[]};
  for(const key of row.order){if(stopped)continue;const id=`rep${input.repId}/${c.id}/${key}`,request=observationPhysicalRequest(c.body,input.best,key);observe({kind:'attempt',repId:input.repId,id});const start=performance.now();
   try{const answer=await ask(request);if(answer.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}assert.ok(['yes','no'].includes(answer.choice));const item={key,request,answer,elapsedMs:performance.now()-start};row.observations.push(item);observe({kind:'answer',repId:input.repId,id,item});}
   catch(error){observe({kind:'qualification-unknown',repId:input.repId,id});if(error?.modelChanged===true)stopped=true;}
  }rows.push(row);observe({kind:'row',repId:input.repId,row});
 }
 return {schema:'ops.sys1.observation-measurement-predictions.v1',inputDigest:digest(input),repId:input.repId,modelDrift:stopped,rows};
}
export async function verifyObservationMeasurement(input,report,events){
 const expected=planned(input);assert.equal(report.schema,'ops.sys1.observation-measurement-predictions.v1');assert.equal(report.inputDigest,digest(input));assert.equal(report.repId,input.repId);assert.equal(typeof report.modelDrift,'boolean');assert.deepEqual(input.templateProof,await observationTemplates(input.best));assert.ok(events.every(e=>e.repId===input.repId));
 const ids=kind=>events.filter(e=>e.kind===kind).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=input.maxPosts);assert.equal(new Set(attempts).size,attempts.length);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(answers.length+failures.length,attempts.length);assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));
 verifyQualificationEvents(report,events,attempts,posts,answers,failures);
 const projected=[];let observed=0;
 for(const [i,row]of report.rows.entries()){
  const c=input.rows[i];assert.deepEqual(row.order,order(i));assert.equal(new Set(row.observations.map(t=>t.key)).size,row.observations.length);assert.ok(row.observations.length<=3);
  for(const item of row.observations){assert.ok(OBSERVATION_KEYS.includes(item.key));assert.deepEqual(item.request,observationPhysicalRequest(c.body,input.best,item.key));assert.equal(item.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(item.answer.choice));const e=events.find(e=>e.kind==='answer'&&e.id===`rep${input.repId}/${c.id}/${item.key}`);assert.ok(e);assert.deepEqual(e.item,item);observed++;}
  const choice=key=>row.observations.find(t=>t.key===key)?.answer.choice??null,E=choice('sharedE');projected.push({id:c.id,best:{E,O:choice('bestO')},scoped:{E,O:choice('scopedO')}});
 }
 assert.equal(observed,answers.length);return {repId:input.repId,modelStable:!report.modelDrift,rows:projected,effectCounts:{assigned:input.maxPosts,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:input.maxPosts-answers.length,unattempted:input.maxPosts-attempts.length},usageScope:'unique physical bestO/scopedO/sharedE only; E shared within this repetition, never reused across repetitions; no separate alias usage'};
}
