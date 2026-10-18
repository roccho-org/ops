import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { checkPlan } from './core.mjs';
import { bindNativeProductCaller } from './native-caller.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const owner = '11111111-1111-4111-8111-111111111111';
const source = 'a'.repeat(40);
const request = () => ({
  goal: { ref: 'g', content: 'Assess a finite synthetic sample.' },
  observations: [{ ref: 'o', content: 'A supplied synthetic observation.' }]
});
const candidate = (count = 1, needs = []) => ({
  clauses: [{ id: 'c', kind: 'obligation', ref: 'g', quote: request().goal.content }],
  questions: Array.from({ length: count }, (_, i) => ({
    id: 'q' + i, core: null, question: 'Does the finite sample satisfy the declared condition?',
    criteria: { problem: 'The supplied observation contradicts the condition.',
      ok: 'The supplied observation supports the condition.', unknown: 'The observation is insufficient.' },
    clauseIds: ['c'], basisRefs: ['g', 'o'], requiredRefs: ['o'], needs: [...needs]
  })), missing: []
});
const planFixture = (count = 1, needs = []) => checkPlan({
  schema: 'ops.goal-evaluation.plan.v2', request: request(), ...candidate(count, needs)
});
function context(t, operation = 'plan', patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semlint-native-caller-'));
  t.after(() => {
    const resolved = path.resolve(root), base = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(base) && path.basename(resolved).startsWith('semlint-native-caller-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  for (const name of ['engine', 'ssh', 'return']) fs.mkdirSync(path.join(root, name));
  const socket = path.join(root, 'control.sock');
  fs.writeFileSync(socket, 'synthetic presence only');
  const queue = [], ssh = [];
  let currentOwner = owner;
  const runtime = {
    ownerThread: () => currentOwner, now: () => Date.parse('2026-10-19T00:00:00.000Z'),
    nonce: () => '22222222-2222-4222-8222-222222222222',
    spawn: (exe, argv, options) => {
      queue.push({ exe, argv, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true; child.unref = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Queued message 33333333-3333-4333-8333-333333333333 for thread ' + owner + '.\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  };
  const options = {
    id: 'synthetic-native-product', mode: 'test-double', operation,
    runId: randomUUID(), sourceSha: source, ledgerDir: path.join(root, 'engine'),
    ssh: { sshPath: path.join(root, 'ssh.exe'), host: 'synthetic-host',
      envsSha: 'b'.repeat(40), opsSha: 'c'.repeat(40), ledgerDir: path.join(root, 'ssh') },
    ownerReturn: { codexPath: path.join(root, 'codex.exe'), endpoint: 'unix://' + socket,
      ownerThread: owner, ledgerDir: path.join(root, 'return'),
      expiresAt: '2026-10-19T00:01:00.000Z', timeoutMs: 100 },
    deadlineMs: 1000, ...patch
  };
  return { root, socket, queue, ssh, options, runtime,
    bind: () => bindNativeProductCaller(options, { ownerReturn: runtime }),
    changeOwner: value => { currentOwner = value; } };
}
function fakeSSH(t, context, response) {
  t.mock.method(childProcess, 'spawn', (exe, argv, options) => {
    const capture = { exe, argv, options, input: null };
    context.ssh.push(capture);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.pid = 12345; child.kill = () => true; child.unref = () => {};
    child.stdin = { on() {}, destroy() { this.destroyed = true; }, end(input, callback) {
      capture.input = Buffer.from(input); callback?.();
      queueMicrotask(() => {
        const supplied = response(JSON.parse(capture.input.toString('utf8')), capture, child);
        if (supplied === null) return;
        const frame = {
          schema: 'typellm.cli-response-metadata.v1', stdinComplete: true,
          stdinBytes: capture.input.length, stdinSha256: hash(capture.input),
          responseMetadataStatus: 'SDK_OBSERVATION_AVAILABLE', metadataSchema: 'typellm.response-metadata.v1',
          publicModelStatus: 'ABSENT', reportedPublicModel: null,
          responseIdStatus: 'ABSENT', providerResponseId: null, backendIdentityStatus: 'UNKNOWN'
        };
        child.stdout.emit('data', Buffer.from(JSON.stringify(supplied.body) + '\n'));
        child.stderr.emit('data', Buffer.from('TYPELLM_RESPONSE_METADATA_JSON_BEGIN\n'
          + JSON.stringify(frame) + '\nTYPELLM_RESPONSE_METADATA_JSON_END\n'));
        child.emit('close', supplied.exit ?? 0, null);
      });
    } };
    return child;
  });
}
function successfulProposal() { return { body: { result: { proposal: JSON.stringify(candidate()) } } }; }
function noticeEvent(ctx) {
  const claim = JSON.parse(fs.readFileSync(path.join(ctx.options.ownerReturn.ledgerDir,
    ctx.options.runId, 'claim.json'), 'utf8'));
  return claim;
}

test('native product caller: real Core plan terminal drives official exact-owner queue once', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const caller = ctx.bind(), result = await caller.run(request());
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.deepEqual(result.request, request());
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 1);
  const record = caller.receipts()[0], event = noticeEvent(ctx);
  assert.equal(record.outcome, 'COMPLETED');
  assert.equal(record.goalCoverage, 'NOT_CERTIFIED'); assert.equal(record.authority, false);
  assert.equal(record.utility, 'UNKNOWN'); assert.equal(record.correspondingReceipts, true);
  assert.equal(record.executorInvocations, 1); assert.equal(record.sshSpawnInvocations, 1);
  assert.equal(record.resultSha256, hash(JSON.stringify(result)));
  const actual = JSON.parse(fs.readFileSync(path.join(ctx.options.ledgerDir,
    ctx.options.runId + '.engine', 'transport.receipts.json'), 'utf8'));
  assert.equal(record.transportReceiptSha256, hash(JSON.stringify(actual)));
  assert.equal(event.schema, 'jev.product-terminal-event.v2');
  assert.equal(event.transportLifecycle, 'LOCAL_SSH_CLOSED');
  assert.equal(event.sourceSha, source); assert.equal(event.runId, ctx.options.runId);
  assert.equal(event.ownerThread, owner); assert.equal(event.resultSha256, record.resultSha256);
  assert.equal(record.returnStatus, 'QUEUED_NOT_CONSUMED');
  assert.equal(record.consumptionStatus, 'NOT_OBSERVED');
  assert.equal(ctx.queue[0].options.shell, false);
  assert.deepEqual(ctx.queue[0].argv.slice(0, 5), ['queue', '--remote', ctx.options.ownerReturn.endpoint, '--thread', owner]);
  assert.match(ctx.queue[0].argv[6], /one engine-operation terminal/);
  assert.ok(!ctx.queue[0].argv[6].includes(request().goal.content));
  assert.ok(ctx.ssh[0].argv.includes('--response-metadata'));
  for (const key of ['TYPELLM_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
    assert.equal(Object.hasOwn(ctx.ssh[0].options.env, key), false);
  await assert.rejects(caller.run(request()), /NATIVE_PRODUCT_ALREADY_CONSUMED/);
  assert.equal(ctx.queue.length, 1);
});

test('native product caller: across-factory engine claim prevents a second execution or notice', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  await ctx.bind().run(request());
  const again = ctx.bind();
  await assert.rejects(again.run(request()), /NATIVE_PRODUCT_ALREADY_CLAIMED/);
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 1);
});

test('native product caller: needs-only real judge result uses explicit zero-executor lifecycle', async t => {
  const ctx = context(t, 'judge');
  fakeSSH(t, ctx, () => { assert.fail('needs-only must not spawn SSH'); });
  const caller = ctx.bind(), result = await caller.run(planFixture(4, ['A synthetic observation remains unsupplied.']));
  assert.equal(result.calls, 0); assert.equal(result.judgments.length, 4);
  assert.ok(result.judgments.every(row => row.status === 'INCOMPLETE'));
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 1);
  const record = caller.receipts()[0], event = noticeEvent(ctx);
  assert.equal(record.outcome, 'HOLD'); assert.equal(record.incompleteCount, 4);
  assert.equal(record.latchedTransportFailure, false);
  assert.equal(record.executorInvocations, 0); assert.equal(record.transportReceiptCount, 0);
  assert.equal(event.transportLifecycle, 'NO_EXECUTOR_INVOCATION');
  assert.equal(event.physicalCloseObserved, false);
  assert.equal(record.remoteEffects, 'NOT_DISPATCHED_BY_CALLER');
});

test('native product caller: valid unknown does not latch or suppress another real judgment', async t => {
  const ctx = context(t, 'judge');
  fakeSSH(t, ctx, () => ({ body: { result: { judgment: 'unknown' } } }));
  const caller = ctx.bind(), result = await caller.run(planFixture(2));
  assert.equal(result.calls, 2);
  assert.ok(result.judgments.every(row => row.status === 'OBSERVED' && row.label === 'unknown' && row.model === 'UNKNOWN'));
  assert.equal(ctx.ssh.length, 2); assert.equal(ctx.queue.length, 1);
  assert.equal(caller.receipts()[0].latchedTransportFailure, false);
  assert.equal(caller.receipts()[0].unknownCount, 2);
  assert.equal(caller.receipts()[0].outcome, 'HOLD');
});

test('native product caller: first transport failure latches physical calls, preserving Core accounting', async t => {
  const ctx = context(t, 'judge');
  fakeSSH(t, ctx, () => ({ body: { error: 'provider_http_error', upstreamStatus: 504 }, exit: 3 }));
  const caller = ctx.bind(), result = await caller.run(planFixture(4));
  assert.equal(result.calls, 4);
  assert.ok(result.judgments.every(row => row.status === 'EXECUTION_ERROR'));
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 1);
  const record = caller.receipts()[0];
  assert.equal(record.coreLogicalCalls, 4); assert.equal(record.executorInvocations, 1);
  assert.equal(record.latchedTransportFailure, true); assert.equal(record.outcome, 'FAILED');
  assert.equal(record.physicalCloseObserved, true);
});

test('native product caller: first SDK rejection also latches without converting it into unknown', async t => {
  const ctx = context(t, 'judge');
  fakeSSH(t, ctx, () => ({ body: { result: { judgment: 'not-a-declared-label' } } }));
  const caller = ctx.bind(), result = await caller.run(planFixture(3));
  assert.equal(result.calls, 3);
  assert.ok(result.judgments.every(row => row.status === 'EXECUTION_ERROR'));
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 1);
  assert.equal(caller.receipts()[0].latchedTransportFailure, true);
  assert.equal(caller.receipts()[0].outcome, 'FAILED');
});

test('native product caller: local Core rejection preserves its error and may notify only a zero-executor failure', async t => {
  const ctx = context(t); fakeSSH(t, ctx, () => { assert.fail('invalid input must not spawn'); });
  const caller = ctx.bind();
  await assert.rejects(caller.run({ invalid: true }), /INVALID_REQUEST/);
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 1);
  const record = caller.receipts()[0], event = noticeEvent(ctx);
  assert.equal(record.resultKind, 'SAFE_ERROR_ENVELOPE');
  assert.equal(record.errorCode, 'INVALID_REQUEST');
  assert.equal(event.outcome, 'FAILED'); assert.equal(event.executorInvocations, 0);
  assert.equal(event.physicalCloseObserved, false);
});

