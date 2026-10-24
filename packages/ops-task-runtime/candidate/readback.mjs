import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha, read, inventory, inputIdentity, declaredEnv} from './requests.mjs';
import {alive, discover, sameContext} from './process.mjs';
const fail = s => { throw Error(s); };
export function attemptReadback(dir) {
  const a = read(path.join(dir, 'accepted.json')), r = read(path.join(dir, 'receipt.json'));
  if (r.schema !== 'ops.taskCandidateAttempt/1' || r.status !== 'OBSERVED' || !r.oracleIntact || !r.workIntact || r.dir !== dir) fail('receipt identity/integrity');
  for (const k of ['eventId', 'runId', 'attemptId', 'x', 'commit', 'tree', 'inputSha256', 'runtimeIdentity', 'target', 'declaredEnv', 'mode', 'route', 'oracle']) assert.deepEqual(r[k], a[k], `acceptance mismatch ${k}`);
  if (inputIdentity(r) !== r.x || r.target !== 'linux-amd64') fail('input binding');
  assert.deepEqual(r.declaredEnv, declaredEnv);
  assert.deepEqual(inventory(path.join(dir, 'snapshot')), r.oracle);
  const input = fs.readFileSync(path.join(dir, 'snapshot', 'input.bin'));
  if (sha(input) !== r.inputSha256) fail('input bytes');
  for (const [rel, digest] of r.oracle) if (sha(fs.readFileSync(path.join(dir, 'work', rel))) !== digest) fail('work source changed');
  const process = read(path.join(dir, 'process-final.json'));
  if (!process.allStopped || (sameContext(process.root) && discover(process.root, process.descendants).some(alive))) fail('live process tree');
  const out = path.join(dir, 'work', 'out');
  if (fs.readdirSync(out).some(n => n.endsWith('.partial'))) fail('partial artifact');
  if (fs.existsSync(path.join(out, 'forbidden.json'))) fail('dependent executed');
  function artifact(name) {
    const x = read(path.join(out, name + '.json'));
    if (x.x !== r.x || x.inputSha256 !== r.inputSha256) fail('stale result');
    return x;
  }
  let semantic;
  if (r.mode === 'success') {
    const p = artifact('result'), a = artifact('a'), b = artifact('b');
    artifact('a-started'); artifact('b-started');
    if (r.exit !== 0 || r.cancelled || p.status !== 'PASS' || p.semantic !== 'AB') fail('success exit/result');
    const leaf = read(r.route === 'direct' ? path.join(dir, 'stdout') : path.join(dir, 'actrun/run-1/tasks/pure-check__step_1.stdout.log'));
    if (leaf.schema !== 'ops.taskRuntimeStaticReceipt/1' || leaf.status !== 'PASS' || leaf.target !== r.target) fail('real static leaf receipt');
    if (!(Math.max(a.start, b.start) < Math.min(a.end, b.end)) || p.join < Math.max(a.end, b.end) || a.pid === b.pid) fail('DAG interval/process');
    semantic = {status: p.status, semantic: p.semantic, exitClass: 'zero'};
  } else if (r.mode === 'failure') {
    const p = artifact('failure');
    if (r.exit === 0 || r.exit === null || r.cancelled || p.errorClass !== 'fixture-root-failure' || p.leafExit !== 7) fail('failure class');
    semantic = {status: 'EXPECTED_FAILURE', errorClass: p.errorClass, leafExit: p.leafExit, exitClass: 'nonzero'};
  } else if (r.mode === 'cancel') {
    artifact('cancel-root'); const d = artifact('descendant');
    if (!r.cancelled || r.exit === 0 || !process.descendants.some(p => p.pid === d.pid)) fail('cancel/descendant evidence');
    semantic = {status: 'EXPECTED_CANCEL', errorClass: 'cancelled-process-tree', exitClass: 'cancelled'};
  } else fail('unknown mode');
  return {commit: r.commit, tree: r.tree, x: r.x, inputSha256: r.inputSha256, runtimeIdentity: r.runtimeIdentity, target: r.target, mode: r.mode, ...semantic, dependentStarted: false};
}
export function readback(root) {
  const x = read(path.join(root, 'invocation.json')), admission = read(path.join(root, 'admission.json'));
  if (!x.accepted.length || x.accepted.length > 2 || admission.bound !== 2 || admission.boundScope !== 'one invocation') fail('admission bound');
  assert.deepEqual(admission.accepted, x.accepted.map(({eventId, runId, attemptId, x}) => ({eventId, runId, attemptId, x})));
  assert.deepEqual(admission.rejected, x.rejected);
  if (x.rejected.some(r => r.status !== 'REJECTED_CAPACITY' || r.queued !== false) || (x.rejected.length && x.accepted.length !== 2)) fail('rejection');
  const dirs = x.accepted.map(a => fs.realpathSync(a.dir));
  if (new Set(dirs).size !== dirs.length || dirs.some((a, i) => dirs.some((b, j) => i !== j && a.startsWith(b + path.sep)))) fail('write isolation');
  const normalized = x.accepted.map(a => {
    if (a.commit !== x.commit || a.tree !== x.tree) fail('invocation source');
    return attemptReadback(a.dir);
  });
  const success = x.accepted.filter(a => a.mode === 'success').map(a => read(path.join(a.dir, 'work', 'out', 'result.json')));
  if (success.length === 2 && !(Math.max(success[0].start, success[1].start) < Math.min(success[0].end, success[1].end))) fail('run overlap');
  return {schema: 'ops.taskCandidateReadback/1', status: 'PASS', normalized, rejected: x.rejected};
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(readback(process.argv[2]), null, 2));
