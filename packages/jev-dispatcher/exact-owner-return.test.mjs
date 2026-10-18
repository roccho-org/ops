import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { bindExactOwnerReturn, withProductOwnerReturn } from './exact-owner-return.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const queued = '44444444-4444-4444-8444-444444444444';
const sha = value => createHash('sha256').update(value).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-return-test-'));
let serial = 0;
const fixture = ({ output = `Queued message ${queued} for thread ${owner}.\n`, exit = 0,
  hang = false, noClose = false, spawnThrows = false, killThrows = false,
  killReturn = true, currentOwner = owner, now = Date.now } = {}) => {
  const ledgerDir = path.join(root, String(++serial)); fs.mkdirSync(ledgerDir);
  const observations = { spawns: [], kills: 0, unrefs: 0 };
  const options = { mode: 'test-double', codexPath: path.join(root, 'codex.exe'),
    endpoint: 'unix://' + path.join(root, 'existing.sock'), ownerThread: owner, runId: run,
    sourceSha: 'a'.repeat(40), ledgerDir, expiresAt: new Date(Date.now() + 60000).toISOString(), timeoutMs: 1000 };
  const runtime = { ownerThread: () => currentOwner, nonce: () => nonce, now,
    spawn: (exe, argv, spawnOptions) => {
      observations.spawns.push({ exe, argv, spawnOptions });
      if (spawnThrows) throw new Error('synthetic spawn failure');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      observations.child = child;
      child.unref = () => { observations.unrefs++; };
      child.kill = () => {
        observations.kills++;
        if (killThrows) throw new Error('synthetic kill failure');
        if (!noClose) queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return killReturn;
      };
      queueMicrotask(() => {
        if (output) child.stdout.write(output);
        if (!hang) { child.stdout.end(); child.stderr.end(); child.emit('close', exit, null); }
      });
      return child;
    } };
  const event = { schema: 'jev.product-terminal-event.v1', ownerThread: owner, runId: run,
    sourceSha: options.sourceSha, outcome: 'FAILED', resultSha256: 'b'.repeat(64),
    transportReceiptSha256: 'c'.repeat(64), physicalCloseObserved: true };
  return { options, runtime, event, observations, receiver: bindExactOwnerReturn(options, runtime) };
};

test('exact owner return uses the explicit official remote queue and records ACK only', async () => {
  const f = fixture(); const receipt = await f.receiver.deliver(f.event);
  assert.equal(receipt.status, 'QUEUED_NOT_CONSUMED');
  assert.equal(receipt.enqueueStatus, 'ACK_OBSERVED'); assert.equal(receipt.consumptionStatus, 'NOT_OBSERVED');
  assert.equal(receipt.queuedSubmissionId, queued); assert.equal(receipt.physicalCloseObserved, true);
  assert.equal(receipt.expiresAt, f.options.expiresAt);
  const call = f.observations.spawns[0];
  assert.deepEqual(call.argv.slice(0, 6), ['queue', '--remote', f.options.endpoint, '--thread', owner, '--message']);
  assert.equal(call.spawnOptions.shell, false); assert.equal(call.spawnOptions.windowsHide, true);
  assert.deepEqual(call.spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(!call.argv.some(a => ['--no-daemon', '--remote-auth-token-env', '--model', '-c'].includes(a)));
  assert.match(call.argv[6], new RegExp('OWNER_RETURN_CONSUMED ' + run + ' ' + nonce));
  assert.ok(call.argv[6].includes('Delivery expiry UTC: ' + f.options.expiresAt));
  assert.ok(receipt.noticeBytes <= 2048 && receipt.argvUpperBound < 32767);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.options.ledgerDir, run, 'receipt.json')));
  assert.deepEqual(persisted, receipt);
  assert.equal(receipt.stdoutSha256, sha(fs.readFileSync(path.join(f.options.ledgerDir, run, 'response.stdout'))));
  assert.equal(receipt.retries, 0); assert.equal(receipt.remoteEffects, 'UNKNOWN');
  await assert.rejects(f.receiver.deliver(f.event), /OWNER_RETURN_ALREADY_CLAIMED/);
  assert.equal(f.observations.spawns.length, 1);
});

