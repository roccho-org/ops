import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { generateTyped } from '../../packages/typellm/src/typellm.mjs';
import { bindTypeLLMSSHExecutor } from './typellm-ssh-executor.mjs';

// Every child is synthetic. No SSH executable, target, credential or provider is used.
const SHA_ENVS = 'a'.repeat(40), SHA_OPS = 'b'.repeat(40);
const MAX_INPUT = 131072, MAX_STDOUT = 1048576, MAX_STDERR = 16384;
const BEGIN = 'TYPELLM_RESPONSE_METADATA_JSON_BEGIN', END = 'TYPELLM_RESPONSE_METADATA_JSON_END';
const hash = value => createHash('sha256').update(value).digest('hex');
const request = () => ({ context: 'synthetic-context-private-fixture', questions: { answer: { type: 'string' } } });
const output = () => ({ result: { answer: 'synthetic-answer-private-fixture' },
  usage: { input_tokens: 3, thinking_tokens: 0 }, elapsed: 0.25 });
const jsonLine = value => Buffer.from(JSON.stringify(value) + '\n');
function metadata(input, patch = {}) {
  return { schema: 'typellm.cli-response-metadata.v1', stdinComplete: true,
    stdinBytes: input.length, stdinSha256: hash(input), responseMetadataStatus: 'SDK_OBSERVATION_AVAILABLE',
    metadataSchema: 'typellm.response-metadata.v1', publicModelStatus: 'OBSERVED',
    reportedPublicModel: 'reported-public-model', responseIdStatus: 'OBSERVED',
    providerResponseId: 'reported-response-id', backendIdentityStatus: 'UNKNOWN', ...patch };
}
const frame = (input, patch) => BEGIN + '\n' + JSON.stringify(metadata(input, patch)) + '\n' + END + '\n';
const errorIs = code => error => error?.code === code && error.message === code;
function lastReceipt(executor) {
  const list = executor.receipts();
  assert.equal(Object.isFrozen(list), true);
  const record = list.at(-1);
  assert.ok(record); assert.equal(Object.isFrozen(record), true);
  assert.ok(Object.values(record).every(x => x === null || ['string', 'number', 'boolean'].includes(typeof x)));
  assert.equal(record.backendIdentityStatus, 'UNKNOWN');
  assert.equal(record.bindingAuthority, 'DECLARED_ONLY');
  assert.equal(fs.readFileSync(record.receiptPath, 'utf8'), JSON.stringify(record) + '\n');
  return record;
}
async function finite(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('synthetic executor did not settle within test bound')), ms);
  })]); } finally { clearTimeout(timer); }
}
function fakeChild(h, behavior, stdinError) {
  const child = new EventEmitter();
  child.pid = 41001 + h.children.length; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.unrefs = 0; child.killMode = 'close'; child.closed = false;
  const chunks = [];
  child.stdin = stdinError ? new Writable({ write(chunk, _encoding, done) {
    chunks.push(Buffer.from(chunk)); done(Object.assign(new Error('synthetic stdin failure'), { code: 'EPIPE' }));
  } }) : new PassThrough();
  if (!stdinError) child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  child.close = (code = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true; child.exitCode = code; child.signalCode = signal;
    child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
  };
  child.kill = signal => {
    child.kills.push(signal);
    if (child.killMode === 'false') return false;
    if (child.killMode === 'throw') throw Object.assign(new Error('synthetic kill refusal'), { code: 'EPERM' });
    queueMicrotask(() => child.close(null, signal)); return true;
  };
  child.unref = () => { child.unrefs++; };
  child.success = (input, value = output(), sidecar = frame(input)) => {
    child.stdout.write(jsonLine(value)); child.stderr.write('ops-typellm: synthetic build log\n' + sidecar);
    child.close();
  };
  child.stdin.on('finish', () => queueMicrotask(() => {
    child.input = Buffer.concat(chunks);
    try { behavior(child, child.input); }
    catch (error) { h.behaviorErrors.push(error); child.emit('error', error); child.close(255); }
  }));
  h.children.push(child); return child;
}
function harness(t) {
  const tempParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'typellm-ssh-executor-test-'));
  const ledgerDir = path.join(root, 'ledger'); fs.mkdirSync(ledgerDir, { mode: 0o700 });
  const h = { root, ledgerDir, spawns: [], children: [], pending: [], behaviorErrors: [],
    behavior: (child, input) => child.success(input), stdinError: false, spawnError: null };
  t.mock.method(childProcess, 'spawn', (executable, argv, options) => {
    h.spawns.push({ executable, argv, options });
    if (h.spawnError) throw h.spawnError;
    return fakeChild(h, h.behavior, h.stdinError);
  });
  h.config = (patch = {}) => {
    const settings = { sshPath: path.join(root, 'never-executed-ssh'), host: 'fixture-oci',
      envsSha: SHA_ENVS, opsSha: SHA_OPS, runId: randomUUID(), ledgerDir, deadlineMs: 1000, maxCalls: 5, ...patch };
    return { settings, executor: bindTypeLLMSSHExecutor(settings) };
  };
  h.call = (configured, value = request(), sequence = 1, kind = 'proposal', signal) => {
    const callId = configured.settings.runId + '/' + kind + '/' + sequence;
    const pending = configured.executor.executeTyped(value, { callId, ...(signal ? { signal } : {}) });
    h.pending.push(pending); pending.catch(() => {}); return pending;
  };
  t.after(async () => {
    for (const child of h.children) if (!child.closed) child.close(null, 'SIGKILL');
    await Promise.allSettled(h.pending);
    // Only the test-owned synthetic namespace is removed, never a production ledger.
    assert.equal(path.dirname(path.resolve(root)), tempParent);
    assert.ok(path.basename(root).startsWith('typellm-ssh-executor-test-'));
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(h.behaviorErrors, []);
  });
  return h;
}

