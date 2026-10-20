import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {targetRequest} from '../feedback-improvement.mjs';import {failureDetails,responseFlags} from '../target-loop/loop.mjs';
import {judgeRequest,deriveDiagnosis,JUDGE_LABELS,repairInputs} from './comparison.mjs';
import {configurationPlan,confirmationComparison} from './confirmation.mjs';
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
export function confirmationInput(data,frozen,execution){
  assert.equal(data.schema,'ops.sys1.counterfactual-root-corpus.v1');assert.equal(data.name,'confirmation');
  assert.equal(data.cases.length,32);assert.equal(new Set(data.cases.map(c=>c.id)).size,32);
  const plan=configurationPlan(Object.fromEntries(frozen.plan.configurations.map(c=>[c.id,c.instructions])));
  assert.deepEqual(plan,frozen.plan);assert.equal(plan.execute,true);assert.equal(plan.uniqueConfigCount,3);
  const rows=data.cases.map(({id,body,family})=>{assert.ok(body.trim()&&Buffer.byteLength(body)<16000);return {id,body,family};});
  return {schema:'ops.sys1.counterfactual-input.v1',phase:'confirmation',rows,plan,execution,maxPosts:plan.plannedPosts,expectedModel:'jev-1.13.0'};
}
export async function evaluateConfirmation(input,ask,observe=()=>{}){
  assert.equal(input.phase,'confirmation');assert.equal(input.rows.length,32);assert.equal(input.maxPosts,224);
  const rows=[];let stop=false;
  for(const [index,c]of input.rows.entries()){
    const configs=input.plan.configurations,offset=index%configs.length;
    const order=[...configs.slice(offset),...configs.slice(0,offset)];
    const row={id:c.id,order:order.map(x=>x.id),configurations:[],judge:null};
    for(const config of order){const target=[];
      for(const role of ['E','O']){
        if(stop)continue;const request=targetRequest(c.body,config.instructions,role),id=c.id+'/'+config.id+'/'+role;
        observe({kind:'attempt',id});const start=performance.now();
        try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(['yes','no'].includes(answer.choice));
          const item={role,request,answer,elapsedMs:performance.now()-start};target.push(item);observe({kind:'answer',id,item});
        }catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)stop=true;}
      }
      row.configurations.push({id:config.id,target});
    }
    if(!stop){const id=c.id+'/judge',request=judgeRequest(c.body);observe({kind:'attempt',id});const start=performance.now();
      try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(Object.hasOwn(JUDGE_LABELS,answer.choice));
        row.judge={role:'judge',request,answer,elapsedMs:performance.now()-start};observe({kind:'answer',id,item:row.judge});
      }catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)stop=true;}
    }
    rows.push(row);observe({kind:'row',row});
  }
  return {schema:'ops.sys1.counterfactual-confirmation-report.v1',inputDigest:digest(input),terminalReceipt:true,modelDrift:stop,rows};
}
export function confirmationProjection(input,report,gold){
  assert.equal(report.schema,'ops.sys1.counterfactual-confirmation-report.v1');assert.equal(report.inputDigest,digest(input));
  assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(c=>c.id));assert.deepEqual(gold.map(c=>c.id),input.rows.map(c=>c.id));
  const physicalRows=[],diagnoses=[];
  for(const [index,r]of report.rows.entries()){
    const c=input.rows[index],configs=input.plan.configurations,offset=index%configs.length;assert.equal(gold[index].body,c.body);
    const order=[...configs.slice(offset),...configs.slice(0,offset)];assert.deepEqual(r.order,order.map(x=>x.id));assert.deepEqual(r.configurations.map(x=>x.id),r.order);
    for(const config of r.configurations){const instructions=configs.find(p=>p.id===config.id).instructions;
      assert.ok(config.target.length<=2);assert.equal(new Set(config.target.map(t=>t.role)).size,config.target.length);
      for(const t of config.target){assert.ok(['E','O'].includes(t.role));assert.deepEqual(t.request,targetRequest(c.body,instructions,t.role));assert.equal(t.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(t.answer.choice));}
      physicalRows.push({id:r.id,configuration:config.id,status:config.target.length===2?'qualified':'unknown',model:input.expectedModel,...Object.fromEntries(config.target.map(t=>[t.role,t.answer.choice]))});
    }
    if(r.judge){assert.deepEqual(r.judge.request,judgeRequest(c.body));assert.equal(r.judge.answer.model,input.expectedModel);assert.ok(Object.hasOwn(JUDGE_LABELS,r.judge.answer.choice));}
    const best=physicalRows.find(p=>p.id===r.id&&p.configuration==='best');
    diagnoses.push({id:r.id,...(best.status==='qualified'?deriveDiagnosis(r.judge?.answer.choice??null,best):{status:'unknown',diagnosis:null})});
  }
  const comparison=confirmationComparison(gold,physicalRows,input.plan,input.expectedModel);
  if(report.modelDrift!==false)for(const key of ['A','B']){comparison[key].rawOutcome=comparison[key].outcome;comparison[key].outcome='UNKNOWN';comparison[key].reason='model drift makes this comparison incomparable';}
  const judgeMetrics={assigned:gold.length,qualified:0,unknown:0,correctClassification:0,actualTargetErrors:{assigned:0,detected:0,exactDiagnostic:0,wrongScope:0,missed:0,unknown:0},actualTargetCorrect:{assigned:0,falseAlarm:0,noChange:0,unknown:0},targetUnknown:0,rows:[]};
  for(const [i,g]of gold.entries()){
    const judge=report.rows[i].judge,actual=diagnoses[i],best=physicalRows.find(r=>r.id===g.id&&r.configuration==='best');
    if(judge){judgeMetrics.qualified++;const label=JUDGE_LABELS[judge.answer.choice];if(label.E===g.gold.E&&label.O===g.gold.O)judgeMetrics.correctClassification++;}else judgeMetrics.unknown++;
    const expectedLabel=Object.entries(JUDGE_LABELS).find(([,v])=>v.E===g.gold.E&&v.O===g.gold.O)?.[0];assert.ok(expectedLabel);
    const expected=best.status==='qualified'?deriveDiagnosis(expectedLabel,best):{status:'unknown',diagnosis:null};
    let targetStatus='unknown';
    if(best.status==='qualified'){
      const correct=best.E===g.gold.E&&best.O===g.gold.O,group=correct?judgeMetrics.actualTargetCorrect:judgeMetrics.actualTargetErrors;
      targetStatus=correct?'correct':'error';group.assigned++;
      if(actual.status!=='qualified')group.unknown++;else if(correct)actual.diagnosis==='no_change'?group.noChange++:group.falseAlarm++;else actual.diagnosis==='no_change'?group.missed++:group.detected++;
      if(!correct&&actual.status==='qualified'&&actual.diagnosis!=='no_change')actual.diagnosis===expected.diagnosis?group.exactDiagnostic++:group.wrongScope++;
    }else judgeMetrics.targetUnknown++;
    judgeMetrics.rows.push({id:g.id,targetStatus,expected,actual,exactDiagnosticMatch:expected.status==='qualified'&&actual.status==='qualified'?expected.diagnosis===actual.diagnosis:null});
  }
  return {targetComplete:physicalRows.every(r=>r.status==='qualified'),judgeComplete:report.rows.every(r=>r.judge),modelStable:report.modelDrift===false,physicalRows,diagnoses,judgeMetrics,comparison,
    holdoutDisposition:'retired after this single comparison; no candidate change or selection from its results'};
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
    assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.ok(['development','confirmation'].includes(request.phase));
    assert.equal(git('rev-parse','HEAD^'),request.sourceSha);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);
    assert.deepEqual(git('diff','--name-only','HEAD^','HEAD').split('\n'),[REQUEST]);
    const response=await fetch(`https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-counterfactual.yml/runs?branch=${BRANCH}&event=push&per_page=100`,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const history=await response.json(),expectedRuns=request.phase==='development'?1:2;
    assert.equal(history.total_count,expectedRuns);assert.equal(history.workflow_runs.length,expectedRuns);
    const run=history.workflow_runs.find(r=>String(r.id)===process.env.GITHUB_RUN_ID);assert.ok(run);assert.equal(run.head_sha,process.env.GITHUB_SHA);assert.equal(run.run_attempt,1);assert.equal(run.actor.login,'roccho-dev');
    if(request.phase==='confirmation'){
      const prior=read('../results/counterfactual-development-20261020/provider.json'),observed=history.workflow_runs.find(r=>r.id===prior.runId);
      assert.ok(observed);assert.equal(observed.head_sha,prior.head);assert.equal(observed.run_attempt,1);assert.equal(observed.conclusion,'success');
      assert.equal(observed.status,'completed');assert.equal(observed.actor.login,'roccho-dev');assert.equal(observed.event,'push');assert.equal(observed.head_branch,BRANCH);
      const frozen=read('../results/counterfactual-repair-20261020/parsed.json');
      assert.equal(frozen.plan.configurations.find(c=>c.id==='best').instructions,read('../candidates/binary-eo-v3.json').instructions);
      for(const arm of ['feedback','no-feedback']){assert.equal(frozen.results[arm].status,'valid');assert.equal(frozen.plan.configurations.find(c=>c.id===arm).instructions,frozen.results[arm].candidate.instructions);}
    }
    const execution={runUrl:`https://github.com/roccho-org/ops/actions/runs/${run.id}`,source:request.sourceSha,activation:run.head_sha};
    write(at('input.json'),request.phase==='development'?developmentInput(read('development.json'),read('../candidates/binary-eo-v3.json').instructions,execution):confirmationInput(read('confirmation-gold.json'),read('../results/counterfactual-repair-20261020/parsed.json'),execution));
  }else if(mode==='evaluate'){
    const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
    write(at('attempt.json'),{inputDigest:digest(input),maxPosts:input.maxPosts});
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
    const report=await(input.phase==='development'?evaluateDevelopment(input,ask,observe):evaluateConfirmation(input,ask,observe));report.actualPosts=calls;write(at('predictions.json'),report);
    if(report.rows.some(r=>(input.phase==='development'?r.target.length!==2:r.configurations.some(c=>c.target.length!==2))||!r.judge))process.exitCode=2;
  }else{
    assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8')),report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));
    const result=input.phase==='development'?developmentProjection(input,report):confirmationProjection(input,report,read('confirmation-gold.json').cases);
    write(at('projection.json'),result);if(!result.targetComplete||!result.judgeComplete||!result.modelStable)process.exitCode=2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('COUNTERFACTUAL_STOP: bounded source, qualification or transport failure; no retry');process.exitCode=2;});
