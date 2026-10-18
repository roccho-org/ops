import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { bindSemlintOwnerSSHExecutor } from './semlint-owner-ssh-executor.mjs';
import { preparePlan, runPlan, validateOwnerResult } from '../../packages/jev-review/semlint-entry.mjs';
import { composeResultComment } from '../../packages/jev-review/github-comment.mjs';
import { JEV_MODEL } from '../../packages/jev-review/core.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
export function syntheticOwnerInput({ needs = false, edition = 16 } = {}) {
  const content = 'Finite synthetic source.';
  const row = { ref: 'synthetic', revision: 'r1', content, sha256: hash(content),
    evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content) }, englishAuxiliary: null };
  return { schema: 'ops.semlint.real-input.v1', cases: [{ id: 'synthetic', input: {
    schema: 'ops.semlint.input.v' + edition,
    subject: { kind: 'ci-artifact', scope: 'whole synthetic source', ...row },
    context: needs ? [] : [{ role: 'basis', ...row }],
    checks: [{ id: 'synthetic-check', axis: 'Aligned', concern: 'Assess the supplied finite synthetic condition.',
      requiredRoles: ['basis'], crossLinks: [], predicate: {
        question: 'Does the supplied condition hold?', true: 'The supplied condition holds.',
        false: 'The supplied condition does not hold.' } }]
  } }] };
}
export async function syntheticOwnerResult(prepared, { providerNull = false } = {}) {
  const result = await runPlan(prepared, async (_state, questions) => ({
    model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.25 }])),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, elapsed: 0
  }));
  if (!providerNull) {
    for (const row of result.cases) {
      const count = row.result.accounting.callbackAttempts;
      row.provider = { attemptedHttpCalls: count, completedHttpCalls: count,
        validatedResponses: row.result.accounting.validatedCalls,
        statusClass: count ? 'VALIDATED_RESPONSE' : 'NOT_RUN', validatedModel: count ? JEV_MODEL : null,
        usage: count ? row.result.accounting.usage : null, elapsedMs: 0,
        responseDigest: count ? hash('synthetic response only') : null };
    }
    Object.assign(result.accounting, { providerHttpCalls: result.accounting.callbackAttempts,
      completedHttpCalls: result.accounting.callbackAttempts, validatedResponses: result.accounting.validatedCalls,
      unknownHttpCalls: 0 });
  }
  return result;
}
function context(t, patch = {}) {
  const tempParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'semlint-owner-ssh-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(path.dirname(resolved) === tempParent
      && path.basename(resolved).startsWith('semlint-owner-ssh-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const options = { sshPath: path.join(root, 'ssh.exe'), host: 'synthetic-owner',
    remoteLauncherPath: '/nix/store/' + 'a'.repeat(32) + '-ops-semlint-owner/bin/ops-semlint-owner',
    envsSha: 'b'.repeat(40), opsSha: 'c'.repeat(40), resourcesSha: 'd'.repeat(40), runId: randomUUID(), ledgerDir: root,
    deadlineMs: 1000, ...patch };
  return { root, options, callId: options.runId + '/evaluate/1' };
}
export function fakeOwnerChild(output, { exit = 0, stderr = 'public synthetic launcher diagnostic\n', hang = false, kill = 'close' } = {}) {
  const child = new EventEmitter(), chunks = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.stdin.on('data', data => chunks.push(Buffer.from(data)));
  child.unrefCalls = 0; child.unref = () => { child.unrefCalls++; };
  const close = code => { child.exitCode = code; child.emit('close', code, null); };
  child.kill = () => {
    if (kill === 'throw') throw Object.assign(new Error('synthetic kill failure'), { code: 'EPERM' });
    if (kill === 'false') return false;
    setImmediate(() => close(1)); return true;
  };
  child.stdin.on('finish', () => {
    child.input = Buffer.concat(chunks);
    if (!hang) setImmediate(() => {
      if (output) child.stdout.emit('data', Buffer.isBuffer(output) ? output : Buffer.from(output));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      close(exit);
    });
  });
  return child;
}