test('native product caller: absent endpoint is a consumed return attempt with queue zero', async t => {
  const ctx = context(t, 'judge'); fs.unlinkSync(ctx.socket);
  fakeSSH(t, ctx, () => { assert.fail('needs-only must not spawn'); });
  const caller = ctx.bind(), result = await caller.run(planFixture(1, ['One synthetic need.']));
  assert.equal(result.judgments[0].status, 'INCOMPLETE');
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 0);
  assert.equal(caller.receipts()[0].returnStatus, 'HOLD_ENDPOINT_UNAVAILABLE');
  assert.equal(caller.receipts()[0].enqueueStatus, 'NOT_ATTEMPTED');
  assert.equal(caller.returnReceipts()[0].spawnInvocations, 0);
  assert.equal(caller.returnReceipts()[0].remoteEffects, 'NOT_DISPATCHED');
  assert.ok(fs.existsSync(path.join(ctx.options.ownerReturn.ledgerDir, ctx.options.runId, 'claim.json')));
  await assert.rejects(caller.run(planFixture()), /NATIVE_PRODUCT_ALREADY_CONSUMED/);
  assert.equal(ctx.queue.length, 0);
});

test('native product caller: owner mismatch blocks engine and sender without a fallback identity', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const caller = ctx.bind(); ctx.changeOwner('44444444-4444-4444-8444-444444444444');
  await assert.rejects(caller.run(request()), /OWNER_THREAD_MISMATCH/);
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 0);
  assert.equal(caller.receipts().length, 0);
});

