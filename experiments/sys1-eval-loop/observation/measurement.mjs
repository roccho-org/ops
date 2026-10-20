import assert from 'node:assert/strict';import {digest} from '../run.mjs';
import {observationPhysicalRequest,observationTemplates} from './request.mjs';import {wireTemplate} from '../regression/scoped-request.mjs';
import {verifyQualificationEvents} from './qualification.mjs';
import {expectationRequest,expectationTemplates,expectationTemplatesFromOriginal} from '../expectation/request.mjs';
export const OBSERVATION_KEYS=Object.freeze(['bestO','scopedO','sharedE']);
export const EXPECTATION_KEYS=Object.freeze(['bestE','scopedE','sharedO']);
const profiles=Object.freeze({observation:Object.freeze({input:'ops.sys1.observation-measurement.v1',predictions:'ops.sys1.observation-measurement-predictions.v1',keys:OBSERVATION_KEYS,request:observationPhysicalRequest,templates:observationTemplates,shared:'E'}),expectation:Object.freeze({input:'ops.sys1.expectation-census-measurement.v1',predictions:'ops.sys1.expectation-census-predictions.v1',keys:EXPECTATION_KEYS,request:expectationRequest,templates:expectationTemplates,shared:'O'})});
const order=(i,p)=>[...p.keys.slice(i%3),...p.keys.slice(0,i%3)];
function frozenExpectation(selection){assert.equal(selection.schema,'ops.sys1.expectation-selection.v1');assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.adopted,false);assert.equal(selection.expectedModel,'jev-1.13.0');assert.deepEqual(selection.physical.measurement,EXPECTATION_KEYS);const {best,templateProof}=selection.configuration;assert.deepEqual(templateProof,expectationTemplatesFromOriginal(templateProof));return {best,templateProof};}
async function prepareMeasurement(cases,selection,repId,execution,p){
 assert.ok(repId===1||repId===2);assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.adopted,false);const {best,templateProof}=p===profiles.expectation?frozenExpectation(selection):selection.configuration;assert.deepEqual(templateProof,await p.templates(best));
 assert.ok(cases.length>0&&cases.length<=300);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 const rows=cases.map(({id,body})=>{assert.ok(typeof id==='string'&&id&&!id.includes('/'));assert.ok(typeof body==='string'&&body.trim());return {id,body};});
 for(const r of rows)for(const key of p.keys)assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(p.request(r.body,best,key))))<24000);
 return {schema:p.input,repId,rows,best,templateProof,expectedModel:'jev-1.13.0',maxPosts:3*rows.length,execution};
}
function planned(input,p){assert.equal(input.schema,p.input);assert.ok(input.repId===1||input.repId===2);assert.ok(input.rows.length>0&&input.rows.length<=300);assert.equal(input.maxPosts,3*input.rows.length);assert.equal(new Set(input.rows.map(r=>r.id)).size,input.rows.length);return input.rows.flatMap((r,i)=>order(i,p).map(k=>`rep${input.repId}/${r.id}/${k}`));}
async function evaluateMeasurement(input,ask,observe,p){
 planned(input,p);const rows=[];let stopped=false;
 for(const [index,c]of input.rows.entries()){
  const row={id:c.id,order:order(index,p),observations:[]};
  for(const key of row.order){if(stopped)continue;const id=`rep${input.repId}/${c.id}/${key}`,request=p.request(c.body,input.best,key);observe({kind:'attempt',repId:input.repId,id});const start=performance.now();
   try{const answer=await ask(request);if(answer.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}assert.ok(['yes','no'].includes(answer.choice));const item={key,request,answer,elapsedMs:performance.now()-start};row.observations.push(item);observe({kind:'answer',repId:input.repId,id,item});}
   catch(error){observe({kind:'qualification-unknown',repId:input.repId,id});if(error?.modelChanged===true)stopped=true;}
  }rows.push(row);observe({kind:'row',repId:input.repId,row});
 }
 return {schema:p.predictions,inputDigest:digest(input),repId:input.repId,modelDrift:stopped,rows};
}
async function verifyMeasurement(input,report,events,p){
 const expected=planned(input,p);assert.equal(report.schema,p.predictions);assert.equal(report.inputDigest,digest(input));assert.equal(report.repId,input.repId);assert.equal(typeof report.modelDrift,'boolean');assert.deepEqual(input.templateProof,await p.templates(input.best));assert.ok(events.every(e=>e.repId===input.repId));
 const ids=kind=>events.filter(e=>e.kind===kind).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=input.maxPosts);assert.equal(new Set(attempts).size,attempts.length);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(answers.length+failures.length,attempts.length);assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));
 verifyQualificationEvents(report,events,attempts,posts,answers,failures);
 const projected=[];let observed=0;
 for(const [i,row]of report.rows.entries()){
  const c=input.rows[i];assert.deepEqual(row.order,order(i,p));assert.equal(new Set(row.observations.map(t=>t.key)).size,row.observations.length);assert.ok(row.observations.length<=3);
  for(const item of row.observations){assert.ok(p.keys.includes(item.key));assert.deepEqual(item.request,p.request(c.body,input.best,item.key));assert.equal(item.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(item.answer.choice));const e=events.find(e=>e.kind==='answer'&&e.id===`rep${input.repId}/${c.id}/${item.key}`);assert.ok(e);assert.deepEqual(e.item,item);observed++;}
  const choice=key=>row.observations.find(t=>t.key===key)?.answer.choice??null,shared=choice(p.keys[2]);projected.push(p.shared==='E'?{id:c.id,best:{E:shared,O:choice('bestO')},scoped:{E:shared,O:choice('scopedO')}}:{id:c.id,best:{E:choice('bestE'),O:shared},scoped:{E:choice('scopedE'),O:shared}});
 }
 assert.equal(observed,answers.length);return {repId:input.repId,modelStable:!report.modelDrift,rows:projected,effectCounts:{assigned:input.maxPosts,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:input.maxPosts-answers.length,unattempted:input.maxPosts-attempts.length},usageScope:p.shared==='E'?'unique physical bestO/scopedO/sharedE only; E shared within this repetition, never reused across repetitions; no separate alias usage':'unique physical bestE/scopedE/sharedO only; O shared within this repetition, never reused across repetitions; logical arm usage may attribute O to each arm, but that sum is not physical usage'};
}
// Two named, closed contexts only. Legacy inputs/reports gain no new fields.
export async function prepareObservationMeasurement(cases,selection,repId,execution){return prepareMeasurement(cases,selection,repId,execution,profiles.observation);}
export async function evaluateObservationMeasurement(input,ask,observe=()=>{}){return evaluateMeasurement(input,ask,observe,profiles.observation);}
export async function verifyObservationMeasurement(input,report,events){return verifyMeasurement(input,report,events,profiles.observation);}
export async function prepareExpectationCensusMeasurement(cases,selection,repId,execution){return prepareMeasurement(cases,selection,repId,execution,profiles.expectation);}
export function assertExpectationCensusEffectInput(input,cases,selection,repId,execution){planned(input,profiles.expectation);assert.deepEqual(Object.keys(input).sort(),['schema','repId','rows','best','templateProof','expectedModel','maxPosts','execution'].sort());assert.equal(input.repId,repId);assert.equal(input.expectedModel,'jev-1.13.0');assert.deepEqual(input.rows,cases.map(({id,body})=>({id,body})));const frozen=frozenExpectation(selection);assert.deepEqual(input.best,frozen.best);assert.deepEqual(input.templateProof,frozen.templateProof);assert.deepEqual(input.execution,execution);}
export async function evaluateExpectationCensusMeasurement(input,ask,observe=()=>{}){return evaluateMeasurement(input,ask,observe,profiles.expectation);}
export async function verifyExpectationCensusMeasurement(input,report,events,cases,selection){assert.deepEqual(input,await prepareExpectationCensusMeasurement(cases,selection,input.repId,input.execution));return verifyMeasurement(input,report,events,profiles.expectation);}
