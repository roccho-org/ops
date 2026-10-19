// Execute the actual workflow admission, with only provider history and request
// observations replaced. No Jev key, model calls, second admission or YAML parser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {loadInput,digest} from './run.mjs';
import {sessionContract,plannedModelCalls} from './split.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const yaml=fs.readFileSync(path.join(root,'.github/workflows/sys1-improvement-proof.yml'),'utf8');
const block=yaml.match(/        id: request[\s\S]*?        run: \|\r?\n([\s\S]*?)      - name: Evaluate/)[1];
const lines=block.trimEnd().split(/\r?\n/).map(x=>x.slice(10));
assert.equal(lines.shift(),"node --input-type=module <<'JS'");assert.equal(lines.pop(),'JS');
const actualScript=lines.join('\n');
const base=JSON.parse(fs.readFileSync(path.join(root,'experiments/sys1-eval-loop/results/closure-20261019/baseline.json')));
const input=loadInput(path.join(root,'experiments/sys1-eval-loop/candidates/baseline.json'),path.join(root,'experiments/sys1-eval-loop/suites/role-boundaries'));
const real=loadInput(path.join(root,'experiments/sys1-eval-loop/candidates/baseline.json'),path.join(root,'experiments/sys1-eval-loop/suites/closure-real'));
const splitBase={...base,total:9,actualCalls:9,contractDigest:digest(sessionContract(real.contract,27)),goldDigest:real.contract.goldSha256,runUrl:'https://github.com/roccho-org/ops/actions/runs/30',accounting:{expectedMaxCalls:9}};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sys1-admission-'));
after(()=>fs.rmdirSync(dir));
function exercise(phase,change=()=>{}) {
  const phases=['baseline','candidate','split-baseline','split-candidate'],n=phases.indexOf(phase)+1;
  const rows=[{id:39219472578,html_url:base.runUrl},{id:39220305535,html_url:'https://github.com/roccho-org/ops/actions/runs/39220305535'},{id:30,html_url:splitBase.runUrl},{id:40,html_url:'https://github.com/roccho-org/ops/actions/runs/40'}].slice(0,n);
  for(const r of rows)Object.assign(r,{status:'completed',conclusion:'success'});
  const data={request:{phase,candidate:phase==='candidate'?'closure-rules-v1':phase==='split-candidate'?'binary-eo-v3':'baseline'},
    history:{total_count:n,workflow_runs:rows},base:structuredClone(base),splitBase:structuredClone(splitBase),current:String(rows.at(-1)?.id??99)};
  change(data);
  const output=path.join(dir,'output');
  const prelude=`import realFs from 'node:fs';
    const fixture=${JSON.stringify(data)};
    const originalRead=realFs.readFileSync;
    realFs.readFileSync=function(p,...args){
      if(p==='experiments/sys1-eval-loop/live-request.json')return JSON.stringify(fixture.request);
      if(p==='experiments/sys1-eval-loop/results/closure-20261019/baseline.json')return JSON.stringify(fixture.base);
      if(p==='experiments/sys1-eval-loop/results/closure-20261019/split-baseline.json')return JSON.stringify(fixture.splitBase);
      return originalRead.call(this,p,...args);
    };
    globalThis.fetch=async()=>({status:200,json:async()=>fixture.history});\n`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',prelude+actualScript],{cwd:root,encoding:'utf8',
    env:{SystemRoot:process.env.SystemRoot??'',GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_RUN_ID:data.current,GITHUB_OUTPUT:output,GH_TOKEN:'test-placeholder'}});
  const printed=fs.existsSync(output)?fs.readFileSync(output,'utf8'):'';
  if(fs.existsSync(output))fs.unlinkSync(output);
  return {status:r.status,printed,stderr:r.stderr};
}
for(const phase of ['baseline','candidate','split-baseline','split-candidate'])
  test('actual workflow admits only the valid '+phase+' phase',()=>{
    const r=exercise(phase);assert.equal(r.status,0,r.stderr);assert.match(r.printed,new RegExp('phase='+phase));
  });
for(const [name,phase,change] of [
  ['fifth run','split-candidate',d=>d.history.total_count=5],
  ['missing current run','split-baseline',d=>d.current='999'],
  ['unfinished prior run','split-baseline',d=>d.history.workflow_runs[0].status='in_progress'],
  ['failed prior run','split-candidate',d=>d.history.workflow_runs[0].conclusion='failure'],
  ['changed Gold','candidate',d=>d.base.goldDigest='different'],
  ['changed model','candidate',d=>d.base.models=['different']],
  ['already reached target','candidate',d=>d.base.targetReached=true],
  ['wrong split contract','split-candidate',d=>d.splitBase.contractDigest='different'],
  ['unobserved baseline run','candidate',d=>d.base.runUrl='https://github.com/roccho-org/ops/actions/runs/999'],
  ['another split candidate','split-candidate',d=>d.request.candidate='closure-rules-v1'],
]) test('actual workflow refuses '+name+' before producing an evaluation request',()=>{
  const r=exercise(phase,change);assert.notEqual(r.status,0);assert.equal(r.printed,'');
});
test('declared43 equals derived calls; split short-circuits are not fake model calls',()=>{
  assert.equal(2*input.cases.length+real.cases.length+plannedModelCalls(real,'binary-eo-v3'),43);
  const mixed={cases:[{purpose:'historical-record',complete:true},{purpose:'task',complete:false},{purpose:'task',complete:true}]};
  assert.equal(plannedModelCalls(mixed,'binary-eo-v3'),2);
});