test('binding, source, close and event whitelist failures cause no send or claim', async () => {
  for (const patch of [{ sourceSha: 'd'.repeat(40) }, { runId: owner }, { ownerThread: run },
    { resultSha256: 'bad' }, { physicalCloseObserved: false }, { extra: 'must not be sent' }]) {
    const f = fixture(); await assert.rejects(f.receiver.deliver({ ...f.event, ...patch }), /INVALID_OWNER_RETURN_EVENT/);
    assert.equal(f.observations.spawns.length, 0);
    assert.equal(fs.existsSync(path.join(f.options.ledgerDir, run)), false);
  }
  const f = fixture({ currentOwner: run });
  await assert.rejects(f.receiver.deliver(f.event), /OWNER_THREAD_MISMATCH/);
  assert.equal(f.observations.spawns.length, 0);
});

test('expiry and malformed options fail before effects, including forbidden live runtime overrides', async () => {
  const f = fixture();
  const expired = bindExactOwnerReturn({ ...f.options, expiresAt: '2000-01-01T00:00:00.000Z' }, f.runtime);
  await assert.rejects(expired.deliver(f.event), /OWNER_RETURN_EXPIRED/);
  for (const patch of [{ endpoint: 'ws://localhost:4000' }, { endpoint: 'unix://' },
    { timeoutMs: 30001 }, { codexPath: null }, { ledgerDir: null },
    { expiresAt: '2027-01-01' }, { extra: true }])
    assert.throws(() => bindExactOwnerReturn({ ...f.options, ...patch }, f.runtime), /INVALID_OWNER_RETURN_BINDING/);
  assert.throws(() => bindExactOwnerReturn({ ...f.options, mode: 'live' }, f.runtime), /LIVE_RUNTIME_OVERRIDE/);
  assert.equal(f.observations.spawns.length, 0);
});

test('child nonzero, malformed ACK, wrong owner and synchronous failure remain UNKNOWN without retry', async () => {
  for (const input of [{ exit: 1 }, { output: 'unrecognized output\n' },
    { output: `Queued message ${queued} for thread ${run}.\n` }, { spawnThrows: true }]) {
    const f = fixture(input); const receipt = await f.receiver.deliver(f.event);
    assert.notEqual(receipt.status, 'QUEUED_NOT_CONSUMED'); assert.equal(receipt.enqueueStatus, 'UNKNOWN');
    assert.equal(receipt.consumptionStatus, 'NOT_OBSERVED'); assert.equal(receipt.retries, 0);
    await assert.rejects(f.receiver.deliver(f.event), /OWNER_RETURN_ALREADY_CLAIMED/);
    assert.equal(f.observations.spawns.length, 1);
  }
});

test('output limit stops one child and labels the retained prefix rather than a complete stream', async () => {
  const f = fixture({ output: 'x'.repeat(32769), hang: true });
  const receipt = await f.receiver.deliver(f.event);
  assert.equal(receipt.errorCode, 'QUEUE_OUTPUT_LIMIT'); assert.equal(f.observations.kills, 1);
  assert.equal(receipt.stdoutKeptBytes, 32768); assert.equal(receipt.stdoutObservedBytesLowerBound, 32769);
  assert.equal(receipt.stdoutComplete, false); assert.equal(receipt.enqueueStatus, 'UNKNOWN');
});

test('timeout cannot invent a physical close or enqueue failure when close is missing', async () => {
  const f = fixture({ output: '', hang: true, noClose: true });
  const receiver = bindExactOwnerReturn({ ...f.options, timeoutMs: 1 }, f.runtime);
  const receipt = await receiver.deliver(f.event);
  assert.equal(receipt.errorCode, 'QUEUE_TIMEOUT'); assert.equal(receipt.physicalCloseObserved, false);
  assert.equal(receipt.stdoutComplete, false); assert.equal(receipt.enqueueStatus, 'UNKNOWN');
  assert.equal(receipt.childExitCode, null); assert.equal(f.observations.spawns.length, 1);
});

