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


test('native product artifact: actual result is regular, byte-exact and readable before queue', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const queueSpawn = ctx.runtime.spawn;
  let observedBeforeQueue = false, saved;
  ctx.runtime.spawn = (exe, argv, options) => {
    const file = path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'engine.result.json');
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    saved = fs.readFileSync(file);
    assert.ok(saved.toString('utf8').endsWith('\n'));
    assert.ok(!argv[6].includes(request().goal.content));
    assert.ok(!argv[6].includes(file));
    observedBeforeQueue = true;
    return queueSpawn(exe, argv, options);
  };
  const caller = ctx.bind(), result = await caller.run(request()), record = caller.receipts()[0];
  assert.equal(observedBeforeQueue, true);
  assert.deepEqual(JSON.parse(saved.toString('utf8')), result);
  assert.ok(saved.equals(Buffer.from(JSON.stringify(result) + '\n')));
  assert.equal(record.resultSha256, hash(JSON.stringify(result)));
  assert.equal(record.resultArtifactBasename, 'engine.result.json');
  assert.equal(record.resultArtifactSha256, hash(saved));
  assert.equal(record.resultArtifactBytes, saved.length);
  assert.equal(record.resultArtifactStatus, 'VERIFIED_READBACK');
  assert.equal(record.resultArtifactErrorCode, null);
  assert.equal(noticeEvent(ctx).resultSha256, record.resultSha256);
  assert.equal(ctx.queue.length, 1);
});

test('native product artifact: write failure suppresses queue and preserves successful engine value', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'engine.result.json'))
      throw new Error('synthetic result artifact write failure');
    return originalWrite.call(this, file, ...args);
  });
  const caller = ctx.bind(), result = await caller.run(request()), record = caller.receipts()[0];
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.deepEqual(result.request, request());
  assert.equal(ctx.queue.length, 0);
  assert.equal(record.resultArtifactStatus, 'NOT_VERIFIED');
  assert.equal(record.resultArtifactSha256, null);
  assert.equal(record.resultArtifactErrorCode, 'NATIVE_RESULT_ARTIFACT_NOT_VERIFIED');
  assert.equal(record.returnStatus, 'NOT_SENT_OR_UNKNOWN');
});

test('native product artifact: write failure never replaces original Core error', async t => {
  const ctx = context(t); fakeSSH(t, ctx, () => { assert.fail('invalid Core input'); });
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'engine.result.json'))
      throw new Error('synthetic artifact error must not replace Core error');
    return originalWrite.call(this, file, ...args);
  });
  const caller = ctx.bind();
  await assert.rejects(caller.run({ invalid: true }), /INVALID_REQUEST/);
  assert.equal(ctx.queue.length, 0); assert.equal(ctx.ssh.length, 0);
  assert.equal(caller.receipts()[0].errorCode, 'INVALID_REQUEST');
  assert.equal(caller.receipts()[0].resultKind, 'SAFE_ERROR_ENVELOPE');
  assert.equal(caller.receipts()[0].resultArtifactStatus, 'NOT_VERIFIED');
});

test('native product artifact: readback mismatch suppresses queue and retains partial artifact', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const file = path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'engine.result.json');
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (candidateFile, ...args) {
    const actual = originalRead.call(this, candidateFile, ...args);
    if (candidateFile === file) {
      const altered = Buffer.from(actual); altered[0] ^= 1; return altered;
    }
    return actual;
  });
  const caller = ctx.bind(), result = await caller.run(request()), record = caller.receipts()[0];
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.equal(ctx.queue.length, 0);
  assert.equal(record.resultArtifactStatus, 'NOT_VERIFIED');
  assert.equal(record.resultArtifactSha256, null);
  assert.equal(record.returnStatus, 'NOT_SENT_OR_UNKNOWN');
  assert.ok(originalRead(file).equals(Buffer.from(JSON.stringify(result) + '\n')));
});

test('native product artifact: regular-file identity is required before queue', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  const file = path.join(ctx.options.ledgerDir, ctx.options.runId + '.engine', 'engine.result.json');
  const originalStat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (candidateFile, ...args) {
    const actual = originalStat.call(this, candidateFile, ...args);
    return candidateFile === file ? { size: actual.size, isFile: () => false, isSymbolicLink: () => false } : actual;
  });
  const caller = ctx.bind(), result = await caller.run(request());
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.equal(ctx.queue.length, 0);
  assert.equal(caller.receipts()[0].resultArtifactStatus, 'NOT_VERIFIED');
  assert.equal(caller.receipts()[0].resultArtifactErrorCode, 'NATIVE_RESULT_ARTIFACT_NOT_VERIFIED');
});

test('native product expiry: delivery expiry does not replace a legitimate engine value', async t => {
  const ctx = context(t); fakeSSH(t, ctx, successfulProposal);
  ctx.runtime.now = () => Date.parse('2026-10-19T00:02:00.000Z');
  const caller = ctx.bind(), result = await caller.run(request()), record = caller.receipts()[0];
  assert.equal(result.schema, 'ops.goal-evaluation.plan.v2');
  assert.equal(ctx.ssh.length, 1); assert.equal(ctx.queue.length, 0);
  assert.equal(record.resultArtifactStatus, 'VERIFIED_READBACK');
  assert.equal(record.returnStatus, 'NOT_SENT_OR_UNKNOWN');
  assert.equal(record.resultSha256, hash(JSON.stringify(result)));
});

test('native product expiry: delivery expiry preserves original Core error and safe error artifact', async t => {
  const ctx = context(t); fakeSSH(t, ctx, () => { assert.fail('invalid Core input'); });
  ctx.runtime.now = () => Date.parse('2026-10-19T00:02:00.000Z');
  const caller = ctx.bind();
  await assert.rejects(caller.run({ invalid: true }), /INVALID_REQUEST/);
  assert.equal(ctx.ssh.length, 0); assert.equal(ctx.queue.length, 0);
  const record = caller.receipts()[0];
  assert.equal(record.resultArtifactStatus, 'VERIFIED_READBACK');
  assert.equal(record.resultKind, 'SAFE_ERROR_ENVELOPE');
  assert.equal(record.errorCode, 'INVALID_REQUEST');
  const artifact = JSON.parse(fs.readFileSync(path.join(ctx.options.ledgerDir,
    ctx.options.runId + '.engine', 'engine.result.json'), 'utf8'));
  assert.deepEqual(artifact, { schema: 'ops.native-product-error.v1', errorCode: 'INVALID_REQUEST' });
  assert.equal(record.resultSha256, hash(JSON.stringify(artifact)));
});


