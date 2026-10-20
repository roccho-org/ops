import assert from 'node:assert/strict';import {digest} from '../run.mjs';import {targetRequest} from '../feedback-improvement.mjs';import {scopedRequest,scopedTemplates} from './scoped-request.mjs';import {pairedComparison} from '../counterfactual/comparison.mjs';
const COUNTS=Object.freeze({screen:48,audit:64}),KEYS=['bestE','scopedE','sharedO'];
export function fixedRequest(body,best,key){assert.ok(KEYS.includes(key));return key==='scopedE'?scopedRequest(body,best,'E'):targetRequest(body,best,key==='sharedO'?'O':'E');}
export async function prepareFreshScoped(data,phase,best,execution){
 assert.ok(Object.hasOwn(COUNTS,phase));assert.equal(data.cases.length,COUNTS[phase]);assert.equal(new Set(data.cases.map(c=>c.id)).size,COUNTS[phase]);
 const rows=data.cases.map(({id,family,body})=>{assert.ok(typeof body==='string'&&body.trim()&&Buffer.byteLength(body)<16000);return {id,family,body};});
 return {phase,rows,best,templateProof:await scopedTemplates(best),expectedModel:'jev-1.13.0',maxPosts:3*COUNTS[phase],execution};
}
export async function evaluateFreshScoped(input,ask,observe=()=>{}){
 assert.equal(input.rows.length,COUNTS[input.phase]);assert.equal(input.maxPosts,3*COUNTS[input.phase]);let stopped=false;const rows=[];
 for(const [index,c]of input.rows.entries()){
  const offset=index%3,order=[...KEYS.slice(offset),...KEYS.slice(0,offset)],row={id:c.id,order,observations:[]};
  for(const key of order){if(stopped)continue;const id=c.id+'/'+key,request=fixedRequest(c.body,input.best,key);observe({kind:'attempt',id});const start=performance.now();
   try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(['yes','no'].includes(answer.choice));const item={key,request,answer,elapsedMs:performance.now()-start};row.observations.push(item);observe({kind:'answer',id,item});}
   catch(e){observe({kind:'qualification-unknown',id});if(e?.modelChanged===true)stopped=true;}
  }
  rows.push(row);observe({kind:'row',row});
 }
 return {inputDigest:digest(input),modelDrift:stopped,rows};
}
export function verifyFreshEffects(input,report,events){
 assert.equal(input.rows.length,COUNTS[input.phase]);assert.equal(input.maxPosts,3*COUNTS[input.phase]);
 const ids=k=>events.filter(e=>e.kind===k).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');
 const expected=input.rows.flatMap((c,index)=>{const o=index%3;return [...KEYS.slice(o),...KEYS.slice(0,o)].map(k=>c.id+'/'+k);});
 assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.equal(new Set(attempts).size,attempts.length);assert.ok(attempts.length<=input.maxPosts);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.equal(answers.length+failures.length,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());
 assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);assert.equal(answers.length,report.rows.reduce((n,r)=>n+r.observations.length,0));
 return {assignedPosts:input.maxPosts,attempted:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:input.maxPosts-answers.length,unattempted:input.maxPosts-attempts.length,contemporarySharedOAssigned:input.rows.length};
}
export async function freshScopedProjection(input,report,gold){
 assert.equal(input.rows.length,COUNTS[input.phase]);assert.equal(gold.length,COUNTS[input.phase]);assert.equal(report.inputDigest,digest(input));assert.deepEqual(input.templateProof,await scopedTemplates(input.best));assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(c=>c.id));assert.deepEqual(gold.map(c=>c.id),input.rows.map(c=>c.id));
 const rows=[];
 for(const [i,c]of gold.entries()){
  assert.equal(c.body,input.rows[i].body);const r=report.rows[i],offset=i%3;assert.deepEqual(r.order,[...KEYS.slice(offset),...KEYS.slice(0,offset)]);assert.equal(new Set(r.observations.map(t=>t.key)).size,r.observations.length);assert.ok(r.observations.length<=3);
  for(const item of r.observations){assert.ok(KEYS.includes(item.key));assert.deepEqual(item.request,fixedRequest(c.body,input.best,item.key));assert.equal(item.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(item.answer.choice));}
  const get=key=>r.observations.find(t=>t.key===key),O=get('sharedO');
  for(const [arm,Ekey]of [['best','bestE'],['feedback','scopedE']]){const E=get(Ekey);rows.push({id:c.id,arm,status:E&&O?'qualified':'unknown',model:input.expectedModel,E:E?.answer.choice,O:O?.answer.choice,observationOrigin:{E:{caseId:c.id,template:Ekey},O:{caseId:c.id,template:'sharedO',shared:true}}});}
 }
 const scored=pairedComparison(gold,rows,input.expectedModel),pair=scored.A;
 let disposition=!pair.complete?'UNKNOWN':pair.axisRegressed.length?'OBSERVED_REGRESSION':pair.delta>0?'FINITE_GAIN':'NO_GAIN_OBSERVED';if(report.modelDrift!==false)disposition='UNKNOWN';
 return {modelStable:report.modelDrift===false,rows:rows.map(r=>({...r,arm:r.arm==='feedback'?'scoped':r.arm})),comparison:{configuration:'original Best + scoped E criteria',stage:input.phase,disposition,eligible:disposition==='FINITE_GAIN',assigned:gold.length,baselineCorrect:scored.arms.best.correct,candidateCorrect:scored.arms.feedback.correct,pair},
  usageScope:'sum each of BestE/scopedE/sharedO native traces once; sharedO is not an independent arm observation; paired evaluation savings are not deployed inference savings'};
}