test('caller automatic finally preserves the exact original product value and error', async () => {
  const value = Object.freeze({ syntheticProduct: true });
  const success = fixture();
  assert.equal(await withProductOwnerReturn(async () => value,
    terminal => { assert.equal(terminal.value, value); assert.equal(terminal.rejected, false); return success.event; }, success.receiver), value);
  assert.equal(success.observations.spawns.length, 1);
  const original = new Error('synthetic product failure');
  const failed = fixture({ exit: 1 });
  await assert.rejects(withProductOwnerReturn(async () => { throw original; },
    terminal => { assert.equal(terminal.error, original); assert.equal(terminal.rejected, true); return failed.event; }, failed.receiver), e => e === original);
  assert.equal(failed.receiver.receipts()[0].enqueueStatus, 'UNKNOWN');
  assert.equal(failed.observations.spawns.length, 1);
});

test('terminal description failures and promises never replace the product result or send', async () => {
  for (const describe of [() => { throw new Error('synthetic callback failure'); },
    () => Promise.resolve({}), () => Promise.reject(new Error('unsupported async failure')),
    () => ({ invalid: true })]) {
    const f = fixture(); const value = {};
    assert.equal(await withProductOwnerReturn(() => value, describe, f.receiver), value);
    assert.equal(f.observations.spawns.length, 0);
    assert.equal(f.receiver.receipts()[0].status, 'NOT_SENT_OR_UNKNOWN');
  }
  await assert.rejects(withProductOwnerReturn(() => null, () => ({}), {}), /INVALID_OWNER_RETURN_CALLER/);
});

test('no-close kill failure detaches handles; late close/error/data cannot mutate frozen receipt', async () => {
  for (const failure of [{ killReturn: false }, { killThrows: true }]) {
    const f = fixture({ output: '', hang: true, noClose: true, ...failure });
    const receiver = bindExactOwnerReturn({ ...f.options, timeoutMs: 1 }, f.runtime);
    const pending = receiver.deliver(f.event);
    assert.doesNotThrow(() => f.observations.child.emit('error', new Error('initial synthetic error')));
    const receipt = await pending, before = JSON.stringify(receipt);
    assert.equal(receipt.physicalCloseObserved, false); assert.equal(receipt.childUnrefObserved, true);
    assert.equal(f.observations.unrefs, 1);
    assert.equal(receipt.stdoutDetached, true); assert.equal(receipt.stderrDetached, true);
    assert.equal(receipt.enqueueStatus, 'UNKNOWN'); assert.equal(receipt.consumptionStatus, 'NOT_OBSERVED');
    assert.doesNotThrow(() => f.observations.child.emit('close', 0, null));
    assert.doesNotThrow(() => f.observations.child.emit('error', new Error('late synthetic error')));
    assert.doesNotThrow(() => f.observations.child.emit('error', new Error('second late synthetic error')));
    assert.doesNotThrow(() => f.observations.child.emit('error', new Error('third late synthetic error')));
    assert.doesNotThrow(() => f.observations.child.stdout.emit('error', new Error('late synthetic pipe error')));
    assert.doesNotThrow(() => f.observations.child.stdout.emit('data', Buffer.from('late data')));
    assert.equal(JSON.stringify(receipt), before);
    assert.equal(f.observations.spawns.length, 1); assert.equal(receipt.retries, 0);
  }
});


