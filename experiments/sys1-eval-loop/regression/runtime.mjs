import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {developmentPlan,evaluateTargets,developmentProjection,verifyEffects} from './targets.mjs';import {loadDevelopment,loadRepairResults} from './development.mjs';
import {digest} from '../run.mjs';import {failureDetails,responseFlags} from '../target-loop/loop.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),BRANCH='codex/jev-regression-repair-20261020',REQUEST='experiments/sys1-eval-loop/regression/request.json';
const read=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8')),write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x)+'\n',{flag:'wx',mode:0o600});
async function main(){
 const [mode,dir]=process.argv.slice(2);assert.ok(['prepare','evaluate','project'].includes(mode)&&dir);fs.mkdirSync(dir,{recursive:true});const at=n=>path.join(dir,n);
 if(mode==='prepare'){
  assert.ok(!process.env.JEV_API_KEY);assert.equal(process.env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(process.env.GITHUB_ACTOR,'roccho-dev');assert.equal(process.env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),request=read('regression/request.json');assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.equal(request.phase,'development');
  assert.equal(git('rev-parse','HEAD^'),request.sourceSha);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);assert.deepEqual(git('diff','--name-only','HEAD^','HEAD').split('\n'),[REQUEST]);
  const response=await fetch(`https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-regression-repair.yml/runs?branch=${BRANCH}&event=push&per_page=100`,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
  const history=await response.json();assert.equal(history.total_count,1);assert.equal(history.workflow_runs.length,1);const run=history.workflow_runs[0];assert.equal(String(run.id),process.env.GITHUB_RUN_ID);assert.equal(run.head_sha,process.env.GITHUB_SHA);assert.equal(run.run_attempt,1);assert.equal(run.actor.login,'roccho-dev');assert.equal(run.event,'push');assert.equal(run.head_branch,BRANCH);
  const d=loadDevelopment(),plan=developmentPlan(d,loadRepairResults());assert.ok(plan.maxPosts>0&&plan.maxPosts<=128);
  const rows=d.rows.map(({id,family,body})=>({id,family,body}));
  write(at('input.json'),{phase:'development',rows,plan,maxPosts:plan.maxPosts,expectedModel:'jev-1.13.0',execution:{source:request.sourceSha,activation:run.head_sha,runUrl:`https://github.com/roccho-org/ops/actions/runs/${run.id}`}});
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
  const report=await evaluateTargets(input,ask,observe);report.actualPosts=calls;write(at('predictions.json'),report);if(report.modelDrift||report.rows.some(r=>r.configurations.some(c=>c.target.length!==2)))process.exitCode=2;
 }else{
  assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8')),report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));
  const cached=read('results/counterfactual-confirmation-20261020/projection.json').physicalRows.filter(r=>r.configuration==='best');
  const events=fs.readFileSync(at('events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const effectCounts=verifyEffects(input,report,events),p=developmentProjection(input,report,read('counterfactual/confirmation-gold.json').cases,cached);write(at('projection.json'),{...p,effectCounts});if(!p.modelStable||p.physical.some(r=>r.status!=='qualified'))process.exitCode=2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('REGRESSION_STOP: bounded source, qualification or transport failure; no retry');process.exitCode=2;});
