#!/usr/bin/env node
// Finite evidence-only validator. No dispatch, runner launch, or replay.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const receiptContract = {
  schema: 'ops.taskRuntimeE2E/1', status: 'PASS', positive: 1, negative: 2,
};
const keys = ['event','source','tree','ref','workflowRef','runtime',
  'run','jobKey','jobId','attempt','runner','runnerId','root','nodePath'];
const workflowPath = '.github/workflows/ops-task-runtime-release.yml';
const numeric = x => { assert.match(x, /^[1-9][0-9]*$/); };
const apiId = x => { assert.ok(Number.isSafeInteger(x) && x > 0); return String(x); };

// Input records are retained provider GET responses, not artifact fields.
// No match or multiple matches is HOLD, even if the request may have succeeded.
export function identifyRun(expectedJob, records) {
  const matches = records.filter(r =>
    r.display_title === 'ghalet:'+expectedJob.event &&
    r.head_sha === expectedJob.source &&
    'refs/heads/'+r.head_branch === expectedJob.ref &&
    r.path === workflowPath &&
    String(r.run_attempt) === expectedJob.attempt);
  return matches.length === 1 ? {status:'MATCH',run:matches[0]} :
    {status:'HOLD',reason:'absent-or-ambiguous-provider-run'};
}

export function verify(expected, observed) {
  assert.equal(expected.schema, 'ops.ghaletOverlapExpectation/3');
  assert.equal(observed.schema, 'ops.ghaletOverlapObservation/3');
  assert.equal(expected.jobs.length, 2);
  assert.equal(observed.jobs.length, 2);
  assert.match(expected.hostBootId, /^[0-9a-f-]{36}$/);
  assert.equal(observed.hostBootId, expected.hostBootId);
  const intervals = observed.jobs.map((job,i) => {
    const want=expected.jobs[i];
    for (const key of keys) {
      assert.equal(typeof want[key], 'string');
      assert.ok(want[key].length);
      assert.equal(job[key], want[key], key);
    }
    for (const key of ['source','tree']) assert.match(want[key], /^[0-9a-f]{40}$/);
    assert.match(want.runtime, /^[0-9a-f]{64}$/);
    for (const key of ['run','jobId','attempt','runnerId']) numeric(want[key]);
    assert.equal(want.jobKey,'ghalet-native-check');
    assert.equal(want.workflowRef,'roccho-org/ops/'+workflowPath+'@'+want.ref);
    const selected=identifyRun(want,job.providerRuns);
    assert.equal(selected.status,'MATCH','HOLD: absent or ambiguous provider event');
    const run=selected.run, provider=job.providerJob;
    assert.equal(apiId(run.id),want.run);
    assert.equal(apiId(run.run_attempt),want.attempt);
    assert.equal(apiId(provider.id),want.jobId);
    assert.equal(apiId(provider.run_id),want.run);
    assert.equal(apiId(provider.run_attempt),want.attempt);
    assert.equal(provider.name,want.jobKey); // This workflow has no matrix/name override.
    assert.equal(provider.runner_name,want.runner);
    assert.equal(apiId(provider.runner_id),want.runnerId);
    assert.equal(run.status,'completed');
    assert.equal(run.conclusion,'success');
    assert.equal(provider.status,'completed');
    assert.equal(provider.conclusion,'success');
    assert.equal(job.hostBootId,expected.hostBootId);
    for (const checkout of [job.pre,job.post])
      assert.deepEqual(checkout,{source:want.source,tree:want.tree,clean:true});
    assert.equal(job.exitCode,0);
    assert.deepEqual(job.receipt,receiptContract);
    assert.equal(job.timing?.schema,'ops.taskRuntimeE2ETiming/1');
    assert.equal(job.timing.outcome,'success');
    const producer=job.timing.producer;
    assert.ok(Number.isSafeInteger(producer.pid) && producer.pid>0);
    assert.match(producer.startTicks,/^[1-9][0-9]*$/);
    assert.equal(producer.nodeSha256,want.runtime);
    assert.equal(producer.nodePath,want.nodePath);
    assert.equal(producer.root,want.root);
    assert.equal(producer.hostBootId,expected.hostBootId);
    for (const value of [job.timing.startNs,job.timing.endNs])
      assert.match(value,/^[1-9][0-9]*$/);
    const start=BigInt(job.timing.startNs),end=BigInt(job.timing.endNs);
    assert.ok(start<end);
    return [start,end];
  });
  for (const key of ['event','run','jobId','runner','runnerId'])
    assert.notEqual(expected.jobs[0][key],expected.jobs[1][key],key);
  for (const key of ['source','tree','runtime','ref','workflowRef'])
    assert.equal(expected.jobs[0][key],expected.jobs[1][key],key);
  const [[a,b],[c,d]]=intervals;
  assert.ok((a>c?a:c)<(b<d?b:d),'Missing: actual E2E suite overlap');
  return {status:'PASS',scope:'externally-bound two-success-E2E-suite-overlap-only',
    wholeLiveGate:'NOT_EVALUATED'};
}

