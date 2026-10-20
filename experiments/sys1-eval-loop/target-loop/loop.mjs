import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest} from '../run.mjs';
import {classify} from '../split.mjs';
import {evaluate as evaluateChunk,targetRequest,evaluatorRequest,DIAGNOSIS} from '../feedback-improvement.mjs';
import {parseEvents} from '../self-grading.mjs';

export const BRANCH='codex/jev-target-loop-20261020';
export const LIMIT=1000;
export const REQUEST='experiments/sys1-eval-loop/target-loop/request.json';
const ROOT=fileURLToPath(new URL('./',import.meta.url));
const readLocal=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x)+'\n',{flag:'wx',mode:0o600});
const rate=(n,d)=>({numerator:n,denominator:d,value:d?n/d:null});
const known=g=>g&&['yes','no'].includes(g.E)&&['yes','no'].includes(g.O)&&typeof g.basis==='string'&&g.basis.trim();
export function casesFor(dataset,read=readLocal) {
  if(dataset==='confirmation')return read('confirmation.json').cases;
  const fictional=read('development.json').cases,publication=read('public-snapshot.json'),gold=read('public-gold.json').rows;
  const rows=[...fictional,...publication.cases.map(c=>({...c,gold:gold.find(g=>g.id===c.id)??null}))];
  if(dataset==='expanded'||dataset==='stress'){
    const extra=read('stress.json').cases;
    if(dataset==='stress')return extra;rows.push(...extra);
  }
  return rows;
}
export function makeInput(request,execution={mode:'test-double'},read=readLocal) {
  assert.deepEqual(Object.keys(request).sort(),['configuration','dataset','phase','sourceSha']);
  assert.ok(['development','stress','validation','confirmation'].includes(request.phase));
  assert.ok(['development','stress','expanded','confirmation'].includes(request.dataset));
  assert.match(request.sourceSha,/^[a-f0-9]{40}$/);
  assert.ok(request.configuration==='baseline'||/^candidate-[1-3]$/.test(request.configuration));
  if(request.phase==='development')assert.ok(request.dataset==='development'&&request.configuration==='baseline');
  if(request.phase==='stress')assert.ok(request.dataset==='stress'&&request.configuration==='baseline');
  if(request.phase==='validation')assert.ok(['development','expanded'].includes(request.dataset)&&request.configuration!=='baseline');
  if(request.phase==='confirmation')assert.ok(request.dataset==='confirmation'&&request.configuration!=='baseline');
  const cases=casesFor(request.dataset,read);
  assert.equal(cases.length,{development:48,stress:24,expanded:72,confirmation:48}[request.dataset]);
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  for(const c of cases){assert.ok(typeof c.body==='string'&&c.body.trim()&&Buffer.byteLength(c.body)<16000);assert.ok(c.gold===null||known(c.gold));}
  const baseline=read('../candidates/binary-eo-v3.json').instructions;
  let candidate=null;
  if(request.configuration!=='baseline'){
    candidate=read(request.configuration+'.json');assert.equal(candidate.id,request.configuration);
    assert.ok(typeof candidate.instructions==='string'&&candidate.instructions.trim()&&Buffer.byteLength(candidate.instructions)<6000);
    assert.notEqual(candidate.instructions,baseline);assert.ok(Array.isArray(candidate.feedback)&&candidate.feedback.length>0);
    for(const f of candidate.feedback)assert.ok(typeof f.caseId==='string'&&['evaluator','gold-sys2'].includes(f.origin)&&typeof f.decision==='string'&&f.decision.trim());
  }
  const controls=request.phase==='development'?cases.slice(0,16).map((c,n)=>{
    assert.ok(known(c.gold));const flip=x=>x==='yes'?'no':'yes';
    return {id:'injected-'+c.id,caseId:c.id,body:c.body,E:n%3===1?c.gold.E:flip(c.gold.E),O:n%3===0?c.gold.O:flip(c.gold.O)};
  }):[];
  const maxPosts=cases.length*(request.phase==='confirmation'?4:3)+controls.length;
  const input={schema:'ops.sys1.target-loop-input.v1',request,execution,baseline,candidate,
    rows:cases.map(({id,body,family})=>({id,body,family:family??'unspecified'})),controls,maxPosts,expectedModel:'jev-1.13.0',deadlineMs:15000};
  const key=digest({phase:request.phase,bodies:input.rows.map(r=>r.body),baseline,candidate:candidate?.instructions??null,controls});
  return {input,plan:{maxPosts,key}};
}
export function admit(request,env,history,source,plans) {
  assert.equal(env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(env.GITHUB_ACTOR,'roccho-dev');
  assert.equal(env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
  assert.equal(source.head,env.GITHUB_SHA);assert.equal(source.parent,request.sourceSha);assert.deepEqual(source.changed,[REQUEST]);
  assert.equal(history.total_count,history.workflow_runs.length);assert.ok(history.total_count>0&&history.total_count<=100);
  const current=history.workflow_runs.find(r=>String(r.id)===env.GITHUB_RUN_ID);assert.ok(current);assert.equal(current.head_sha,source.head);
  const keys=[],reservations=[];
  for(const r of history.workflow_runs){assert.equal(r.run_attempt,1);assert.equal(r.actor.login,'roccho-dev');assert.equal(r.event,'push');assert.equal(r.head_branch,BRANCH);
    if(r!==current)assert.equal(r.status,'completed');
    const p=plans[r.head_sha];assert.ok(p&&Number.isInteger(p.maxPosts)&&p.maxPosts>0);keys.push(p.key);reservations.push(p.maxPosts);}
  assert.equal(new Set(keys).size,keys.length,'duplicate inference assignment is not a new experiment');
  const total=reservations.reduce((s,n)=>s+n,0);assert.ok(total<=LIMIT,'new-series 1000 POST limit');return total;
}
const order=input=>input.rows.flatMap((r,n)=>(input.request.phase==='confirmation'?(n%2?[input.request.configuration,'baseline']:['baseline',input.request.configuration]):[input.request.configuration]).map(arm=>({id:r.id,arm})));
export async function evaluate(input,ask,observe=()=>{}) {
  const confirmation=input.request.phase==='confirmation',size=confirmation?12:4,rows=[],controls=[];let stopped=false,attemptedPosts=0;
  const observed=e=>{if(e.kind==='attempt')attemptedPosts++;observe(e);};
  for(let offset=0;offset<input.rows.length;offset+=size){
    const chunk=input.rows.slice(offset,offset+size),rename=r=>({...r,arm:r.arm==='candidate'?input.request.configuration:confirmation?'baseline':input.request.configuration});
    if(stopped){rows.push(...order({...input,rows:chunk}).map(r=>({...r,status:'not_run',trace:[]})));continue;}
    const inner={phase:confirmation?'confirmation':'development',maxCalls:confirmation?48:12,
      rows:chunk.map(({id,body})=>({id,body})),baseline:confirmation?input.baseline:input.candidate?.instructions??input.baseline,
      candidate:input.candidate,expectedModel:input.expectedModel};
    const report=await evaluateChunk(inner,ask,e=>observed(e.kind==='row'?{kind:'row',row:rename(e.row)}:e));
    rows.push(...report.rows.map(rename));stopped=report.rows.some(r=>r.status!=='ok');
  }
  for(const c of input.controls){
    const row={id:c.id,caseId:c.caseId,status:'not_run'};
    if(!stopped){observed({kind:'attempt',id:c.id});const start=performance.now();
      try{const request=evaluatorRequest(c.body,c.E,c.O),answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(Object.hasOwn(DIAGNOSIS,answer.choice));
        Object.assign(row,{status:'ok',request,answer,elapsedMs:performance.now()-start});}
      catch{row.status='error';stopped=true;}}
    controls.push(row);observe({kind:'control',row});
  }
  return {schema:'ops.sys1.target-loop-predictions.v1',inputDigest:digest(input),terminalReceipt:true,attemptedPosts,rows,controls};
}
const expectedDiagnosis=(gold,E,O)=>!known(gold)?null:E!==gold.E?(O!==gold.O?'both_scope':'requirement_scope'):(O!==gold.O?'evidence_scope':'no_change');
// Development selection consumes ALL baseline batches, including correct cases.
// It is separate from one-shot confirmation and cannot turn judge agreement
// into an adoption gate.
export function compareDevelopment(baselines,candidate) {
  assert.ok(baselines.length>0&&candidate.request.phase==='validation');
  assert.ok(baselines.every(b=>['development','stress'].includes(b.request.phase)));
  const before=baselines.flatMap(b=>b.rows),after=candidate.rows;
  assert.equal(new Set(before.map(r=>r.id)).size,before.length);
  assert.deepEqual(before.map(r=>r.id).sort(),after.map(r=>r.id).sort());
  const regressed=[],axisRegressed=[],resolved=[];
  for(const b of before){const c=after.find(c=>c.id===b.id);assert.deepEqual(b.gold,c.gold);
    for(const axis of ['E','O']){const x=b.trace.find(t=>t.axis===axis),y=c.trace.find(t=>t.axis===axis);
      if(x&&y){assert.equal(x.request.text,y.request.text);assert.equal(x.answer.model,y.answer.model);
        if(known(b.gold)&&x.answer.choice===b.gold[axis]&&y.answer.choice!==b.gold[axis])axisRegressed.push({id:b.id,axis});}}
    if(b.correct===true&&c.correct===false)regressed.push(b.id);if(b.correct===false&&c.correct===true)resolved.push(b.id);}
  const complete=[...baselines,candidate].every(s=>s.status==='OBSERVATION_COMPLETE'),delta=complete?after.filter(r=>r.correct).length-before.filter(r=>r.correct).length:null;
  return {scope:'development selection only; not confirmation',assigned:before.length,delta,resolved,regressed,axisRegressed,
    outcome:!complete?'INCOMPLETE':regressed.length||axisRegressed.length?'REGRESSION_KEEP_BASELINE':delta>0?'DEVELOPMENT_CANDIDATE':'NO_EFFECT_KEEP_BASELINE'};
}
export function score(input,report,read=readLocal) {
  assert.deepEqual(input,makeInput(input.request,input.execution,read).input);assert.equal(report.inputDigest,digest(input));
  assert.equal(report.schema,'ops.sys1.target-loop-predictions.v1');assert.deepEqual(report.rows.map(({id,arm})=>({id,arm})),order(input));
  const cases=casesFor(input.request.dataset,read),arms={},rows=[],diagnostic={matched:0,falseAlarm:0,missed:0,wrongAxis:0,uncertain:0,unknown:0},observations=[];
  const confusion=()=>({truePositive:0,trueNegative:0,falsePositive:0,falseNegative:0,unknown:0});
  for(const row of report.rows){
    const c=cases.find(c=>c.id===row.id),instructions=row.arm==='baseline'?input.baseline:input.candidate.instructions;
    const a=arms[row.arm]??=( {assigned:0,completed:0,correct:0,wrong:0,unknown:0,axes:{E:confusion(),O:confusion()},families:{}} );a.assigned++;
    assert.ok(['ok','error','not_run'].includes(row.status));assert.ok(row.trace.length<=2);
    for(const [n,t] of row.trace.entries()){
      assert.equal(t.axis,['E','O'][n]);assert.deepEqual(t.request,targetRequest(c.body,instructions,t.axis));assert.equal(t.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(t.answer.choice));observations.push(t);
    }
    for(const axis of ['E','O']){const t=row.trace.find(t=>t.axis===axis),q=a.axes[axis];
      if(!t||!known(c.gold))q.unknown++;else q[t.answer.choice===c.gold[axis]?(c.gold[axis]==='yes'?'truePositive':'trueNegative'):(c.gold[axis]==='yes'?'falseNegative':'falsePositive')]++;}
    let correct=null,diagnosis=null;
    if(row.trace.length===2){a.completed++;assert.equal(row.prediction,classify(...row.trace.map(t=>t.answer.choice)));
      if(known(c.gold)){correct=row.prediction===classify(c.gold.E,c.gold.O);a[correct?'correct':'wrong']++;}else a.unknown++;
      if(input.request.phase!=='confirmation'){
        diagnosis=expectedDiagnosis(c.gold,...row.trace.map(t=>t.answer.choice));
        if(row.evaluator){assert.deepEqual(row.evaluator.request,evaluatorRequest(c.body,...row.trace.map(t=>t.answer.choice)));assert.equal(row.evaluator.answer.model,input.expectedModel);assert.ok(Object.hasOwn(DIAGNOSIS,row.evaluator.answer.choice));observations.push(row.evaluator);
          const actual=row.evaluator.answer.choice;
          diagnostic[!diagnosis?'unknown':actual===diagnosis?'matched':actual==='uncertain'?'uncertain':diagnosis==='no_change'?'falseAlarm':actual==='no_change'?'missed':'wrongAxis']++;
        }else diagnostic.unknown++;
      }
    }else{a.unknown++;if(input.request.phase!=='confirmation')diagnostic.unknown++;}
    const f=a.families[c.family??'unspecified']??={assigned:0,correct:0,wrong:0,unknown:0};f.assigned++;f[correct===null?'unknown':correct?'correct':'wrong']++;
    rows.push({...row,gold:c.gold,correct,expectedDiagnosis:diagnosis});
  }
  assert.deepEqual(report.controls.map(r=>r.id),input.controls.map(r=>r.id));
  const injected={assigned:input.controls.length,matched:0,wrong:0,uncertain:0,unknown:0,rows:[]};
  for(const r of report.controls){const c=input.controls.find(c=>c.id===r.id),gold=cases.find(x=>x.id===c.caseId).gold,expected=expectedDiagnosis(gold,c.E,c.O);
    if(r.status==='ok'){assert.deepEqual(r.request,evaluatorRequest(c.body,c.E,c.O));assert.equal(r.answer.model,input.expectedModel);assert.ok(Object.hasOwn(DIAGNOSIS,r.answer.choice));observations.push(r);
      injected[r.answer.choice===expected?'matched':r.answer.choice==='uncertain'?'uncertain':'wrong']++;
    }else injected.unknown++;
    injected.rows.push({...r,expectedDiagnosis:expected});}
  const complete=report.terminalReceipt===true&&report.actualPosts===input.maxPosts&&report.attemptedPosts===input.maxPosts&&report.rows.every(r=>r.status==='ok')&&report.controls.every(r=>r.status==='ok')&&Object.values(arms).every(a=>a.unknown===0);
  const judged=rows.filter(r=>r.expectedDiagnosis),errors=judged.filter(r=>r.expectedDiagnosis!=='no_change'),correct=judged.filter(r=>r.expectedDiagnosis==='no_change');
  const group=rs=>({assigned:rs.length,matched:rs.filter(r=>r.evaluator?.answer.choice===r.expectedDiagnosis).length,
    missed:rs.filter(r=>r.expectedDiagnosis!=='no_change'&&r.evaluator?.answer.choice==='no_change').length,
    falseAlarm:rs.filter(r=>r.expectedDiagnosis==='no_change'&&r.evaluator&& !['no_change','uncertain'].includes(r.evaluator.answer.choice)).length,
    wrongAxis:rs.filter(r=>r.expectedDiagnosis!=='no_change'&&r.evaluator&&!['no_change','uncertain',r.expectedDiagnosis].includes(r.evaluator.answer.choice)).length,
    uncertain:rs.filter(r=>r.evaluator?.answer.choice==='uncertain').length,unknown:rs.filter(r=>!r.evaluator).length});
  diagnostic.actualErrors=group(errors);diagnostic.actualCorrect=group(correct);
  diagnostic.errorDetection=rate(errors.filter(r=>r.evaluator&&!['no_change','uncertain'].includes(r.evaluator.answer.choice)).length,errors.length);
  diagnostic.falseAlarmRate=rate(diagnostic.actualCorrect.falseAlarm,correct.length);
  for(const a of Object.values(arms)){a.completion=rate(a.completed,a.assigned);a.accuracy=complete?rate(a.correct,a.assigned):{...rate(a.correct,a.assigned),value:null};}
  const resolved=[],regressed=[],axisRegressed=[];
  if(input.request.phase==='confirmation')for(const c of cases){const b=rows.find(r=>r.id===c.id&&r.arm==='baseline'),v=rows.find(r=>r.id===c.id&&r.arm!=='baseline');
    if(b.correct===false&&v.correct===true)resolved.push(c.id);if(b.correct===true&&v.correct===false)regressed.push(c.id);
    for(const axis of ['E','O']){const before=b.trace.find(t=>t.axis===axis),after=v.trace.find(t=>t.axis===axis);if(known(c.gold)&&before&&after&&before.answer.choice===c.gold[axis]&&after.answer.choice!==c.gold[axis])axisRegressed.push({id:c.id,axis});}}
  const usageRows=observations.filter(x=>Object.values(x.answer.usage??{}).some(Number.isFinite));
  const result={schema:'ops.sys1.target-loop-measurement.v1',execution:input.execution,request:input.request,inputDigest:digest(input),status:complete?'OBSERVATION_COMPLETE':'INCOMPLETE',
    actualPosts:report.actualPosts??null,maxPosts:input.maxPosts,arms,diagnostic,injectedControls:injected,rows,resolved,regressed,axisRegressed,
    usage:usageRows.length?usageRows.reduce((s,x)=>{for(const[k,v]of Object.entries(x.answer.usage))if(Number.isFinite(v))s[k]=(s[k]??0)+v;return s;},{}):null,
    usageRows:usageRows.length,elapsedMs:observations.reduce((s,x)=>s+(x.elapsedMs??0),0),providerCost:null,humanCost:null,
    evidenceScope:input.request.phase==='confirmation'?'root-authored, trusted knowledge-separated one-shot confirmation; not OS-isolated or a population claim':'all assigned development cases; never confirmation quality',
    evaluatorContribution:'NOT_IDENTIFIED',appsEffect:'NOT_TESTED',qualityAdoptionAuthorized:false};
  if(input.request.phase==='confirmation'){const a=arms[input.request.configuration],b=arms.baseline;result.delta=complete?a.correct-b.correct:null;
    result.outcome=!complete?'INCOMPLETE':axisRegressed.length||regressed.length?'REGRESSION_KEEP_BASELINE':result.delta>0?'FINITE_IMPROVEMENT_CANDIDATE':'NO_EFFECT_KEEP_BASELINE';
    result.repairRate=complete?rate(resolved.length,b.wrong):null;result.breakRate=complete?rate(regressed.length,b.correct):null;}
  return result;
}
async function main(){
  const [mode,dir]=process.argv.slice(2);assert.ok(dir&&['prepare','evaluate','score'].includes(mode));fs.mkdirSync(dir,{recursive:true});const at=n=>path.join(dir,n);
  if(mode==='prepare'){
    assert.ok(!process.env.JEV_API_KEY);assert.equal(process.env.GITHUB_ACTIONS,'true');
    const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),source={head:git('rev-parse','HEAD'),parent:git('rev-parse','HEAD^'),changed:git('diff','--name-only','HEAD^','HEAD').split('\n')};
    const request=readLocal('request.json'),r=await fetch('https://api.github.com/repos/roccho-org/ops/actions/workflows/sys1-target-loop.yml/runs?branch='+BRANCH+'&event=push&per_page=100',
      {headers:{Authorization:'Bearer '+process.env.GH_TOKEN},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);const history=await r.json(),plans={};
    let confirmations=0;
    for(const run of history.workflow_runs){const read=p=>JSON.parse(git('show',run.head_sha+':'+path.posix.normalize('experiments/sys1-eval-loop/target-loop/'+p)));
      const old=read('request.json');if(old.phase==='confirmation')confirmations++;plans[run.head_sha]=makeInput(old,{mode:'native-reservation'},read).plan;}
    assert.ok(confirmations<=1,'one confirmation, no selection on repeated H');
    const reserved=admit(request,process.env,history,source,plans),execution={mode:'live',sourceSha:source.head,reviewedSourceSha:source.parent,reservedPosts:reserved,
      runUrl:`https://github.com/roccho-org/ops/actions/runs/${process.env.GITHUB_RUN_ID}`};
    write(at('input.json'),makeInput(request,execution).input);
  }else if(mode==='evaluate'){
    const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
    write(at('attempt.json'),{inputDigest:digest(input),maxPosts:input.maxPosts,reservedPosts:input.execution.reservedPosts});
    const observe=e=>{fs.appendFileSync(at('events.jsonl'),JSON.stringify(e)+'\n',{mode:0o600});console.log('TARGET_LOOP_EVENT '+JSON.stringify(e));};
    const client=await import('../../../packages/jev/src/client.mjs');let calls=0;
    const bound=client.bindJev({apiKey:process.env.JEV_API_KEY,fetch:(u,i)=>fetch(u,{...i,redirect:'error'})});
    const ask=async request=>{let usage=null;const provider={available:bound.available,post:async body=>{
      assert.equal(body.model,'jev-latest');assert.equal(Object.keys(body.answers??{}).length,0);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);
      assert.ok(calls<input.maxPosts);calls++;const data=await bound.post(body,{deadlineMs:15000});assert.equal(data.model,input.expectedModel);
      assert.deepEqual(Object.keys(data.answers??{}),['live']);const a=data.answers.live,p=a.probabilities;
      assert.ok(Math.abs(Object.values(p).reduce((s,v)=>s+v,0)-1)<1e-5&&p[a.choice]>=Math.max(...Object.values(p))-1e-6);
      usage=Object.fromEntries(Object.entries(data.usage??{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));return data;}};
      const r=await client.askJevChoice({...request,provider});return {choice:r.choice.choice,model:r.model,usage};};
    const report=await evaluate(input,ask,observe);report.actualPosts=calls;write(at('predictions.json'),report);
    if(report.rows.some(r=>r.status!=='ok')||report.controls.some(r=>r.status!=='ok'))process.exitCode=2;
  }else{
    assert.ok(!process.env.JEV_API_KEY);const input=JSON.parse(fs.readFileSync(at('input.json'),'utf8'));let report;
    try{report=JSON.parse(fs.readFileSync(at('predictions.json'),'utf8'));}catch{
      const {events,truncatedFinalRecord}=parseEvents(fs.existsSync(at('events.jsonl'))?fs.readFileSync(at('events.jsonl'),'utf8'):'');
      report={schema:'ops.sys1.target-loop-predictions.v1',inputDigest:digest(input),terminalReceipt:false,actualPosts:null,attemptedPosts:events.filter(e=>e.kind==='attempt').length,truncatedFinalRecord,
        rows:order(input).map(r=>events.find(e=>e.kind==='row'&&e.row.id===r.id&&e.row.arm===r.arm)?.row??{...r,status:'not_run',trace:[]}),
        controls:input.controls.map(c=>events.find(e=>e.kind==='control'&&e.row.id===c.id)?.row??{id:c.id,caseId:c.caseId,status:'not_run'})};
      write(at('recovered-predictions.json'),report);}
    const result=score(input,report);write(at('measurement.json'),result);console.log('TARGET_LOOP_RESULT '+JSON.stringify(result));
    if(result.status!=='OBSERVATION_COMPLETE')process.exitCode=2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('TARGET_LOOP_STOP: source, input, model, auth or transport failure; no automatic retry');process.exitCode=2;});
