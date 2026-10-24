import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {read, write, inventory, binding, execute, inputIdentity} from './requests.mjs';
import {discover, alive} from './process.mjs';
import {attemptReadback} from './readback.mjs';

export async function recover(args) {
  if (![2, 4].includes(args.length) || args[0] !== '--attempt' || (args.length === 4 && args[2] !== '--retry-runtime')) throw Error('recover --attempt DIR [--retry-runtime MANIFEST]');
  const dir = path.resolve(args[1]);
  if (fs.existsSync(path.join(dir, 'receipt.json'))) {
    const result = attemptReadback(dir);
    console.log(JSON.stringify({status: 'COLLECTED_NO_REPLAY', attempt: dir, result}));
    return;
  }
  const state = read(path.join(dir, 'process.json'));
  const processes = discover(state.root, state.descendants);
  if (processes.some(alive)) { console.log(JSON.stringify({status: 'HOLD', attempt: dir, processes})); return; }
  if (args.length !== 4) { console.log(JSON.stringify({status: 'STOPPED_INCOMPLETE', attempt: dir, retryPermitted: true})); return; }
  const a = read(path.join(dir, 'accepted.json')), runtime = binding(args[3]);
  if (inputIdentity(a) !== a.x) throw Error('retry input identity');
  assert.deepEqual(inventory(path.join(dir, 'snapshot')), a.oracle);
  assert.deepEqual(Object.fromEntries(Object.entries(runtime.tools).sort().map(([k, v]) => [k, v.sha256])), a.runtimeIdentity);
  const attemptId = crypto.randomUUID(), next = path.join(path.dirname(dir), attemptId);
  fs.mkdirSync(next);
  for (const name of ['tmp', 'home']) fs.mkdirSync(path.join(next, name));
  for (const name of ['snapshot', 'work']) fs.cpSync(path.join(dir, 'snapshot'), path.join(next, name), {recursive: true});
  const retry = {...a, attemptId, dir: next, priorAttempt: dir};
  write(path.join(next, 'accepted.json'), retry);
  await execute(retry, runtime);
  console.log(JSON.stringify({status: 'RETRIED_STOPPED_INCOMPLETE', priorAttempt: dir, attempt: next, result: attemptReadback(next)}));
}