// Explicit-v2 structural tests use synthetic descriptors; only the product caller owns real evidence.
import testNativeV2 from 'node:test';
import assertNativeV2 from 'node:assert/strict';
import fsNativeV2 from 'node:fs';
import pathNativeV2 from 'node:path';
import osNativeV2 from 'node:os';
import { EventEmitter as NativeV2Emitter } from 'node:events';
import { PassThrough as NativeV2Pipe } from 'node:stream';
import { randomUUID as nativeV2UUID } from 'node:crypto';
function nativeV2Context(t) {
  const root = fsNativeV2.mkdtempSync(pathNativeV2.join(osNativeV2.tmpdir(), 'semlint-return-v2-'));
  t.after(() => {
    const absolute = pathNativeV2.resolve(root);
    assertNativeV2.ok(absolute.startsWith(pathNativeV2.resolve(osNativeV2.tmpdir()) + pathNativeV2.sep)
      && pathNativeV2.basename(absolute).startsWith('semlint-return-v2-'));
    fsNativeV2.rmSync(absolute, { recursive: true, force: true });
  });
  const owner = '11111111-1111-4111-8111-111111111111', runId = nativeV2UUID(), queue = [];
  const options = { mode: 'test-double', codexPath: pathNativeV2.join(root, 'codex.exe'),
    endpoint: 'unix://' + pathNativeV2.join(root, 'absent.sock'), ownerThread: owner,
    runId, sourceSha: 'a'.repeat(40), ledgerDir: root,
    expiresAt: '2026-10-19T00:01:00.000Z', timeoutMs: 100 };
  let now = Date.parse('2026-10-19T00:00:00.000Z');
  const runtime = { now: () => now, ownerThread: () => owner, nonce: nativeV2UUID,
    spawn: (exe, argv) => {
      queue.push({ exe, argv });
      const child = new NativeV2Emitter();
      child.stdout = new NativeV2Pipe(); child.stderr = new NativeV2Pipe();
      child.kill = () => true; child.unref = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Queued message 33333333-3333-4333-8333-333333333333 for thread ' + owner + '.\n'));
        child.emit('close', 0, null);
      });
      return child;
    } };
  const event = { schema: 'jev.product-terminal-event.v2', ownerThread: owner, runId,
    sourceSha: options.sourceSha, outcome: 'HOLD', resultSha256: 'b'.repeat(64),
    transportReceiptSha256: 'c'.repeat(64), physicalCloseObserved: false,
    transportLifecycle: 'NO_EXECUTOR_INVOCATION', executorInvocations: 0 };
  return { root, options, runtime, event, queue, expire: () => { now += 120000; } };
}

testNativeV2('owner return v2: mismatched count/lifecycle/closure and forged owner/source fail closed', async t => {
  const c = nativeV2Context(t), receiver = bindExactOwnerReturn(c.options, c.runtime);
  for (const delta of [
    { executorInvocations: 1 }, { physicalCloseObserved: true },
    { transportLifecycle: 'LOCAL_SSH_CLOSED' }, { executorInvocations: -1 },
    { executorInvocations: 1.5 }, { executorInvocations: 1, transportLifecycle: 'LOCAL_SSH_CLOSED' },
    { ownerThread: nativeV2UUID() }, { sourceSha: 'd'.repeat(40) }, { fabricated: true }
  ]) await assertNativeV2.rejects(receiver.deliver({ ...c.event, ...delta }), /INVALID_OWNER_RETURN_EVENT/);
  assertNativeV2.equal(c.queue.length, 0);
  assertNativeV2.equal(receiver.receipts().length, 0);
  const record = await receiver.deliver(c.event);
  assertNativeV2.equal(record.status, 'QUEUED_NOT_CONSUMED');
  assertNativeV2.equal(record.eventSchema, 'jev.product-terminal-event.v2');
  assertNativeV2.equal(record.executorInvocations, 0);
  await assertNativeV2.rejects(receiver.deliver(c.event), /OWNER_RETURN_ALREADY_CLAIMED/);
  assertNativeV2.equal(c.queue.length, 1);
});

testNativeV2('owner return v2: explicit preflight claims absent endpoint once without queue', async t => {
  const c = nativeV2Context(t);
  const receiver = bindExactOwnerReturn({ ...c.options, requireEndpointPresence: true }, c.runtime);
  const record = await receiver.deliver(c.event);
  assertNativeV2.equal(record.status, 'HOLD_ENDPOINT_UNAVAILABLE');
  assertNativeV2.equal(record.enqueueStatus, 'NOT_ATTEMPTED');
  assertNativeV2.equal(record.spawnInvocations, 0);
  assertNativeV2.equal(record.remoteEffects, 'NOT_DISPATCHED');
  assertNativeV2.equal(c.queue.length, 0);
  fsNativeV2.writeFileSync(c.options.endpoint.slice(7), 'presence after consumed claim');
  await assertNativeV2.rejects(receiver.deliver(c.event), /OWNER_RETURN_ALREADY_CLAIMED/);
  assertNativeV2.equal(c.queue.length, 0);
  assertNativeV2.throws(() => bindExactOwnerReturn({ ...c.options, requireEndpointPresence: false }, c.runtime),
    /INVALID_OWNER_RETURN_BINDING/);
});

