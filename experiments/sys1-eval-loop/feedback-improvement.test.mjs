import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {corpus,prepare,evaluate,score,admit,targetRequest,evaluatorRequest,CAPS,BRANCH} from './feedback-improvement.mjs';
import {digest} from './run.mjs';
const ROOT=fileURLToPath(new URL('./',import.meta.url));
const answer=choice=>({choice,model:'jev-1.13.0',usage:null});
function fixture(phase='development') {
  const input=prepare('development');input.phase=phase;input.maxCalls=CAPS[phase];
  input.rows=corpus()[phase].map(({id,body})=>({id,body}));
  if(phase==='confirmation')input.candidate={schema:'ops.sys1.feedback-candidate.v1',instructions:input.baseline+'\nA test double only.',developmentRunUrl:'https://github.com/roccho-org/ops/actions/runs/1',feedback:[{caseId:'d-atlas',diagnosis:'evidence_scope',decision:'test double'}]};
  return input;
}
function tempRoot(candidate) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-fixture-'));fs.mkdirSync(path.join(root,'candidates'));
  for(const p of ['feedback-corpus.json','candidates/binary-eo-v3.json'])fs.copyFileSync(path.join(ROOT,p),path.join(root,p));
  if(candidate)fs.writeFileSync(path.join(root,'feedback-candidate.json'),JSON.stringify(candidate));
  return root;
}
function perfect(input){return async request=>{
  if(Object.hasOwn(request.criteria,'no_change'))return answer('no_change');
  const body=JSON.parse(request.text).body,r=corpus()[input.phase].find(r=>r.body===body);
  return answer(r.gold[request.instructions.includes('本問はEだけ')?'E':'O']);};}