test('native product caller: one invoked executor with missing receipt cannot be relabeled no executor', async t => {
  const ctx = context(t, 'judge');
  fs.mkdirSync(path.join(ctx.options.ssh.ledgerDir, ctx.options.runId + '.1'));
  fakeSSH(t, ctx, () => { assert.fail('pre-existing transport claim must reject before spawn'); });
  const caller = ctx.bind(), result = await caller.run(planFixture(2));
  assert.equal(result.calls, 2); assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 0);
  const record = caller.receipts()[0];
  assert.equal(record.executorInvocations, 1); assert.equal(record.transportReceiptCount, 0);
  assert.equal(record.correspondingReceipts, false); assert.equal(record.transportLifecycle, 'UNPROVED');
  assert.equal(record.returnStatus, 'NOT_SENT_OR_UNKNOWN');
  assert.equal(record.latchedTransportFailure, true);
});

test('native product caller: pending executor and unproved closure never produce a queue event', async t => {
  const ctx = context(t, 'judge', { deadlineMs: 10 });
  fakeSSH(t, ctx, () => null);
  const caller = ctx.bind(), result = await caller.run(planFixture());
  assert.equal(result.judgments[0].status, 'EXECUTION_ERROR');
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 0);
  const record = caller.receipts()[0], encoded = JSON.stringify(record);
  assert.equal(record.transportLifecycle, 'UNPROVED');
  assert.equal(record.pendingExecutors, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(JSON.stringify(record), encoded);
  assert.equal(caller.receipts()[0], record);
  assert.equal(ctx.queue.length, 0);
});