test('SSH executor binds one fixed argv and exact JSON+LF to flat raw receipts', async t => {
  const h = harness(t), configured = h.config(), value = request();
  const serialized = JSON.stringify(value), input = Buffer.from(serialized + '\n');
  assert.equal(Object.isFrozen(configured.executor), true);
  const pending = h.call(configured, value); value.context = 'later mutation';
  const returned = await finite(pending);
  assert.deepEqual(returned, output()); assert.equal(h.spawns.length, 1);
  const spawn = h.spawns[0];
  assert.equal(spawn.executable, configured.settings.sshPath);
  assert.deepEqual(spawn.argv, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--',
    'fixture-oci', 'ops-typellm', '--envs-sha', SHA_ENVS, '--ops-sha', SHA_OPS, '--response-metadata']);
  assert.equal(spawn.options.shell, false); assert.equal(spawn.options.windowsHide, true);
  assert.deepEqual(spawn.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(h.children[0].input, input);
  const record = lastReceipt(configured.executor);
  assert.equal(record.status, 'RETURNED'); assert.equal(record.spawnInvocations, 1);
  assert.equal(record.physicalCloseObserved, true); assert.equal(record.childExitCode, 0);
  assert.equal(record.remoteEffects, 'UNKNOWN'); assert.equal(record.stdinWriteCompleted, true);
  assert.equal(record.typedRequestBytes, Buffer.byteLength(serialized));
  assert.equal(record.typedRequestSha256, hash(serialized));
  assert.equal(record.stdinBytes, input.length); assert.equal(record.stdinSha256, hash(input));
  assert.notEqual(record.typedRequestSha256, record.stdinSha256);
  assert.deepEqual(fs.readFileSync(record.stdinPath), input);
  for (const stream of ['stdout', 'stderr']) {
    const bytes = fs.readFileSync(record[stream + 'Path']);
    assert.equal(record[stream + 'Bytes'], bytes.length);
    assert.equal(record[stream + 'Sha256'], hash(bytes)); assert.equal(record[stream + 'Complete'], true);
  }
  assert.equal(record.reportedPublicModel, 'reported-public-model');
  assert.equal(record.providerResponseId, 'reported-response-id');
  assert.equal(JSON.stringify(record).includes('synthetic-context-private-fixture'), false);
  assert.equal(JSON.stringify(record).includes('synthetic-answer-private-fixture'), false);
  const manifest = fs.readFileSync(path.join(h.ledgerDir, configured.settings.runId + '.binding.json'));
  assert.equal(record.bindingSha256, hash(manifest)); assert.equal(configured.executor.bindingSha256, hash(manifest));
});