test('owner validator preserves prepared identity, v16-only policy and legacy comment gates', async () => {
  const prepared = await preparePlan(syntheticOwnerInput());
  const result = await syntheticOwnerResult(prepared);
  assert.deepEqual(copy(validateOwnerResult(prepared, result, 'owner-v16')), result);
  assert.throws(() => validateOwnerResult(copy(prepared), result, 'owner-v16'), /ENTRY_NOT_ADMITTED/);
  assert.throws(() => validateOwnerResult(prepared, result), /RESULT_IDENTITY_MISMATCH/);
  assert.throws(() => validateOwnerResult(prepared, result, 'arbitrary'), /INVALID_OWNER_RESULT_POLICY/);
  assert.throws(() => validateOwnerResult(prepared, { ...result, cases: [] }, 'owner-v16'), /RESULT_IDENTITY_MISMATCH/);
  const synthetic = await syntheticOwnerResult(prepared, { providerNull: true });
  assert.throws(() => validateOwnerResult(prepared, synthetic, 'owner-v16'), /INVALID_PROVIDER_ACCOUNTING/);
  const legacy = await preparePlan(syntheticOwnerInput({ edition: 14 }));
  const legacyResult = await syntheticOwnerResult(legacy, { providerNull: true });
  assert.deepEqual(copy(validateOwnerResult(legacy, legacyResult)), legacyResult);
  assert.throws(() => validateOwnerResult(legacy, legacyResult, 'owner-v16'), /RESULT_IDENTITY_MISMATCH/);
  assert.throws(() => composeResultComment({ prepared }, result), /REQUEST_NOT_ADMITTED/);
});

test('owner validator rejects result/digest/record/projection/accounting weakening', async () => {
  const prepared = await preparePlan(syntheticOwnerInput()), result = await syntheticOwnerResult(prepared);
  const mutations = [
    x => { x.model = 'other'; }, x => { x.planDigest = '0'.repeat(64); },
    x => { x.cases[0].id = 'other'; }, x => { x.cases[0].result.questionDigest = '0'.repeat(64); },
    x => { x.cases[0].result.projection = {}; }, x => { x.cases[0].result.records[0].noul = 2; },
    x => { x.cases[0].result.counts.evaluated = 0; },
    x => { x.cases[0].provider.attemptedHttpCalls = 0; },
    x => { x.accounting.providerHttpCalls = 0; }, x => { x.accounting.cost = 0; },
  ];
  for (const mutate of mutations) {
    const changed = copy(result); mutate(changed);
    assert.throws(() => validateOwnerResult(prepared, changed, 'owner-v16'));
  }
});

test('fixed owner SSH sends exact protocol once and retains local bytes without a TypeLLM frame', async t => {
  const c = context(t), prepared = await preparePlan(syntheticOwnerInput()), result = await syntheticOwnerResult(prepared);
  const child = fakeOwnerChild(JSON.stringify(result) + '\n'), calls = [];
  const env = { PATH: 'synthetic path' };
  for (const key of ['TYPELLM_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
    Object.defineProperty(env, key, { enumerable: true, get() { throw new Error('provider value must not be read'); } });
  t.mock.property(process, 'env', env);
  t.mock.method(childProcess, 'spawn', (...args) => { calls.push(args); return child; });
  const port = bindSemlintOwnerSSHExecutor(c.options);
  const output = await port.executePlan(prepared.plan, { callId: c.callId });
  assert.deepEqual(output, result); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--',
    c.options.host, c.options.remoteLauncherPath, '--envs-sha', c.options.envsSha, '--ops-sha', c.options.opsSha]);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].env, { PATH: 'synthetic path' });
  assert.ok(child.input.equals(Buffer.from(JSON.stringify(prepared.plan) + '\n')));
  const record = port.receipts()[0];
  assert.equal(record.status, 'RETURNED'); assert.equal(record.spawnInvocations, 1);
  assert.equal(record.stdinSha256, hash(child.input)); assert.equal(record.stdoutSha256, hash(JSON.stringify(result) + '\n'));
  assert.equal(record.remoteStdinByteIdentity, 'UNREPORTED'); assert.equal(record.backendIdentityStatus, 'UNKNOWN');
  assert.equal(record.physicalCloseObserved, true); assert.equal(record.remoteEffects, 'UNKNOWN');
  assert.equal(record.stdoutComplete, true); assert.equal(record.stderrComplete, true);
  assert.deepEqual(copy(validateOwnerResult(prepared, output, 'owner-v16')), result);
  assert.equal(fs.readFileSync(record.stdinPath).equals(child.input), true);
  await assert.rejects(port.executePlan(prepared.plan, { callId: c.callId }), /executor_contract_error/);
  await assert.rejects(bindSemlintOwnerSSHExecutor(c.options).executePlan(prepared.plan, { callId: c.callId }), /executor_contract_error/);
  assert.equal(calls.length, 1);
});

