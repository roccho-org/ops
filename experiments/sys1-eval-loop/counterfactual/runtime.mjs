import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {targetRequest} from '../feedback-improvement.mjs';import {failureDetails,responseFlags} from '../target-loop/loop.mjs';
import {judgeRequest,deriveDiagnosis,JUDGE_LABELS,repairInputs} from './comparison.mjs';
import {digest} from '../run.mjs';
const ROOT=fileURLToPath(new URL('./',import.meta.url));
export const BRANCH='codex/jev-feedback-counterfactual-20261020';
export const REQUEST='experiments/sys1-eval-loop/counterfactual/request.json';
const read=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x)+'\n',{flag:'wx',mode:0o600});
export function developmentInput(data,best,execution){
  assert.equal(data.schema,'ops.sys1.counterfactual-development.v1');assert.equal(data.cases.length,24);
  assert.equal(new Set(data.cases.map(c=>c.id)).size,24);assert.ok(best.trim());
  const rows=data.cases.map(({id,body,family})=>{assert.ok(body.trim()&&Buffer.byteLength(body)<16000);return {id,body,family};});
  return {schema:'ops.sys1.counterfactual-input.v1',phase:'development',rows,best,execution,maxPosts:72,expectedModel:'jev-1.13.0'};
}
export async function evaluateDevelopment(input,ask,observe=()=>{}){
  assert.equal(input.phase,'development');assert.equal(input.rows.length,24);assert.equal(input.maxPosts,72);
  const rows=[];let stop=false;
  for(const c of input.rows){const row={id:c.id,target:[],judge:null,diagnosis:{status:'unknown',diagnosis:null}};
    for(const role of ['E','O','judge']){
      if(stop)continue;const request=role==='judge'?judgeRequest(c.body):targetRequest(c.body,input.best,role),id=c.id+'/'+role;
      observe({kind:'attempt',id});const start=performance.now();
      try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);
        assert.ok(role==='judge'?Object.hasOwn(JUDGE_LABELS,answer.choice):['yes','no'].includes(answer.choice));
        const item={role,request,answer,elapsedMs:performance.now()-start};observe({kind:'answer',id,item});
        if(role==='judge')row.judge=item;else row.target.push(item);
      }catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)stop=true;}
    }
    if(row.target.length===2)row.diagnosis=deriveDiagnosis(row.judge?.answer.choice??null,Object.fromEntries(row.target.map(t=>[t.role,t.answer.choice])));
    rows.push(row);observe({kind:'row',row});
  }
  return {schema:'ops.sys1.counterfactual-report.v1',inputDigest:digest(input),terminalReceipt:true,modelDrift:stop,rows};
}
export function developmentProjection(input,report){
  assert.equal(report.schema,'ops.sys1.counterfactual-report.v1');assert.equal(report.inputDigest,digest(input));assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));
  for(const r of report.rows){const c=input.rows.find(c=>c.id===r.id);assert.ok(r.target.length<=2);assert.equal(new Set(r.target.map(t=>t.role)).size,r.target.length);
    for(const t of r.target){assert.ok(['E','O'].includes(t.role));assert.deepEqual(t.request,targetRequest(c.body,input.best,t.role));assert.equal(t.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(t.answer.choice));}
    if(r.judge){assert.equal(r.judge.role,'judge');assert.deepEqual(r.judge.request,judgeRequest(c.body));assert.equal(r.judge.answer.model,input.expectedModel);assert.ok(Object.hasOwn(JUDGE_LABELS,r.judge.answer.choice));}
    const expected=r.target.length===2?deriveDiagnosis(r.judge?.answer.choice??null,Object.fromEntries(r.target.map(t=>[t.role,t.answer.choice]))):{status:'unknown',diagnosis:null};assert.deepEqual(r.diagnosis,expected);
  }
  const outputs=report.rows.map(r=>({id:r.id,status:r.target.length===2?'qualified':'unknown',...Object.fromEntries(r.target.map(t=>[t.role,t.answer.choice]))}));
  const advice=report.rows.map(r=>({id:r.id,...r.diagnosis}));
  const targetComplete=outputs.every(r=>r.status==='qualified'),judgeComplete=report.rows.every(r=>r.judge);
  return {targetComplete,judgeComplete,modelStable:report.modelDrift===false,outputs,advice,repair:targetComplete&&report.modelDrift===false?repairInputs(input.rows,outputs,advice,input.best):null,
    goldScoring:'private root only until both generated candidates frozen; no correctness supplied here'};
}
async function main(){
  const [mode,dir]=process.argv.slice(2);assert.ok(['prepare','evaluate','project'].includes(mode)&&dir);fs.mkdirSync(dir,{recursive:true});const at=n=>path.join(dir,n);
  if(mode==='prepare'){
    assert.ok(!process.env.JEV_API_KEY);assert.equal(process.env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(process.env.GITHUB_ACTOR,'roccho-dev');
    assert.equal(process.env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
    const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),request=read('request.json');
    assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.equal(request.phase,'development');
    assert.equal(git('rev-parse','HEAD^'),request.sourceSha);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);
    assert.deepEqual(git('diff','--name-only','HEAD^','HEAD').split('\n'),[REQUEST]);
    const response=await fetch(`https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-counterfactual.yml/runs?branch=${BRANCH}&event=push&per_page=100`,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const history=await response.json();assert.equal(history.total_count,1);assert.equal(history.workflow_runs.length,1);
    const run=history.workflow_runs[0];assert.equal(String(run.id),process.env.GITHUB_RUN_ID);assert.equal(run.head_sha,process.env.GITHUB_SHA);assert.equal(run.run_attempt,1);assert.equal(run.actor.login,'roccho-dev');
    write(at('input.json'),developmentInput(read('development.json'),read('../candidates/binary-eo-v3.json').instructions,{runUrl:`https://github.com/roccho-org/ops/actions/runs/${run.id}`,source:request.sourceSha,activation:run.head_sha}));
  }else if(mode==='evaluate'){
    const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
    write(at('attempt.json'),{inputDigest:digest(input),maxPosts:72});
    let calls=0,activeId=null,httpStatus=null,stage='local';const observe=e=>{if(e.kind==='attempt')activeId=e.id;fs.appendFileSync(at('events.jsonl'),JSON.stringify(e)+'\n',{mode:0o600});};
    const client=await import('../../../packages/jev/src/client.mjs'),bound=client.bindJev({apiKey:process.env.JEV_API_KEY,fetch:async(u,i)=>{const r=await fetch(u,{...i,redirect:'error'});httpStatus=r.status;return r;}});
    const ask=async request=>{let usage=null;httpStatus=null;stage='local';try{
      const provider={available:bound.available,post:async body=>{assert.equal(body.model,'jev-latest');assert.equal(Object.keys(body.answers??{}).length,0);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);assert.ok(calls<input.maxPosts);calls++;stage='provider';
        const data=await bound.post(body,{deadlineMs:15000});observe({kind:'response-flags',id:activeId,...responseFlags(data,input.expectedModel)});
        stage='response-model';if(data.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}
        stage='response-answers';assert.deepEqual(Object.keys(data.answers??{}),['live']);const a=data.answers.live,p=a.probabilities;stage='response-probabilities';
        assert.ok(Math.abs(Object.values(p).reduce((s,v)=>s+v,0)-1)<1e-5&&p[a.choice]>=Math.max(...Object.values(p))-1e-6);
        usage=Object.fromEntries(Object.entries(data.usage??{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));stage='typed-contract';return data;}};
      const r=await client.askJevChoice({...request,provider});return {choice:r.choice.choice,model:r.model,usage};
    }catch(error){observe({kind:'failure',id:activeId,...failureDetails(error,stage,httpStatus)});throw error;}};
    const report=await evaluateDevelopment(input,ask,observe);report.actualPosts=calls;write(at('predictions.json'),report);
    if(report.rows.some(r=>r.target.length!==2||!r.judge))process.exitCode=2;
  }else{
    assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8')),report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));
    const result=developmentProjection(input,report);write(at('projection.json'),result);if(!result.targetComplete||!result.judgeComplete)process.exitCode=2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('COUNTERFACTUAL_STOP: bounded source, qualification or transport failure; no retry');process.exitCode=2;});