test('native product caller: default Core cap is retained and raising its caller-local cap is bounded', async t => {
  const ctx = context(t); fakeSSH(t, ctx, () => { assert.fail('default Core byte limit must reject locally'); });
  const caller = ctx.bind(), large = request(); large.goal.content += 'x'.repeat(29000);
  await assert.rejects(caller.run(large), /BYTE_LIMIT/);
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 1);
  const other = context(t);
  assert.throws(() => bindNativeProductCaller({ ...other.options, maxBytes: 65537 }, { ownerReturn: other.runtime }), /INVALID_NATIVE_PRODUCT_LIMIT/);
  assert.throws(() => bindNativeProductCaller({ ...other.options, arbitraryTerminal: {} }, { ownerReturn: other.runtime }), /INVALID_NATIVE_PRODUCT_CALLER/);
  assert.throws(() => bindNativeProductCaller({ ...other.options, mode: 'live' }, { ownerReturn: other.runtime }), /LIVE_RUNTIME_OVERRIDE/);
});

test('native product caller: final receipt IO failure is visible without replacing the actual result', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const caller = ctx.bind(), originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'receipt.json')) {
      const error = new Error('synthetic IO'); error.code = 'ENOSPC'; throw error;
    }
    return originalWrite.call(this, file, ...args);
  });
  const result = await caller.run(request());
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.equal(caller.receipts()[0].receiptWriteFailed, true);
  assert.equal(ctx.queue.length, 1);
});
