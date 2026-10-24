#!/usr/bin/env node
// Evidence-only validator: never dispatches, starts runners, or retries.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function verify(expected, observed) {
  assert.equal(expected.schema, 'ops.ghaletOverlapExpectation/1');
  assert.equal(observed.schema, 'ops.ghaletOverlapObservation/1');
  const keys = ['event', 'source', 'ref', 'runtime', 'run', 'job', 'attempt', 'runner'];
  assert.equal(expected.jobs.length, 2);
  assert.equal(observed.jobs.length, 2);
  assert.match(expected.hostBootId, /^[0-9a-f-]{36}$/);
  assert.equal(observed.hostBootId, expected.hostBootId);
  const intervals = observed.jobs.map((job, i) => {
    for (const key of keys) {
      assert.equal(typeof expected.jobs[i][key], 'string');
      assert.ok(expected.jobs[i][key].length);
      assert.equal(job[key], expected.jobs[i][key], key);
    }
    assert.equal(job.exitCode, 0);
    assert.equal(job.receipt?.schema, 'ops.taskRuntimeStaticReceipt/1');
    assert.equal(job.receipt.status, 'PASS');
    assert.equal(job.timing?.schema, 'ops.taskRuntimeValidationTiming/1');
    assert.equal(job.timing.outcome, 'success');
    for (const value of [job.timing.startNs, job.timing.endNs])
      assert.match(value, /^[1-9][0-9]*$/);
    const start = BigInt(job.timing.startNs), end = BigInt(job.timing.endNs);
    assert.ok(start < end);
    return [start, end];
  });
  for (const key of ['event', 'job', 'runner'])
    assert.notEqual(expected.jobs[0][key], expected.jobs[1][key]);
  assert.equal(expected.jobs[0].source, expected.jobs[1].source);
  assert.equal(expected.jobs[0].runtime, expected.jobs[1].runtime);
  const [[a,b],[c,d]] = intervals;
  assert.ok((a > c ? a : c) < (b < d ? b : d), 'Missing: actual validation overlap');
  return { status: 'PASS', scope: 'externally-bound two-success-validation-overlap-only',
    wholeLiveGate: 'NOT_EVALUATED' };
}

function selftest() {
  const expected = { schema: 'ops.ghaletOverlapExpectation/1',
    hostBootId: '11111111-1111-1111-1111-111111111111', jobs: [0,1].map(i =>
      Object.fromEntries(['event','source','ref','runtime','run','job','attempt','runner']
        .map(k => [k, ['source','ref','runtime'].includes(k) ? k : k+i]))) };
  const observed = { schema: 'ops.ghaletOverlapObservation/1',
    hostBootId: expected.hostBootId, jobs: expected.jobs.map((j,i) => ({ ...j, exitCode: 0,
      receipt: {schema:'ops.taskRuntimeStaticReceipt/1',status:'PASS'},
      timing:{schema:'ops.taskRuntimeValidationTiming/1',outcome:'success',
        startNs:String(10+i),endNs:String(20+i)} })) };
  verify(expected, observed);
  const mutations = [
    o => { o.jobs = []; }, o => { o.jobs.pop(); },
    o => { delete o.jobs[0].receipt; }, o => { delete o.jobs[0].timing; },
    o => { o.jobs[0].exitCode = 1; }, o => { o.jobs[0].timing.startNs='0'; },
    o => { o.jobs[1].timing.startNs='30';o.jobs[1].timing.endNs='40'; },
    o => { o.hostBootId='another-host'; },
    ...['event','source','ref','runtime','run','job','attempt','runner'].map(k =>
      o => { o.jobs[0][k]='stale-or-substituted'; }),
    o => { o.jobs[0].timing.outcome='failure'; },
    o => { o.jobs[0].receipt.status='FAIL'; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(observed); mutate(copy);
    assert.throws(() => verify(expected,copy));
  }
  assert.throws(() => verify({},observed));
  console.log(JSON.stringify({status:'PASS',scope:'LOCAL_VALIDATOR_TEST_ONLY',
    negatives:mutations.length+1,liveProof:'MISSING'}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--selftest') selftest();
    else {
      assert.equal(process.argv.length, 4, 'usage: ghalet-proof.mjs EXPECTED OBSERVED | --selftest');
      console.log(JSON.stringify(verify(...process.argv.slice(2).map(p =>
        JSON.parse(fs.readFileSync(p,'utf8'))))));
    }
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
