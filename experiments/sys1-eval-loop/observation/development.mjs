import assert from 'node:assert/strict';
import {digest} from '../run.mjs';
import {verifyMeasurement} from '../real-cases/measurement.mjs';
import {summarizeObserved} from '../real-cases/summary.mjs';
import {targetRequest} from '../feedback-improvement.mjs';
import {wireTemplate} from '../regression/scoped-request.mjs';
import {observationRequest,observationTemplates} from './request.mjs';

export function historicalDevelopmentRows(historical){
 const {input,report}=historical;assert.equal(input.repId,1);assert.equal(input.execution.runUrl,'https://github.com/roccho-org/ops/actions/runs/39410714744');assert.equal(report.inputDigest,digest(input));assert.equal(input.rows.length,118);assert.equal(report.rows.length,118);
 return input.rows.map((c,i)=>{assert.equal(c.id,report.rows[i].id);const aliases={};for(const [axis,key]of [['E','bestE'],['O','sharedO']]){const item=report.rows[i].observations.find(x=>x.key===key);assert.ok(item);assert.equal(item.answer.model,'jev-1.13.0');assert.ok(['yes','no'].includes(item.answer.choice));assert.deepEqual(item.request,targetRequest(c.body,input.best,axis));aliases[axis]={choice:item.answer.choice,sourceRun:input.execution.runUrl,sourceActivation:input.execution.activation,source:input.execution.source,repId:1,caseId:c.id,key};}return {id:c.id,body:c.body,aliases};});
}
export function assertDevelopmentEffectInput(input,historical,execution){
 planned(input);assert.equal(input.expectedModel,'jev-1.13.0');assert.deepEqual(input.best,historical.input.best);assert.deepEqual(input.rows,historicalDevelopmentRows(historical));assert.deepEqual(input.execution,execution);
 // Only body/Best/fixed source create actual requests. Full serialized proof is
 // checked without credentials in prepare/project, not invoked under a key.
}

export async function prepareDevelopment(corpus,historical,execution){
 const {input,report,events}=historical;
 assert.equal(input.repId,1);assert.equal(input.execution.runUrl,'https://github.com/roccho-org/ops/actions/runs/39410714744');
 assert.equal(corpus.cases.length,118);assert.equal(input.rows.length,118);
 const old=await verifyMeasurement(input,report,events);assert.equal(old.modelStable,true);assert.equal(old.effectCounts.qualified,354);
 const rows=[];
 for(const [i,c]of corpus.cases.entries()){
  assert.equal(c.id,input.rows[i].id);assert.equal(c.body,input.rows[i].body);
  for(const axis of ['E','O'])assert.ok(['yes','no',null].includes(c.gold?.[axis]));
  const aliases={};
  for(const [axis,key]of [['E','bestE'],['O','sharedO']]){
   const item=report.rows[i].observations.find(x=>x.key===key);assert.ok(item);
   assert.deepEqual(await wireTemplate(targetRequest(c.body,input.best,axis)),await wireTemplate(item.request));
   aliases[axis]={choice:item.answer.choice,sourceRun:input.execution.runUrl,sourceActivation:input.execution.activation,source:input.execution.source,repId:1,caseId:c.id,key};
  }
  assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(observationRequest(c.body,input.best,'O'))))<24000);
  rows.push({id:c.id,body:c.body,aliases});
 }
 return {schema:'ops.sys1.observation-development.v1',rows,best:input.best,templateProof:await observationTemplates(input.best),expectedModel:'jev-1.13.0',maxPosts:118,execution,historicalScope:'closed pass1 original Best E and O; nonconcurrent historical aliases, not fresh E validation'};
}
function planned(input){assert.equal(input.schema,'ops.sys1.observation-development.v1');assert.equal(input.rows.length,118);assert.equal(input.maxPosts,118);assert.equal(new Set(input.rows.map(r=>r.id)).size,118);return input.rows.map(r=>r.id+'/scopedO');}
export async function evaluateDevelopment(input,ask,observe=()=>{}){
 planned(input);const rows=[];let stopped=false;
 for(const c of input.rows){const row={id:c.id,observation:null};
  if(!stopped){const id=c.id+'/scopedO',request=observationRequest(c.body,input.best,'O');observe({kind:'attempt',id});const start=performance.now();
   try{const answer=await ask(request);if(answer.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}assert.ok(['yes','no'].includes(answer.choice));row.observation={request,answer,elapsedMs:performance.now()-start};observe({kind:'answer',id,item:row.observation});}
   catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)stopped=true;}
  }rows.push(row);observe({kind:'row',row});
 }
 return {schema:'ops.sys1.observation-development-predictions.v1',inputDigest:digest(input),modelDrift:stopped,rows};
}
export async function verifyDevelopment(input,report,events,corpus){
 const expected=planned(input);assert.equal(report.schema,'ops.sys1.observation-development-predictions.v1');assert.equal(report.inputDigest,digest(input));assert.deepEqual(input.templateProof,await observationTemplates(input.best));assert.equal(typeof report.modelDrift,'boolean');
 const ids=kind=>events.filter(e=>e.kind===kind).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');
 assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=118);assert.equal(new Set(attempts).size,attempts.length);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(answers.length+failures.length,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.equal(new Set([...answers,...failures]).size,attempts.length);
 assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);assert.equal(corpus.cases.length,118);
 const rows=[];
 for(const [i,row]of report.rows.entries()){
  const c=input.rows[i],gold=corpus.cases[i];assert.equal(c.id,gold.id);assert.equal(c.body,gold.body);
  if(row.observation){assert.deepEqual(row.observation.request,observationRequest(c.body,input.best,'O'));assert.equal(row.observation.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(row.observation.answer.choice));const e=events.find(e=>e.kind==='answer'&&e.id===c.id+'/scopedO');assert.ok(e);assert.deepEqual(e.item,row.observation);}else assert.ok(!answers.includes(c.id+'/scopedO'));
  rows.push({id:c.id,gold:{E:gold.gold.E,O:gold.gold.O},best:{E:c.aliases.E.choice,O:c.aliases.O.choice},scoped:{E:c.aliases.E.choice,O:row.observation?.answer.choice??null}});
 }
 assert.equal(answers.length,report.rows.filter(r=>r.observation).length);
 const summary=summarizeObserved(rows,{modelStable:!report.modelDrift});
 const counts={assigned:118,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:118-answers.length,unattempted:118-attempts.length};
 const qualified=counts.qualified===118,positiveKnownGain=summary.axes.O.b>summary.axes.O.c,noKnownRegression=summary.axes.O.regressions===0;
 const eligible=qualified&&!report.modelDrift&&positiveKnownGain&&noKnownRegression;
 return {rows,summary,effectCounts:counts,guard:{eligible,qualified,modelStable:!report.modelDrift,positiveKnownGain,noKnownRegression,scope:'known-Gold development guard only; all 118 retained including four Gold-null cases; not fresh effect approximation'},outcome:eligible?'DEVELOPMENT_GUARD_PASS':!noKnownRegression?'DEVELOPMENT_GUARD_FAIL':report.modelDrift||!qualified?'UNKNOWN':'DEVELOPMENT_GUARD_FAIL'};
}
