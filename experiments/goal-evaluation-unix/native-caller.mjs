import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotJson, exact } from '../../packages/jev-review/semlint-entry.mjs';
import { plan, judge } from './core.mjs';
import { bindTypeLLMSSHExecutor } from './typellm-ssh-executor.mjs';
import { bindTypeLLMExecutorPorts } from './typellm-executor-ports.mjs';
import { bindExactOwnerReturn, withProductOwnerReturn } from '../../packages/jev-dispatcher/exact-owner-return.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const ownCodes = new Set(['BYTE_LIMIT', 'INVALID_REQUEST', 'INVALID_PLAN', 'INVALID_PROPOSAL',
  'INVALID_PORT', 'INVALID_CORE', 'CORE_MISMATCH', 'INVALID_LIMITS', 'INVALID_ENTRY_INPUT',
  'INVALID_CLAUSE', 'CLAUSE_QUOTE_NOT_FOUND', 'CLAUSE_LIMIT_OR_ID', 'QUESTION_LIMIT_OR_ID',
  'INVALID_QUESTION', 'REQUIRED_REF_NOT_SUPPLIED', 'INVALID_CRITERIA', 'INVALID_MISSING']);
const safeCode = error => ownCodes.has(error?.message) ? error.message : 'NATIVE_OPERATION_FAILED';
const keys = ['id', 'mode', 'operation', 'runId', 'sourceSha', 'ledgerDir', 'ssh', 'ownerReturn',
  'deadlineMs', 'maxCalls', 'maxBytes', 'maxQuestions', 'maxClauses', 'cores',
  'proposalFormat', 'requestTimeoutSeconds'];
const sshKeys = ['sshPath', 'host', 'envsSha', 'opsSha', 'ledgerDir'];
const returnKeys = ['codexPath', 'endpoint', 'ownerThread', 'ledgerDir', 'expiresAt', 'timeoutMs'];
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_NATIVE_PRODUCT_LEDGER');
  let stat;
  try { stat = fs.lstatSync(value); } catch { fail('INVALID_NATIVE_PRODUCT_LEDGER'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_NATIVE_PRODUCT_LEDGER');
}
function bounded(value, fallback, maximum) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail('INVALID_NATIVE_PRODUCT_LIMIT');
  return number;
}

