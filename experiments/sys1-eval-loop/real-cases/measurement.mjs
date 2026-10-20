import assert from 'node:assert/strict';
import {digest} from '../run.mjs';
import {fixedRequest} from '../regression/scoped-fresh.mjs';
import {scopedTemplates,wireTemplate} from '../regression/scoped-request.mjs';
export const KEYS=Object.freeze(['bestE','scopedE','sharedO']);
const order=i=>[...KEYS.slice(i%3),...KEYS.slice(0,i%3)];
export async function prepareMeasurement(cases,best,repId,execution){
 assert.ok(repId===1||repId===2);assert.ok(Array.isArray(cases)&&cases.length>0&&cases.length<=300);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 const rows=cases.map(({id,body})=>{assert.ok(typeof id==='string'&&id&&!id.includes('/'));assert.ok(typeof body==='string'&&body.trim());return {id,body};});
 for(const r of rows)for(const k of KEYS)assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(fixedRequest(r.body,best,k))))<24000);
 return {schema:'ops.sys1.real-case-measurement.v1',repId,rows,best,templateProof:await scopedTemplates(best),expectedModel:'jev-1.13.0',maxPosts:3*rows.length,execution};
}
function planned(input){assert.ok(input.repId===1||input.repId===2);assert.equal(input.maxPosts,3*input.rows.length);return input.rows.flatMap((r,i)=>order(i).map(k=>`rep${input.repId}/${r.id}/${k}`));}
export async function evaluateMeasurement(input,ask,observe=()=>{}){
 planned(input);const rows=[];let stopped=false;
 for(const [index,c]of input.rows.entries()){
  const row={id:c.id,order:order(index),observations:[]};
  for(const key of row.order){if(stopped)continue;const id=`rep${input.repId}/${c.id}/${key}`,request=fixedRequest(c.body,input.best,key);observe({kind:'attempt',repId:input.repId,id});const start=performance.now();
   try{const answer=await ask(request);if(answer.model!==input.expectedModel){const e=Error('model changed');e.modelChanged=true;throw e;}assert.ok(['yes','no'].includes(answer.choice));const item={key,request,answer,elapsedMs:performance.now()-start};row.observations.push(item);observe({kind:'answer',repId:input.repId,id,item});}
   catch(error){observe({kind:'qualification-unknown',repId:input.repId,id});if(error?.modelChanged===true)stopped=true;}
  }
  rows.push(row);observe({kind:'row',repId:input.repId,row});
 }
 return {inputDigest:digest(input),repId:input.repId,modelDrift:stopped,rows};
}
export async function verifyMeasurement(input,report,events){
 const expected=planned(input);assert.equal(report.inputDigest,digest(input));assert.equal(report.repId,input.repId);assert.deepEqual(input.templateProof,await scopedTemplates(input.best));assert.ok(events.every(e=>e.repId===input.repId));
 const ids=k=>events.filter(e=>e.kind===k).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');
 assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=input.maxPosts);assert.equal(new Set(attempts).size,attempts.length);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.equal(answers.length+failures.length,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);
 assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));let observed=0;
 const scoredRows=[];
 for(const [i,r]of report.rows.entries()){
  const c=input.rows[i];assert.deepEqual(r.order,order(i));assert.equal(new Set(r.observations.map(t=>t.key)).size,r.observations.length);assert.ok(r.observations.length<=3);
  for(const item of r.observations){assert.ok(KEYS.includes(item.key));assert.deepEqual(item.request,fixedRequest(c.body,input.best,item.key));assert.equal(item.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(item.answer.choice));const event=events.find(e=>e.kind==='answer'&&e.id===`rep${input.repId}/${c.id}/${item.key}`);assert.ok(event);assert.deepEqual(event.item,item);observed++;}
  const choice=k=>r.observations.find(t=>t.key===k)?.answer.choice??null,O=choice('sharedO');scoredRows.push({id:c.id,best:{E:choice('bestE'),O},scoped:{E:choice('scopedE'),O}});
 }
 assert.equal(answers.length,observed);assert.equal(typeof report.modelDrift,'boolean');
 return {repId:input.repId,modelStable:report.modelDrift===false,rows:scoredRows,effectCounts:{assigned:input.maxPosts,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:input.maxPosts-answers.length,unattempted:input.maxPosts-attempts.length},usageScope:'each physical template once per pass; O aliases roles within this pass only; no cross-pass reuse'};
}