test('explicit host caller saves actual needs-only result before any typed command', async t => {
  const c = context(t, 'judge');
  c.options.ownerReturn = { transport: 'host-mcp', hostId: 'local', ownerThread: owner,
    ledgerDir: path.join(c.root, 'return'), expiresAt: '2026-10-19T00:01:00.000Z', timeoutMs: 100 };
  t.mock.method(childProcess, 'spawn', () => { throw new Error('NO_SSH_ALLOWED'); });
  const caller = c.bind(), value = await caller.run(planFixture(1, ['synthetic unfilled need']));
  assert.equal(value.calls, 0); assert.equal(value.judgments[0].status, 'INCOMPLETE');
  const engine = caller.receipts()[0], file = path.join(c.options.ledgerDir, c.options.runId + '.engine', 'engine.result.json');
  const saved = fs.readFileSync(file);
  assert.equal(hash(saved), engine.resultArtifactSha256);
  assert.deepEqual(JSON.parse(saved.toString('utf8')), value);
  const status = caller.takeHostCommand(); assert.equal(status.kind, 'OBSERVE_OWNER_STATUS');
  assert.equal(c.queue.length, 0); assert.equal(engine.executorInvocations, 0);
  const observedAt = '2026-10-19T00:00:00.000Z';
  caller.acceptHostObservation(status.commandId, { schema: 'jev.host-owner-status.v1', ownerThread: owner,
    hostId: 'local', status: 'idle', observedAt, statusMeaning: 'RUNTIME_TURN_STATUS' });
  const send = caller.takeHostCommand(); assert.equal(send.arguments.threadId, owner);
  assert.ok(send.arguments.prompt.includes(engine.resultSha256));
  assert.ok(!send.arguments.prompt.includes('synthetic unfilled need'));
  caller.acceptHostSendResult(send.commandId, { schema: 'jev.host-owner-send-observation.v1',
    ownerThread: owner, hostId: 'local', status: 'acknowledged', observedAt });
  assert.equal(caller.returnReceipts().at(-1).consumptionStatus, 'NOT_OBSERVED');
  assert.equal(caller.returnReceipts().at(-1).status, 'HOST_ACK_REPORTED_NOT_CONSUMED');
});

test('host caller retains original engine error and creates a bound safe artifact', async t => {
  const c = context(t, 'judge');
  c.options.ownerReturn = { transport: 'host-mcp', hostId: 'local', ownerThread: owner,
    ledgerDir: path.join(c.root, 'return'), expiresAt: '2026-10-19T00:01:00.000Z', timeoutMs: 100 };
  const caller = c.bind(); let original;
  await assert.rejects(caller.run({}), error => { original = error; return error instanceof Error; });
  assert.ok(original); const engine = caller.receipts()[0];
  assert.equal(engine.operationStatus, 'REJECTED');
  assert.equal(engine.resultArtifactStatus, 'VERIFIED_READBACK');
  assert.equal(engine.resultKind, 'SAFE_ERROR_ENVELOPE');
  assert.equal(caller.takeHostCommand().kind, 'OBSERVE_OWNER_STATUS');
  assert.equal(c.queue.length, 0);
});

test('host caller artifact write failure prevents commands while preserving needs-only engine result', async t => {
  const c = context(t, 'judge');
  c.options.ownerReturn = { transport: 'host-mcp', hostId: 'local', ownerThread: owner,
    ledgerDir: path.join(c.root, 'return'), expiresAt: '2026-10-19T00:01:00.000Z', timeoutMs: 100 };
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('engine.result.json')) throw new Error('synthetic artifact I/O');
    return originalWrite(file, ...args);
  });
  const caller = c.bind(), value = await caller.run(planFixture(1, ['synthetic missing']));
  assert.equal(value.judgments[0].status, 'INCOMPLETE');
  assert.equal(caller.takeHostCommand(), null);
  assert.equal(caller.returnReceipts().at(-1).status, 'NOT_SENT_OR_UNKNOWN');
  assert.equal(c.queue.length, 0);
});

import { runFiniteNativeHostBridge, readFiniteNativeHostCommand, submitFiniteNativeHostToolResult } from './native-caller.mjs';

function finiteBridgeFixture(t, patch = {}) {
  const c = context(t, 'judge');
  const packetDir = path.join(c.root, 'packets'); fs.mkdirSync(packetDir);
  c.runtime.now = Date.now;
  c.options.ownerReturn = { transport: 'host-mcp', hostId: 'local', ownerThread: owner,
    ledgerDir: path.join(c.root, 'return'), expiresAt: new Date(Date.now() + 120000).toISOString(),
    timeoutMs: 30000, exchangeTimeoutMs: 1000, statusListLimit: 50, ...patch };
  const config = { callerOptions: c.options, packetDir };
  const dir = path.join(packetDir, c.options.runId + '.bridge');
  const packetOptions = phase => ({ packetDir, runId: c.options.runId, phase });
  return { ...c, packetDir, config, dir, packetOptions,
    run: (value = planFixture(1, ['synthetic missing evidence'])) =>
      runFiniteNativeHostBridge(config, value, { ownerReturn: c.runtime }) };
}
function finiteListResult(status = 'idle', rowPatch = {}, extra = []) {
  return { content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1,
    sidebarPreferences: {}, untrustedDataNotice: 'synthetic', pinnedThreads: [],
    threads: [{ id: owner, hostId: 'local', status, title: 'must not be projected', ...rowPatch }, ...extra],
    sections: [], unavailableHosts: [], unavailableSources: [] }) }], isError: false };
}
function finiteDriver(t, c, handle) {
  const errors = [], seen = new Set(); let inner;
  const check = () => {
    try {
      if (!inner && fs.existsSync(c.dir)) inner = fs.watch(c.dir, check);
      for (const phase of [1, 2]) {
        if (seen.has(phase) || !fs.existsSync(path.join(c.dir, 'phase-' + phase + '.command.json'))) continue;
        seen.add(phase);
        const packet = readFiniteNativeHostCommand(c.packetOptions(phase));
        Promise.resolve().then(() => handle(packet, phase)).catch(error => errors.push(error));
      }
    } catch (error) { errors.push(error); }
  };
  const outer = fs.watch(c.packetDir, check);
  t.after(() => { outer.close(); inner?.close(); });
  return { errors, seen };
}
function submitFiniteSynthetic(c, phase, result) {
  const at = new Date().toISOString();
  return submitFiniteNativeHostToolResult({ ...c.packetOptions(phase), toolStartedAt: at, toolCompletedAt: at }, result);
}
function finiteReceipt(c) { return JSON.parse(fs.readFileSync(path.join(c.dir, 'receipt.json'), 'utf8')); }

