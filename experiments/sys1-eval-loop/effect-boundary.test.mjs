import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeEffectWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';
const boundary={path:'.github/workflows/sys1-improvement-proof.yml',secretScope:'organization',secretName:'JEV_API_KEY',allowedEvents:['push'],maxCalls:43};
const plan=["const phases=['baseline','candidate','split-baseline','split-candidate'];",
  "assert.equal(history.total_count,phases.indexOf(r.phase)+1);",
  "assert.ok(prior.every(x=>x.status==='completed'&&x.conclusion==='success'));",
  "assert.equal(next(b).action,'PROPOSE_ONE_CANDIDATE');",
  "if(r.phase==='split-candidate') assert.equal(r.candidate,'binary-eo-v3');"].join('\n');
const fixture={on:{push:{branches:['codex/jev-improvement-closure-20261019'],paths:['experiments/sys1-eval-loop/live-request.json']}},
  permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-improvement-proof','cancel-in-progress':false},
  jobs:{evaluate:{if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",
    'runs-on':'ubuntu-24.04','timeout-minutes':5,
    env:{TRIAL_SUITE:'role-boundaries',TRIAL_SOURCE_SHA:'${{ github.sha }}',TRIAL_SESSION_CALLS:'24'},steps:[
      {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false}},
      {id:'request',env:{GH_TOKEN:'${{ github.token }}'},run:plan},
      {env:{JEV_API_KEY:'${{ secrets.JEV_API_KEY }}',CANDIDATE:'${{ steps.request.outputs.candidate }}',PHASE:'${{ steps.request.outputs.phase }}'},
        run:['case "$PHASE" in','  baseline|candidate) entry=run.mjs ;;','  split-baseline|split-candidate) entry=split.mjs; export TRIAL_SUITE=closure-real TRIAL_SESSION_CALLS=27 ;;','  *) exit 1 ;;','esac','node "experiments/sys1-eval-loop/$entry" evaluate "$CANDIDATE" "$RUNNER_TEMP/sys1-result"'].join('\n')}
    ]}}};
test('only the exact separate finite proof is admitted without changing the old Org route',()=>{
  assert.deepEqual(analyzeEffectWorkflow(fixture,boundary).issues,[]);
  assert.ok(analyzeEffectWorkflow(fixture,{...boundary,path:'.github/workflows/other.yml'}).issues.length);
});
for(const [name,change] of [
  ['wrong actor',w=>w.jobs.evaluate.if=w.jobs.evaluate.if.replace('roccho-dev','other')],
  ['rerun spending',w=>w.jobs.evaluate.if=w.jobs.evaluate.if.replace('github.run_attempt == 1','true')],
  ['another branch',w=>w.on.push.branches=['proposals']],
  ['automatic broad path',w=>w.on.push.paths=['**']],
  ['another event',w=>w.on.issue_comment={}],
  ['write token',w=>w.permissions.contents='write'],
  ['secret in job',w=>w.jobs.evaluate.env.JEV_API_KEY='${{ secrets.JEV_API_KEY }}'],
  ['second keyed step',w=>w.jobs.evaluate.steps.push(structuredClone(w.jobs.evaluate.steps[2]))],
  ['no bounded history',w=>w.jobs.evaluate.steps[1].run='true'],
  ['skipped admission',w=>w.jobs.evaluate.steps[1].if='false'],
  ['mutable checkout',w=>w.jobs.evaluate.steps[0].with.ref='proposals'],
  ['persisted checkout credential',w=>w.jobs.evaluate.steps[0].with['persist-credentials']=true],
  ['different credential program',w=>w.jobs.evaluate.steps[2].run='node arbitrary.mjs'],
  ['ignored failure',w=>w.jobs.evaluate.steps[2]['continue-on-error']=true],
  ['parallel effect job',w=>w.jobs.extra=structuredClone(w.jobs.evaluate)],
]) test('refuse '+name,()=>{
  const w=structuredClone(fixture);change(w);assert.ok(analyzeEffectWorkflow(w,boundary).issues.length);
});
test('increasing the explicit trial allowance fails closed',()=>{
  assert.ok(analyzeEffectWorkflow(fixture,{...boundary,maxCalls:44}).issues.length);
});
