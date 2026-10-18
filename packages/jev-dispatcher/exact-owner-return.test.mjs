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
  hang = false, noClose = false, spawnThrows = false, currentOwner = owner, now = Date.now } = {}) => {
  const ledgerDir = path.join(root, String(++serial)); fs.mkdirSync(ledgerDir);
  const observations = { spawns: [], kills: 0 };
  const options = { mode: 'test-double', codexPath: path.join(root, 'codex.exe'),
    endpoint: 'unix://' + path.join(root, 'existing.sock'), ownerThread: owner, runId: run,
    sourceSha: 'a'.repeat(40), ledgerDir, expiresAt: new Date(Date.now() + 60000).toISOString(), timeoutMs: 1000 };
  const runtime = { ownerThread: () => currentOwner, nonce: () => nonce, now,
    spawn: (exe, argv, spawnOptions) => {
      observations.spawns.push({ exe, argv, spawnOptions });
      if (spawnThrows) throw new Error('synthetic spawn failure');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { observations.kills++; if (!noClose) queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
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
  const call = f.observations.spawns[0];
  assert.deepEqual(call.argv.slice(0, 6), ['queue', '--remote', f.options.endpoint, '--thread', owner, '--message']);
  assert.equal(call.spawnOptions.shell, false); assert.equal(call.spawnOptions.windowsHide, true);
  assert.deepEqual(call.spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(!call.argv.some(a => ['--no-daemon', '--remote-auth-token-env', '--model', '-c'].includes(a)));
  assert.match(call.argv[6], new RegExp('OWNER_RETURN_CONSUMED ' + run + ' ' + nonce));
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
    { timeoutMs: 30001 }, { codexPath: null }, { ledgerDir: null }, { extra: true }])
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
