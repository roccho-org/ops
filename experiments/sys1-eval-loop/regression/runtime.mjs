import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {developmentProjection,verifyEffects} from './targets.mjs';import {loadDevelopment} from './development.mjs';
import {prepareScopedDevelopment,evaluateScopedDevelopment,scopedDevelopmentProjection,verifyScopedEffects} from './scoped-development.mjs';
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
async function main(){
 const [mode,dir]=process.argv.slice(2);assert.ok(['prepare','evaluate','project'].includes(mode)&&dir);fs.mkdirSync(dir,{recursive:true});const at=n=>path.join(dir,n);
 if(mode==='prepare'){
  assert.ok(!process.env.JEV_API_KEY);assert.equal(process.env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(process.env.GITHUB_ACTOR,'roccho-dev');assert.equal(process.env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),request=read('regression/request.json');assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.equal(request.phase,'development-scoped');
  assert.equal(git('rev-parse','HEAD^'),request.sourceSha);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);assert.deepEqual(git('diff','--name-only','HEAD^','HEAD').split('\n'),[REQUEST]);
  const response=await fetch(`https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-regression-repair.yml/runs?branch=${BRANCH}&event=push&per_page=100`,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
  const history=await response.json();assert.equal(history.total_count,2);assert.equal(history.workflow_runs.length,2);const run=history.workflow_runs.find(r=>String(r.id)===process.env.GITHUB_RUN_ID);assert.ok(run);assert.equal(run.head_sha,process.env.GITHUB_SHA);assert.equal(run.run_attempt,1);assert.equal(run.actor.login,'roccho-dev');assert.equal(run.event,'push');assert.equal(run.head_branch,BRANCH);
  const prior=retainedDevelopmentFailure(),observed=history.workflow_runs.find(r=>r.id===prior.provider.runId);assert.ok(observed);assert.equal(observed.head_sha,prior.provider.head);assert.equal(observed.head_sha,prior.input.execution.activation);assert.equal(observed.run_attempt,1);assert.equal(observed.status,'completed');assert.equal(observed.conclusion,prior.provider.conclusion);assert.equal(observed.actor.login,'roccho-dev');assert.equal(observed.event,'push');assert.equal(observed.head_branch,BRANCH);
  const d=loadDevelopment(),cached=cachedSource();
  const input=await prepareScopedDevelopment(d,cached.report,cached.rows,{source:request.sourceSha,activation:run.head_sha,runUrl:`https://github.com/roccho-org/ops/actions/runs/${run.id}`},cached.origin);assert.deepEqual(input.templateProof,read('regression/scoped-plan.json'));write(at('input.json'),input);
 }else if(mode==='evaluate'){
  const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');write(at('attempt.json'),{inputDigest:digest(input),maxPosts:input.maxPosts});
  let calls=0,activeId=null,httpStatus=null,stage='local';const observe=e=>{if(e.kind==='attempt')activeId=e.id;fs.appendFileSync(at('events.jsonl'),JSON.stringify(e)+'\n',{mode:0o600});};
  const client=await import('../../../packages/jev/src/client.mjs'),bound=client.bindJev({apiKey:process.env.JEV_API_KEY,fetch:async(u,i)=>{const r=await fetch(u,{...i,redirect:'error'});httpStatus=r.status;return r;}});
  const ask=async request=>{let usage=null;httpStatus=null;stage='local';try{
   const provider={available:bound.available,post:async body=>{assert.equal(body.model,'jev-latest');assert.equal(Object.keys(body.answers??{}).length,0);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);assert.ok(calls<input.maxPosts);calls++;observe({kind:'post',id:activeId});stage='provider';
    const data=await bound.post(body,{deadlineMs:15000});observe({kind:'response-flags',id:activeId,...responseFlags(data,input.expectedModel)});stage='response-model';if(data.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}
    stage='response-answers';assert.deepEqual(Object.keys(data.answers??{}),['live']);const a=data.answers.live,p=a.probabilities;stage='response-probabilities';assert.ok(Math.abs(Object.values(p).reduce((s,v)=>s+v,0)-1)<1e-5&&p[a.choice]>=Math.max(...Object.values(p))-1e-6);
    usage=Object.fromEntries(Object.entries(data.usage??{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));stage='typed-contract';return data;}};
   const r=await client.askJevChoice({...request,provider});return {choice:r.choice.choice,model:r.model,usage};
  }catch(error){observe({kind:'failure',id:activeId,...failureDetails(error,stage,httpStatus)});throw error;}};
  const report=await evaluateScopedDevelopment(input,ask,observe);report.actualPosts=calls;write(at('predictions.json'),report);if(report.modelDrift||report.rows.some(r=>!r.E))process.exitCode=2;
 }else{
  assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8')),report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));
  const cached=cachedSource();assert.deepEqual(input,await prepareScopedDevelopment(loadDevelopment(),cached.report,cached.rows,input.execution,cached.origin));
  const events=fs.readFileSync(at('events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const effectCounts=verifyScopedEffects(input,report,events),p=await scopedDevelopmentProjection(input,report,read('counterfactual/confirmation-gold.json').cases,cached.rows,cached.origin);write(at('projection.json'),{...p,effectCounts});if(!p.modelStable||p.comparison.qualified!==32)process.exitCode=2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('REGRESSION_STOP: bounded source, qualification or transport failure; no retry');process.exitCode=2;});