async function suiteProducerFaults() {
  // Exercise the actual suite module, not fabricated observed receipts.
  // All patches are test-local and restored; no fault flags enter product code.
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'ghalet-suite-faults-'));
  const spawn=childProcess.spawnSync, write=process.stdout.write;
  const hadTiming=Object.hasOwn(process.env,'OPS_TASK_CI_TIMING');
  const oldTiming=process.env.OPS_TASK_CI_TIMING;
  const faults=[
    {name:'spawn-error',result:{status:null,error:Object.assign(new Error('spawnSync EPERM'),{code:'EPERM'})}},
    {name:'signal',result:{status:null,signal:'SIGTERM'}},
    {name:'null-status',result:{status:null}},
    {name:'missing-status',result:{status:undefined}},
    {name:'abnormal-exit',result:{status:2}},
    {name:'string-status',result:{status:'1'}},
    {name:'error-with-status',result:{status:1,error:new Error('spawnSync EPERM')}},
    {name:'signal-with-status',result:{status:1,signal:'SIGTERM'}},
  ];
  const records=[];
  try {
    // Positive, negative1 and negative2 must each reject every OS/abnormal fault.
    for (const target of [0,1,2]) for (const fault of faults) {
      let calls=0,stdout='';
      const timing=path.join(out,'case-'+records.length+'.json');
      process.env.OPS_TASK_CI_TIMING=timing;
      childProcess.spawnSync=()=>{
        const call=calls++;
        return {status:call===0?0:1,signal:null,stdout:'',stderr:'',
          ...(call===target?fault.result:{})};
      };
      syncBuiltinESMExports();
      process.stdout.write=(chunk)=>{stdout+=String(chunk);return true;};
      const module=new URL('./e2e.mjs',import.meta.url);
      module.searchParams.set('faultCase',String(records.length));
      let rejected=false;
      try { await import(module.href); } catch { rejected=true; }
      assert.ok(rejected,'actual suite accepted '+fault.name);
      assert.equal(calls,target+1);
      assert.equal(stdout,'');
      assert.equal(JSON.parse(fs.readFileSync(timing,'utf8')).outcome,'failure');
      records.push({target,fault:fault.name,rejected:true,timingOutcome:'failure'});
    }
    // A normal exit1 is still required: exit0 on either negative is a failure.
    for (const target of [1,2]) {
      let calls=0;
      const timing=path.join(out,'negative-zero-'+target+'.json');
      process.env.OPS_TASK_CI_TIMING=timing;
      childProcess.spawnSync=()=>({status:calls++===target?0:(calls===1?0:1),signal:null,stdout:'',stderr:''});
      syncBuiltinESMExports();
      const module=new URL('./e2e.mjs',import.meta.url);
      module.searchParams.set('negativeZero',String(target));
      await assert.rejects(import(module.href));
      assert.equal(JSON.parse(fs.readFileSync(timing,'utf8')).outcome,'failure');
      records.push({target,fault:'negative-exit0',rejected:true,timingOutcome:'failure'});
    }
    // Controlled normal trace proves this test is not satisfied by unconditional failure.
    let calls=0,stdout='';
    const timing=path.join(out,'normal-trace.json');
    process.env.OPS_TASK_CI_TIMING=timing;
    childProcess.spawnSync=()=>({status:calls++===0?0:1,signal:null,stdout:'',stderr:''});
    syncBuiltinESMExports();
    process.stdout.write=(chunk)=>{stdout+=String(chunk);return true;};
    const module=new URL('./e2e.mjs',import.meta.url);
    module.searchParams.set('normalTraceControl','1');
    await import(module.href);
    assert.equal(calls,3);
    assert.deepEqual(JSON.parse(stdout),receiptContract);
    assert.equal(JSON.parse(fs.readFileSync(timing,'utf8')).outcome,'success');
  } finally {
    childProcess.spawnSync=spawn;
    syncBuiltinESMExports();
    process.stdout.write=write;
    if(hadTiming) process.env.OPS_TASK_CI_TIMING=oldTiming;
    else delete process.env.OPS_TASK_CI_TIMING;
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2)+'\n');
  return {negativeCases:records.length,controlledNormalTrace:true,evidence:out};
}

