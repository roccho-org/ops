import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFeedbackWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';
const cli='node experiments/sys1-eval-loop/feedback-improvement.mjs ';
const w={on:{push:{branches:['codex/jev-feedback-improvement-20261020'],paths:['experiments/sys1-eval-loop/feedback-development-live.json','experiments/sys1-eval-loop/feedback-confirmation-live.json']}},
  permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-feedback-improvement','cancel-in-progress':false},
  jobs:{evaluate:{if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",'runs-on':'ubuntu-24.04','timeout-minutes':16,steps:[
    {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false,'fetch-depth':0}},
    {run:'node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'},
    {id:'prepare',env:{GH_TOKEN:'${{ github.token }}'},run:cli+'prepare "$RUNNER_TEMP/feedback-improvement"'},
    {env:{JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},run:cli+'evaluate "$RUNNER_TEMP/feedback-improvement"'},
    {if:"always() && steps.prepare.outcome == 'success'",run:cli+'score "$RUNNER_TEMP/feedback-improvement"'},
    {uses:'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',if:'always()',with:{name:'sys1-feedback-${{ github.run_id }}',path:'${{ runner.temp }}/feedback-improvement','if-no-files-found':'ignore','retention-days':30}}
  ]}}};
const b={secretScope:'organization',secretName:'JEV_API_KEY',maxCalls:60,allowedEvents:['push']};
test('only the two bounded feedback phase activations pass; actual YAML separately parsed by canonical checker',()=>assertFeedbackWorkflow(w,b));
for(const [name,mutate] of Object.entries({
  'broader branch':x=>x.on.push.branches.push('proposals'),
  'all pushes':x=>delete x.on.push.paths,
  'manual refill':x=>x.on.workflow_dispatch={},
  'environment expansion':x=>x.jobs.evaluate.environment='other',
  'write permission':x=>x.permissions.actions='write',
  'rerun':x=>x.jobs.evaluate.if="github.actor == 'roccho-dev'",
  'skipped preflight':x=>x.jobs.evaluate.steps[2].if='false',
  'credential source acquisition':x=>x.jobs.evaluate.steps[3].run+=' && curl example.invalid',
  'scorer credential':x=>x.jobs.evaluate.steps[4].env={JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'},
  'lost receipt':x=>x.jobs.evaluate.steps[5].with.path='wrong',
  'cancel existing effect':x=>x.concurrency['cancel-in-progress']=true,
  'continue failure':x=>x.jobs.evaluate['continue-on-error']=true
}))test('reject '+name,()=>{const x=structuredClone(w);mutate(x);assert.throws(()=>assertFeedbackWorkflow(x,b));});
test('closed trial cap is not widened',()=>assert.throws(()=>assertFeedbackWorkflow(w,{...b,maxCalls:61})));