test('finite native bridge owns needs-only terminal artifact before its two packet commands', async t => {
  const c = finiteBridgeFixture(t), originals = [];
  t.mock.method(childProcess, 'spawn', () => { throw new Error('external child forbidden'); });
  const driver = finiteDriver(t, c, (packet, phase) => {
    const engineDir = path.join(c.options.ledgerDir, c.options.runId + '.engine');
    const terminal = JSON.parse(fs.readFileSync(path.join(engineDir, 'terminal.json'), 'utf8'));
    const original = fs.readFileSync(path.join(engineDir, 'engine.result.json'));
    assert.equal(hash(original), terminal.resultArtifactSha256);
    originals.push(original);
    assert.equal(packet.command.arguments.model, undefined);
    assert.equal(packet.command.arguments.thinking, undefined);
    assert.equal(packet.command.commandId, c.options.runId + '/host-return/' + phase);
    assert.equal(packet.runtimeSampledAt, undefined);
    submitFiniteSynthetic(c, phase, phase === 1 ? finiteListResult() : { content: [], isError: false });
  });
  const result = await c.run();
  assert.deepEqual(driver.errors, []); assert.deepEqual([...driver.seen], [1, 2]);
  assert.equal(result.judgments[0].status, 'INCOMPLETE');
  assert.equal(originals.length, 2); assert.ok(originals[0].equals(originals[1]));
  const record = finiteReceipt(c);
  assert.equal(record.phases, 2); assert.equal(record.status, 'HOLD');
  assert.equal(record.errorCode, 'HOST_SEND_UNKNOWN');
  assert.equal(record.consumptionStatus, 'NOT_OBSERVED'); assert.equal(record.runtimeSampledAt, null);
  assert.equal(record.remoteEffects, 'UNKNOWN');
  const observation = JSON.parse(fs.readFileSync(path.join(c.dir, 'phase-1.observation.json'), 'utf8'));
  assert.equal(observation.runtimeSampledAt, null);
  assert.equal(observation.classification, 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL');
  assert.equal(JSON.stringify(observation).includes('must not be projected'), false);
  assert.equal(c.queue.length, 0); assert.equal(c.ssh.length, 0);
});

test('finite native bridge rejects active, absent host, duplicate identity and oversized normal tool results', async t => {
  for (const kind of ['active', 'host-missing', 'duplicate', 'oversize']) {
    const c = finiteBridgeFixture(t);
    const driver = finiteDriver(t, c, (_packet, phase) => {
      let response = finiteListResult();
      if (kind === 'active') response = finiteListResult('active');
      if (kind === 'host-missing') response = finiteListResult('idle', { hostId: null });
      if (kind === 'duplicate') response = finiteListResult('idle', {}, [{ id: owner, hostId: 'local', status: 'idle' }]);
      if (kind === 'oversize') response = { content: [{ type: 'text', text: 'x'.repeat(262145) }], isError: false };
      submitFiniteSynthetic(c, phase, response);
    });
    const result = await c.run();
    assert.equal(result.judgments[0].status, 'INCOMPLETE'); assert.deepEqual(driver.errors, []);
    assert.deepEqual([...driver.seen], [1]);
    assert.equal(finiteReceipt(c).errorCode, 'OWNER_IDLE_NOT_ESTABLISHED');
    assert.equal(fs.existsSync(path.join(c.dir, 'phase-2.command.json')), false);
  }
});

test('finite native bridge packet identity is closed and a malformed input is never retried', async t => {
  for (const change of ['nonce', 'sourceSha', 'commandSha256', 'extra', 'partial']) {
    const c = finiteBridgeFixture(t);
    const driver = finiteDriver(t, c, (packet, phase) => {
      const { command, schema, ...identity } = packet;
      const at = new Date().toISOString();
      const observation = { schema: 'ops.native-host-observation.v1', ...identity,
        toolStartedAt: at, toolCompletedAt: at, runtimeSampledAt: null, toolResultBytes: 2,
        toolResultSha256: hash('{}'), classification: 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL',
        observation: { schema: 'jev.host-owner-status.v1', ownerThread: owner, hostId: 'local',
          status: 'idle', observedAt: at, statusMeaning: 'RUNTIME_TURN_STATUS' } };
      if (change === 'nonce') observation.nonce = randomUUID();
      if (change === 'sourceSha') observation.sourceSha = 'e'.repeat(40);
      if (change === 'commandSha256') observation.commandSha256 = 'e'.repeat(64);
      if (change === 'extra') observation.unexpected = true;
      fs.writeFileSync(path.join(c.dir, 'phase-' + phase + '.observation.json'),
        change === 'partial' ? '{' : JSON.stringify(observation) + '\n', { flag: 'wx', mode: 0o600 });
    });
    await c.run(); assert.deepEqual(driver.errors, []);
    assert.equal(finiteReceipt(c).status, 'HOLD'); assert.equal(finiteReceipt(c).phases, 1);
    assert.equal(fs.existsSync(path.join(c.dir, 'phase-2.command.json')), false);
  }
});

test('finite bridge timeout closes its watch and late packets cannot mutate the original receipt', async t => {
  const c = finiteBridgeFixture(t, { exchangeTimeoutMs: 25 });
  const originalWatch = fs.watch, watchers = [];
  t.mock.method(fs, 'watch', (...args) => {
    const watcher = originalWatch(...args), close = watcher.close.bind(watcher), row = { closed: false };
    watcher.close = () => { row.closed = true; return close(); }; watchers.push(row); return watcher;
  });
  const result = await c.run();
  assert.equal(result.judgments[0].status, 'INCOMPLETE');
  const before = fs.readFileSync(path.join(c.dir, 'receipt.json'));
  assert.equal(finiteReceipt(c).errorCode, 'HOST_EXCHANGE_TIMEOUT');
  assert.ok(watchers.length > 0 && watchers.every(row => row.closed));
  assert.doesNotThrow(() => submitFiniteSynthetic(c, 1, finiteListResult()));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(fs.readFileSync(path.join(c.dir, 'receipt.json')).equals(before));
});

test('finite bridge rejects early phase inputs and preserves the valid engine result', async t => {
  const c = finiteBridgeFixture(t), mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, ...args) => {
    const result = mkdir(dir, ...args);
    if (dir === c.dir) fs.writeFileSync(path.join(dir, 'phase-2.observation.json'), '{}\n', { flag: 'wx' });
    return result;
  });
  const value = await c.run();
  assert.equal(value.judgments[0].status, 'INCOMPLETE');
  assert.equal(finiteReceipt(c).errorCode, 'HOST_PACKET_INVALID'); assert.equal(finiteReceipt(c).phases, 0);
});

