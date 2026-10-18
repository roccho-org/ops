import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TypedProviderError } from '../../packages/typellm/src/typellm.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex40 = /^[a-f0-9]{40}$/;
const optionKeys = ['sshPath', 'host', 'envsSha', 'opsSha', 'runId', 'ledgerDir', 'deadlineMs', 'maxCalls'];
const frameKeys = ['schema', 'stdinComplete', 'stdinBytes', 'stdinSha256', 'responseMetadataStatus',
  'metadataSchema', 'publicModelStatus', 'reportedPublicModel', 'responseIdStatus',
  'providerResponseId', 'backendIdentityStatus'];
const BEGIN = 'TYPELLM_RESPONSE_METADATA_JSON_BEGIN';
const END = 'TYPELLM_RESPONSE_METADATA_JSON_END';
const MAX_INPUT = 131072, MAX_STDOUT = 1048576, MAX_STDERR = 16384;
const fail = code => { throw new TypedProviderError(code); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const publicString = value => typeof value === 'string' && value.length > 0 && value.isWellFormed()
  && value.trim() === value && value.length <= 256 && Buffer.byteLength(value) <= 256
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const statusPair = (status, value) => status === 'OBSERVED' ? publicString(value)
  : ['ABSENT', 'INVALID'].includes(status) && value === null;

function parseFrame(bytes, input) {
  const lines = decode(bytes).split('\n');
  const begins = [], ends = [];
  lines.forEach((line, i) => { if (line === BEGIN) begins.push(i); if (line === END) ends.push(i); });
  if (begins.length !== 1 || ends.length !== 1 || ends[0] !== begins[0] + 2
      || ends[0] === lines.length - 1)
    fail('executor_contract_error');
  const meta = JSON.parse(lines[begins[0] + 1]);
  if (!plain(meta) || JSON.stringify(meta) !== lines[begins[0] + 1]
      || Object.keys(meta).length !== frameKeys.length
      || Object.keys(meta).some(key => !frameKeys.includes(key))
      || meta.schema !== 'typellm.cli-response-metadata.v1' || meta.stdinComplete !== true
      || meta.stdinBytes !== input.length || meta.stdinSha256 !== sha(input)
      || meta.backendIdentityStatus !== 'UNKNOWN') fail('executor_contract_error');
  if (meta.responseMetadataStatus === 'SDK_OBSERVATION_AVAILABLE') {
    if (meta.metadataSchema !== 'typellm.response-metadata.v1'
        || !statusPair(meta.publicModelStatus, meta.reportedPublicModel)
        || !statusPair(meta.responseIdStatus, meta.providerResponseId)) fail('executor_contract_error');
  } else fail('executor_contract_error');
  return meta;
}

function parseOutput(bytes) {
  const text = decode(bytes);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r'))
    fail('executor_contract_error');
  const result = JSON.parse(text);
  if (!plain(result) || !Object.hasOwn(result, 'result')
      || Object.keys(result).some(key => !['result', 'usage', 'elapsed'].includes(key)))
    fail('executor_contract_error');
  // The caller's existing generateTyped validation still validates the answer/schema/usage.
  return result;
}

// Host transport only. Pins/alias/path are declarations until separately admitted against
// the actual SSH configuration, host key, installed wrapper and target source identities.
export function bindTypeLLMSSHExecutor(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => !optionKeys.includes(key)))
    throw new Error('INVALID_TYPELLM_SSH_EXECUTOR');
  const { sshPath, host, envsSha, opsSha, runId, ledgerDir, deadlineMs = 95000, maxCalls = 5 } = options;
  if (typeof sshPath !== 'string' || !path.isAbsolute(sshPath) || /[\u0000\r\n]/u.test(sshPath)
      || typeof host !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(host)
      || typeof envsSha !== 'string' || !hex40.test(envsSha)
      || typeof opsSha !== 'string' || !hex40.test(opsSha)
      || typeof runId !== 'string' || !uuid.test(runId)
      || typeof ledgerDir !== 'string' || !path.isAbsolute(ledgerDir)
      || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 95000
      || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 5)
    throw new Error('INVALID_TYPELLM_SSH_EXECUTOR');
  const root = fs.lstatSync(ledgerDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('INVALID_TYPELLM_SSH_LEDGER');
  const argv = Object.freeze(['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--',
    host, 'ops-typellm', '--envs-sha', envsSha, '--ops-sha', opsSha, '--response-metadata']);
  const bindingJson = JSON.stringify({ sshPath, host, envsSha, opsSha, runId, argv, deadlineMs, maxCalls }) + '\n';
  const bindingSha256 = sha(bindingJson);
  const records = [];
  let calls = 0;

  const executeTyped = async (request, callOptions = {}) => {
    if (!plain(callOptions) || Object.keys(callOptions).some(key => !['callId', 'signal'].includes(key)))
      fail('executor_contract_error');
    const { callId, signal } = callOptions;
    const match = typeof callId === 'string' && callId.match(/^([a-f0-9-]+)\/(proposal|judgment)\/([1-5])$/);
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
      schema: 'typellm.ssh-executor-receipt.v1', callId, bindingSha256, bindingAuthority: 'DECLARED_ONLY',
      declaredHost: host, declaredSshPath: sshPath, declaredEnvsSha: envsSha, declaredOpsSha: opsSha,
      startedAt: new Date().toISOString(), completedAt: null, status: 'CLAIMED', errorCode: null,
      spawnInvocations: 0, childPid: null, childExitCode: null, childSignal: null,
      childErrorCode: null, physicalCloseObserved: false, closeGraceExpired: false,
      childKillReturn: null, childKillErrorCode: null, remoteEffects: 'NOT_DISPATCHED_BY_EXECUTOR',
      typedRequestBytes: null, typedRequestSha256: null, stdinBytes: null, stdinSha256: null,
      stdinWriteCompleted: false, stdoutBytes: null, stdoutSha256: null, stdoutComplete: false,
      stderrBytes: null, stderrSha256: null, stderrComplete: false,
      stdoutObservedBytesLowerBound: 0, stderrObservedBytesLowerBound: 0,
      responseMetadataStatus: 'UNVERIFIED', publicModelStatus: 'UNKNOWN', reportedPublicModel: null,
      responseIdStatus: 'UNKNOWN', providerResponseId: null, backendIdentityStatus: 'UNKNOWN',
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
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref?.();
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
      const serialized = JSON.stringify(request);
      input = Buffer.from(serialized + '\n', 'utf8');
      if (input.length > MAX_INPUT) fail('executor_contract_error');
      record.typedRequestBytes = Buffer.byteLength(serialized);
      record.typedRequestSha256 = sha(serialized);
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
        child.once('error', error => { if (!finalized) record.childErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN'; });
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
      let meta, returned;
      try { meta = parseFrame(err, input); returned = parseOutput(out); }
      catch { fail('executor_contract_error'); }
      for (const key of ['responseMetadataStatus', 'publicModelStatus', 'reportedPublicModel',
        'responseIdStatus', 'providerResponseId']) record[key] = meta[key];
      record.status = 'RETURNED';
      return returned;
    } catch (error) {
      record.status = 'FAILED';
      if (!child && record.spawnInvocations === 1 && !(error instanceof TypedProviderError))
        record.childErrorCode = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      record.errorCode = error instanceof TypedProviderError ? error.code : 'executor_failed';
      throw new TypedProviderError(record.errorCode);
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
  return Object.freeze({ executeTyped, bindingSha256, receipts: () => Object.freeze([...records]) });
}