test('SSH executor excludes four parent API fields without reading their values or rewriting SSH auth settings', async t => {
  const h = harness(t), configured = h.config();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
  const names = ['TYPELLM_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const synthetic = { PATH: 'synthetic-path', SSH_AUTH_SOCK: 'synthetic-existing-agent' };
  let reads = 0;
  for (const name of names) Object.defineProperty(synthetic, name, {
    enumerable: true, get() { reads++; throw new Error('excluded key must never be read'); },
  });
  try {
    Object.defineProperty(process, 'env', { ...descriptor, value: synthetic });
    await finite(h.call(configured));
  } finally { Object.defineProperty(process, 'env', descriptor); }
  assert.equal(reads, 0); assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0].options.env, { PATH: 'synthetic-path', SSH_AUTH_SOCK: 'synthetic-existing-agent' });
  assert.ok(names.every(name => !Object.hasOwn(h.spawns[0].options.env, name)));
});

test('SSH executor validates factory/call boundaries and rejects a symlink ledger before spawning', async t => {
  const h = harness(t), configured = h.config();
  for (const patch of [{ sshPath: 'relative-ssh' }, { host: '-oProxyCommand=bad' }, { host: 'x;bad' },
    { envsSha: 'A'.repeat(40) }, { opsSha: 'b'.repeat(39) }, { runId: '../wrong' },
    { ledgerDir: 'relative' }, { deadlineMs: 0 }, { deadlineMs: 95001 }, { maxCalls: 0 },
    { maxCalls: 6 }, { apiKey: 'unsupported' }, { unknown: true }])
    assert.throws(() => bindTypeLLMSSHExecutor({ ...configured.settings, ...patch }));
  const link = path.join(h.root, 'ledger-link');
  fs.symlinkSync(h.ledgerDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => bindTypeLLMSSHExecutor({ ...configured.settings, ledgerDir: link }), /INVALID_TYPELLM_SSH_LEDGER/);
  for (const options of [{}, { callId: configured.settings.runId + '/proposal/0' },
    { callId: configured.settings.runId + '/proposal/6' }, { callId: randomUUID() + '/proposal/1' },
    { callId: configured.settings.runId + '/proposal/1/../2' },
    { callId: configured.settings.runId + '/proposal/1', extra: true },
    { callId: configured.settings.runId + '/proposal/1', signal: {} }])
    await assert.rejects(() => configured.executor.executeTyped(request(), options), errorIs('executor_contract_error'));
  assert.equal(h.spawns.length, 0); assert.deepEqual(configured.executor.receipts(), []);
});