test('finite bridge handles artifact failure and original engine errors without inventing a result', async t => {
  const c = finiteBridgeFixture(t);
  const driver = finiteDriver(t, c, (_packet, phase) => submitFiniteSynthetic(c, phase, finiteListResult('active')));
  await assert.rejects(c.run({}), /INVALID_PLAN/);
  assert.deepEqual(driver.errors, []);
  assert.equal(finiteReceipt(c).status, 'HOLD');
  const envelope = JSON.parse(fs.readFileSync(path.join(c.options.ledgerDir, c.options.runId + '.engine', 'engine.result.json'), 'utf8'));
  assert.equal(envelope.schema, 'ops.native-product-error.v1');
  const failed = finiteBridgeFixture(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('engine.result.json')) throw new Error('synthetic I/O');
    return write(file, ...args);
  });
  const value = await failed.run(); assert.equal(value.judgments[0].status, 'INCOMPLETE');
  assert.equal(finiteReceipt(failed).phases, 0);
  assert.equal(fs.existsSync(path.join(failed.dir, 'phase-1.command.json')), false);
});

test('finite bridge publication and duplicate responses are exclusive with no copy fallback', async t => {
  const c = finiteBridgeFixture(t);
  const driver = finiteDriver(t, c, (_packet, phase) => {
    submitFiniteSynthetic(c, phase, finiteListResult('active'));
    assert.throws(() => submitFiniteSynthetic(c, phase, finiteListResult()), /EEXIST/);
    const complete = fs.lstatSync(path.join(c.dir, 'phase-1.observation.json'));
    const pending = fs.lstatSync(path.join(c.dir, 'phase-1.observation.json.pending'));
    assert.equal(complete.ino, pending.ino); assert.ok(complete.isFile() && !complete.isSymbolicLink());
  });
  await c.run(); assert.deepEqual(driver.errors, []); assert.equal(finiteReceipt(c).phases, 1);
  await assert.rejects(c.run(), /EEXIST/);
  const forbidden = finiteBridgeFixture(t);
  assert.throws(() => readFiniteNativeHostCommand({ ...forbidden.packetOptions(1), phase: 3 }), /INVALID_NATIVE_HOST_PACKET/);
  await assert.rejects(runFiniteNativeHostBridge({ ...forbidden.config,
    callerOptions: { ...forbidden.options, mode: 'live' } }, {}, { ownerReturn: forbidden.runtime }), /LIVE_RUNTIME_OVERRIDE/);
});

test('finite bridge clamps phase2 to the receiver observation origin across a measured 7ms issue gap', async t => {
  const c = finiteBridgeFixture(t, { exchangeTimeoutMs: 30010 }), origin = Date.now();
  let clock = origin, phase1Expires;
  c.runtime.now = () => clock;
  t.mock.method(Date, 'now', () => clock);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    const returned = write(file, ...args);
    if (String(file).endsWith('host-status.command.json')) clock += 7;
    return returned;
  });
  const driver = finiteDriver(t, c, (packet, phase) => {
    const startedAt = new Date(clock).toISOString();
    if (phase === 1) {
      phase1Expires = Date.parse(packet.commandExpiresAt);
      assert.equal(phase1Expires, origin + 30007);
      submitFiniteNativeHostToolResult({ ...c.packetOptions(phase),
        toolStartedAt: startedAt, toolCompletedAt: startedAt }, finiteListResult());
    } else {
      assert.equal(Date.parse(packet.commandExpiresAt), origin + 30000);
      assert.equal(phase1Expires - Date.parse(packet.commandExpiresAt), 7);
      assert.doesNotThrow(() => readFiniteNativeHostCommand(c.packetOptions(phase)));
      clock = origin + 30000;
      // The driver cannot begin another tool call in the old extra 7ms window.
      assert.throws(() => readFiniteNativeHostCommand(c.packetOptions(phase)), /NATIVE_HOST_PACKET_EXPIRED/);
      // A tool already started inside the bound may complete later; no new tool is invoked here.
      submitFiniteNativeHostToolResult({ ...c.packetOptions(phase), toolStartedAt: startedAt,
        toolCompletedAt: new Date(clock).toISOString() }, { content: [], isError: false });
    }
  });
  const result = await c.run();
  assert.equal(result.judgments[0].status, 'INCOMPLETE'); assert.deepEqual(driver.errors, []);
  assert.deepEqual([...driver.seen], [1, 2]);
  assert.equal(finiteReceipt(c).consumptionStatus, 'NOT_OBSERVED');
  assert.equal(c.queue.length, 0); assert.equal(c.ssh.length, 0);
});

import { fileURLToPath } from 'node:url';
import { projectFiniteHostToolResultForDriver, submitFiniteNativeHostProjection,
  awaitFiniteNativeHostCommand } from './native-caller.mjs';

function projectedBridgeFixture(t, patch = {}) {
  const c = finiteBridgeFixture(t, patch);
  c.config.observationFormat = 'projection-v2';
  return c;
}
function submitProjectedSynthetic(c, phase, response) {
  const at = new Date().toISOString();
  return submitFiniteNativeHostProjection({ ...c.packetOptions(phase), toolStartedAt: at, toolCompletedAt: at },
    projectFiniteHostToolResultForDriver(response, owner, phase));
}