// One finite product operation owns both the actual transport and its terminal descriptor.
// Binding metadata is declared source/target intent; external source admission is still required.
export function bindNativeProductCaller(options, testRuntime) {
  const input = snapshotJson(options);
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)))
    fail('INVALID_NATIVE_PRODUCT_CALLER');
  const { id, mode, operation, runId, sourceSha, ledgerDir, ssh, ownerReturn,
    deadlineMs, proposalFormat = 'json-string', requestTimeoutSeconds } = input;
  if (typeof id !== 'string' || !id.trim() || !['live', 'test-double'].includes(mode)
      || !['plan', 'judge'].includes(operation) || !uuid.test(runId)
      || typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)
      || !ssh || !exact(ssh, sshKeys.concat(Object.hasOwn(ssh, 'remoteLauncherPath') ? ['remoteLauncherPath'] : []))
      || !exact(ownerReturn, returnKeys)
      || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 95000
      || !['json-string', 'typed-relations-v1', 'typed-relations-dependent-v1'].includes(proposalFormat)
      || (Object.hasOwn(input, 'requestTimeoutSeconds') && requestTimeoutSeconds !== 60))
    fail('INVALID_NATIVE_PRODUCT_CALLER');
  if (mode === 'live' && testRuntime !== undefined) fail('LIVE_RUNTIME_OVERRIDE');
  if (mode === 'test-double' && (!testRuntime || !exact(testRuntime, ['ownerReturn'])))
    fail('INVALID_NATIVE_PRODUCT_RUNTIME');
  const owner = mode === 'live' ? () => process.env.CODEX_THREAD_ID : testRuntime.ownerReturn?.ownerThread;
  if (typeof owner !== 'function' || owner() !== ownerReturn.ownerThread) fail('OWNER_THREAD_MISMATCH');
  directory(ledgerDir);
  const maxCalls = bounded(input.maxCalls, operation === 'plan' ? 1 : 4, operation === 'plan' ? 1 : 4);
  const limits = {
    maxBytes: bounded(input.maxBytes, 28000, 65536),
    maxQuestions: bounded(input.maxQuestions, 4, 4),
    maxClauses: bounded(input.maxClauses, 16, 16), maxCalls
  };
  const cores = freeze(snapshotJson(input.cores === undefined ? [] : input.cores));
  const receiver = bindExactOwnerReturn({
    ...ownerReturn, mode, runId, sourceSha, requireEndpointPresence: true
  }, testRuntime?.ownerReturn);
  const transport = bindTypeLLMSSHExecutor({ ...ssh, runId, deadlineMs, maxCalls });
  const invocationIds = [];
  let pending = 0, consumed = false, latched = false;
  const executeTyped = async (request, callOptions) => {
    // Count before the first await, including local transport rejection before a child exists.
    invocationIds.push(callOptions.callId); pending++;
    try { return await transport.executeTyped(request, callOptions); }
    finally { pending--; }
  };
  const ports = bindTypeLLMExecutorPorts({
    id, mode, runId, deadlineMs, maxCalls, executeTyped,
    executorId: id + '/ssh', bindingSha256: transport.bindingSha256,
    proposalFormat, ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds })
  });
  const binding = freeze({ ...input, limits, transportBindingSha256: transport.bindingSha256 });
  const bindingSha256 = sha(JSON.stringify(binding));
  const records = [];
  const which = async question => {
    if (latched) fail('NATIVE_TRANSPORT_LATCHED');
    try { return await ports.which(question); }
    catch (error) { latched = true; throw error; }
  };

  const run = async value => {
    if (consumed) fail('NATIVE_PRODUCT_ALREADY_CONSUMED');
    consumed = true;
    if (owner() !== ownerReturn.ownerThread) fail('OWNER_THREAD_MISMATCH');
    const claim = path.join(ledgerDir, runId + '.engine');
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch (error) { if (error?.code === 'EEXIST') fail('NATIVE_PRODUCT_ALREADY_CLAIMED'); throw error; }
    fs.writeFileSync(path.join(claim, 'claim.json'), JSON.stringify({
      schema: 'ops.native-product-claim.v1', ownerThread: ownerReturn.ownerThread, runId,
      sourceSha, bindingSha256, operation, bindingAuthority: 'DECLARED_ONLY'
    }) + '\n', { flag: 'wx', mode: 0o600 });
    let terminal;
    const describeTerminal = ({ rejected, value: result, error }) => {
      const actual = transport.receipts(), portRecords = ports.receipts();
      const actualIds = actual.map(record => record.callId);
      const corresponding = actual.length === invocationIds.length
        && new Set(invocationIds).size === invocationIds.length
        && new Set(actualIds).size === actualIds.length
        && invocationIds.every(callId => actualIds.includes(callId));
      const none = invocationIds.length === 0 && actual.length === 0 && pending === 0;
      const closed = invocationIds.length > 0 && corresponding && pending === 0
        && actual.every(record => record.physicalCloseObserved === true);
      const lifecycle = none ? 'NO_EXECUTOR_INVOCATION' : closed ? 'LOCAL_SSH_CLOSED' : 'UNPROVED';
      const operationFailed = rejected || actual.some(record => record.status !== 'RETURNED')
        || portRecords.some(record => record.status === 'FAILED');
      const outcome = operationFailed ? 'FAILED' : operation === 'judge'
        && (result.missing.length || result.judgments.some(row => row.status !== 'OBSERVED' || row.label === 'unknown'))
        ? 'HOLD' : 'COMPLETED';
      const resultBody = JSON.stringify(rejected ? {
        schema: 'ops.native-product-error.v1', errorCode: safeCode(error)
      } : result);
      const receiptBody = JSON.stringify(actual);
      terminal = {
        schema: 'ops.native-product-terminal.v1', mode, ownerThread: ownerReturn.ownerThread,
        runId, sourceSha, bindingSha256, bindingAuthority: 'DECLARED_ONLY', operation,
        outcome, operationStatus: rejected ? 'REJECTED' : 'SETTLED',
        goalCoverage: 'NOT_CERTIFIED', authority: false, utility: 'UNKNOWN',
        resultSha256: sha(resultBody), resultBytes: Buffer.byteLength(resultBody),
        resultKind: rejected ? 'SAFE_ERROR_ENVELOPE' : 'ACTUAL_ENGINE_RESULT',
        resultArtifactBasename: 'engine.result.json', resultArtifactBytes: null,
        resultArtifactSha256: null, resultArtifactStatus: 'NOT_VERIFIED', resultArtifactErrorCode: null,
        transportReceiptSha256: sha(receiptBody), transportReceiptBytes: Buffer.byteLength(receiptBody),
        portReceiptSha256: sha(JSON.stringify(portRecords)),
        executorInvocations: invocationIds.length, transportReceiptCount: actual.length,
        pendingExecutors: pending, correspondingReceipts: corresponding,
        sshSpawnInvocations: actual.reduce((sum, record) => sum + record.spawnInvocations, 0),
        physicalCloseObserved: closed, transportLifecycle: lifecycle,
        coreLogicalCalls: operation === 'judge' && !rejected ? result.calls : null,
        incompleteCount: operation === 'judge' && !rejected
          ? result.judgments.filter(row => row.status === 'INCOMPLETE').length : null,
        unknownCount: operation === 'judge' && !rejected
          ? result.judgments.filter(row => row.status === 'OBSERVED' && row.label === 'unknown').length : null,
        latchedTransportFailure: latched, errorCode: rejected ? safeCode(error) : null,
        remoteEffects: none ? 'NOT_DISPATCHED_BY_CALLER' : 'UNKNOWN'
      };
      // The owned result must already be readable before a queued P can consume the notice.
      const resultArtifact = Buffer.from(resultBody + '\n');
      const resultPath = path.join(claim, 'engine.result.json');
      try {
        fs.writeFileSync(resultPath, resultArtifact, { flag: 'wx', mode: 0o600 });
        const identity = fs.lstatSync(resultPath);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.size !== resultArtifact.length)
          fail('NATIVE_RESULT_ARTIFACT_NOT_VERIFIED');
        const actualResult = fs.readFileSync(resultPath);
        if (!actualResult.equals(resultArtifact) || sha(actualResult) !== sha(resultArtifact))
          fail('NATIVE_RESULT_ARTIFACT_NOT_VERIFIED');
        terminal.resultArtifactBytes = actualResult.length;
        terminal.resultArtifactSha256 = sha(actualResult);
        terminal.resultArtifactStatus = 'VERIFIED_READBACK';
      } catch {
        terminal.resultArtifactErrorCode = 'NATIVE_RESULT_ARTIFACT_NOT_VERIFIED';
        fail('NATIVE_RESULT_ARTIFACT_NOT_VERIFIED');
      }
      // Snapshot actual records privately before forming an event; no case text enters the notice.
      fs.writeFileSync(path.join(claim, 'transport.receipts.json'), receiptBody + '\n', { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(claim, 'terminal.json'), JSON.stringify(terminal) + '\n', { flag: 'wx', mode: 0o600 });
      if (!none && !closed) fail('NATIVE_TRANSPORT_LIFECYCLE_UNPROVED');
      return {
        schema: 'jev.product-terminal-event.v2', ownerThread: ownerReturn.ownerThread,
        runId, sourceSha, outcome, resultSha256: terminal.resultSha256,
        transportReceiptSha256: terminal.transportReceiptSha256,
        physicalCloseObserved: closed, executorInvocations: invocationIds.length,
        transportLifecycle: lifecycle
      };
    };
    try {
      return await withProductOwnerReturn(
        () => operation === 'plan'
          ? plan(value, { propose: ports.propose, cores, ...limits })
          : judge(value, { id, mode, which }, limits),
        describeTerminal, receiver
      );
    } finally {
      const delivery = receiver.receipts().at(-1);
      const record = {
        ...(terminal ?? {
          schema: 'ops.native-product-terminal.v1', mode, ownerThread: ownerReturn.ownerThread,
          runId, sourceSha, operation, outcome: 'HOLD', goalCoverage: 'NOT_CERTIFIED',
          authority: false, errorCode: 'TERMINAL_RECORD_UNAVAILABLE'
        }),
        returnStatus: delivery?.status ?? 'NOT_ATTEMPTED',
        enqueueStatus: delivery?.enqueueStatus ?? 'NOT_ATTEMPTED',
        consumptionStatus: 'NOT_OBSERVED', retries: 0, receiptWriteFailed: false
      };
      try { fs.writeFileSync(path.join(claim, 'receipt.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { record.receiptWriteFailed = true; }
      records.push(Object.freeze(record));
    }
  };
  return Object.freeze({
    run, bindingSha256,
    receipts: () => Object.freeze([...records]),
    returnReceipts: () => receiver.receipts()
  });
}
