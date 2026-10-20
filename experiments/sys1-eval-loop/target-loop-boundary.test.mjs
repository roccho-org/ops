import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTargetLoopWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';
const cli='node experiments/sys1-eval-loop/target-loop/loop.mjs ';
const w={on:{push:{branches:['codex/jev-target-loop-20261020'],paths:['experiments/sys1-eval-loop/target-loop/request.json']}},permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-target-loop','cancel-in-progress':false},jobs:{evaluate:{if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",'runs-on':'ubuntu-24.04','timeout-minutes':60,steps:[
  {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false,'fetch-depth':0}},
  {run:'node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'},
  {id:'prepare',env:{GH_TOKEN:'${{ github.token }}'},run:cli+'prepare "$RUNNER_TEMP/target-loop"'},
  {env:{JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},run:cli+'evaluate "$RUNNER_TEMP/target-loop"'},
  {if:"always() && steps.prepare.outcome == 'success'",run:cli+'score "$RUNNER_TEMP/target-loop"'},
  {uses:'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',if:'always()',with:{name:'sys1-target-loop-${{ github.run_id }}',path:'${{ runner.temp }}/target-loop','if-no-files-found':'ignore','retention-days':30}}
]}}};
const b={secretScope:'organization',secretName:'JEV_API_KEY',maxCalls:1000,allowedEvents:['push']};
test('new series reuses exact existing secret isolation profile',()=>assertTargetLoopWorkflow(w,b));
for(const [name,mutate] of Object.entries({
  branch:x=>x.on.push.branches.push('proposals'),path:x=>x.on.push.paths.push('**'),dispatch:x=>x.on.workflow_dispatch={},
  rerun:x=>x.jobs.evaluate.if='true',timeout:x=>x.jobs.evaluate['timeout-minutes']=90,permission:x=>x.permissions.contents='write',
  environment:x=>x.jobs.evaluate.environment='other',source:x=>x.jobs.evaluate.steps[0].with['fetch-depth']=1,
  skip:x=>x.jobs.evaluate.steps[2].if='false',command:x=>x.jobs.evaluate.steps[3].run+=' && echo extra',
  leakedSecret:x=>x.jobs.evaluate.steps[4].env={JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},receipt:x=>x.jobs.evaluate.steps[5].with.path='elsewhere',cancel:x=>x.concurrency['cancel-in-progress']=true
}))test('reject '+name,()=>{const x=structuredClone(w);mutate(x);assert.throws(()=>assertTargetLoopWorkflow(x,b));});
test('series cap cannot silently widen',()=>assert.throws(()=>assertTargetLoopWorkflow(w,{...b,maxCalls:1001})));