test('functions projection measures only its reported canonical wrapper and never returns host body text', () => {
  const doc = fs.readFileSync(new URL('./native-caller.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(projectFiniteHostToolResultForDriver.toString()));
  for (const text of ['ASCII', '日本語', 'emoji 😀', '\ud800']) {
    const response = finiteListResult('idle', { title: text });
    const projected = projectFiniteHostToolResultForDriver(response, owner, 1);
    const canonical = JSON.stringify(response);
    assert.equal(projected.status, 'idle');
    assert.equal(projected.reportedRawJsonBytes, Buffer.byteLength(canonical));
    assert.equal(projected.reportedRawJsonUnits, canonical.length);
    assert.equal(projected.rawSizeStatus, 'WITHIN_REPORTED_BOUND');
    assert.equal(Object.hasOwn(projected, 'rawToolResultSha256'), false);
    assert.deepEqual(Object.keys(projected), ['schema', 'status', 'classification',
      'reportedRawJsonBytes', 'reportedRawJsonUnits', 'rawSizeStatus']);
  }
  let getters = 0;
  const response = { isError: false };
  Object.defineProperty(response, 'content', { enumerable: true, get() { getters++; throw new Error('not read'); } });
  assert.equal(projectFiniteHostToolResultForDriver(response, owner, 1).status, 'unknown');
  assert.equal(getters, 0);
  assert.equal(projectFiniteHostToolResultForDriver({ content: [], isError: false }, owner, 2).classification,
    'SEND_ACK_CONTRACT_UNKNOWN');
  assert.equal(projectFiniteHostToolResultForDriver({ isError: true }, owner, 2).status, 'failed');
});

test('functions projection fails closed on identity, schema, entry and reported size boundaries', () => {
  for (const response of [finiteListResult('idle', { hostId: undefined }),
    finiteListResult('idle', {}, [{ id: owner, hostId: 'local', status: 'idle' }]),
    finiteListResult('arbitrary'), { ...finiteListResult(), extra: true },
    { content: [{ type: 'text', text: '{' }], isError: false },
    finiteListResult('idle', {}, Array.from({ length: 1000 }, () => ({ id: 'other' })))]) {
    assert.equal(projectFiniteHostToolResultForDriver(response, owner, 1).status, 'unknown');
  }
  for (const text of ['x'.repeat(262145), '漢'.repeat(100000)]) {
    const projected = projectFiniteHostToolResultForDriver({ content: [{ type: 'text', text }], isError: false }, owner, 1);
    assert.equal(projected.status, 'unknown'); assert.equal(projected.rawSizeStatus, 'OVER_REPORTED_BOUND');
    assert.equal(projected.reportedRawJsonBytes, null);
  }
  assert.equal(projectFiniteHostToolResultForDriver(finiteListResult('active'), owner, 1).status, 'active');
});

test('projection v2 owns exact projection hashes, keeps raw identity unknown and preserves the engine artifact', async t => {
  const c = projectedBridgeFixture(t), projections = [];
  t.mock.method(childProcess, 'spawn', () => { throw new Error('no external transport'); });
  const driver = finiteDriver(t, c, (packet, phase) => {
    assert.throws(() => submitFiniteSynthetic(c, phase, finiteListResult()), /INVALID_NATIVE_HOST_PACKET/);
    const projected = projectFiniteHostToolResultForDriver(phase === 1 ? finiteListResult() : { isError: false }, owner, phase);
    const at = new Date().toISOString();
    const out = submitFiniteNativeHostProjection({ ...c.packetOptions(phase), toolStartedAt: at, toolCompletedAt: at }, projected);
    projections.push(projected);
    assert.equal(out.projectionSha256, hash(JSON.stringify(projected) + '\n'));
    assert.equal(out.rawToolResultSha256, null);
    assert.equal(packet.command.arguments.model, undefined);
  });
  const result = await c.run();
  assert.equal(result.judgments[0].status, 'INCOMPLETE'); assert.deepEqual(driver.errors, []);
  assert.deepEqual([...driver.seen], [1, 2]);
  const binding = JSON.parse(fs.readFileSync(path.join(c.dir, 'binding.json')));
  assert.equal(binding.schema, 'ops.native-host-bridge.v2');
  assert.equal(binding.bindingSha256, hash(JSON.stringify({ callerBindingSha256: binding.callerBindingSha256,
    observationFormat: 'projection-v2' })));
  const bytes = fs.readFileSync(path.join(c.dir, 'phase-1.observation.json'));
  const observed = JSON.parse(bytes);
  assert.equal(observed.schema, 'ops.native-host-observation.v2');
  assert.equal(observed.projectionBytes, Buffer.byteLength(JSON.stringify(projections[0]) + '\n'));
  assert.equal(observed.projectionSha256, hash(JSON.stringify(projections[0]) + '\n'));
  assert.equal(observed.rawToolResultSha256, null);
  assert.equal(observed.rawIdentityStatus, 'NOT_OBSERVED_BY_NATIVE');
  assert.equal(bytes.includes(Buffer.from('must not be projected')), false);
  assert.equal(finiteReceipt(c).errorCode, 'HOST_SEND_UNKNOWN');
  assert.equal(finiteReceipt(c).rawToolResultSha256, null);
  assert.equal(finiteReceipt(c).consumptionStatus, 'NOT_OBSERVED');
  assert.equal(c.ssh.length, 0); assert.equal(c.queue.length, 0);
});

test('raw v1 and projection v2 bindings cannot be interchanged by a driver', async t => {
  const c = finiteBridgeFixture(t);
  const driver = finiteDriver(t, c, (_packet, phase) => {
    assert.throws(() => submitProjectedSynthetic(c, phase, finiteListResult()), /INVALID_NATIVE_HOST_PACKET/);
    submitFiniteSynthetic(c, phase, finiteListResult('active'));
  });
  await c.run(); assert.deepEqual(driver.errors, []);
  const binding = JSON.parse(fs.readFileSync(path.join(c.dir, 'binding.json')));
  assert.equal(binding.schema, 'ops.native-host-bridge.v1');
  assert.equal(Object.hasOwn(binding, 'observationFormat'), false);
  assert.equal(Object.hasOwn(finiteReceipt(c), 'rawToolResultSha256'), false);
});

test('projection v2 rejects tampered hashes, raw identity claims and packet identities without a second command', async t => {
  for (const change of ['hash', 'raw', 'nonce', 'extra']) {
    const c = projectedBridgeFixture(t);
    const driver = finiteDriver(t, c, (packet, phase) => {
      const { command, schema, ...identity } = packet, at = new Date().toISOString();
      const projection = projectFiniteHostToolResultForDriver(finiteListResult(), owner, phase);
      const observed = { schema: 'ops.native-host-observation.v2', ...identity,
        toolStartedAt: at, toolCompletedAt: at, runtimeSampledAt: null,
        rawToolResultSha256: null, rawIdentityStatus: 'NOT_OBSERVED_BY_NATIVE',
        projectionBytes: Buffer.byteLength(JSON.stringify(projection) + '\n'),
        projectionSha256: hash(JSON.stringify(projection) + '\n'), projection };
      if (change === 'hash') observed.projectionSha256 = '0'.repeat(64);
      if (change === 'raw') observed.rawToolResultSha256 = '0'.repeat(64);
      if (change === 'nonce') observed.nonce = randomUUID();
      if (change === 'extra') observed.extra = true;
      fs.writeFileSync(path.join(c.dir, 'phase-1.observation.json'), JSON.stringify(observed) + '\n', { flag: 'wx' });
    });
    await c.run(); assert.deepEqual(driver.errors, []);
    assert.equal(finiteReceipt(c).errorCode, 'HOST_PACKET_INVALID');
    assert.equal(finiteReceipt(c).phases, 1);
  }
});

test('one-shot command readiness arms before checking, closes its watch and returns a fixed terminal summary', async t => {
  const c = projectedBridgeFixture(t), run = c.run();
  const original = fs.watch, watchers = [];
  t.mock.method(fs, 'watch', (...args) => {
    const watcher = original(...args), close = watcher.close.bind(watcher), row = { closed: false };
    watcher.close = () => { row.closed = true; return close(); }; watchers.push(row); return watcher;
  });
  const ready = await awaitFiniteNativeHostCommand({ ...c.packetOptions(1), waitMs: 1000 });
  assert.equal(ready.kind, 'COMMAND'); assert.equal(ready.packet.phase, 1);
  submitProjectedSynthetic(c, 1, finiteListResult('active'));
  await run;
  const terminal = await awaitFiniteNativeHostCommand({ ...c.packetOptions(2), waitMs: 1000 });
  assert.deepEqual(terminal, { kind: 'TERMINAL', status: 'HOLD', consumptionStatus: 'NOT_OBSERVED' });
  assert.ok(watchers.length >= 2 && watchers.every(row => row.closed));
});

test('one-shot readiness rejects timeout and terminal identity tampering without exposing receipt strings', async t => {
  const c = projectedBridgeFixture(t, { exchangeTimeoutMs: 30 }), run = c.run();
  await assert.rejects(awaitFiniteNativeHostCommand({ ...c.packetOptions(2), waitMs: 5 }), /HOST_EXCHANGE_TIMEOUT/);
  await run;
  const file = path.join(c.dir, 'receipt.json'), receipt = JSON.parse(fs.readFileSync(file));
  receipt.ownerThread = randomUUID(); receipt.errorCode = 'private arbitrary string';
  fs.writeFileSync(file, JSON.stringify(receipt) + '\n'); // Synthetic corruption only.
  await assert.rejects(awaitFiniteNativeHostCommand({ ...c.packetOptions(2), waitMs: 10 }), /INVALID_NATIVE_HOST_PACKET/);
});

test('closed ordinary-Node helper transports only bounded scalar projection arguments', async t => {
  const c = projectedBridgeFixture(t);
  const modulePath = fileURLToPath(new URL('./native-caller.mjs', import.meta.url));
  const invoke = args => childProcess.spawnSync(process.execPath, [modulePath, ...args],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  const common = phase => ['--packet-dir', c.packetDir, '--run-id', c.options.runId, '--phase', String(phase)];
  const driver = finiteDriver(t, c, (_packet, phase) => {
    const ready = invoke(['host-command', ...common(phase), '--wait-ms', '100']);
    assert.equal(ready.status, 0); assert.equal(ready.stderr, '');
    assert.equal(JSON.parse(ready.stdout).output.kind, 'COMMAND');
    const projection = projectFiniteHostToolResultForDriver(finiteListResult('active'), owner, phase);
    const at = new Date().toISOString();
    const supplied = invoke(['host-observe-projection', ...common(phase), '--started-at', at, '--completed-at', at,
      '--status', projection.status, '--classification', projection.classification,
      '--raw-bytes', String(projection.reportedRawJsonBytes), '--raw-units', String(projection.reportedRawJsonUnits),
      '--raw-size', projection.rawSizeStatus]);
    assert.equal(supplied.status, 0); assert.equal(supplied.stderr, '');
    assert.equal(JSON.parse(supplied.stdout).output.rawToolResultSha256, null);
    assert.equal(supplied.stdout.includes('must not be projected'), false);
  });
  await c.run(); assert.deepEqual(driver.errors, []); assert.deepEqual([...driver.seen], [1]);
  for (const args of [['unknown'], ['host-command', ...common(1), '--wait-ms', '100', '--extra', 'secret'],
    ['host-command', ...common(1), '--wait-ms', '100', '--wait-ms', '100'],
    ['host-command', ...common(1), '--wait-ms', '9'.repeat(9000)]]) {
    const bad = invoke(args);
    assert.equal(bad.status, 2); assert.equal(bad.stderr, '');
    assert.deepEqual(JSON.parse(bad.stdout), { schema: 'ops.native-host-cli.v1', status: 'HOLD', errorCode: 'HOST_HELPER_FAILED' });
  }
});

test('projection CLI rejects a raw-v1 binding before exposing its otherwise valid command', async t => {
  const c = finiteBridgeFixture(t, { exchangeTimeoutMs: 10000 });
  const modulePath = fileURLToPath(new URL('./native-caller.mjs', import.meta.url));
  const driver = finiteDriver(t, c, (_packet, phase) => {
    const child = childProcess.spawnSync(process.execPath, [modulePath, 'host-command',
      '--packet-dir', c.packetDir, '--run-id', c.options.runId, '--phase', String(phase), '--wait-ms', '100'],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
    assert.equal(child.status, 2); assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { schema: 'ops.native-host-cli.v1', status: 'HOLD', errorCode: 'HOST_HELPER_FAILED' });
    // The old exported API still reads valid raw-v1 packets. No host tool is called.
    assert.equal(readFiniteNativeHostCommand(c.packetOptions(phase)).phase, phase);
    submitFiniteSynthetic(c, phase, finiteListResult('active'));
  });
  await c.run(); assert.deepEqual(driver.errors, []); assert.deepEqual([...driver.seen], [1]);
});

test('projection CLI emits complete 8192-byte success or fixed HOLD at 8193 bytes without leaking a prefix', async t => {
  const c = projectedBridgeFixture(t, { exchangeTimeoutMs: 10000 });
  const driver = finiteDriver(t, c, (_packet, phase) =>
    submitProjectedSynthetic(c, phase, phase === 1 ? finiteListResult() : { isError: false }));
  await c.run(); assert.deepEqual(driver.errors, []);
  const packetDir = path.join(c.root, 'bounded-cli-copy'), dir = path.join(packetDir, c.options.runId + '.bridge');
  fs.mkdirSync(packetDir); fs.mkdirSync(dir);
  fs.copyFileSync(path.join(c.dir, 'binding.json'), path.join(dir, 'binding.json'));
  const packet = JSON.parse(fs.readFileSync(path.join(c.dir, 'phase-2.command.json')));
  const envelopeBytes = () => Buffer.byteLength(JSON.stringify({ schema: 'ops.native-host-cli.v1',
    status: 'OK', output: { kind: 'COMMAND', packet } }) + '\n');
  const setPrompt = text => {
    packet.command.arguments.prompt = text;
    packet.commandSha256 = hash(JSON.stringify(packet.command));
  };
  setPrompt('');
  const extra = 8192 - envelopeBytes(); assert.ok(extra > 0);
  setPrompt('\u0001'.repeat(Math.floor(extra / 6)) + 'x'.repeat(extra % 6));
  assert.ok(Buffer.byteLength(packet.command.arguments.prompt) <= 2048);
  assert.equal(envelopeBytes(), 8192);
  const file = path.join(dir, 'phase-2.command.json');
  fs.writeFileSync(file, JSON.stringify(packet) + '\n', { flag: 'wx' });
  const modulePath = fileURLToPath(new URL('./native-caller.mjs', import.meta.url));
  const invoke = () => childProcess.spawnSync(process.execPath, [modulePath, 'host-command',
    '--packet-dir', packetDir, '--run-id', c.options.runId, '--phase', '2', '--wait-ms', '100'],
  { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  const exact = invoke();
  assert.equal(exact.status, 0); assert.equal(exact.stderr.length, 0); assert.equal(exact.stdout.length, 8192);
  assert.equal(JSON.parse(exact.stdout).output.packet.commandSha256, packet.commandSha256);
  setPrompt(packet.command.arguments.prompt + 'x');
  assert.equal(envelopeBytes(), 8193);
  fs.writeFileSync(file, JSON.stringify(packet) + '\n'); // Independent synthetic copy only.
  const over = invoke();
  assert.equal(over.status, 2); assert.equal(over.stderr.length, 0); assert.ok(over.stdout.length < 8192);
  assert.deepEqual(JSON.parse(over.stdout), { schema: 'ops.native-host-cli.v1', status: 'HOLD', errorCode: 'HOST_HELPER_FAILED' });
  assert.equal(over.stdout.includes(Buffer.from('commandSha256')), false);
});

test('command and event digest shapes are closed without equating receiver and caller bindings', async t => {
  const c = projectedBridgeFixture(t);
  const driver = finiteDriver(t, c, (packet, phase) => {
    const binding = JSON.parse(fs.readFileSync(path.join(c.dir, 'binding.json')));
    assert.notEqual(packet.command.bindingSha256, binding.callerBindingSha256);
    for (const field of ['bindingSha256', 'eventSha256']) for (const type of ['string', 'array']) {
      const packetDir = path.join(c.root, 'invalid-' + field + '-' + type), dir = path.join(packetDir, c.options.runId + '.bridge');
      fs.mkdirSync(packetDir); fs.mkdirSync(dir);
      fs.copyFileSync(path.join(c.dir, 'binding.json'), path.join(dir, 'binding.json'));
      const bad = JSON.parse(JSON.stringify(packet));
      bad.command[field] = type === 'string' ? 'not-a-sha' : [packet.command[field]];
      if (field === 'eventSha256') bad.eventSha256 = bad.command.eventSha256;
      bad.commandSha256 = hash(JSON.stringify(bad.command));
      fs.writeFileSync(path.join(dir, 'phase-1.command.json'), JSON.stringify(bad) + '\n', { flag: 'wx' });
      assert.throws(() => readFiniteNativeHostCommand({ packetDir, runId: c.options.runId, phase }), /INVALID_NATIVE_HOST_PACKET/);
    }
    submitProjectedSynthetic(c, phase, finiteListResult('active'));
  });
  await c.run(); assert.deepEqual(driver.errors, []);
  assert.equal(finiteReceipt(c).phases, 1);
});

import { syntheticOwnerInput, syntheticOwnerResult, fakeOwnerChild } from './semlint-owner-ssh-executor.test.mjs';
import { preparePlan as prepareOwnerPlan } from '../../packages/jev-review/semlint-entry.mjs';

function ownerEvaluateFixture(t) {
  const c = finiteBridgeFixture(t, { exchangeTimeoutMs: 10000 });
  c.options.operation = 'evaluate';
  c.options.ssh.remoteLauncherPath = '/nix/store/' + 'a'.repeat(32) + '-ops-semlint-owner/bin/ops-semlint-owner';
  c.options.ssh.resourcesSha = 'd'.repeat(40);
  c.options.ownerLimits = { maxCases: 1, maxCalls: 1, maxInputBytes: 1048576, timeoutMs: 15000, deadlineMs: 60000 };
  return c;
}

test('evaluate owns validated owner output before return and separates remote reports from local SSH counts', async t => {
  const c = ownerEvaluateFixture(t), input = syntheticOwnerInput(), prepared = await prepareOwnerPlan(input, c.options.ownerLimits);
  const expected = await syntheticOwnerResult(prepared), spawned = [];
  t.mock.method(childProcess, 'spawn', (exe, argv, options) => {
    const child = fakeOwnerChild(JSON.stringify(expected) + '\n'); spawned.push({ exe, argv, options, child }); return child;
  });
  const driver = finiteDriver(t, c, (_packet, phase) => {
    const engine = path.join(c.options.ledgerDir, c.options.runId + '.engine');
    const terminal = JSON.parse(fs.readFileSync(path.join(engine, 'terminal.json')));
    const artifact = fs.readFileSync(path.join(engine, 'engine.result.json'));
    assert.equal(terminal.resultArtifactStatus, 'VERIFIED_READBACK');
    assert.equal(hash(artifact), terminal.resultArtifactSha256); assert.deepEqual(JSON.parse(artifact), expected);
    assert.equal(terminal.outcome, 'COMPLETED'); assert.equal(terminal.goalCoverage, 'NOT_CERTIFIED');
    assert.equal(terminal.localCallerSourceSha, source);
    assert.equal(terminal.declaredRemoteOpsSha, c.options.ssh.opsSha);
    assert.equal(terminal.declaredResourcesSha, c.options.ssh.resourcesSha);
    assert.equal(terminal.ownerReportedHttpCalls, 1); assert.equal(terminal.sshSpawnInvocations, 1);
    assert.equal(terminal.providerAccountingAuthority, 'REMOTE_OWNER_SOURCE_REPORTED');
    assert.equal(terminal.coreLogicalCalls, null);
    submitFiniteSynthetic(c, phase, finiteListResult('active'));
  });
  const result = await runFiniteNativeHostBridge(c.config, input, { ownerReturn: c.runtime });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), expected); assert.deepEqual(driver.errors, []);
  assert.equal(spawned.length, 1); assert.equal(c.queue.length, 0);
  assert.ok(spawned[0].child.input.equals(Buffer.from(JSON.stringify(prepared.plan) + '\n')));
  assert.equal(spawned[0].argv.includes('--response-metadata'), false);
  assert.deepEqual(spawned[0].argv.slice(-4), ['--envs-sha', c.options.ssh.envsSha, '--ops-sha', c.options.ssh.opsSha]);
  assert.equal(finiteReceipt(c).consumptionStatus, 'NOT_OBSERVED');
});

test('evaluate retains legitimate INCOMPLETE and zero reported provider calls after one owner SSH', async t => {
  const c = ownerEvaluateFixture(t), input = syntheticOwnerInput({ needs: true });
  const expected = await syntheticOwnerResult(await prepareOwnerPlan(input, c.options.ownerLimits));
  t.mock.method(childProcess, 'spawn', () => fakeOwnerChild(JSON.stringify(expected) + '\n'));
  const driver = finiteDriver(t, c, (_packet, phase) => submitFiniteSynthetic(c, phase, finiteListResult('active')));
  const result = await runFiniteNativeHostBridge(c.config, input, { ownerReturn: c.runtime });
  assert.equal(result.cases[0].result.records[0].status, 'INCOMPLETE');
  const terminal = JSON.parse(fs.readFileSync(path.join(c.options.ledgerDir, c.options.runId + '.engine', 'terminal.json')));
  assert.equal(terminal.outcome, 'HOLD'); assert.equal(terminal.incompleteCount, 1);
  assert.equal(terminal.ownerReportedHttpCalls, 0); assert.equal(terminal.sshSpawnInvocations, 1);
  assert.equal(terminal.executorInvocations, 1); assert.equal(terminal.physicalCloseObserved, true);
  assert.equal(terminal.portReceiptSha256, hash('[]')); assert.deepEqual(driver.errors, []);
});

test('evaluate rejects Core options/input before SSH and forged returned accounting after close', async t => {
  const invalid = ownerEvaluateFixture(t);
  assert.throws(() => bindNativeProductCaller({ ...invalid.options, maxCalls: 1 }, { ownerReturn: invalid.runtime }), /INVALID_NATIVE_PRODUCT_CALLER/);
  assert.throws(() => bindNativeProductCaller({ ...invalid.options, proposalFormat: 'json-string' }, { ownerReturn: invalid.runtime }), /INVALID_NATIVE_PRODUCT_CALLER/);
  let spawns = 0;
  const mock = t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('forbidden'); });
  const driver = finiteDriver(t, invalid, (_packet, phase) => submitFiniteSynthetic(invalid, phase, finiteListResult('active')));
  await assert.rejects(runFiniteNativeHostBridge(invalid.config, {}, { ownerReturn: invalid.runtime }), /INVALID_ENTRY_PLAN/);
  assert.equal(spawns, 0); assert.deepEqual(driver.errors, []);
  const failed = JSON.parse(fs.readFileSync(path.join(invalid.options.ledgerDir, invalid.options.runId + '.engine', 'terminal.json')));
  assert.equal(failed.transportLifecycle, 'NO_EXECUTOR_INVOCATION'); assert.equal(failed.executorInvocations, 0);
  assert.equal(failed.outcome, 'FAILED'); mock.mock.restore();
  const c = ownerEvaluateFixture(t), input = syntheticOwnerInput();
  const bad = await syntheticOwnerResult(await prepareOwnerPlan(input, c.options.ownerLimits)); bad.accounting.providerHttpCalls = 0;
  t.mock.method(childProcess, 'spawn', () => fakeOwnerChild(JSON.stringify(bad) + '\n'));
  const returned = finiteDriver(t, c, (_packet, phase) => submitFiniteSynthetic(c, phase, finiteListResult('active')));
  await assert.rejects(runFiniteNativeHostBridge(c.config, input, { ownerReturn: c.runtime }), /INVALID_PROVIDER_ACCOUNTING/);
  assert.deepEqual(returned.errors, []);
  const terminal = JSON.parse(fs.readFileSync(path.join(c.options.ledgerDir, c.options.runId + '.engine', 'terminal.json')));
  assert.equal(terminal.outcome, 'FAILED'); assert.equal(terminal.physicalCloseObserved, true);
  assert.equal(terminal.ownerReportedHttpCalls, null); assert.equal(terminal.errorCode, 'INVALID_PROVIDER_ACCOUNTING');
});