async function selftest() {
  const expected={schema:'ops.ghaletOverlapExpectation/3',
    hostBootId:'11111111-1111-1111-1111-111111111111',jobs:[0,1].map(i=>({
      event:'event'+i,source:'a'.repeat(40),tree:'b'.repeat(40),
      ref:'refs/heads/candidate',workflowRef:'roccho-org/ops/'+workflowPath+'@refs/heads/candidate',
      runtime:'c'.repeat(64),run:String(100+i),jobKey:'ghalet-native-check',
      jobId:String(200+i),attempt:'1',runner:'runner'+i,runnerId:String(300+i),
      root:'/work/package',nodePath:'/nix/store/example/bin/node',
    }))};
  const observed={schema:'ops.ghaletOverlapObservation/3',hostBootId:expected.hostBootId,
    jobs:expected.jobs.map((j,i)=>({...j,hostBootId:expected.hostBootId,
      pre:{source:j.source,tree:j.tree,clean:true},post:{source:j.source,tree:j.tree,clean:true},
      providerRuns:[{id:Number(j.run),run_attempt:1,display_title:'ghalet:'+j.event,
        head_sha:j.source,head_branch:'candidate',path:workflowPath,status:'completed',conclusion:'success'}],
      providerJob:{id:Number(j.jobId),run_id:Number(j.run),run_attempt:1,name:j.jobKey,
        runner_name:j.runner,runner_id:Number(j.runnerId),status:'completed',conclusion:'success'},
      exitCode:0,receipt:structuredClone(receiptContract),
      timing:{schema:'ops.taskRuntimeE2ETiming/1',outcome:'success',
        startNs:String(10+i),endNs:String(20+i),producer:{pid:400+i,startTicks:'123',nodePath:j.nodePath,
          nodeSha256:j.runtime,hostBootId:expected.hostBootId,root:j.root}}}))};
  verify(expected,observed); // Same real logical job key in independent runs is valid.
  const mutations=[
    o=>{o.jobs=[];},o=>{o.jobs.pop();},o=>{delete o.jobs[0].receipt;},
    o=>{delete o.jobs[0].timing;},o=>{o.jobs[0].exitCode=1;},
    o=>{o.jobs[0].timing.startNs='0';},o=>{o.jobs[1].timing.startNs='30';o.jobs[1].timing.endNs='40';},
    o=>{o.hostBootId='wrong';},o=>{o.jobs[0].hostBootId='wrong';},
    ...keys.map(k=>o=>{o.jobs[0][k]='substituted';}),
    ...Object.keys(receiptContract).map(k=>o=>{o.jobs[0].receipt[k]='wrong';}),
    o=>{o.jobs[0].receipt.extra='not-in-contract';},
    o=>{o.jobs[0].timing.outcome='failure';},
    o=>{o.jobs[0].timing.schema='ops.taskRuntimeValidationTiming/1';},
    o=>{o.jobs[0].receipt={schema:'ops.taskRuntimeStaticReceipt/1',status:'PASS',
      authority:'roccho-dev/adrs#317',target:'linux-amd64',dagAuthority:'Taskfile.yml',
      entryAuthority:'.gosh/events.jsonl generated at materialization'};},
    ...['nodeSha256','nodePath','hostBootId','root'].map(k=>o=>{o.jobs[0].timing.producer[k]='wrong';}),
    o=>{o.jobs[0].timing.producer.pid=0;},
    o=>{o.jobs[0].timing.producer.startTicks='0';},
    o=>{o.jobs[0].pre.clean=false;},o=>{o.jobs[0].post.clean=false;},
    o=>{o.jobs[0].post.tree='d'.repeat(40);},
    ...['id','run_id','run_attempt','name','runner_name','runner_id'].map(k=>
      o=>{o.jobs[0].providerJob[k]=typeof o.jobs[0].providerJob[k]==='number'?999:'wrong';}),
    o=>{o.jobs[0].providerRuns=[];},
    o=>{o.jobs[0].providerRuns.push(structuredClone(o.jobs[0].providerRuns[0]));},
    ...['display_title','head_sha','head_branch','path','run_attempt','id'].map(k=>
      o=>{o.jobs[0].providerRuns[0][k]=typeof o.jobs[0].providerRuns[0][k]==='number'?999:'wrong';}),
    o=>{o.jobs[0].providerJob.conclusion='failure';},
    o=>{o.jobs[0].providerRuns[0].status='queued';},
  ];
  for(const mutate of mutations) {
    const copy=structuredClone(observed); mutate(copy);
    assert.throws(()=>verify(expected,copy));
  }
  const sameRunExpected=structuredClone(expected),sameRunObserved=structuredClone(observed);
  sameRunExpected.jobs[1].run=sameRunExpected.jobs[0].run;
  sameRunObserved.jobs[1].run=sameRunExpected.jobs[0].run;
  sameRunObserved.jobs[1].providerRuns[0].id=100;
  sameRunObserved.jobs[1].providerJob.run_id=100;
  assert.throws(()=>verify(sameRunExpected,sameRunObserved));
  assert.throws(()=>verify({},observed));
  assert.equal(identifyRun(expected.jobs[0],[]).status,'HOLD');
  assert.equal(identifyRun(expected.jobs[0],[...observed.jobs[0].providerRuns,
    ...observed.jobs[0].providerRuns]).status,'HOLD');
  console.log(JSON.stringify({status:'PASS',scope:'LOCAL_VALIDATOR_TEST_ONLY',
    negatives:mutations.length+2,suiteProducerFaults:await suiteProducerFaults(),liveProof:'MISSING'}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv[2]==='--selftest') await selftest();
    else {
      assert.equal(process.argv.length,4,'usage: ghalet-proof.mjs EXPECTED OBSERVED | --selftest');
      console.log(JSON.stringify(verify(...process.argv.slice(2).map(p=>JSON.parse(fs.readFileSync(p,'utf8'))))));
    }
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
