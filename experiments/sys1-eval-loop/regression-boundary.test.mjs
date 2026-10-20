import test from 'node:test';import assert from 'node:assert/strict';
import {assertRegressionWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';
const cli='node experiments/sys1-eval-loop/regression/runtime.mjs ';
const w={on:{push:{branches:['codex/jev-regression-repair-20261020'],paths:['experiments/sys1-eval-loop/regression/request.json']}},permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-regression-repair','cancel-in-progress':false},jobs:{evaluate:{if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",'runs-on':'ubuntu-24.04','timeout-minutes':90,steps:[
  {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false,'fetch-depth':0}},
  {run:'node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'},
  {id:'prepare',env:{GH_TOKEN:'${{ github.token }}'},run:cli+'prepare "$RUNNER_TEMP/regression"'},
  {env:{JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},run:cli+'evaluate "$RUNNER_TEMP/regression"'},
  {if:"always() && steps.prepare.outcome == 'success'",run:cli+'project "$RUNNER_TEMP/regression"'},
  {uses:'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',if:'always()',with:{name:'sys1-regression-${{ github.run_id }}',path:'${{ runner.temp }}/regression','if-no-files-found':'ignore','retention-days':30}}
]}}};
const b={secretScope:'organization',secretName:'JEV_API_KEY',maxCalls:672,allowedEvents:['push']};
test('new development route reuses the complete existing secret isolation profile',()=>assertRegressionWorkflow(w,b));
test('reject timeout that cannot preserve a full288-call deadline path and final evidence',()=>{const x=structuredClone(w);x.jobs.evaluate['timeout-minutes']=20;assert.throws(()=>assertRegressionWorkflow(x,b));});
for(const [name,mutate]of Object.entries({branch:x=>x.on.push.branches.push('proposals'),dispatch:x=>x.on.workflow_dispatch={},rerun:x=>x.jobs.evaluate.if='true',write:x=>x.permissions.contents='write',earlySecret:x=>x.jobs.evaluate.steps[2].env.JEV_API_KEY='${{ secrets.JEV_API_KEY }}',skip:x=>x.jobs.evaluate.steps[2].if='false',command:x=>x.jobs.evaluate.steps[3].run+=' extra',receipt:x=>x.jobs.evaluate.steps[5].with.path='other'}))
  test('reject counterfactual boundary '+name,()=>{const x=structuredClone(w);mutate(x);assert.throws(()=>assertRegressionWorkflow(x,b));});

