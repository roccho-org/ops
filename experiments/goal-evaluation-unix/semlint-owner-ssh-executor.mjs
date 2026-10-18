import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotJson, exact } from '../../packages/jev-review/semlint-entry.mjs';

export class SemlintOwnerSSHError extends Error {
  constructor(code) { super(code); this.name = 'SemlintOwnerSSHError'; this.code = code; }
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex40 = /^[a-f0-9]{40}$/;
const launcherPath = /^\/nix\/store\/[0-9a-z]{32}-ops-semlint-owner\/bin\/ops-semlint-owner$/;
const optionKeys = ['sshPath', 'host', 'envsSha', 'opsSha', 'runId', 'ledgerDir', 'deadlineMs', 'remoteLauncherPath', 'resourcesSha'];
const MAX_INPUT = 1048576, MAX_STDOUT = 1048576, MAX_STDERR = 16384;
const fail = code => { throw new SemlintOwnerSSHError(code); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function parseOutput(bytes) {
  const text = decode(bytes);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r'))
    fail('executor_contract_error');
  const result = JSON.parse(text);
  if (!plain(result) || result.schema !== 'ops.semlint.real-result.v3')
    fail('executor_contract_error');
  // The caller validates the complete result against its same admitted prepared plan.
  if (JSON.stringify(result) + '\n' !== text) fail('executor_contract_error');
  return result;
}

// Host transport only. Pins/alias/path are declarations until separately admitted against
// the actual SSH configuration, host key, installed wrapper and target source identities.
export function bindSemlintOwnerSSHExecutor(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => !optionKeys.includes(key)))
    throw new Error('INVALID_SEMLINT_OWNER_SSH_EXECUTOR');
  const { sshPath, host, envsSha, opsSha, runId, ledgerDir, resourcesSha, deadlineMs = 95000 } = options;
  const maxCalls = 1;
  const hasRemoteLauncherPath = Object.hasOwn(options, 'remoteLauncherPath');
  const remoteLauncherPath = hasRemoteLauncherPath ? options.remoteLauncherPath : undefined;
  if (typeof sshPath !== 'string' || !path.isAbsolute(sshPath) || /[\u0000\r\n]/u.test(sshPath)
      || typeof host !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(host)
      || !hasRemoteLauncherPath || (hasRemoteLauncherPath && (typeof remoteLauncherPath !== 'string'
        || !launcherPath.test(remoteLauncherPath) || /[\u0000\r\n]/u.test(remoteLauncherPath)))
      || typeof envsSha !== 'string' || !hex40.test(envsSha)
      || typeof opsSha !== 'string' || !hex40.test(opsSha)
      || typeof resourcesSha !== 'string' || !hex40.test(resourcesSha)
      || typeof runId !== 'string' || !uuid.test(runId)
      || typeof ledgerDir !== 'string' || !path.isAbsolute(ledgerDir)
      || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 95000
      || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 5)
    throw new Error('INVALID_SEMLINT_OWNER_SSH_EXECUTOR');
  const root = fs.lstatSync(ledgerDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('INVALID_SEMLINT_OWNER_SSH_LEDGER');
  const argv = Object.freeze(['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--',
    host, remoteLauncherPath,
    '--envs-sha', envsSha, '--ops-sha', opsSha]);
  // Preserve the original manifest bytes when the optional absolute launcher is omitted.
  const bindingJson = JSON.stringify({ sshPath, host, envsSha, opsSha, resourcesSha, runId, argv, deadlineMs, maxCalls,
    ...(hasRemoteLauncherPath ? { remoteLauncherPath } : {}) }) + '\n';
  const bindingSha256 = sha(bindingJson);
  const records = [];
  let calls = 0;

  const executePlan = async (request, callOptions = {}) => {
    if (!plain(callOptions) || Object.keys(callOptions).some(key => !['callId', 'signal'].includes(key)))
      fail('executor_contract_error');
    const { callId, signal } = callOptions;
    const match = typeof callId === 'string' && callId.match(/^([a-f0-9-]+)\/(evaluate)\/(1)$/);
    if (!match || match[1] !== runId || Number(match[3]) > maxCalls
        || (signal !== undefined && !(signal instanceof AbortSignal)))
      fail('executor_contract_error');
    if (calls >= maxCalls) fail('executor_contract_error');
    calls++;
    // Atomic persisted claim protects against replay by another factory/process too.
    // Never remove a failed/partial claim or convert an unknown call into a retry.
    // A sequence is unique across both kinds, bounding the run even across factories.
    const claim = path.join(ledgerDir, runId + '.' + match[3]);
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch { fail('executor_contract_error'); }
    const stdinPath = path.join(claim, 'request.stdin');
    const stdoutPath = path.join(claim, 'response.stdout');
    const stderrPath = path.join(claim, 'response.stderr');
    const receiptPath = path.join(claim, 'receipt.json');
    const record = {
      schema: 'semlint.owner-ssh-executor-receipt.v1', callId, bindingSha256, bindingAuthority: 'DECLARED_ONLY',
      declaredHost: host, declaredSshPath: sshPath, declaredEnvsSha: envsSha, declaredOpsSha: opsSha, declaredResourcesSha: resourcesSha,
      declaredRemoteLauncherPath: hasRemoteLauncherPath ? remoteLauncherPath : null,
      startedAt: new Date().toISOString(), completedAt: null, status: 'CLAIMED', errorCode: null,
      spawnInvocations: 0, childPid: null, childExitCode: null, childSignal: null,
      childErrorCode: null, physicalCloseObserved: false, closeGraceExpired: false,
      childKillReturn: null, childKillErrorCode: null, remoteEffects: 'NOT_DISPATCHED_BY_EXECUTOR',
      ownerPlanBytes: null, ownerPlanSha256: null, stdinBytes: null, stdinSha256: null,
      stdinWriteCompleted: false, stdoutBytes: null, stdoutSha256: null, stdoutComplete: false,
      stderrBytes: null, stderrSha256: null, stderrComplete: false,
      stdoutObservedBytesLowerBound: 0, stderrObservedBytesLowerBound: 0,
      remoteStdinByteIdentity: 'UNREPORTED', backendIdentityStatus: 'UNKNOWN', cleanupFailed: false,
      stdinPath, stdoutPath, stderrPath, receiptPath
    };
    let outFd, errFd, child, input, stdoutKept = 0, stderrKept = 0;
    let outOverflow = false, errOverflow = false, ioFailure = false;
    let abort, timer, closeTimer, resolveClosed, stoppedCode = null, finalized = false;
    const stop = code => {
      if (stoppedCode || finalized) return;
      stoppedCode = code;
      // This controls the local SSH process only. Remote work/costs remain UNKNOWN.
      if (child && child.exitCode === null && child.signalCode === null) {
        try { record.childKillReturn = child.kill('SIGKILL') === true; }
        catch (error) { record.childKillErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN'; }
      }
      if (child && !record.physicalCloseObserved) closeTimer = setTimeout(() => {
        if (finalized || record.physicalCloseObserved) return;
        record.closeGraceExpired = true;
        // Never invent a close/exit when the process or inherited pipes did not close.
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream.destroy(); } catch { record.cleanupFailed = true; }
        }
        try { child.unref?.(); } catch { record.cleanupFailed = true; }
        resolveClosed?.();
      }, 250);
    };
    try {
      const manifest = path.join(ledgerDir, runId + '.binding.json');
      try { fs.writeFileSync(manifest, bindingJson, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error?.code !== 'EEXIST') fail('executor_failed');
        const stat = fs.lstatSync(manifest);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(bindingJson)
            || fs.readFileSync(manifest, 'utf8') !== bindingJson) fail('executor_contract_error');
      }
      if (signal?.aborted) fail('cancelled');
      if (!plain(request)) fail('executor_contract_error');
      const captured = snapshotJson(request);
      if (!exact(captured, Object.hasOwn(captured, 'limits') ? ['schema', 'cases', 'limits'] : ['schema', 'cases'])
          || captured.schema !== 'ops.semlint.real-input.v1' || !Array.isArray(captured.cases)
          || captured.cases.length < 1 || captured.cases.length > 24) fail('executor_contract_error');
      const serialized = JSON.stringify(captured);
      input = Buffer.from(serialized + '\n', 'utf8');
      if (input.length > MAX_INPUT) fail('executor_contract_error');
      record.ownerPlanBytes = Buffer.byteLength(serialized);
      record.ownerPlanSha256 = sha(serialized);
      record.stdinBytes = input.length;
      record.stdinSha256 = sha(input);
      fs.writeFileSync(stdinPath, input, { flag: 'wx', mode: 0o600 });
      outFd = fs.openSync(stdoutPath, 'wx', 0o600);
      errFd = fs.openSync(stderrPath, 'wx', 0o600);
      const env = {};
      const excluded = ['TYPELLM_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
      for (const key of Object.keys(process.env)) if (!excluded.includes(key)) env[key] = process.env[key];
      record.spawnInvocations = 1;
      record.remoteEffects = 'UNKNOWN';
      record.status = 'IN_FLIGHT';
      child = childProcess.spawn(sshPath, [...argv], { shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], env });
      record.childPid = Number.isInteger(child.pid) ? child.pid : null;
      const capture = (stream, chunk) => {
        if (finalized || ioFailure) return;
        const stdout = stream === 'stdout';
        const cap = stdout ? MAX_STDOUT : MAX_STDERR;
        const kept = stdout ? stdoutKept : stderrKept;
        record[stdout ? 'stdoutObservedBytesLowerBound' : 'stderrObservedBytesLowerBound'] += chunk.length;
        const prefix = chunk.subarray(0, Math.max(0, cap - kept));
        try {
          for (let offset = 0; offset < prefix.length;) {
            const written = fs.writeSync(stdout ? outFd : errFd, prefix, offset, prefix.length - offset);
            if (written < 1) throw new Error('STDIO_WRITE_INCOMPLETE');
            offset += written;
            if (stdout) stdoutKept += written; else stderrKept += written;
          }
        } catch { ioFailure = true; stop('executor_failed'); }
        if (chunk.length > prefix.length) {
          if (stdout) outOverflow = true; else errOverflow = true;
          stop('executor_contract_error');
        }
      };
      child.stdout.on('data', chunk => capture('stdout', chunk));
      child.stderr.on('data', chunk => capture('stderr', chunk));
      child.stdout.on('error', () => { ioFailure = true; stop('executor_failed'); });
      child.stderr.on('error', () => { ioFailure = true; stop('executor_failed'); });
      child.stdin.on('error', () => { ioFailure = true; stop('executor_failed'); });
      const closed = new Promise(resolve => {
        resolveClosed = resolve;
        child.on('error', error => { if (!finalized) record.childErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN'; });
        child.once('close', (code, childSignal) => {
          if (finalized) return;
          record.physicalCloseObserved = true;
          record.childExitCode = Number.isInteger(code) ? code : null;
          record.childSignal = typeof childSignal === 'string' ? childSignal : null;
          resolve();
        });
      });
      abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('executor_timeout'), deadlineMs);
      if (signal?.aborted) abort();
      if (!stoppedCode) child.stdin.end(input, error => {
        if (finalized) return;
        if (error) { ioFailure = true; stop('executor_failed'); }
        else record.stdinWriteCompleted = true;
      });
      await closed;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      fs.closeSync(outFd); outFd = undefined;
      fs.closeSync(errFd); errFd = undefined;
      const out = fs.readFileSync(stdoutPath), err = fs.readFileSync(stderrPath);
      record.stdoutBytes = out.length; record.stdoutSha256 = sha(out);
      record.stderrBytes = err.length; record.stderrSha256 = sha(err);
      record.stdoutComplete = record.physicalCloseObserved && !outOverflow && !ioFailure;
      record.stderrComplete = record.physicalCloseObserved && !errOverflow && !ioFailure;
      if (stoppedCode) fail(stoppedCode);
      if (ioFailure || record.childErrorCode || record.childExitCode !== 0 || record.childSignal
          || !record.stdinWriteCompleted) fail('executor_failed');
      let returned;
      try { returned = parseOutput(out); }
      catch { fail('executor_contract_error'); }
      record.status = 'RETURNED';
      return returned;
    } catch (error) {
      record.status = 'FAILED';
      if (!child && record.spawnInvocations === 1 && !(error instanceof SemlintOwnerSSHError))
        record.childErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      record.errorCode = error instanceof SemlintOwnerSSHError ? error.code : 'executor_failed';
      throw new SemlintOwnerSSHError(record.errorCode);
    } finally {
      finalized = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      let closeFailed = false;
      for (const fd of [outFd, errFd]) if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { closeFailed = true; }
      }
      if (closeFailed) { record.status = 'FAILED'; record.errorCode = 'executor_failed'; }
      record.completedAt = new Date().toISOString();
      // The receipt is private and flat; raw case-bearing stdio never enters public logs.
      // A failed receipt write is itself a failed invocation, not a reason to retry SSH.
      try { fs.writeFileSync(receiptPath, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { record.status = 'FAILED'; record.errorCode = 'executor_failed'; records.push(Object.freeze(record)); fail('executor_failed'); }
      records.push(Object.freeze(record));
      if (closeFailed) fail('executor_failed');
    }
  };
  return Object.freeze({ executePlan, bindingSha256, receipts: () => Object.freeze([...records]) });
}
