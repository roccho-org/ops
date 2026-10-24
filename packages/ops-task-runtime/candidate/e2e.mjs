import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {read, write} from './requests.mjs';
import {readback} from './readback.mjs';
import {stopTree, processIdentity, discover, alive} from './process.mjs';

export async function candidateE2E(manifest, root, evidence) {
  fs.mkdirSync(evidence, {recursive: false});
  const cli = path.join(root, 'packages/ops-task-runtime/bin/ops-task-runtime.mjs');
  let invocation = 0;
  const invoke = async (args, expected = 0) => {
    const serial = ++invocation;
    const stdoutPath = path.join(evidence, `cli-${serial}.stdout`), stderrPath = path.join(evidence, `cli-${serial}.stderr`);
    const stdout = fs.openSync(stdoutPath, 'wx'), stderr = fs.openSync(stderrPath, 'wx');
    const child = spawn(process.execPath, [cli, 'candidate', ...args], {stdio: ['ignore', stdout, stderr], signal: AbortSignal.timeout(45000)});
    const r = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (status, signal) => resolve({status, signal}));});
    fs.closeSync(stdout); fs.closeSync(stderr);
    r.stdout = fs.readFileSync(stdoutPath, 'utf8'); r.stderr = fs.readFileSync(stderrPath, 'utf8');
    write(path.join(evidence, `cli-${serial}.json`), {args, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message});
    assert.ifError(r.error);
    assert.equal(r.status, expected, r.stderr || r.stdout); return r.stdout;
  };
  const summaries = {};
  for (const route of ['direct', 'actrun']) for (const mode of ['success', 'failure', 'cancel']) {
    const req = path.join(evidence, `${route}-${mode}.request.json`), out = path.join(evidence, `${route}-${mode}`);
    write(req, {schema: 'ops.taskCandidateRequests/1', requests: ['QQ==', 'Qg==', 'Qw=='].map((inputBase64, i) => ({eventId: `${route}-${mode}-${i}`, inputBase64, route, mode}))});
    await invoke(['requests', '--repo', root, '--request-file', req, '--runtime-manifest', manifest, '--evidence-dir', out]);
    const result = readback(out);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.normalized.length, 2);
    write(path.join(evidence, `${route}-${mode}.readback.json`), result);
    summaries[`${route}-${mode}`] = result.normalized;
  }
  for (const mode of ['success', 'failure', 'cancel']) assert.deepEqual(summaries[`direct-${mode}`], summaries[`actrun-${mode}`], `${mode} route parity`);
  const invocationFile = path.join(evidence, 'direct-success/invocation.json');
  const admissionFile = path.join(evidence, 'direct-success/admission.json');
  const originalInvocation = fs.readFileSync(invocationFile), originalAdmission = fs.readFileSync(admissionFile);
  const changedInvocation = JSON.parse(originalInvocation), changedAdmission = JSON.parse(originalAdmission);
  changedInvocation.accepted[0].eventId = changedAdmission.accepted[0].eventId = 'mismatched-event';
  fs.writeFileSync(invocationFile, JSON.stringify(changedInvocation)); fs.writeFileSync(admissionFile, JSON.stringify(changedAdmission));
  assert.throws(() => readback(path.join(evidence, 'direct-success')), /invocation\/attempt k mismatch/);
  fs.writeFileSync(invocationFile, originalInvocation); fs.writeFileSync(admissionFile, originalAdmission);
  const run = read(path.join(evidence, 'direct-success/invocation.json')).accepted[0];
  const out = path.join(run.dir, 'work/out'), resultPath = path.join(out, 'result.json'), original = fs.readFileSync(resultPath);
  const missingJoin = JSON.parse(original); delete missingJoin.join;
  fs.writeFileSync(resultPath, JSON.stringify(missingJoin));
  assert.throws(() => readback(path.join(evidence, 'direct-success')), /monotonic/);
  const badInterval = JSON.parse(original); badInterval.start--;
  fs.writeFileSync(resultPath, JSON.stringify(badInterval));
  assert.throws(() => readback(path.join(evidence, 'direct-success')), /inconsistent interval/);
  const result = JSON.parse(original); result.x = 'stale'; fs.writeFileSync(resultPath, JSON.stringify(result));
  assert.throws(() => readback(path.join(evidence, 'direct-success')), /stale/);
  fs.writeFileSync(resultPath, original);
  fs.writeFileSync(path.join(out, 'stale.partial'), 'incomplete');
  assert.throws(() => readback(path.join(evidence, 'direct-success')), /partial/);
  fs.unlinkSync(path.join(out, 'stale.partial'));
  fs.renameSync(resultPath, resultPath + '.missing');
  assert.throws(() => readback(path.join(evidence, 'direct-success')));
  fs.renameSync(resultPath + '.missing', resultPath);
  const collected = JSON.parse(await invoke(['recover', '--attempt', run.dir]));
  assert.equal(collected.status, 'COLLECTED_NO_REPLAY');
  assert.equal(fs.readFileSync(resultPath).toString(), original.toString());
  const recoveryReq = path.join(evidence, 'recovery.request.json'), recoveryOut = path.join(evidence, 'recovery');
  write(recoveryReq, {schema: 'ops.taskCandidateRequests/1', requests: [{eventId: 'unknown-live', inputBase64: 'QQ==', route: 'direct', mode: 'success'}]});
  const child = spawn(process.execPath, [cli, 'candidate', 'requests', '--repo', root, '--request-file', recoveryReq, '--runtime-manifest', manifest, '--evidence-dir', recoveryOut], {stdio: 'ignore'});
  const exited = new Promise(resolve => child.once('exit', resolve));
  let a;
  for (let i = 0; i < 500; i++) {
    if (fs.existsSync(path.join(recoveryOut, 'admission.json'))) {
      const id = read(path.join(recoveryOut, 'admission.json')).accepted[0];
      const dir = path.join(recoveryOut, id.runId, id.attemptId);
      if (fs.existsSync(path.join(dir, 'work/out/a-started.json')) && fs.existsSync(path.join(dir, 'work/out/b-started.json'))) { a = read(path.join(dir, 'accepted.json')); break; }
    }
    await delay(10);
  }
  if (!a) { child.kill('SIGKILL'); await exited; throw Error('recovery fixture did not start'); }
  child.kill('SIGKILL'); await exited;
  const hold = JSON.parse(await invoke(['recover', '--attempt', a.dir])); assert.equal(hold.status, 'HOLD');
  const processState = read(path.join(a.dir, 'process.json'));
  await stopTree(processState.root, processState.descendants);
  const stopped = JSON.parse(await invoke(['recover', '--attempt', a.dir])); assert.equal(stopped.status, 'STOPPED_INCOMPLETE');
  const retry = JSON.parse(await invoke(['recover', '--attempt', a.dir, '--retry-runtime', manifest]));
  assert.equal(retry.status, 'RETRIED_STOPPED_INCOMPLETE'); assert.equal(retry.result.x, a.x); assert.notEqual(retry.attempt, a.dir);
  // Simulate PID reuse with actual independently owned live processes. A stale
  // start identity must neither discover nor kill the replacement's children.
  const markerPath = path.join(evidence, 'unrelated-child.pid');
  const program = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)";
  const unrelated = spawn(process.execPath, ['-e', program, markerPath], {detached: true, stdio: 'ignore'});
  const unrelatedExit = new Promise(resolve => unrelated.once('exit', resolve));
  const unrelatedRoot = processIdentity(unrelated.pid);
  try {
    for (let i = 0; i < 500 && !fs.existsSync(markerPath); i++) await delay(10);
    assert.equal(fs.existsSync(markerPath), true);
    const descendant = processIdentity(Number(fs.readFileSync(markerPath, 'utf8')));
    const stale = {...unrelatedRoot, start: String(BigInt(unrelatedRoot.start) - 1n)};
    assert.equal(discover(stale).filter(alive).length, 0);
    await stopTree(stale, []);
    assert.equal(alive(unrelatedRoot), true); assert.equal(alive(descendant), true);
    write(path.join(evidence, 'stale-pid-negative.json'), {stale, actualRoot: unrelatedRoot, actualDescendant: descendant, replacementSurvived: true});
  } finally { await stopTree(unrelatedRoot, discover(unrelatedRoot)); await unrelatedExit; }
  const invalid = read(manifest); invalid.tools.task.sha256 = '0'.repeat(64);
  const invalidPath = path.join(evidence, 'invalid-runtime.json'); write(invalidPath, invalid);
  const requestArgs = ['requests', '--repo', root, '--request-file', recoveryReq, '--runtime-manifest', invalidPath, '--evidence-dir', path.join(evidence, 'must-not-run')];
  await invoke(requestArgs, 1); assert.equal(fs.existsSync(path.join(evidence, 'must-not-run')), false);
  const marker = path.join(root, 'packages/ops-task-runtime', `.candidate-dirty-${process.pid}`);
  fs.writeFileSync(marker, 'untracked proof input');
  try {
    requestArgs[6] = manifest;
    await invoke(requestArgs, 1);
    assert.equal(fs.existsSync(path.join(evidence, 'must-not-run')), false);
  } finally { fs.unlinkSync(marker); }
  const packet = {schema: 'ops.taskCandidateE2E/1', status: 'PASS', parity: ['success', 'failure', 'cancel'], destructive: ['stale', 'partial', 'missing', 'runtime-tamper', 'dirty-source', 'invocation-k-mismatch', 'missing-join-time', 'inconsistent-interval', 'stale-pid-unrelated-process'], recovery: [collected.status, hold.status, stopped.status, retry.status], normalized: summaries, evidence};
  write(path.join(evidence, 'e2e.json'), packet);
  return packet;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(await candidateE2E(process.argv[2], path.resolve(process.argv[3]), path.resolve(process.argv[4]))));
