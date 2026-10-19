import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeEffectWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';
const b={path:'.github/workflows/sys1-self-grading-proof.yml',secretScope:'organization',secretName:'JEV_API_KEY',maxCalls:18,allowedEvents:['push']};
const cli='node experiments/sys1-eval-loop/self-grading.mjs ';
const w={on:{push:{branches:['codex/jev-self-grading-measurement-20261020'],paths:['experiments/sys1-eval-loop/self-grading-live.json']}},
  permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-self-grading-proof','cancel-in-progress':false},jobs:{evaluate:{
  if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",'runs-on':'ubuntu-24.04','timeout-minutes':5,steps:[
    {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false,'fetch-depth':0}},
    {run:'node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'},
    {id:'prepare',env:{GH_TOKEN:'${{ github.token }}'},run:cli+'prepare "$RUNNER_TEMP/self-grading"'},
    {env:{JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},run:cli+'evaluate "$RUNNER_TEMP/self-grading"'},
    {if:"always() && steps.prepare.outcome == 'success'",run:cli+'score "$RUNNER_TEMP/self-grading"'},
    {uses:'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',if:'always()'}
  ]}}};
test('finite self-grading admission leaves the old Org and 43-call routes unchanged',()=>{
  assert.deepEqual(analyzeEffectWorkflow(w,b).issues,[]);
  assert.ok(analyzeEffectWorkflow(w,{...b,path:'.github/workflows/unrelated.yml'}).issues.length);
  assert.ok(analyzeEffectWorkflow(w,{...b,maxCalls:19}).issues.length);
});
for(const [name,edit] of [
  ['other actor',x=>x.jobs.evaluate.if='true'],
  ['other entry',x=>x.on.push.paths=['**']],
  ['other branch',x=>x.on.push.branches=['proposals']],
  ['extra event',x=>x.on.pull_request_target={}],
  ['permissions',x=>x.permissions.contents='write'],
  ['parallel job',x=>x.jobs.other=structuredClone(x.jobs.evaluate)],
  ['matrix',x=>x.jobs.evaluate.strategy={matrix:{n:[1,2]}}],
  ['skipped plan',x=>x.jobs.evaluate.steps[2].if='false'],
  ['skipped tests',x=>x.jobs.evaluate.steps[1].if='false'],
  ['mutable source',x=>x.jobs.evaluate.steps[0].with.ref='proposals'],
  ['persisted credentials',x=>x.jobs.evaluate.steps[0].with['persist-credentials']=true],
  ['extra key',x=>x.jobs.evaluate.steps[2].env.JEV_API_KEY='${{ secrets.JEV_API_KEY }}'],
  ['different credential program',x=>x.jobs.evaluate.steps[3].run='node unbounded.mjs'],
  ['ignored failure',x=>x.jobs.evaluate.steps[3]['continue-on-error']=true],
  ['changed working directory',x=>x.jobs.evaluate.steps[3]['working-directory']='other'],
  ['lost partial receipt',x=>x.jobs.evaluate.steps[5].if='success()'],
])test('self-grading rejects '+name,()=>{
  const v=structuredClone(w);edit(v);assert.ok(analyzeEffectWorkflow(v,b).issues.length);
});