test('owner SSH rejects unknown options, launcher alternatives, oversized and invalid inputs before spawn', async t => {
  const c = context(t); let spawns = 0;
  t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('forbidden'); });
  for (const patch of [{ remoteLauncherPath: undefined }, { remoteLauncherPath: 'ops-semlint-owner' },
    { remoteLauncherPath: '/nix/store/' + 'a'.repeat(32) + '-ops-typellm/bin/ops-typellm' },
    { maxCalls: 2 }, { extra: true }])
    assert.throws(() => bindSemlintOwnerSSHExecutor({ ...c.options, ...patch }), /INVALID_SEMLINT_OWNER_SSH_EXECUTOR/);
  for (const input of [{}, { schema: 'ops.semlint.real-input.v1', cases: [{ id: 'x', input: 'x'.repeat(1048576) }] }]) {
    const fresh = context(t), port = bindSemlintOwnerSSHExecutor(fresh.options);
    await assert.rejects(port.executePlan(input, { callId: fresh.callId }), /executor_contract_error/);
    assert.equal(port.receipts()[0].spawnInvocations, 0);
    assert.equal(port.receipts()[0].remoteEffects, 'NOT_DISPATCHED_BY_EXECUTOR');
  }
  const fresh = context(t), aborted = new AbortController(); aborted.abort();
  const port = bindSemlintOwnerSSHExecutor(fresh.options);
  await assert.rejects(port.executePlan(syntheticOwnerInput(), { callId: fresh.callId, signal: aborted.signal }), /cancelled/);
  assert.equal(port.receipts()[0].spawnInvocations, 0); assert.equal(spawns, 0);
});

test('owner SSH preserves nonzero, malformed, duplicate and overflowing originals as failed attempts', async t => {
  const prepared = await preparePlan(syntheticOwnerInput()), result = await syntheticOwnerResult(prepared);
  for (const kind of ['nonzero', 'partial', 'extra-line', 'duplicate', 'invalid-utf8', 'overflow']) {
    const c = context(t);
    let bytes = Buffer.from(JSON.stringify(result) + '\n');
    if (kind === 'partial') bytes = Buffer.from('{');
    if (kind === 'extra-line') bytes = Buffer.from(JSON.stringify(result) + '\n{}\n');
    if (kind === 'duplicate') bytes = Buffer.from('{"schema":"wrong",' + JSON.stringify(result).slice(1) + '\n');
    if (kind === 'invalid-utf8') bytes = Buffer.from([0xff, 10]);
    if (kind === 'overflow') bytes = Buffer.alloc(1048577, 120);
    const child = fakeOwnerChild(bytes, { exit: kind === 'nonzero' ? 1 : 0 });
    const mock = t.mock.method(childProcess, 'spawn', () => child);
    const port = bindSemlintOwnerSSHExecutor(c.options);
    await assert.rejects(port.executePlan(prepared.plan, { callId: c.callId }));
    const record = port.receipts()[0];
    assert.equal(record.status, 'FAILED'); assert.equal(record.spawnInvocations, 1);
    assert.equal(record.remoteEffects, 'UNKNOWN'); assert.ok(record.stdoutBytes <= 1048576);
    assert.equal(hash(fs.readFileSync(record.stdoutPath)), record.stdoutSha256);
    if (kind === 'overflow') assert.equal(record.stdoutComplete, false);
    mock.mock.restore();
  }
});

test('owner SSH bounds no-close kill failures and ignores late child events after receipt freeze', async t => {
  for (const kill of ['false', 'throw']) {
    const c = context(t, { deadlineMs: 5 }), child = fakeOwnerChild(null, { hang: true, kill });
    const mock = t.mock.method(childProcess, 'spawn', () => child);
    const port = bindSemlintOwnerSSHExecutor(c.options), started = performance.now();
    await assert.rejects(port.executePlan(syntheticOwnerInput(), { callId: c.callId }), /executor_timeout/);
    assert.ok(performance.now() - started < 2000);
    const record = port.receipts()[0], original = JSON.stringify(record);
    assert.equal(record.physicalCloseObserved, false); assert.equal(record.closeGraceExpired, true);
    assert.equal(record.stdoutComplete, false); assert.equal(child.unrefCalls, 1);
    assert.doesNotThrow(() => {
      child.emit('error', new Error('late one')); child.emit('error', new Error('late two'));
      child.emit('close', 0, null); child.stdout.emit('data', Buffer.from('late'));
    });
    assert.equal(JSON.stringify(record), original); assert.equal(record.remoteEffects, 'UNKNOWN');
    mock.mock.restore();
  }
});