testNativeV2('owner return v2: preflight rejects directory and expired descriptors', async t => {
  const c = nativeV2Context(t);
  fsNativeV2.mkdirSync(c.options.endpoint.slice(7));
  const receiver = bindExactOwnerReturn({ ...c.options, requireEndpointPresence: true }, c.runtime);
  assertNativeV2.equal((await receiver.deliver(c.event)).status, 'HOLD_ENDPOINT_UNAVAILABLE');
  assertNativeV2.equal(c.queue.length, 0);
  const other = nativeV2Context(t); other.expire();
  await assertNativeV2.rejects(bindExactOwnerReturn(other.options, other.runtime).deliver(other.event), /OWNER_RETURN_EXPIRED/);
  assertNativeV2.equal(other.queue.length, 0);
});

testNativeV2('owner return v1: legacy schema and notice stay unchanged without new preflight', async t => {
  const c = nativeV2Context(t), receiver = bindExactOwnerReturn(c.options, c.runtime);
  const event = { schema: 'jev.product-terminal-event.v1', ownerThread: c.event.ownerThread,
    runId: c.event.runId, sourceSha: c.event.sourceSha, outcome: 'COMPLETED',
    resultSha256: c.event.resultSha256, transportReceiptSha256: c.event.transportReceiptSha256,
    physicalCloseObserved: true };
  const record = await receiver.deliver(event);
  assertNativeV2.equal(record.status, 'QUEUED_NOT_CONSUMED');
  assertNativeV2.equal(Object.hasOwn(record, 'eventSchema'), false);
  assertNativeV2.equal(c.queue.length, 1); // Absent endpoint was never a legacy preflight condition.
  assertNativeV2.ok(!c.queue[0].argv[6].includes('one engine-operation'));
  await assertNativeV2.rejects(bindExactOwnerReturn({ ...c.options, requireEndpointPresence: true }, c.runtime)
    .deliver(event), /INVALID_OWNER_RETURN_EVENT/);
  assertNativeV2.equal(c.queue.length, 1);
});


testNativeV2('owner return binding: true preflight cannot be weakened by postbind false/delete', async t => {
  for (const mutation of ['false', 'delete']) {
    const c = nativeV2Context(t), options = { ...c.options, requireEndpointPresence: true };
    const originalBinding = sha(JSON.stringify(options));
    const receiver = bindExactOwnerReturn(options, c.runtime);
    if (mutation === 'false') options.requireEndpointPresence = false;
    else delete options.requireEndpointPresence;
    const record = await receiver.deliver(c.event);
    assertNativeV2.equal(record.bindingSha256, originalBinding);
    assertNativeV2.equal(record.status, 'HOLD_ENDPOINT_UNAVAILABLE');
    assertNativeV2.equal(record.spawnInvocations, 0);
    assertNativeV2.equal(c.queue.length, 0);
  }
});

testNativeV2('owner return binding: adding a flag after bind cannot change legacy behavior', async t => {
  const c = nativeV2Context(t), originalBinding = sha(JSON.stringify(c.options));
  const receiver = bindExactOwnerReturn(c.options, c.runtime);
  c.options.requireEndpointPresence = true;
  const event = { schema: 'jev.product-terminal-event.v1', ownerThread: c.event.ownerThread,
    runId: c.event.runId, sourceSha: c.event.sourceSha, outcome: 'COMPLETED',
    resultSha256: c.event.resultSha256, transportReceiptSha256: c.event.transportReceiptSha256,
    physicalCloseObserved: true };
  const record = await receiver.deliver(event);
  assertNativeV2.equal(record.bindingSha256, originalBinding);
  assertNativeV2.equal(record.status, 'QUEUED_NOT_CONSUMED');
  assertNativeV2.equal(c.queue.length, 1);
  assertNativeV2.ok(!c.queue[0].argv[6].includes('one engine-operation'));
});


// Synthetic host protocol only: no host/MCP calls or live endpoint discovery.
import { bindExactOwnerHostReturn as bindHostReturnForTest } from './exact-owner-return.mjs';
import * as hostReturnFS from 'node:fs';
import * as hostReturnPath from 'node:path';
import * as hostReturnOS from 'node:os';
import { randomUUID as hostReturnUUID } from 'node:crypto';

