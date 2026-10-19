import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepare,judgeRequest,evaluateJudge,scoreJudge,partialReport,parseEvents,admit,MAX_CALLS,BRANCH} from './self-grading.mjs';

const {input,truth}=prepare();
const answer=(choice,model='jev-1.13.0')=>({choice,model,probabilities:{accept:choice==='accept'?1:0,reject:choice==='reject'?1:0,abstain:choice==='abstain'?1:0},confidence:1,usage:{input_tokens:2,output_tokens:1}});
async function run(choose) {
  let calls=0;const r=await evaluateJudge(input,async q=>choose(q,calls++));r.actualCalls=calls;return r;
}
test('real recorded source is paired and both Gold classes exist, with all source traces validated',()=>{
  assert.equal(input.rows.length,18);assert.equal(truth.rows.filter(t=>t.correct).length,14);
  for(const c of new Set(truth.rows.map(t=>t.caseId))) {
    const rows=truth.rows.filter(t=>t.caseId===c);assert.deepEqual(rows.map(r=>r.arm).sort(),['after','before']);
  }
});
test('judge only receives task and proposed output, not arm, IDs, Gold, old score or provenance',()=>{
  for(const row of input.rows) {
    const q=judgeRequest(row,input.labels),body=JSON.parse(q.text);
    assert.deepEqual(Object.keys(body),['task','proposedLabel']);
    assert.deepEqual(Object.keys(body.task),['purpose','complete','body','comments']);
    assert.deepEqual(Object.keys(q.criteria),['accept','reject','abstain']);
  }
});
test('perfect judge permits actual finite calibration and reproduces a paired gain, not repair efficacy',async()=>{
  const r=await run((q,n)=>answer(truth.rows[n].correct?'accept':'reject')),s=scoreJudge(input,truth,r);
  assert.equal(s.measurementStatus,'OBSERVATION_COMPLETE');
  assert.deepEqual(s.falseAccept,{numerator:0,denominator:4,value:0});
  assert.deepEqual(s.falseReject,{numerator:0,denominator:14,value:0});
  assert.equal(s.observedGoldDelta,4/9);assert.equal(s.judgedAcceptanceDelta,4/9);
  assert.equal(s.actualCalls,18);assert.equal(s.qualityAdoptionAuthorized,false);
  assert.equal(s.selfRepairEffect,'NOT_TESTED');assert.equal(s.holdout,'NOT_AVAILABLE');
});
test('always-pass judge is exposed rather than passing as perfect accuracy or quality improvement',async()=>{
  const s=scoreJudge(input,truth,await run(()=>answer('accept')));
  assert.equal(s.falseAccept.value,1);assert.deepEqual(s.deliveredRisk,{numerator:4,denominator:18,value:4/18});
  assert.equal(s.judgedAcceptanceDelta,0);assert.equal(s.judgeSignal,'CONSTANT');
  assert.equal(s.measurementStatus,'OBSERVATION_COMPLETE');
});
test('all abstention has zero coverage and no defined delivered risk; it is not perfect judging',async()=>{
  const s=scoreJudge(input,truth,await run(()=>answer('abstain')));
  assert.equal(s.coverage.value,0);assert.equal(s.deliveredRisk.value,null);
  assert.equal(s.counts.abstainCorrect,14);assert.equal(s.counts.abstainWrong,4);assert.equal(s.judgeSignal,'NO_BINARY_SIGNAL');
  assert.equal(s.falseAccept.value,null);assert.equal(s.falseReject.value,null);assert.equal(s.judgedAcceptanceDelta,null);
  assert.equal(s.negativeCoverage.value,0);assert.equal(s.arms.after.falseAccept.value,null);
});
test('transport failure stops all subsequent calls without dropping the denominator',async()=>{
  const r=await run((q,n)=>{if(n===2)throw Error('raw secret must not appear');return answer('accept');});
  const s=scoreJudge(input,truth,r);
  assert.equal(s.actualCalls,3);assert.equal(s.counts.errors,1);assert.equal(s.counts.notRun,15);
  assert.equal(s.measurementStatus,'INCOMPLETE');assert.equal(s.judgedAcceptanceDelta,null);
  assert.equal(s.falseAccept.value,null);assert.equal(s.falseReject.value,null);assert.equal(s.deliveredRisk.value,null);
  assert.ok(!JSON.stringify(r).includes('raw secret'));
});
test('changed reported model stops and preserves response metadata',async()=>{
  const r=await run(()=>answer('accept','other'));assert.equal(r.rows[0].status,'error');
  assert.equal(r.rows[0].answer.model,'other');assert.equal(r.actualCalls,1);
});
test('changed request and duplicate or inconsistent truth cannot create a valid measurement',async()=>{
  const r=await run(()=>answer('accept'));r.rows[0].request.text='tampered';
  assert.throws(()=>scoreJudge(input,truth,r));
  const t=structuredClone(truth);t.rows[0].correct=!t.rows[0].correct;
  assert.throws(()=>scoreJudge(input,t,awaitedReport));
});
const awaitedReport=await run(()=>answer('accept'));
test('abrupt interruption retains completed rows and cannot imply a complete or zero-error result',async()=>{
  const events=[];
  await assert.rejects(evaluateJudge(input,async()=>answer('accept'),e=>{
    events.push(e);if(e.kind==='attempt'&&e.id==='q02')throw Error('simulated hard stop');
  }));
  const r=partialReport(input,events),s=scoreJudge(input,truth,r);
  assert.equal(r.rows[0].status,'ok');assert.equal(r.rows[1].status,'error');
  assert.equal(r.rows[2].status,'not_run');assert.equal(s.actualCalls,null);
  assert.equal(s.measurementStatus,'INCOMPLETE');assert.equal(s.falseAccept.value,null);
  const empty=scoreJudge(input,truth,partialReport(input,[]));assert.equal(empty.counts.notRun,18);
});
test('finite native run identity refuses replay, second trigger, stale head and broadened authorization',()=>{
  const env={GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_ACTOR:'roccho-dev',GITHUB_REF:'refs/heads/'+BRANCH,
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123'};
  const h={total_count:1,workflow_runs:[{id:123,head_sha:env.GITHUB_SHA,event:'push',head_branch:BRANCH}]};
  const request={trial:'judge-feasibility-20261020',sourceSha:'b'.repeat(40)};
  const source={head:env.GITHUB_SHA,parent:request.sourceSha,changed:['experiments/sys1-eval-loop/self-grading-live.json']};
  admit(request,env,h,source);
  for(const edit of [e=>e.GITHUB_ACTOR='other',e=>e.GITHUB_REF='refs/heads/proposals',e=>e.GITHUB_RUN_ATTEMPT='2'])
    {const e={...env};edit(e);assert.throws(()=>admit(request,e,h,source));}
  assert.throws(()=>admit(request,env,{...h,total_count:2},source));
  assert.throws(()=>admit(request,env,{...h,workflow_runs:[{...h.workflow_runs[0],head_sha:'b'.repeat(40)}]},source));
  assert.throws(()=>admit({...request,maxCalls:999},env,h,source));
  assert.throws(()=>admit(request,env,h,{...source,parent:'c'.repeat(40)}));
  assert.throws(()=>admit(request,env,h,{...source,changed:[...source.changed,'experiments/sys1-eval-loop/self-grading.mjs']}));
  assert.equal(MAX_CALLS,18);
});
test('partial JSON tail is flagged, complete rows remain, and malformed middle is not silently ignored',()=>{
  const prefix=JSON.stringify({kind:'attempt',id:'q01'})+'\n';
  const p=parseEvents(prefix+'{"kind":"row"');assert.equal(p.events.length,1);assert.equal(p.truncatedFinalRecord,true);
  assert.equal(scoreJudge(input,truth,partialReport(input,p.events)).measurementStatus,'INCOMPLETE');
  assert.throws(()=>parseEvents(prefix+'{broken}\n'+prefix));
  assert.equal(parseEvents(prefix.trim()).events.length,1);
});
test('a nonterminal receipt cannot publish complete rates, and missing token metadata is unknown',async()=>{
  const r=await run(()=>({...answer('accept'),usage:{}}));r.terminalReceipt=false;
  const s=scoreJudge(input,truth,r);assert.equal(s.measurementStatus,'INCOMPLETE');assert.equal(s.falseAccept.value,null);
  assert.equal(s.usage,null);assert.equal(s.usageRows,0);assert.deepEqual(s.semanticHintRows,['q11','q12']);
});
for(const interrupted of [false,true])test('real keyless score CLI recovers '+(interrupted?'truncated events/terminal bytes':'empty events and no terminal')+' as incomplete',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sys1-judge-score-'));
  try {
    fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify(input));
    fs.writeFileSync(path.join(dir,'events.jsonl'),interrupted?JSON.stringify({kind:'attempt',id:'q01'})+'\n{"kind":"row"':'');
    if(interrupted)fs.writeFileSync(path.join(dir,'predictions.json'),'{');
    const env={...process.env};delete env.JEV_API_KEY;
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('./self-grading.mjs',import.meta.url)),'score',dir],{env,encoding:'utf8'});
    assert.equal(r.status,2,r.stderr);
    const s=JSON.parse(fs.readFileSync(path.join(dir,'measurement.json'),'utf8'));
    assert.equal(s.measurementStatus,'INCOMPLETE');assert.equal(s.actualCalls,null);assert.equal(s.falseAccept.value,null);
    assert.equal(s.counts.errors,interrupted?1:0);assert.equal(s.counts.notRun,interrupted?17:18);
    assert.equal(fs.existsSync(path.join(dir,'truth.json')),true);
  } finally {
    for(const n of ['input.json','events.jsonl','predictions.json','recovered-predictions.json','truth.json','measurement.json'])
      if(fs.existsSync(path.join(dir,n)))fs.unlinkSync(path.join(dir,n));
    fs.rmdirSync(dir);
  }
});

