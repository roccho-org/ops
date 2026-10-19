import assert from 'node:assert/strict';
import test from 'node:test';
import {prepare,judgeRequest,evaluateJudge,scoreJudge,admit,MAX_CALLS,BRANCH} from './self-grading.mjs';

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
  assert.equal(s.measurementStatus,'MEASURABLE_FINITE_PILOT');
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
  assert.equal(s.measurementStatus,'MEASURABLE_FINITE_PILOT');
});
test('all abstention has zero coverage and no defined delivered risk; it is not perfect judging',async()=>{
  const s=scoreJudge(input,truth,await run(()=>answer('abstain')));
  assert.equal(s.coverage.value,0);assert.equal(s.deliveredRisk.value,null);
  assert.equal(s.counts.abstainCorrect,14);assert.equal(s.counts.abstainWrong,4);assert.equal(s.judgeSignal,'NO_BINARY_SIGNAL');
});
test('transport failure stops all subsequent calls without dropping the denominator',async()=>{
  const r=await run((q,n)=>{if(n===2)throw Error('raw secret must not appear');return answer('accept');});
  const s=scoreJudge(input,truth,r);
  assert.equal(s.actualCalls,3);assert.equal(s.counts.errors,1);assert.equal(s.counts.notRun,15);
  assert.equal(s.measurementStatus,'INCOMPLETE');assert.equal(s.judgedAcceptanceDelta,null);
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
test('finite native run identity refuses replay, second trigger, stale head and broadened authorization',()=>{
  const env={GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_ACTOR:'roccho-dev',GITHUB_REF:'refs/heads/'+BRANCH,
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123'};
  const h={total_count:1,workflow_runs:[{id:123,head_sha:env.GITHUB_SHA,event:'push',head_branch:BRANCH}]};
  admit({trial:'judge-feasibility-20261020'},env,h);
  for(const edit of [e=>e.GITHUB_ACTOR='other',e=>e.GITHUB_REF='refs/heads/proposals',e=>e.GITHUB_RUN_ATTEMPT='2'])
    {const e={...env};edit(e);assert.throws(()=>admit({trial:'judge-feasibility-20261020'},e,h));}
  assert.throws(()=>admit({trial:'judge-feasibility-20261020'},env,{...h,total_count:2}));
  assert.throws(()=>admit({trial:'judge-feasibility-20261020'},env,{...h,workflow_runs:[{...h.workflow_runs[0],head_sha:'b'.repeat(40)}]}));
  assert.throws(()=>admit({trial:'judge-feasibility-20261020',maxCalls:999},env,h));
  assert.equal(MAX_CALLS,18);
});

