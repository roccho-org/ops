import assert from 'node:assert/strict';import {digest} from '../run.mjs';
import {verifyQualificationEvents} from '../observation/qualification.mjs';
import {roleRequest} from './request.mjs';
import {prepareRoleDevelopment} from './development.mjs';
import {expectationRoleDevelopmentGuard,expectationBoundaryDevelopmentGuard} from './guard.mjs';
import {boundaryRequest}from'./boundary-request.mjs';import {prepareBoundaryDevelopment}from'./boundary-input.mjs';
const ROLE=Object.freeze({inputSchema:'ops.sys1.expectation-role-development.v1',predictionsSchema:'ops.sys1.expectation-role-development-predictions.v1',projectionSchema:'ops.sys1.expectation-role-development-projection.v1',prepare:prepareRoleDevelopment,request:roleRequest,guard:expectationRoleDevelopmentGuard,usageScope:"1252 new physical E requests only; historical O and E receipts are evidence aliases, never new calls; single candidate E is a qualified provider receipt; projection adds no physical call or fabricated provider fields; absent total_tokens and money stay unknown"});
const BOUNDARY=Object.freeze({inputSchema:'ops.sys1.expectation-boundary-development.v1',predictionsSchema:'ops.sys1.expectation-boundary-development-predictions.v1',projectionSchema:'ops.sys1.expectation-boundary-development-projection.v1',prepare:prepareBoundaryDevelopment,request:boundaryRequest,guard:expectationBoundaryDevelopmentGuard,usageScope:'1252 new physical E requests only; prior E and O are historical evidence aliases; single boundary candidate is its qualified provider receipt; no fabricated probabilities/model/usage; missing total_tokens and money stay unknown'});
const keys=['bestE','scopedE'],order=i=>[...keys.slice(i%2),...keys.slice(0,i%2)];
function planned(profile,input){assert.equal(input.schema,profile.inputSchema);assert.equal(input.maxPosts,1252);assert.equal(input.expectedModel,'jev-1.13.0');assert.equal(input.rows.length,626);assert.equal(new Set(input.rows.map(r=>r.id)).size,626);return input.rows.flatMap((r,i)=>order(i).map(k=>r.id+'/'+k));}
async function evaluatePaired(profile,input,ask,observe){
 planned(profile,input);const rows=[];let modelDrift=false;
 for(const [i,c]of input.rows.entries()){
  const row={id:c.id,observations:[]};
  for(const key of order(i))if(!modelDrift){const id=c.id+'/'+key,request=profile.request(c.body,input.best,key);observe({kind:'attempt',id});const start=performance.now();try{const answer=await ask(request);if(answer.model!==input.expectedModel){const e=Error('model changed');e.modelChanged=true;throw e;}assert.ok(['yes','no'].includes(answer.choice));const item={key,request,answer,elapsedMs:performance.now()-start};row.observations.push(item);observe({kind:'answer',id,item});}catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)modelDrift=true;}}
  rows.push(row);observe({kind:'row',row});
 }
 return {schema:profile.predictionsSchema,inputDigest:digest(input),modelDrift,rows};
}
async function projectPaired(profile,input,attempt,report,events,data){
 const expected=planned(profile,input);assert.deepEqual(attempt,{inputDigest:digest(input),maxPosts:1252});assert.deepEqual(input,await profile.prepare(data,input.execution));assert.equal(report.schema,profile.predictionsSchema);assert.equal(report.inputDigest,digest(input));assert.equal(typeof report.modelDrift,'boolean');
 const ids=k=>events.filter(e=>e.kind===k).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=1252);for(const a of [attempts,posts,answers,failures])assert.equal(new Set(a).size,a.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);assert.ok(answers.every(id=>posts.includes(id)));assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.equal(new Set([...answers,...failures]).size,attempts.length);verifyQualificationEvents(report,events,attempts,posts,answers,failures);assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);
 const predictions=report.rows.map((row,i)=>{const expectedKeys=order(i);assert.ok(Array.isArray(row.observations));assert.deepEqual(row.observations.map(t=>t.key),expectedKeys.filter(k=>row.observations.some(t=>t.key===k)));const p={id:row.id,bestE:null,currentE:null};for(const item of row.observations){assert.ok(expectedKeys.includes(item.key));assert.deepEqual(item.request,profile.request(input.rows[i].body,input.best,item.key));assert.equal(item.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(item.answer.choice));assert.deepEqual(events.find(e=>e.kind==='answer'&&e.id===row.id+'/'+item.key)?.item,item);p[item.key==='bestE'?'bestE':'currentE']=item.answer.choice;}return p;});assert.equal(report.rows.reduce((n,r)=>n+r.observations.length,0),answers.length);
 const effectCounts={assigned:1252,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:1252-answers.length,unattempted:1252-attempts.length},guard=profile.guard(data.rows,predictions,{qualified:answers.length,modelStable:!report.modelDrift}),knownFailure=guard.unionERegressed.length||guard.E.regressed.length,outcome=knownFailure?'DEVELOPMENT_GUARD_FAIL':report.modelDrift?'UNKNOWN_INVALID_MEASUREMENT':!guard.qualificationComplete?'UNKNOWN_INCOMPLETE_MEASUREMENT':guard.eligible?'DEVELOPMENT_GUARD_PASS':'DEVELOPMENT_GUARD_FAIL';
 return {schema:profile.projectionSchema,components:predictions,derived:guard.derived,effectCounts,guard,outcome,aliasScope:data.scope,usageScope:profile.usageScope};
}

// Two fixed internal contexts; callers cannot supply a profile, schema or constructor.
export function evaluateRoleDevelopment(input,ask,observe){return evaluatePaired(ROLE,input,ask,observe);}
export function projectRoleDevelopment(input,attempt,report,events,data){return projectPaired(ROLE,input,attempt,report,events,data);}
export function evaluateBoundaryDevelopment(input,ask,observe){return evaluatePaired(BOUNDARY,input,ask,observe);}
export function projectBoundaryDevelopment(input,attempt,report,events,data){return projectPaired(BOUNDARY,input,attempt,report,events,data);}
