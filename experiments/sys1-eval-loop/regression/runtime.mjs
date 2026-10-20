import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {developmentProjection,verifyEffects} from './targets.mjs';import {loadDevelopment} from './development.mjs';
import {prepareScopedDevelopment,evaluateScopedDevelopment,scopedDevelopmentProjection,verifyScopedEffects} from './scoped-development.mjs';
import {prepareFreshScoped,evaluateFreshScoped,freshScopedProjection,verifyFreshEffects} from './scoped-fresh.mjs';
import {digest} from '../run.mjs';import {failureDetails,responseFlags} from '../target-loop/loop.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),BRANCH='codex/jev-regression-repair-20261020',REQUEST='experiments/sys1-eval-loop/regression/request.json';
const read=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8')),write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x)+'\n',{flag:'wx',mode:0o600});
function cachedSource(){
 const at='results/counterfactual-confirmation-20261020/',provider=read(at+'provider.json');
 return {report:read(at+'predictions.json'),rows:read(at+'projection.json').physicalRows.filter(r=>r.configuration==='best'),origin:{runId:provider.runId,runAttempt:provider.runAttempt,head:provider.head}};
}
export function retainedDevelopmentFailure(){
 const at='results/regression-validation-20261020/',i=read(at+'input.json'),r=read(at+'predictions.json'),cached=cachedSource();
 const events=fs.readFileSync(path.join(ROOT,at+'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const score={...developmentProjection(i,r,read('counterfactual/confirmation-gold.json').cases,cached.rows),effectCounts:verifyEffects(i,r,events)};
 assert.deepEqual(score,read(at+'projection.json'));assert.equal(score.modelStable,true);assert.equal(score.effectCounts.actualPosts,128);
 for(const c of Object.values(score.comparisons))assert.equal(c.disposition,'OBSERVED_REGRESSION');return {provider:read(at+'provider.json'),input:i};
}
export async function retainedScopedDevelopment(){
 const at='results/regression-scoped-development-20261020/',input=read(at+'input.json'),report=read(at+'predictions.json'),cached=cachedSource();
 const events=fs.readFileSync(path.join(ROOT,at+'events.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(input,await prepareScopedDevelopment(loadDevelopment(),cached.report,cached.rows,input.execution,cached.origin));
 const p={...await scopedDevelopmentProjection(input,report,read('counterfactual/confirmation-gold.json').cases,cached.rows,cached.origin),effectCounts:verifyScopedEffects(input,report,events)};
 assert.deepEqual(p,read(at+'projection.json'));assert.equal(p.modelStable,true);assert.equal(p.comparison.disposition,'DEVELOPMENT_GUARD_PASS');assert.equal(p.effectCounts.actualPosts,32);assert.deepEqual(input.templateProof,read('regression/scoped-plan.json'));
 return {provider:read(at+'provider.json'),input};
}
export async function preparedScreen(execution){
 const prior=await retainedScopedDevelopment(),data=read('regression/screen-gold.json'),origin=read('regression/screen-origin.json');assert.equal(data.name,'screen');assert.equal(data.cases.length,48);
 assert.equal(origin.disclosedAfterRun,prior.provider.runId);assert.ok(/^[0-9a-f]{40}$/.test(origin.sourceCommit));assert.equal(origin.sourcePath,'experiments/sys1-eval-loop/regression-root-data/screen-gold.json');
 const old=new Set(loadDevelopment().rows.map(c=>c.body));for(const c of data.cases){assert.ok(!old.has(c.body));assert.ok(['yes','no'].includes(c.gold.E)&&['yes','no'].includes(c.gold.O));}
 const input=await prepareFreshScoped(data,'screen',prior.input.best,execution);assert.deepEqual(input.templateProof,prior.input.templateProof);
 return {...input,dataOrigin:origin,priorDevelopment:{runId:prior.provider.runId,head:prior.provider.head,source:prior.input.execution.source}};
}
export async function retainedScreen(){
 const at='results/regression-screen-20261020/',input=read(at+'input.json'),report=read(at+'predictions.json');
 assert.deepEqual(input,await preparedScreen(input.execution));const events=fs.readFileSync(path.join(ROOT,at+'events.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const p={...await freshScopedProjection(input,report,read('regression/screen-gold.json').cases),effectCounts:verifyFreshEffects(input,report,events)};assert.deepEqual(p,read(at+'projection.json'));assert.equal(p.modelStable,true);assert.equal(p.comparison.disposition,'FINITE_GAIN');assert.equal(p.effectCounts.qualified,144);const selection=read(at+'selection.json');assert.equal(selection.decision,'SELECT_SINGLE_SCOPED_CONFIGURATION_FOR_ONE_FRESH_AUDIT');assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.auditAtSelection,'NOT_READ_NOT_RUN');assert.deepEqual(selection.configuration,{bestInstructions:input.best,templateProof:input.templateProof});return {provider:read(at+'provider.json'),input};
}
export async function preparedAudit(execution){
 const prior=await retainedScreen(),data=read('regression/audit-gold.json'),origin=read('regression/audit-origin.json');assert.equal(data.name,'audit');assert.equal(data.cases.length,64);assert.equal(origin.disclosedAfterRun,prior.provider.runId);assert.ok(/^[0-9a-f]{40}$/.test(origin.sourceCommit));assert.equal(origin.sourcePath,'experiments/sys1-eval-loop/regression-root-data/audit-gold.json');
 const old=new Set([...loadDevelopment().rows,...read('regression/screen-gold.json').cases].map(c=>c.body));for(const c of data.cases){assert.ok(!old.has(c.body));assert.ok(['yes','no'].includes(c.gold.E)&&['yes','no'].includes(c.gold.O));}
 const input=await prepareFreshScoped(data,'audit',prior.input.best,execution);assert.deepEqual(input.templateProof,prior.input.templateProof);return {...input,dataOrigin:origin,priorScreen:{runId:prior.provider.runId,head:prior.provider.head,source:prior.input.execution.source}};
}
async function main(){
 const [mode,dir]=process.argv.slice(2);assert.ok(['prepare','evaluate','project'].includes(mode)&&dir);fs.mkdirSync(dir,{recursive:true});const at=n=>path.join(dir,n);
 if(mode==='prepare'){
  assert.ok(!process.env.JEV_API_KEY);assert.equal(process.env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(process.env.GITHUB_ACTOR,'roccho-dev');assert.equal(process.env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),request=read('regression/request.json');assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.equal(request.phase,'audit');
  assert.equal(git('rev-parse','HEAD^'),request.sourceSha);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);assert.deepEqual(git('diff','--name-only','HEAD^','HEAD').split('\n'),[REQUEST]);
  const response=await fetch(`https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-regression-repair.yml/runs?branch=${BRANCH}&event=push&per_page=100`,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
  const history=await response.json();assert.equal(history.total_count,4);assert.equal(history.workflow_runs.length,4);const run=history.workflow_runs.find(r=>String(r.id)===process.env.GITHUB_RUN_ID);assert.ok(run);assert.equal(run.head_sha,process.env.GITHUB_SHA);assert.equal(run.run_attempt,1);assert.equal(run.actor.login,'roccho-dev');assert.equal(run.event,'push');assert.equal(run.head_branch,BRANCH);
  for(const prior of [retainedDevelopmentFailure(),await retainedScopedDevelopment(),await retainedScreen()]){
   const observed=history.workflow_runs.find(r=>r.id===prior.provider.runId);assert.ok(observed);assert.equal(observed.head_sha,prior.provider.head);assert.equal(observed.head_sha,prior.input.execution.activation);assert.equal(observed.run_attempt,1);assert.equal(observed.status,'completed');assert.equal(observed.conclusion,prior.provider.conclusion);assert.equal(observed.actor.login,'roccho-dev');assert.equal(observed.event,'push');assert.equal(observed.head_branch,BRANCH);
  }
  write(at('input.json'),await preparedAudit({source:request.sourceSha,activation:run.head_sha,runUrl:`https://github.com/roccho-org/ops/actions/runs/${run.id}`}));
 }else if(mode==='evaluate'){
  const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));assert.equal(input.phase,'audit');assert.equal(input.maxPosts,192);assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');write(at('attempt.json'),{inputDigest:digest(input),maxPosts:input.maxPosts});
  let calls=0,activeId=null,httpStatus=null,stage='local';const observe=e=>{if(e.kind==='attempt')activeId=e.id;fs.appendFileSync(at('events.jsonl'),JSON.stringify(e)+'\n',{mode:0o600});};
  const client=await import('../../../packages/jev/src/client.mjs'),bound=client.bindJev({apiKey:process.env.JEV_API_KEY,fetch:async(u,i)=>{const r=await fetch(u,{...i,redirect:'error'});httpStatus=r.status;return r;}});
  const ask=async request=>{let usage=null;httpStatus=null;stage='local';try{
   const provider={available:bound.available,post:async body=>{assert.equal(body.model,'jev-latest');assert.equal(Object.keys(body.answers??{}).length,0);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);assert.ok(calls<input.maxPosts);calls++;observe({kind:'post',id:activeId});stage='provider';
    const data=await bound.post(body,{deadlineMs:15000});observe({kind:'response-flags',id:activeId,...responseFlags(data,input.expectedModel)});stage='response-model';if(data.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}
    stage='response-answers';assert.deepEqual(Object.keys(data.answers??{}),['live']);const a=data.answers.live,p=a.probabilities;stage='response-probabilities';assert.ok(Math.abs(Object.values(p).reduce((s,v)=>s+v,0)-1)<1e-5&&p[a.choice]>=Math.max(...Object.values(p))-1e-6);
    usage=Object.fromEntries(Object.entries(data.usage??{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));stage='typed-contract';return data;}};
   const r=await client.askJevChoice({...request,provider});return {choice:r.choice.choice,model:r.model,usage};
  }catch(error){observe({kind:'failure',id:activeId,...failureDetails(error,stage,httpStatus)});throw error;}};
  const report=await evaluateFreshScoped(input,ask,observe);report.actualPosts=calls;write(at('predictions.json'),report);if(report.modelDrift||report.rows.some(r=>r.observations.length!==3))process.exitCode=2;
 }else{
  assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8')),report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));
  assert.deepEqual(input,await preparedAudit(input.execution));
  const events=fs.readFileSync(at('events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const effectCounts=verifyFreshEffects(input,report,events),p=await freshScopedProjection(input,report,read('regression/audit-gold.json').cases);write(at('projection.json'),{...p,effectCounts});if(!p.modelStable||effectCounts.qualified!==192)process.exitCode=2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('REGRESSION_STOP: bounded source, qualification or transport failure; no retry');process.exitCode=2;});