test('fresh fictional cases and Gold are fixed, balanced, distinct and never in model inputs',()=>{
  const c=corpus(),i=prepare('development');assert.equal(c.confirmation.length,12);
  for(const r of [...c.development,...c.confirmation])for(const axis of ['E','O']){
    const q=targetRequest(r.body,i.baseline,axis);assert.deepEqual(JSON.parse(q.text),{body:r.body});
    assert.ok(!q.text.includes(r.id)&&!q.text.includes('"gold"')&&!q.text.includes('"basis"'));}
  const q=evaluatorRequest(c.development[0].body,'yes','no');assert.deepEqual(JSON.parse(q.text).proposed,{E:'yes',O:'no'});
  assert.deepEqual(Object.keys(q.criteria),['requirement_scope','evidence_scope','both_scope','no_change','uncertain']);
});
test('development actually requires eight target and four typed evaluator requests, no Gold in requests',async()=>{
  const i=prepare('development'),events=[];let calls=0;
  const report=await evaluate(i,async q=>{calls++;return perfect(i)(q);},e=>events.push(e));report.actualCalls=calls;
  const s=score(i,report);assert.equal(calls,12);assert.equal(s.arms.baseline.correct,4);assert.equal(s.status,'OBSERVATION_COMPLETE');
  assert.equal(events.filter(e=>e.kind==='diagnosis').length,4);assert.equal(s.cost,null);assert.equal(s.usage,null);
  assert.equal(s.evaluatorContribution,'NOT_IDENTIFIED');assert.equal(s.qualityAdoptionAuthorized,false);
});
test('partial target axis stops all subsequent network calls; unknown is not a semantic error or perfect score',async()=>{
  const i=prepare('development');let calls=0;
  const r=await evaluate(i,async()=>{if(++calls===2)throw Error('timeout');return answer('yes');});r.actualCalls=calls;
  const s=score(i,r);assert.equal(calls,2);assert.equal(s.status,'INCOMPLETE');assert.equal(s.arms.baseline.unknown,4);
  assert.equal(s.arms.baseline.wrong,0);assert.equal(s.arms.baseline.accuracy,null);assert.equal(r.rows[0].trace.length,1);
});
test('model change stops instead of comparing different models',async()=>{
  const i=prepare('development');let calls=0;const r=await evaluate(i,async()=>{calls++;return {...answer('yes'),model:'other'};});
  r.actualCalls=calls;assert.equal(calls,1);assert.equal(score(i,r).status,'INCOMPLETE');
});
test('typed evaluator failure does not become a complete development receipt',async()=>{
  const i=prepare('development');let calls=0;const r=await evaluate(i,async q=>{calls++;return Object.hasOwn(q.criteria,'no_change')?answer('invented_reason'):perfect(i)(q);});
  r.actualCalls=calls;assert.equal(calls,3);const s=score(i,r);assert.equal(s.status,'INCOMPLETE');
  assert.equal(s.arms.baseline.completed,1);assert.equal(s.arms.baseline.correct,1);assert.equal(s.diagnostic.unknown,4);
});
test('typed diagnosis has independently computed matches, false alarms, misses and wrong axes',async()=>{
  const i=prepare('development');let calls=0;
  const r=await evaluate(i,async q=>{calls++;if(Object.hasOwn(q.criteria,'no_change')){
    const id=i.rows.find(x=>x.body===JSON.parse(q.text).body).id;
    return answer({'d-atlas':'evidence_scope','d-brook':'no_change','d-cedar':'requirement_scope','d-delta':'uncertain'}[id]);}
    const a=await perfect(i)(q),id=i.rows.find(x=>x.body===JSON.parse(q.text).body).id;
    if(['d-brook','d-cedar'].includes(id)&&q.instructions.includes('本問はOだけ'))a.choice=a.choice==='yes'?'no':'yes';return a;});
  r.actualCalls=calls;const s=score(i,r);assert.equal(s.diagnostic.falseAlarm,1);assert.equal(s.diagnostic.missed,1);
  assert.equal(s.diagnostic.wrongAxis,1);assert.equal(s.diagnostic.uncertain,1);assert.equal(s.arms.baseline.axes.O.falseNegative,2);
});
test('caller cannot expand finite call cap',async()=>{
  const i=prepare('development');i.maxCalls=999;let calls=0;await assert.rejects(()=>evaluate(i,async()=>{calls++;return answer('yes');}));assert.equal(calls,0);
});
test('confirmation is paired, counterbalanced, 48 calls and no evaluator adoption veto',async()=>{
  const i=fixture('confirmation'),root=tempRoot(i.candidate);let calls=0;
  try{const r=await evaluate(i,async q=>{calls++;return perfect(i)(q);});r.actualCalls=calls;
    const s=score(i,r,root);assert.equal(calls,48);assert.equal(s.arms.baseline.correct,12);assert.equal(s.arms.candidate.correct,12);
    assert.equal(s.outcome,'NO_EFFECT_KEEP_BASELINE');assert.deepEqual(s.regressed,[]);assert.equal(s.breakRate.value,0);
    assert.equal(s.repairRate.value,null);assert.equal(r.rows[0].arm,'baseline');assert.equal(r.rows[2].arm,'candidate');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an actual candidate regression rejects adoption even if net gain is positive',async()=>{
  const i=fixture('confirmation'),root=tempRoot(i.candidate);let calls=0;
  try{const r=await evaluate(i,async q=>{calls++;const id=i.rows.find(x=>x.body===JSON.parse(q.text).body).id;
    const isCandidate=q.instructions.startsWith(i.candidate.instructions),axis=q.instructions.includes('本問はEだけ')?'E':'O';
    const a=await perfect(i)(q);if(axis==='O'&&((!isCandidate&&['h-lantern','h-harbor'].includes(id))||(isCandidate&&id==='h-iris')))a.choice=a.choice==='yes'?'no':'yes';return a;});
    r.actualCalls=calls;const s=score(i,r,root);assert.equal(s.delta,1);assert.deepEqual(s.regressed,['h-iris']);assert.equal(s.outcome,'REGRESSION_KEEP_BASELINE');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('positive gain with zero observed regressions is a research candidate only',async()=>{
  const i=fixture('confirmation'),root=tempRoot(i.candidate);let calls=0;
  try{const r=await evaluate(i,async q=>{calls++;const a=await perfect(i)(q);if(!q.instructions.startsWith(i.candidate.instructions)&&JSON.parse(q.text).body===i.rows[0].body&&q.instructions.includes('本問はOだけ'))a.choice='yes';return a;});
    r.actualCalls=calls;const s=score(i,r,root);assert.equal(s.outcome,'FINITE_IMPROVEMENT_CANDIDATE');assert.equal(s.qualityAdoptionAuthorized,false);assert.equal(s.repairRate.value,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('breaking a previously correct axis in an already wrong case also retains baseline',async()=>{
  const i=fixture('confirmation'),root=tempRoot(i.candidate);let calls=0;
  try{const r=await evaluate(i,async q=>{calls++;const a=await perfect(i)(q),id=i.rows.find(x=>x.body===JSON.parse(q.text).body).id;
    const candidate=q.instructions.startsWith(i.candidate.instructions),axis=q.instructions.includes('本問はEだけ')?'E':'O';
    if((!candidate&&['h-lantern','h-harbor'].includes(id)&&axis==='O')||(candidate&&id==='h-lantern'&&axis==='E'))a.choice=a.choice==='yes'?'no':'yes';return a;});
    r.actualCalls=calls;const s=score(i,r,root);assert.equal(s.delta,1);assert.deepEqual(s.regressed,[]);
    assert.deepEqual(s.axisRegressed,[{id:'h-lantern',axis:'E'}]);assert.equal(s.outcome,'REGRESSION_KEEP_BASELINE');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('complete claim rejects missing terminal/calls, wrong order, altered request or model',async()=>{
  const i=prepare('development'),r=await evaluate(i,perfect(i));r.actualCalls=12;
  for(const mutate of [x=>x.terminalReceipt=false,x=>x.actualCalls=null]){const x=structuredClone(r);mutate(x);assert.equal(score(i,x).status,'INCOMPLETE');}
  for(const mutate of [x=>x.rows.reverse(),x=>x.rows[0].trace[0].request.text='gold',x=>x.rows[0].trace[0].answer.model='other']){
    const x=structuredClone(r);mutate(x);assert.throws(()=>score(i,x));}
});
test('native admission requires exact marker-only source, branch, actor and first two runs',()=>{
  const source={head:'a'.repeat(40),parent:'b'.repeat(40),changed:['experiments/sys1-eval-loop/feedback-development-live.json']};
  const env={GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_ACTOR:'roccho-dev',GITHUB_REF:'refs/heads/'+BRANCH,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:source.head,GITHUB_RUN_ID:'42'};
  const row={id:42,head_sha:source.head,event:'push',head_branch:BRANCH,run_attempt:1},h={total_count:1,workflow_runs:[row]},a={phase:'development',sourceSha:source.parent};
  admit(a,'development',env,h,source);
  for(const change of [x=>x.GITHUB_RUN_ATTEMPT='2',x=>x.GITHUB_ACTOR='other',x=>x.GITHUB_REF='refs/heads/proposals']){const e={...env};change(e);assert.throws(()=>admit(a,'development',e,h,source));}
  assert.throws(()=>admit(a,'development',env,{...h,total_count:2},source));assert.throws(()=>admit(a,'development',env,h,{...source,changed:[...source.changed,'source.mjs']}));
  const ca={phase:'confirmation',sourceSha:source.parent},cs={...source,changed:['experiments/sys1-eval-loop/feedback-confirmation-live.json']};
  const old={...row,id:41,status:'completed',conclusion:'success'};admit(ca,'confirmation',env,{total_count:2,workflow_runs:[row,old]},cs);
  assert.throws(()=>admit(ca,'confirmation',env,{total_count:2,workflow_runs:[row,{...old,conclusion:'failure'}]},cs));
});
test('real score CLI keeps corrupt terminal and recovers unknown from truncated event tail',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-score-'));try{
    const i=prepare('development');fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify(i));fs.writeFileSync(path.join(dir,'predictions.json'),'{broken');
    fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify({kind:'attempt',id:'d-atlas/baseline/E'})+'\n{"kind":');
    const env={...process.env};delete env.JEV_API_KEY;
    assert.throws(()=>execFileSync(process.execPath,[path.join(ROOT,'feedback-improvement.mjs'),'score',dir],{env,stdio:'pipe'}));
    const s=JSON.parse(fs.readFileSync(path.join(dir,'measurement.json')));assert.equal(s.status,'INCOMPLETE');assert.equal(s.actualCalls,null);
    assert.equal(s.arms.baseline.unknown,4);assert.equal(fs.readFileSync(path.join(dir,'predictions.json'),'utf8'),'{broken');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'recovered-predictions.json'))).truncatedFinalRecord,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