function hostReturnFixture(t) {
  const root = hostReturnFS.mkdtempSync(hostReturnPath.join(hostReturnOS.tmpdir(), 'ops-host-return-'));
  t.after(() => {
    const resolved = hostReturnPath.resolve(root), base = hostReturnPath.resolve(hostReturnOS.tmpdir()) + hostReturnPath.sep;
    assert.ok(resolved.startsWith(base) && hostReturnPath.basename(resolved).startsWith('ops-host-return-'));
    hostReturnFS.rmSync(resolved, { recursive: true, force: true });
  });
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const ownerId = '11111111-1111-4111-8111-111111111111';
  let currentOwner = ownerId;
  const options = { mode: 'test-double', ownerThread: ownerId, hostId: 'local',
    runId: hostReturnUUID(), sourceSha: 'a'.repeat(40), ledgerDir: root,
    expiresAt: new Date(clock + 20000).toISOString(), timeoutMs: 5000 };
  const runtime = { now: () => clock, ownerThread: () => currentOwner, nonce: hostReturnUUID };
  const event = { schema: 'jev.product-terminal-event.v2', ownerThread: ownerId,
    runId: options.runId, sourceSha: options.sourceSha, outcome: 'HOLD', resultSha256: 'b'.repeat(64),
    transportReceiptSha256: 'c'.repeat(64), physicalCloseObserved: false,
    executorInvocations: 0, transportLifecycle: 'NO_EXECUTOR_INVOCATION' };
  const status = (patch = {}) => ({ schema: 'jev.host-owner-status.v1', ownerThread: ownerId,
    hostId: 'local', status: 'idle', observedAt: new Date(clock).toISOString(),
    statusMeaning: 'RUNTIME_TURN_STATUS', ...patch });
  const ack = (patch = {}) => ({ schema: 'jev.host-owner-send-observation.v1', ownerThread: ownerId,
    hostId: 'local', status: 'acknowledged', observedAt: new Date(clock).toISOString(), ...patch });
  return { root, options, runtime, event, status, ack,
    bind: () => bindHostReturnForTest(options, runtime),
    advance: ms => { clock += ms; }, changeOwner: value => { currentOwner = value; } };
}

test('host return commands are fixed data, one-use and ACK never consumption', async t => {
  const f = hostReturnFixture(t), receiver = f.bind();
  await receiver.deliver(f.event);
  const status = receiver.takeHostCommand();
  assert.equal(status.tool, 'codex_app.list_threads');
  assert.deepEqual(status.arguments, { limit: 1 });
  assert.ok(Object.isFrozen(status) && Object.isFrozen(status.arguments));
  receiver.acceptHostObservation(status.commandId, f.status());
  const send = receiver.takeHostCommand();
  assert.equal(send.tool, 'codex_app.send_message_to_thread');
  assert.deepEqual(Object.keys(send.arguments).sort(), ['hostId', 'prompt', 'threadId']);
  assert.equal(send.arguments.threadId, f.options.ownerThread);
  assert.equal(send.arguments.hostId, 'local');
  assert.match(send.arguments.prompt, /Result SHA256: b{64}/);
  assert.ok(Buffer.byteLength(send.arguments.prompt) <= 2048);
  const result = receiver.acceptHostSendResult(send.commandId, f.ack());
  assert.equal(result.status, 'HOST_ACK_REPORTED_NOT_CONSUMED');
  assert.equal(result.enqueueStatus, 'UNKNOWN');
  assert.equal(result.consumptionStatus, 'NOT_OBSERVED');
  assert.equal(result.statusCommandsIssued, 1);
  assert.equal(result.sendCommandsIssued, 1);
  assert.equal(result.hostLifetime, 'NOT_ESTABLISHED_BY_SOURCE');
  assert.equal(result.remoteEffects, 'UNKNOWN');
  const before = JSON.stringify(receiver.receipts());
  receiver.acceptHostSendResult(send.commandId, f.ack());
  receiver.acceptHostObservation(status.commandId, f.status());
  assert.equal(receiver.takeHostCommand(), null);
  assert.equal(JSON.stringify(receiver.receipts()), before);
});