test('SSH executor persists duplicate/crash refusal across factories and kinds with one global sequence budget', async t => {
  const h = harness(t), first = h.config(); let release;
  h.behavior = (child, input) => { release = () => child.success(input); };
  const inFlight = h.call(first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  const second = h.config({ runId: first.settings.runId });
  await assert.rejects(() => h.call(second, request(), 1, 'judgment'), errorIs('executor_contract_error'));
  release(); await finite(inFlight);
  h.behavior = (child, input) => child.success(input);
  for (let sequence = 2; sequence <= 5; sequence++) {
    const fresh = h.config({ runId: first.settings.runId });
    await h.call(fresh, request(), sequence, 'judgment');
  }
  assert.equal(h.spawns.length, 5);
  const exhausted = h.config({ runId: first.settings.runId });
  await assert.rejects(() => exhausted.executor.executeTyped(request(), {
    callId: first.settings.runId + '/judgment/6',
  }), errorIs('executor_contract_error'));
  assert.equal(h.spawns.length, 5);
  const crash = h.config(), claim = path.join(h.ledgerDir, crash.settings.runId + '.1');
  fs.mkdirSync(claim); fs.writeFileSync(path.join(claim, 'unknown-existing-call'), 'keep', { flag: 'wx' });
  await assert.rejects(() => h.call(crash), errorIs('executor_contract_error'));
  assert.equal(fs.readFileSync(path.join(claim, 'unknown-existing-call'), 'utf8'), 'keep');
  assert.equal(h.spawns.length, 5); assert.deepEqual(crash.executor.receipts(), []);
});

test('SSH executor rejects run rebinding and preserves original source/deadline budget manifests', async t => {
  const h = harness(t);
  for (const patch of [{ host: 'another-fixture' }, { opsSha: 'c'.repeat(40) }, { deadlineMs: 999 }, { maxCalls: 4 }]) {
    const first = h.config(); await h.call(first);
    const manifestPath = path.join(h.ledgerDir, first.settings.runId + '.binding.json');
    const before = fs.readFileSync(manifestPath);
    const changed = h.config({ runId: first.settings.runId, ...patch });
    await assert.rejects(() => h.call(changed, request(), 2), errorIs('executor_contract_error'));
    assert.deepEqual(fs.readFileSync(manifestPath), before);
    const failed = lastReceipt(changed.executor);
    assert.equal(failed.spawnInvocations, 0); assert.equal(failed.remoteEffects, 'NOT_DISPATCHED_BY_EXECUTOR');
    assert.equal(failed.status, 'FAILED');
  }
  assert.equal(h.spawns.length, 4);
});

test('SSH executor refuses oversize input and pre-abort without SSH, retaining consumed claims', async t => {
  const h = harness(t), oversize = h.config();
  const large = request(); large.context = 'x'.repeat(MAX_INPUT);
  await assert.rejects(() => h.call(oversize, large), errorIs('executor_contract_error'));
  const a = lastReceipt(oversize.executor);
  assert.equal(a.spawnInvocations, 0); assert.equal(a.remoteEffects, 'NOT_DISPATCHED_BY_EXECUTOR');
  const controller = new AbortController(); controller.abort(); const cancelled = h.config();
  await assert.rejects(() => h.call(cancelled, request(), 1, 'proposal', controller.signal), errorIs('cancelled'));
  assert.equal(lastReceipt(cancelled.executor).spawnInvocations, 0);
  const fresh = h.config({ runId: cancelled.settings.runId });
  await assert.rejects(() => h.call(fresh), errorIs('executor_contract_error'));
  assert.equal(h.spawns.length, 0);
});

test('SSH executor accepts boundary-size stdin and accounts for its physical LF byte', async t => {
  const h = harness(t), configured = h.config(), value = request(); value.context = '';
  const overhead = Buffer.byteLength(JSON.stringify(value) + '\n');
  value.context = 'x'.repeat(MAX_INPUT - overhead);
  await finite(h.call(configured, value));
  assert.equal(h.children[0].input.length, MAX_INPUT);
  assert.equal(lastReceipt(configured.executor).stdinBytes, MAX_INPUT);
});

test('SSH executor requires the sole canonical flat sidecar, matching complete stdin and safe public observations', async t => {
  const h = harness(t);
  const invalid = [
    input => '', input => frame(input) + frame(input), input => JSON.stringify(frame(input)) + '\n',
    input => frame(input).slice(0, -1),
    input => frame(input, { stdinComplete: false }), input => frame(input, { stdinBytes: input.length + 1 }),
    input => frame(input, { stdinSha256: '0'.repeat(64) }),
    input => frame(input, { extra: true }), input => frame(input, { backendIdentityStatus: 'VERIFIED' }),
    input => frame(input, { responseMetadataStatus: 'NOT_OBSERVED' }),
    input => frame(input, { publicModelStatus: 'OBSERVED', reportedPublicModel: null }),
    input => frame(input, { publicModelStatus: 'ABSENT', reportedPublicModel: 'invented' }),
    input => frame(input, { providerResponseId: 'bad\nidentifier' }),
    input => frame(input, { reportedPublicModel: 'x'.repeat(257) }),
    input => frame(input, { reportedPublicModel: 'é'.repeat(129) }),
    input => frame(input, { reportedPublicModel: '\ud800' }),
    input => BEGIN + '\n ' + JSON.stringify(metadata(input)) + '\n' + END + '\n',
    input => BEGIN + '\n' + JSON.stringify(metadata(input)).replace('"stdinComplete":true',
      '"stdinComplete":true,"stdinComplete":true') + '\n' + END + '\n',
  ];
  for (const makeFrame of invalid) {
    h.behavior = (child, input) => child.success(input, output(), makeFrame(input));
    const configured = h.config();
    await assert.rejects(() => finite(h.call(configured)), errorIs('executor_contract_error'));
    const record = lastReceipt(configured.executor);
    assert.equal(record.status, 'FAILED'); assert.equal(record.remoteEffects, 'UNKNOWN');
    assert.equal(record.responseMetadataStatus, 'UNVERIFIED'); assert.equal(record.reportedPublicModel, null);
  }
  h.behavior = (child, input) => child.success(input, output(), frame(input, {
    publicModelStatus: 'ABSENT', reportedPublicModel: null, responseIdStatus: 'INVALID', providerResponseId: null,
  }));
  const absent = h.config(); await h.call(absent);
  const record = lastReceipt(absent.executor);
  assert.equal(record.status, 'RETURNED'); assert.equal(record.publicModelStatus, 'ABSENT');
  assert.equal(record.responseIdStatus, 'INVALID'); assert.equal(record.reportedPublicModel, null);
});

test('SSH executor refuses malformed/partial stdout and physical failures even with a valid sidecar', async t => {
  const h = harness(t);
  const invalid = [Buffer.from('not-json\n'), Buffer.from(JSON.stringify(output())),
    Buffer.from(JSON.stringify(output()) + '\n\n'), Buffer.from('log\n' + JSON.stringify(output()) + '\n'),
    jsonLine([]), jsonLine({ result: {}, model: 'not-a-normalized-field' }), Buffer.from([255, 10])];
  for (const bytes of invalid) {
    h.behavior = (child, input) => { child.stdout.write(bytes); child.stderr.write(frame(input)); child.close(); };
    const configured = h.config();
    await assert.rejects(() => finite(h.call(configured)), errorIs('executor_contract_error'));
    assert.deepEqual(fs.readFileSync(lastReceipt(configured.executor).stdoutPath), bytes);
  }
  for (const [code, signal] of [[3, null], [255, null], [null, 'SIGTERM']]) {
    h.behavior = (child, input) => { child.stdout.write(jsonLine(output())); child.stderr.write(frame(input)); child.close(code, signal); };
    const configured = h.config();
    await assert.rejects(() => finite(h.call(configured)), errorIs('executor_failed'));
    const record = lastReceipt(configured.executor);
    assert.equal(record.childExitCode, code); assert.equal(record.childSignal, signal);
    assert.equal(record.reportedPublicModel, null); assert.equal(record.remoteEffects, 'UNKNOWN');
  }
});

test('SSH executor leaves typed schema revalidation and same-object observations with the outer SDK', async t => {
  const h = harness(t), configured = h.config(), value = request();
  const normalized = await generateTyped({ request: value, provider: { available: true,
    post: () => h.call(configured, value) } });
  assert.deepEqual(normalized, output());
  const observation = generateTyped.responseMetadata(normalized);
  assert.equal(observation.publicModelStatus, 'ABSENT'); assert.equal(observation.responseIdStatus, 'ABSENT');
  assert.equal(lastReceipt(configured.executor).reportedPublicModel, 'reported-public-model');
  h.behavior = (child, input) => child.success(input, { result: { answer: false } });
  const invalid = h.config();
  await assert.rejects(() => generateTyped({ request: value, provider: { available: true,
    post: () => h.call(invalid, value) } }), errorIs('provider_contract_error'));
  // A completed transport is not a certification of the caller's typed answer or Goal.
  assert.equal(lastReceipt(invalid.executor).status, 'RETURNED'); assert.equal(h.spawns.length, 2);
});

test('SSH executor retains only bounded stdout/stderr prefixes and never retries overflow', async t => {
  const h = harness(t);
  for (const [stream, cap] of [['stdout', MAX_STDOUT], ['stderr', MAX_STDERR]]) {
    const configured = h.config();
    h.behavior = child => {
      child[stream].write(Buffer.alloc(cap + 17, 0x78));
      child[stream].write(Buffer.from('late'));
    };
    const before = h.spawns.length;
    await assert.rejects(() => finite(h.call(configured)), errorIs('executor_contract_error'));
    const record = lastReceipt(configured.executor), bytes = fs.readFileSync(record[stream + 'Path']);
    assert.equal(h.spawns.length, before + 1); assert.equal(bytes.length, cap);
    assert.deepEqual(bytes, Buffer.alloc(cap, 0x78)); assert.equal(record[stream + 'Complete'], false);
    assert.ok(record[stream + 'ObservedBytesLowerBound'] >= cap + 17);
    assert.equal(record.remoteEffects, 'UNKNOWN'); assert.deepEqual(h.children.at(-1).kills, ['SIGKILL']);
  }
});

test('SSH executor handles short writes and drops late data after partial-write failure without exceeding the cap', async t => {
  const h = harness(t), originalOpen = fs.openSync, originalWrite = fs.writeSync, originalClose = fs.closeSync;
  const stdoutFds = new Set(); let writes = 0, failAfterFirst = false;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (typeof file === 'string' && file.endsWith('response.stdout') && args[0] === 'wx') stdoutFds.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', function(fd) { stdoutFds.delete(fd); return originalClose.call(this, fd); });
  t.mock.method(fs, 'writeSync', function(fd, buffer, offset, length, ...args) {
    if (!stdoutFds.has(fd) || typeof offset !== 'number' || typeof length !== 'number')
      return originalWrite.call(this, fd, buffer, offset, length, ...args);
    writes++;
    if (failAfterFirst && writes === 2) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
    return originalWrite.call(this, fd, buffer, offset, Math.min(length, 7), ...args);
  });
  const successful = h.config(); await finite(h.call(successful));
  assert.ok(writes > 1); assert.deepEqual(fs.readFileSync(lastReceipt(successful.executor).stdoutPath), jsonLine(output()));
  writes = 0; failAfterFirst = true;
  h.behavior = child => {
    child.stdout.write(Buffer.alloc(MAX_STDOUT, 0x78));
    child.stdout.write(Buffer.alloc(MAX_STDOUT, 0x79));
  };
  const failed = h.config();
  await assert.rejects(() => finite(h.call(failed)), errorIs('executor_failed'));
  const record = lastReceipt(failed.executor), kept = fs.readFileSync(record.stdoutPath);
  assert.equal(kept.length, 7); assert.equal(record.stdoutComplete, false); assert.equal(record.remoteEffects, 'UNKNOWN');
});

test('SSH executor settles no-close/kill-false/kill-throw timeouts with UNKNOWN effects and immutable late receipts', async t => {
  const h = harness(t);
  for (const mode of ['false', 'throw']) {
    h.behavior = child => { child.killMode = mode; };
    const configured = h.config({ deadlineMs: 5 });
    await assert.rejects(() => finite(h.call(configured)), errorIs('executor_timeout'));
    const child = h.children.at(-1), record = lastReceipt(configured.executor);
    assert.equal(record.physicalCloseObserved, false); assert.equal(record.closeGraceExpired, true);
    assert.equal(record.childExitCode, null); assert.equal(record.childSignal, null);
    assert.equal(record.stdoutComplete, false); assert.equal(record.stderrComplete, false);
    assert.equal(record.remoteEffects, 'UNKNOWN'); assert.equal(child.unrefs, 1);
    if (mode === 'false') assert.equal(record.childKillReturn, false);
    else assert.equal(record.childKillErrorCode, 'EPERM');
    const persisted = fs.readFileSync(record.receiptPath);
    child.stdout.emit('data', Buffer.from('late-data'));
    child.emit('error', Object.assign(new Error('late fixture error'), { code: 'LATE' }));
    child.close(0, null);
    assert.deepEqual(fs.readFileSync(record.receiptPath), persisted);
    assert.equal(record.physicalCloseObserved, false); assert.equal(record.childExitCode, null);
  }
});

test('SSH executor cancellation/EPIPE/spawn failure remain failed consumed calls, not successful delivery', async t => {
  const h = harness(t), controller = new AbortController();
  h.behavior = () => controller.abort();
  const cancelled = h.config();
  await assert.rejects(() => finite(h.call(cancelled, request(), 1, 'proposal', controller.signal)), errorIs('cancelled'));
  assert.equal(lastReceipt(cancelled.executor).remoteEffects, 'UNKNOWN');
  h.stdinError = true;
  const brokenInput = h.config();
  await assert.rejects(() => finite(h.call(brokenInput)), errorIs('executor_failed'));
  const inputReceipt = lastReceipt(brokenInput.executor);
  assert.equal(inputReceipt.stdinWriteCompleted, false); assert.equal(inputReceipt.remoteEffects, 'UNKNOWN');
  h.stdinError = false; h.spawnError = Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' });
  const spawnFailure = h.config();
  await assert.rejects(() => finite(h.call(spawnFailure)), errorIs('executor_failed'));
  const record = lastReceipt(spawnFailure.executor);
  assert.equal(record.childErrorCode, 'ENOENT');
  assert.equal(record.spawnInvocations, 1); assert.equal(record.remoteEffects, 'UNKNOWN');
  assert.equal(record.physicalCloseObserved, false);
  const fresh = h.config({ runId: spawnFailure.settings.runId });
  await assert.rejects(() => h.call(fresh), errorIs('executor_contract_error'));
});
