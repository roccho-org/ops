import assert from 'node:assert/strict';import {digest} from '../run.mjs';
import {pairedComparison} from '../counterfactual/comparison.mjs';import {scopedRequest,scopedTemplates,wireTemplate} from './scoped-request.mjs';
export async function prepareScopedDevelopment(development,cachedReport,cachedBest,execution,cacheOrigin){
 assert.ok(Number.isSafeInteger(cacheOrigin.runId));assert.equal(cacheOrigin.runAttempt,1);
 const best=development.best,rows=development.rows.map(({id,family,body})=>({id,family,body}));assert.equal(rows.length,32);assert.equal(cachedBest.length,32);
 const proof=await scopedTemplates(best),aliases=[];
 for(const c of rows){const row=cachedReport.rows.find(r=>r.id===c.id),old=row.configurations.find(x=>x.id==='best').target.find(t=>t.role==='O');assert.ok(old);assert.equal(old.answer.model,'jev-1.13.0');
  assert.deepEqual(await wireTemplate(old.request),await wireTemplate(scopedRequest(c.body,best,'O')));
  const b=cachedBest.find(r=>r.id===c.id);assert.equal(b.status,'qualified');assert.equal(b.O,old.answer.choice);assert.equal(b.model,'jev-1.13.0');aliases.push({id:c.id,axis:'O',origin:{...cacheOrigin,configuration:'best',caseId:c.id,axis:'O'},value:b.O});
 }
 return {phase:'development-scoped',rows,best,templateProof:proof,cacheOrigin,historicalOAliases:aliases,expectedModel:'jev-1.13.0',maxPosts:32,execution};
}
export async function evaluateScopedDevelopment(input,ask,observe=()=>{}){
 assert.equal(input.phase,'development-scoped');assert.equal(input.rows.length,32);assert.equal(input.maxPosts,32);let stopped=false;const rows=[];
 for(const c of input.rows){const row={id:c.id,E:null},id=c.id+'/scoped/E';
  if(!stopped){const request=scopedRequest(c.body,input.best,'E');observe({kind:'attempt',id});const start=performance.now();
   try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(['yes','no'].includes(answer.choice));row.E={axis:'E',request,answer,elapsedMs:performance.now()-start};observe({kind:'answer',id,item:row.E});}
   catch(e){observe({kind:'qualification-unknown',id});if(e?.modelChanged===true)stopped=true;}
  }
  rows.push(row);observe({kind:'row',row});
 }
 return {inputDigest:digest(input),modelDrift:stopped,rows};
}
export function verifyScopedEffects(input,report,events){
 assert.equal(input.maxPosts,32);const ids=kind=>events.filter(e=>e.kind===kind).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown'),expected=input.rows.map(c=>c.id+'/scoped/E');
 assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.equal(new Set(attempts).size,attempts.length);assert.ok(attempts.length<=32);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);
 assert.ok(answers.every(id=>posts.includes(id)));assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.equal(answers.length+failures.length,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());
 assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);assert.equal(answers.length,report.rows.filter(r=>r.E).length);
 return {assignedPosts:32,attempted:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:32-answers.length,unattempted:32-attempts.length,historicalOAliases:32};
}
export async function scopedDevelopmentProjection(input,report,gold,cachedBest,cacheOrigin){
 assert.equal(report.inputDigest,digest(input));assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(c=>c.id));assert.deepEqual(gold.map(c=>c.id),input.rows.map(c=>c.id));assert.deepEqual(input.templateProof,await scopedTemplates(input.best));assert.deepEqual(input.cacheOrigin,cacheOrigin);
 const rows=[];
 for(const [i,c]of gold.entries()){
  assert.equal(c.body,input.rows[i].body);const b=cachedBest.find(r=>r.id===c.id);assert.equal(b.status,'qualified');assert.equal(b.model,input.expectedModel);const alias=input.historicalOAliases[i];assert.equal(alias.id,c.id);assert.equal(alias.value,b.O);assert.deepEqual(alias.origin,{...cacheOrigin,configuration:'best',caseId:c.id,axis:'O'});
  const e=report.rows[i].E;if(e){assert.equal(e.axis,'E');assert.deepEqual(e.request,scopedRequest(c.body,input.best,'E'));assert.equal(e.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(e.answer.choice));}
  rows.push({...b,arm:'best',observationOrigin:'historical PR606 Best E/O'});
  rows.push({id:c.id,arm:'feedback',status:e?'qualified':'unknown',model:input.expectedModel,E:e?.answer.choice,O:b.O,observationOrigin:{E:e?'native scoped E':'unknown',O:alias.origin}});
 }
 const scored=pairedComparison(gold,rows,input.expectedModel),pair=scored.A;
 let disposition=!pair.complete?'UNKNOWN':pair.axisRegressed.length?'OBSERVED_REGRESSION':'DEVELOPMENT_GUARD_PASS';
 if(report.modelDrift!==false)disposition='UNKNOWN';
 return {modelStable:report.modelDrift===false,rows:rows.map(r=>({...r,arm:r.arm==='feedback'?'scoped':r.arm})),comparison:{configuration:'original Best instructions + scoped E criteria',disposition,eligible:disposition==='DEVELOPMENT_GUARD_PASS',correct:scored.arms.feedback.correct,qualified:scored.arms.feedback.qualified,assigned:32,pair},
  claim:'configuration treatment only; original Best/O unchanged; historical O aliases are not new calls or independent observations'};
}