test('host return missing, active, unknown, foreign or stale status never issues send', async t => {
  for (const patch of [{ status: 'active' }, { status: 'unknown' }, { status: 'notLoaded' },
    { statusMeaning: 'UNKNOWN' }, { ownerThread: '99999999-9999-4999-8999-999999999999' },
    { hostId: 'remote' }, { observedAt: '2026-10-18T23:59:59.999Z' },
    { observedAt: '2026-10-19T00:00:01.000Z' }]) {
    const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
    const cmd = r.takeHostCommand(); r.acceptHostObservation(cmd.commandId, f.status(patch));
    assert.equal(r.takeHostCommand(), null);
    assert.equal(r.receipts().at(-1).status, 'HOLD');
    assert.equal(r.receipts().at(-1).sendCommandsIssued, 0);
  }
  const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
  const cmd = r.takeHostCommand(), missing = f.status(); delete missing.status;
  r.acceptHostObservation(cmd.commandId, missing);
  assert.equal(r.receipts().at(-1).sendCommandsIssued, 0);
  assert.equal(r.receipts().at(-1).status, 'HOLD');
});

test('host return rejects getters without executing them and captures primitive binding', async t => {
  const f = hostReturnFixture(t), r = f.bind();
  f.options.ownerThread = '99999999-9999-4999-8999-999999999999';
  await r.deliver(f.event); const cmd = r.takeHostCommand(); let getterCalls = 0;
  const packet = f.status(); Object.defineProperty(packet, 'status', { enumerable: true, get() { getterCalls++; return 'idle'; } });
  r.acceptHostObservation(cmd.commandId, packet);
  assert.equal(getterCalls, 0); assert.equal(r.receipts().at(-1).status, 'HOLD');
  assert.equal(r.receipts().at(-1).ownerThread, f.event.ownerThread);
});

test('host return refuses order violations and a second command take', async t => {
  for (const wrongOrder of ['before-take', 'wrong-id', 'duplicate-take']) {
    const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
    if (wrongOrder === 'before-take') r.acceptHostObservation('not-issued', f.status());
    else { const c = r.takeHostCommand(); if (wrongOrder === 'wrong-id') r.acceptHostObservation(c.commandId + '-wrong', f.status()); else r.takeHostCommand(); }
    assert.equal(r.takeHostCommand(), null); assert.equal(r.receipts().at(-1).status, 'HOLD');
    assert.equal(r.receipts().at(-1).sendCommandsIssued, 0);
  }
});

test('host return checks expiry, owner and idle freshness again before dispatch', async t => {
  for (const reason of ['expiry', 'owner', 'idle-stale']) {
    const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
    const c = r.takeHostCommand(); r.acceptHostObservation(c.commandId, f.status());
    if (reason === 'expiry') f.advance(20001);
    else if (reason === 'idle-stale') f.advance(5001);
    else f.changeOwner('99999999-9999-4999-8999-999999999999');
    assert.equal(r.takeHostCommand(), null); const last = r.receipts().at(-1);
    assert.equal(last.status, 'HOLD'); assert.equal(last.sendCommandsIssued, 0);
  }
});

test('host return claim persists and prevents rebind delivery without retry', async t => {
  const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
  await assert.rejects(r.deliver(f.event), /OWNER_RETURN_ALREADY_CONSUMED/);
  const second = f.bind(); await assert.rejects(second.deliver(f.event), /OWNER_RETURN_ALREADY_CLAIMED/);
  assert.equal(r.receipts().at(-1).statusCommandsIssued, 0);
  assert.throws(() => bindHostReturnForTest({ ...f.options, mode: 'live' }, f.runtime), /LIVE_RUNTIME_OVERRIDE/);
});

test('host return timeout finalizes once and late replies cannot change it', async t => {
  const f = hostReturnFixture(t), r = f.bind(); await r.deliver(f.event);
  const c = r.takeHostCommand(); f.advance(5001);
  const before = JSON.stringify(r.receipts());
  assert.equal(r.receipts().at(-1).errorCode, 'HOST_OBSERVATION_TIMEOUT');
  assert.doesNotThrow(() => r.acceptHostObservation(c.commandId, f.status()));
  assert.equal(JSON.stringify(r.receipts()), before);
});
