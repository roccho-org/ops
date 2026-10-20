import test from 'node:test';import assert from 'node:assert/strict';
import {assertCensusWorkflow} from '../../tools/check-ci-intent-workflow-branches.mjs';import {BRANCH,REQUEST} from './census/admission.mjs';
const d=String.fromCharCode(36),command=mode=>'node experiments/sys1-eval-loop/census/runtime.mjs '+mode+' "$RUNNER_TEMP/census"',boundary={secretScope:'organization',secretName:'JEV_API_KEY',allowedEvents:['push'],maxCalls:2400};
function fixture(){return {on:{push:{branches:[BRANCH],paths:[REQUEST]}},permissions:{actions:'read',contents:'read'},concurrency:{group:'sys1-observation-census','cancel-in-progress':false},jobs:{evaluate:{if:"github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1",'runs-on':'ubuntu-24.04','timeout-minutes':330,steps:[
 {uses:'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',with:{'persist-credentials':false,'fetch-depth':0}},
 {run:'node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'},
 {id:'prepare',env:{GH_TOKEN:d+'{{ github.token }}'},run:command('prepare')},
 {env:{JEV_API_KEY:d+'{{ secrets.JEV_API_KEY }}'},run:command('evaluate')},
 {if:"always() && steps.prepare.outcome == 'success'",run:command('project')},
 {uses:'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',if:'always()',with:{name:'sys1-census-'+d+'{{ github.run_id }}',path:d+'{{ runner.temp }}/census','if-no-files-found':'ignore','retention-days':30}}
 ]}}};}
test('fixed census six-step profile preserves keyless checks, isolated existing secret and always raw retention with 330-minute cap',()=>{assert.doesNotThrow(()=>assertCensusWorkflow(fixture(),boundary));for(const mutate of [w=>w.on.push.paths=['**'],w=>w.on.workflow_dispatch=null,w=>w.jobs.evaluate['timeout-minutes']=170,w=>w.jobs.evaluate['runs-on']='ubuntu-slim',w=>w.jobs.evaluate.steps[0].with['persist-credentials']=true,w=>w.jobs.evaluate.steps[1].run='true',w=>w.jobs.evaluate.steps[2].env.JEV_API_KEY=d+'{{ secrets.JEV_API_KEY }}',w=>w.jobs.evaluate.steps[3].env.OTHER=d+'{{ secrets.OTHER }}',w=>w.jobs.evaluate.steps[4].if='always()',w=>w.jobs.evaluate.steps[5].if='success()']){const w=fixture();mutate(w);assert.throws(()=>assertCensusWorkflow(w,boundary));}assert.throws(()=>assertCensusWorkflow(fixture(),{...boundary,maxCalls:2401}));});
