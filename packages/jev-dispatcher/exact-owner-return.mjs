import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha40 = /^[a-f0-9]{40}$/, sha64 = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const fail = code => { throw new Error(code); };
const states = new WeakMap();
const eventKeys = ['schema', 'ownerThread', 'runId', 'sourceSha', 'outcome',
  'resultSha256', 'transportReceiptSha256', 'physicalCloseObserved'];
const optionKeys = ['mode', 'codexPath', 'endpoint', 'ownerThread', 'runId', 'sourceSha',
  'ledgerDir', 'expiresAt', 'timeoutMs'];
const outputLimit = 32768;

// Host capability supplied by the caller. This is not a model/evaluation port.
// Explicit --remote avoids the CLI's default embedded-server fallback.
export function bindExactOwnerReturn(options, testRuntime) {
  if (!exact(options, optionKeys) && !exact(options, [...optionKeys, 'requireEndpointPresence']))
    fail('INVALID_OWNER_RETURN_BINDING');
  const endpointPresenceExplicit = Object.hasOwn(options, 'requireEndpointPresence');
  const requireEndpointPresence = endpointPresenceExplicit ? options.requireEndpointPresence : false;
  if (endpointPresenceExplicit && requireEndpointPresence !== true)
    fail('INVALID_OWNER_RETURN_BINDING');
  const { mode, codexPath, endpoint, ownerThread, runId, sourceSha, ledgerDir,
    expiresAt, timeoutMs } = options;
  if (!['live', 'test-double'].includes(mode) || typeof codexPath !== 'string' || !path.isAbsolute(codexPath)
      || /[\0\r\n]/u.test(codexPath) || !uuid.test(ownerThread) || !uuid.test(runId)
      || !sha40.test(sourceSha) || typeof ledgerDir !== 'string' || !path.isAbsolute(ledgerDir)
      || typeof endpoint !== 'string' || !endpoint.startsWith('unix://')
      || !path.isAbsolute(endpoint.slice(7)) || /[\0\r\n]/u.test(endpoint)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))
    fail('INVALID_OWNER_RETURN_BINDING');
  if (new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) fail('INVALID_OWNER_RETURN_BINDING');
  if (mode === 'live' && testRuntime !== undefined) fail('LIVE_RUNTIME_OVERRIDE');
  const runtime = mode === 'test-double' ? testRuntime : {
    spawn, now: Date.now, ownerThread: () => process.env.CODEX_THREAD_ID, nonce: randomUUID
  };
  if (!runtime || typeof runtime.spawn !== 'function' || typeof runtime.now !== 'function'
      || typeof runtime.ownerThread !== 'function' || typeof runtime.nonce !== 'function')
    fail('INVALID_OWNER_RETURN_RUNTIME');
  let directory;
  try { directory = fs.lstatSync(ledgerDir); } catch { fail('INVALID_OWNER_RETURN_LEDGER'); }
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('INVALID_OWNER_RETURN_LEDGER');
  const records = [];
  const note = record => { records.push(Object.freeze(record)); return records.at(-1); };
  const binding = hash(JSON.stringify(endpointPresenceExplicit
    ? { ...options, requireEndpointPresence } : options));

  const deliver = async event => {
    const v2 = exact(event, [...eventKeys, 'transportLifecycle', 'executorInvocations'])
      && event.schema === 'jev.product-terminal-event.v2';
    const v1 = exact(event, eventKeys) && event.schema === 'jev.product-terminal-event.v1';
    const lifecycleValid = v2 && Number.isSafeInteger(event.executorInvocations)
      && (event.executorInvocations === 0
        ? event.transportLifecycle === 'NO_EXECUTOR_INVOCATION' && event.physicalCloseObserved === false
        : event.executorInvocations > 0 && event.transportLifecycle === 'LOCAL_SSH_CLOSED'
          && event.physicalCloseObserved === true);
    // The receiver checks structure; the owning product must establish actual counters/receipts.
    if ((!v1 && !lifecycleValid) || (requireEndpointPresence && !v2)
        || event.ownerThread !== ownerThread || event.runId !== runId || event.sourceSha !== sourceSha
        || !['COMPLETED', 'FAILED', 'HOLD', 'RETURN_P', 'TERMINAL'].includes(event.outcome)
        || !sha64.test(event.resultSha256) || !sha64.test(event.transportReceiptSha256)
        || (v1 && event.physicalCloseObserved !== true))
      fail('INVALID_OWNER_RETURN_EVENT');
    if (runtime.ownerThread() !== ownerThread) fail('OWNER_THREAD_MISMATCH');
    const remaining = Date.parse(expiresAt) - runtime.now();
    if (remaining <= 0) fail('OWNER_RETURN_EXPIRED');
    const nonce = runtime.nonce();
    if (!uuid.test(nonce)) fail('INVALID_OWNER_RETURN_NONCE');
    const eventSha256 = hash(JSON.stringify(event));
    const notice = ['Product terminal event for the same P thread.',
      'Owner thread: ' + ownerThread, 'Run: ' + runId, 'Source: ' + sourceSha,
      'Outcome: ' + event.outcome,
      ...(v2 ? ['Outcome is one engine-operation terminal, not Goal or G1/G2 completion.'] : []),
      'Result SHA256: ' + event.resultSha256,
      'Transport receipt SHA256: ' + event.transportReceiptSha256,
      'Event SHA256: ' + eventSha256,
      'Delivery expiry UTC: ' + expiresAt,
      'Receipt nonce: ' + nonce,
      'This queue notice alone proves neither G1/G2 nor automatic consumption.',
      'After this same thread actually consumes the queued turn, verify the bound local receipt',
      'and record OWNER_RETURN_CONSUMED ' + runId + ' ' + nonce + '.',
      'Recheck current source/refs, expiry and authorization before acting; this notice grants no scope.',
      'Never replay consumed calls. web.chat and periodic automation stay paused.'
    ].join('\n');
    const argv = ['queue', '--remote', endpoint, '--thread', ownerThread, '--message', notice];
    const argvUpperBound = 2 * (codexPath.length + argv.join(' ').length) + 2 * argv.length + 8;
    if (Buffer.byteLength(notice) > 2048 || argvUpperBound >= 32767) fail('OWNER_RETURN_ARGV_LIMIT');
    const claim = path.join(ledgerDir, runId);
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch (error) { if (error?.code === 'EEXIST') fail('OWNER_RETURN_ALREADY_CLAIMED'); throw error; }
    const record = { schema: 'jev.exact-owner-return-receipt.v1', mode, ownerThread, runId,
      sourceSha, bindingSha256: binding, bindingAuthority: 'DECLARED_ONLY', eventSha256,
      resultSha256: event.resultSha256, transportReceiptSha256: event.transportReceiptSha256,
      ...(v2 ? { eventSchema: event.schema, transportLifecycle: event.transportLifecycle,
        executorInvocations: event.executorInvocations } : {}),
      outcome: event.outcome, noticeSha256: hash(notice), noticeBytes: Buffer.byteLength(notice),
      nonce, expiresAt, startedAt: new Date(runtime.now()).toISOString(), completedAt: null,
      spawnInvocations: 0, childExitCode: null, childSignal: null, physicalCloseObserved: false,
      errorCode: null, status: 'CLAIMED', enqueueStatus: 'UNKNOWN', queuedSubmissionId: null,
      consumptionStatus: 'NOT_OBSERVED', remoteEffects: 'UNKNOWN',
      childKillReturn: null, childKillError: false, childUnrefObserved: false,
      stdoutDetached: false, stderrDetached: false,
      stdoutKeptBytes: 0, stdoutSha256: null, stdoutObservedBytesLowerBound: 0,
      stderrKeptBytes: 0, stderrSha256: null, stderrObservedBytesLowerBound: 0,
      stdoutComplete: false, stderrComplete: false, argvUpperBound, retries: 0 };
    let outFd, errFd, child, timer, graceTimer, finalized = false, stopped = null;
    let outKept = 0, errKept = 0, outSeen = 0, errSeen = 0;
    const stdout = [], stderr = [];
    const finish = () => {
      if (finalized) return records.at(-1);
      finalized = true;
      clearTimeout(timer); clearTimeout(graceTimer);
      if (child && !record.physicalCloseObserved) {
        try { child.unref(); record.childUnrefObserved = true; } catch {}
        for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          try { stream?.unref?.(); } catch {}
          try { stream?.destroy(); } catch {}
          record[kind + 'Detached'] = stream?.destroyed === true;
        }
      }
      for (const fd of [outFd, errFd]) if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { stopped ??= 'QUEUE_LEDGER_IO'; }
      }
      record.completedAt = new Date(runtime.now()).toISOString();
      record.stdoutObservedBytesLowerBound = outSeen;
      record.stderrObservedBytesLowerBound = errSeen;
      for (const [kind, memory, seen] of [['stdout', stdout, outSeen], ['stderr', stderr, errSeen]]) {
        let actual;
        try {
          const file = path.join(claim, 'response.' + kind), stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > outputLimit) throw new Error('LEDGER_IDENTITY');
          actual = fs.readFileSync(file);
        } catch { stopped ??= 'QUEUE_LEDGER_IO'; }
        const matches = actual !== undefined && actual.equals(Buffer.concat(memory));
        if (!matches) stopped ??= 'QUEUE_LEDGER_IO';
        record[kind + 'KeptBytes'] = actual?.length ?? null;
        record[kind + 'Sha256'] = actual === undefined ? null : hash(actual);
        record[kind + 'Complete'] = record.physicalCloseObserved && seen <= outputLimit
          && matches && actual.length === seen && stopped !== 'QUEUE_LEDGER_IO';
      }
      if (!stopped && record.physicalCloseObserved && record.childExitCode === 0) {
        const raw = Buffer.concat(stdout), text = raw.toString('utf8');
        const match = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.(?:\r?\n)?$/.exec(text);
        if (Buffer.from(text).equals(raw) && match && uuid.test(match[1]) && match[2] === ownerThread) {
          record.status = 'QUEUED_NOT_CONSUMED'; record.enqueueStatus = 'ACK_OBSERVED';
          record.queuedSubmissionId = match[1];
        } else { record.status = 'UNKNOWN_OUTPUT'; record.errorCode = 'QUEUE_ACK_NOT_VERIFIED'; }
      } else { record.status = 'SEND_FAILED_OR_UNKNOWN'; record.errorCode = stopped ?? 'QUEUE_CHILD_NONZERO'; }
      if (stopped === 'OWNER_ENDPOINT_UNAVAILABLE') {
        record.status = 'HOLD_ENDPOINT_UNAVAILABLE'; record.enqueueStatus = 'NOT_ATTEMPTED';
        record.remoteEffects = 'NOT_DISPATCHED';
      }
      try { fs.writeFileSync(path.join(claim, 'receipt.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { record.status = 'RECEIPT_WRITE_FAILED'; record.errorCode = 'RECEIPT_WRITE_FAILED'; }
      return note(record);
    };
    return await new Promise(resolve => {
      const stop = code => {
        if (stopped || finalized) return;
        stopped = code;
        if (child) {
          try { const killed = child.kill('SIGKILL'); record.childKillReturn = typeof killed === 'boolean' ? killed : null; }
          catch { record.childKillError = true; }
        }
        graceTimer = setTimeout(() => resolve(finish()), 3000);
      };
      const capture = (kind, value) => {
        if (finalized) return;
        const bytes = Buffer.from(value);
        const seen = kind === 'stdout' ? (outSeen += bytes.length) : (errSeen += bytes.length);
        if (stopped) return;
        const kept = kind === 'stdout' ? outKept : errKept;
        const slice = bytes.subarray(0, Math.max(0, outputLimit - kept));
        try {
          if (slice.length) fs.writeFileSync(kind === 'stdout' ? outFd : errFd, slice);
          (kind === 'stdout' ? stdout : stderr).push(slice);
          if (kind === 'stdout') outKept += slice.length; else errKept += slice.length;
        } catch { stop('QUEUE_LEDGER_IO'); }
        if (seen > outputLimit) stop('QUEUE_OUTPUT_LIMIT');
      };
      try {
        fs.writeFileSync(path.join(claim, 'claim.json'), JSON.stringify({ ...event, eventSha256, nonce, expiresAt }) + '\n', { flag: 'wx', mode: 0o600 });
        outFd = fs.openSync(path.join(claim, 'response.stdout'), 'wx', 0o600);
        errFd = fs.openSync(path.join(claim, 'response.stderr'), 'wx', 0o600);
        const dispatchRemaining = Date.parse(expiresAt) - runtime.now();
        if (dispatchRemaining <= 0 || runtime.ownerThread() !== ownerThread) {
          stopped = dispatchRemaining <= 0 ? 'OWNER_RETURN_EXPIRED' : 'OWNER_THREAD_MISMATCH';
          resolve(finish()); return;
        }
        if (requireEndpointPresence) {
          let endpointStat;
          try { endpointStat = fs.lstatSync(endpoint.slice(7)); } catch {}
          if (!endpointStat || endpointStat.isSymbolicLink()
              || !(endpointStat.isSocket() || endpointStat.isFile())) {
            stopped = 'OWNER_ENDPOINT_UNAVAILABLE'; resolve(finish()); return;
          }
        }
        timer = setTimeout(() => stop('QUEUE_TIMEOUT'), Math.min(timeoutMs, dispatchRemaining));
        record.spawnInvocations++;
        child = runtime.spawn(codexPath, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', value => capture('stdout', value));
        child.stderr.on('data', value => capture('stderr', value));
        child.stdout.on('error', () => { if (!finalized) stop('QUEUE_PIPE_ERROR'); });
        child.stderr.on('error', () => { if (!finalized) stop('QUEUE_PIPE_ERROR'); });
        child.on('error', () => { if (!finalized) stop('QUEUE_CHILD_ERROR'); });
        child.once('close', (code, signal) => {
          if (finalized) return;
          record.physicalCloseObserved = true; record.childExitCode = code; record.childSignal = signal;
          resolve(finish());
        });
      } catch { stopped = 'QUEUE_START_OR_LEDGER_FAILURE'; resolve(finish()); }
    });
  };
  const receiver = Object.freeze({ deliver, receipts: () => Object.freeze([...records]) });
  states.set(receiver, { note });
  return receiver;
}

// The production caller supplies this hook before starting its finite product run.
// Delivery errors are separate observations and never replace its original value/error.
export async function withProductOwnerReturn(runProduct, describeTerminal, receiver) {
  const state = states.get(receiver);
  if (typeof runProduct !== 'function' || typeof describeTerminal !== 'function' || !state)
    fail('INVALID_OWNER_RETURN_CALLER');
  let value, originalError, rejected = false;
  try { value = await runProduct(); } catch (error) { rejected = true; originalError = error; }
  try {
    const event = describeTerminal({ rejected, value, error: originalError });
    if (event && typeof event.then === 'function') {
      // An unsupported async description must not leave an unhandled rejection.
      Promise.resolve(event).catch(() => {});
      fail('ASYNC_TERMINAL_DESCRIPTION');
    }
    await receiver.deliver(event);
  } catch {
    state.note({ schema: 'jev.exact-owner-return-undelivered.v1', status: 'NOT_SENT_OR_UNKNOWN',
      errorCode: 'TERMINAL_CALLBACK_FAILED', enqueueStatus: 'UNKNOWN', consumptionStatus: 'NOT_OBSERVED', retries: 0 });
  }
  if (rejected) throw originalError;
  return value;
}


// Explicit host-only protocol. Commands are data, never code or fabricated MCP metadata.
// The approved host driver, not this Node module, owns actual tool provenance.
export function bindExactOwnerHostReturn(options, testRuntime) {
  const keys = ['mode', 'ownerThread', 'hostId', 'runId', 'sourceSha', 'ledgerDir', 'expiresAt', 'timeoutMs'];
  const ownData = (value, names) => exact(value, names) && Reflect.ownKeys(value).length === names.length
    && names.every(key => { const d = Object.getOwnPropertyDescriptor(value, key);
      return Object.hasOwn(d, 'value') && (d.value === null || ['string', 'number', 'boolean'].includes(typeof d.value)); });
  if (!ownData(options, keys)) fail('INVALID_HOST_OWNER_RETURN_BINDING');
  const { mode, ownerThread, hostId, runId, sourceSha, ledgerDir, expiresAt, timeoutMs } = options;
  if (!['live', 'test-double'].includes(mode) || !uuid.test(ownerThread) || !uuid.test(runId)
      || !sha40.test(sourceSha) || hostId !== 'local' || typeof ledgerDir !== 'string'
      || !path.isAbsolute(ledgerDir) || /[\0\r\n]/u.test(ledgerDir)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))
      || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt)
    fail('INVALID_HOST_OWNER_RETURN_BINDING');
  if (mode === 'live' && testRuntime !== undefined) fail('LIVE_RUNTIME_OVERRIDE');
  const runtime = mode === 'live'
    ? { now: Date.now, ownerThread: () => process.env.CODEX_THREAD_ID, nonce: randomUUID }
    : testRuntime;
  if (!runtime || !['now', 'ownerThread', 'nonce'].every(key => typeof runtime[key] === 'function'))
    fail('INVALID_HOST_OWNER_RETURN_RUNTIME');
  let directory;
  try { directory = fs.lstatSync(ledgerDir); } catch { fail('INVALID_OWNER_RETURN_LEDGER'); }
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('INVALID_OWNER_RETURN_LEDGER');
  const binding = Object.freeze({ mode, ownerThread, hostId, runId, sourceSha, ledgerDir, expiresAt, timeoutMs });
  const bindingSha256 = hash(JSON.stringify(binding));
  const records = [];
  const note = value => { records.push(Object.freeze(value)); return records.at(-1); };
  let used = false, record = null, claim = null, pending = null, finalized = false;
  const now = () => {
    const value = runtime.now();
    if (!Number.isSafeInteger(value)) fail('INVALID_HOST_OWNER_CLOCK');
    return value;
  };
  const finish = (status, code = null) => {
    if (finalized) return records.at(-1);
    finalized = true; pending = null;
    record.status = status; record.errorCode = code; record.completedAt = new Date(now()).toISOString();
    try { fs.writeFileSync(path.join(claim, 'receipt.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { record.status = 'RECEIPT_WRITE_FAILED'; record.errorCode = 'RECEIPT_WRITE_FAILED'; }
    return note(record);
  };
  const gate = () => {
    if (!record || finalized) return false;
    if (runtime.ownerThread() !== ownerThread) { finish('HOLD', 'OWNER_THREAD_MISMATCH'); return false; }
    const current = now();
    if (current < Date.parse(record.startedAt)) { finish('HOLD', 'HOST_CLOCK_REWIND'); return false; }
    if (current >= Date.parse(expiresAt)) { finish('HOLD', 'OWNER_RETURN_EXPIRED'); return false; }
    if (record.statusObservedAt !== null && (current < Date.parse(record.statusObservedAt)
        || current - Date.parse(record.statusObservedAt) > timeoutMs)) {
      finish('HOLD', 'STALE_HOST_OBSERVATION'); return false;
    }
    if (pending?.takenAt !== null && pending?.takenAt !== undefined
        && now() - pending.takenAt > timeoutMs) { finish('HOLD', 'HOST_OBSERVATION_TIMEOUT'); return false; }
    return true;
  };
  const command = (kind, tool, args, sequence) => Object.freeze({
    schema: 'jev.host-owner-command.v1', kind, commandId: runId + '/host-return/' + sequence,
    ownerThread, hostId, runId, sourceSha, bindingSha256, eventSha256: record.eventSha256,
    expiresAt, tool, arguments: Object.freeze(args)
  });
  let notice;
  const deliver = async inputEvent => {
    if (used) fail('OWNER_RETURN_ALREADY_CONSUMED');
    used = true;
    const v2 = ownData(inputEvent, [...eventKeys, 'transportLifecycle', 'executorInvocations'])
      && inputEvent.schema === 'jev.product-terminal-event.v2';
    const v1 = ownData(inputEvent, eventKeys) && inputEvent.schema === 'jev.product-terminal-event.v1';
    const lifecycle = v2 && Number.isSafeInteger(inputEvent.executorInvocations)
      && (inputEvent.executorInvocations === 0
        ? inputEvent.transportLifecycle === 'NO_EXECUTOR_INVOCATION' && inputEvent.physicalCloseObserved === false
        : inputEvent.executorInvocations > 0 && inputEvent.transportLifecycle === 'LOCAL_SSH_CLOSED'
          && inputEvent.physicalCloseObserved === true);
    if ((!v1 && !lifecycle) || inputEvent.ownerThread !== ownerThread || inputEvent.runId !== runId
        || inputEvent.sourceSha !== sourceSha || !['COMPLETED', 'FAILED', 'HOLD', 'RETURN_P', 'TERMINAL'].includes(inputEvent.outcome)
        || !sha64.test(inputEvent.resultSha256) || !sha64.test(inputEvent.transportReceiptSha256)
        || (v1 && inputEvent.physicalCloseObserved !== true)) fail('INVALID_OWNER_RETURN_EVENT');
    if (runtime.ownerThread() !== ownerThread) fail('OWNER_THREAD_MISMATCH');
    if (now() >= Date.parse(expiresAt)) fail('OWNER_RETURN_EXPIRED');
    const nonce = runtime.nonce();
    if (!uuid.test(nonce)) fail('INVALID_OWNER_RETURN_NONCE');
    const event = Object.freeze({ ...inputEvent }), eventSha256 = hash(JSON.stringify(event));
    notice = [
      'Product terminal event for the same P thread.', 'Owner thread: ' + ownerThread,
      'Run: ' + runId, 'Source: ' + sourceSha, 'Outcome: ' + event.outcome,
      'Outcome is one engine-operation terminal, not Goal or G1/G2 completion.',
      'Result SHA256: ' + event.resultSha256, 'Transport receipt SHA256: ' + event.transportReceiptSha256,
      'Event SHA256: ' + eventSha256, 'Delivery expiry UTC: ' + expiresAt, 'Receipt nonce: ' + nonce,
      'A host acknowledgement is neither proof of queueing nor automatic consumption.',
      'Only after this same thread actually consumes the notice, verify its bound local receipt',
      'and record OWNER_RETURN_CONSUMED ' + runId + ' ' + nonce + '.',
      'Recheck current source/refs, expiry and authorization before acting; this notice grants no scope.',
      'Never replay consumed calls. web.chat and periodic automation stay paused.'
    ].join('\n');
    if (Buffer.byteLength(notice) > 2048) fail('OWNER_RETURN_ARGV_LIMIT');
    claim = path.join(ledgerDir, runId); // Same per-run namespace as the explicit CLI receiver.
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch (error) { if (error?.code === 'EEXIST') fail('OWNER_RETURN_ALREADY_CLAIMED'); throw error; }
    record = { schema: 'jev.exact-owner-host-return-receipt.v1', mode, ownerThread, hostId, runId,
      sourceSha, bindingSha256, bindingAuthority: 'DECLARED_ONLY', eventSha256,
      resultSha256: event.resultSha256, transportReceiptSha256: event.transportReceiptSha256,
      outcome: event.outcome, nonce, expiresAt, noticeSha256: hash(notice), noticeBytes: Buffer.byteLength(notice),
      startedAt: new Date(now()).toISOString(), completedAt: null, status: 'HOST_STATUS_READY', errorCode: null,
      statusCommandsIssued: 0, sendCommandsIssued: 0, hostToolInvocations: 'NOT_OBSERVED_BY_LIBRARY',
      statusObservationAuthority: 'HOST_PORT_REPORTED_NOT_AUTHENTICATED_BY_LIBRARY',
      statusObservationSha256: null, statusObservedAt: null, sendObservationSha256: null, idleStatus: 'NOT_OBSERVED',
      hostLifetime: 'NOT_ESTABLISHED_BY_SOURCE', enqueueStatus: 'UNKNOWN',
      consumptionStatus: 'NOT_OBSERVED', remoteEffects: 'NOT_DISPATCHED_BY_SOURCE', retries: 0 };
    try {
      fs.writeFileSync(path.join(claim, 'claim.json'), JSON.stringify({ ...event, eventSha256, nonce, expiresAt,
        bindingSha256, transport: 'host-mcp' }) + '\n', { flag: 'wx', mode: 0o600 });
      pending = { value: command('OBSERVE_OWNER_STATUS', 'codex_app.list_threads', { limit: 1 }, 1), takenAt: null };
    } catch { return finish('HOLD', 'HOST_RETURN_LEDGER_IO'); }
    return Object.freeze({ ...record });
  };
  const takeHostCommand = () => {
    if (!gate()) return null;
    if (!pending || pending.takenAt !== null) { finish('HOLD', 'HOST_COMMAND_ALREADY_TAKEN'); return null; }
    const value = pending.value;
    pending.takenAt = now();
    record[value.kind === 'OBSERVE_OWNER_STATUS' ? 'statusCommandsIssued' : 'sendCommandsIssued']++;
    if (value.kind === 'SEND_OWNER_NOTICE') record.remoteEffects = 'UNKNOWN';
    try { fs.writeFileSync(path.join(claim, value.kind === 'OBSERVE_OWNER_STATUS'
      ? 'host-status.command.json' : 'host-send.command.json'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { finish('HOLD', 'HOST_RETURN_LEDGER_IO'); return null; }
    record.status = value.kind === 'OBSERVE_OWNER_STATUS' ? 'HOST_STATUS_PENDING' : 'HOST_SEND_PENDING';
    return value;
  };
  const observationValid = (id, value, names, schema, kind) => {
    if (!gate()) return false;
    if (!pending || pending.takenAt === null || pending.value.commandId !== id || pending.value.kind !== kind
        || !ownData(value, names) || value.schema !== schema || value.ownerThread !== ownerThread || value.hostId !== hostId) {
      finish('HOLD', 'INVALID_HOST_OBSERVATION'); return false;
    }
    const statusAllowed = kind === 'OBSERVE_OWNER_STATUS'
      ? ['idle', 'active', 'notLoaded', 'systemError', 'unknown'].includes(value.status)
        && ['RUNTIME_TURN_STATUS', 'UNKNOWN'].includes(value.statusMeaning)
      : ['acknowledged', 'failed', 'unknown'].includes(value.status);
    if (!statusAllowed) { finish('HOLD', 'INVALID_HOST_OBSERVATION'); return false; }
    const at = Date.parse(value.observedAt), current = now();
    if (typeof value.observedAt !== 'string' || !Number.isFinite(at)
        || new Date(at).toISOString() !== value.observedAt || at < pending.takenAt || at > current
        || current - at > timeoutMs) { finish('HOLD', 'STALE_HOST_OBSERVATION'); return false; }
    return true;
  };
  const acceptHostObservation = (id, value) => {
    if (!observationValid(id, value, ['schema', 'ownerThread', 'hostId', 'status', 'observedAt', 'statusMeaning'],
      'jev.host-owner-status.v1', 'OBSERVE_OWNER_STATUS')) return records.at(-1) ?? null;
    record.statusObservationSha256 = hash(JSON.stringify(value));
    record.statusObservedAt = value.observedAt;
    record.idleStatus = value.status === 'idle' ? 'HOST_PORT_REPORTED_IDLE' : 'NOT_IDLE_OR_UNKNOWN';
    try { fs.writeFileSync(path.join(claim, 'host-status.observation.json'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { return finish('HOLD', 'HOST_RETURN_LEDGER_IO'); }
    if (value.status !== 'idle' || value.statusMeaning !== 'RUNTIME_TURN_STATUS')
      return finish('HOLD', 'OWNER_IDLE_NOT_ESTABLISHED');
    pending = { value: command('SEND_OWNER_NOTICE', 'codex_app.send_message_to_thread', {
      threadId: ownerThread, hostId, prompt: notice
    }, 2), takenAt: null };
    record.status = 'HOST_SEND_READY';
    return Object.freeze({ ...record });
  };
  const acceptHostSendResult = (id, value) => {
    if (!observationValid(id, value, ['schema', 'ownerThread', 'hostId', 'status', 'observedAt'],
      'jev.host-owner-send-observation.v1', 'SEND_OWNER_NOTICE')) return records.at(-1) ?? null;
    record.sendObservationSha256 = hash(JSON.stringify(value));
    try { fs.writeFileSync(path.join(claim, 'host-send.observation.json'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { return finish('HOLD', 'HOST_RETURN_LEDGER_IO'); }
    if (value.status === 'acknowledged') return finish('HOST_ACK_REPORTED_NOT_CONSUMED');
    return finish('HOLD', value.status === 'failed' ? 'HOST_SEND_FAILED_REPORTED' : 'HOST_SEND_UNKNOWN');
  };
  const receiver = Object.freeze({ deliver, takeHostCommand, acceptHostObservation, acceptHostSendResult,
    receipts: () => { gate(); return Object.freeze(record && !finalized ? [...records, Object.freeze({ ...record })] : [...records]); }
  });
  states.set(receiver, { note });
  return receiver;
}
