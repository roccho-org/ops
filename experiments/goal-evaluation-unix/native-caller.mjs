import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { snapshotJson, exact } from '../../packages/jev-review/semlint-entry.mjs';
import { plan, judge } from './core.mjs';
import { bindTypeLLMSSHExecutor } from './typellm-ssh-executor.mjs';
import { bindTypeLLMExecutorPorts } from './typellm-executor-ports.mjs';
import { bindExactOwnerReturn, bindExactOwnerHostReturn, withProductOwnerReturn } from '../../packages/jev-dispatcher/exact-owner-return.mjs';

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
const hostReturnKeys = ['transport', 'hostId', 'ownerThread', 'ledgerDir', 'expiresAt', 'timeoutMs'];
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
  const hostReturn = ownerReturn?.transport === 'host-mcp';
  if (typeof id !== 'string' || !id.trim() || !['live', 'test-double'].includes(mode)
      || !['plan', 'judge'].includes(operation) || !uuid.test(runId)
      || typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)
      || !ssh || !exact(ssh, sshKeys.concat(Object.hasOwn(ssh, 'remoteLauncherPath') ? ['remoteLauncherPath'] : []))
      || !exact(ownerReturn, hostReturn ? hostReturnKeys.concat(
        ['statusListLimit', 'exchangeTimeoutMs'].filter(key => Object.hasOwn(ownerReturn, key))) : returnKeys)
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
  const receiver = hostReturn
    ? bindExactOwnerHostReturn({ mode, runId, sourceSha, hostId: ownerReturn.hostId,
      ownerThread: ownerReturn.ownerThread, ledgerDir: ownerReturn.ledgerDir,
      expiresAt: ownerReturn.expiresAt, timeoutMs: ownerReturn.timeoutMs,
      ...Object.fromEntries(['statusListLimit', 'exchangeTimeoutMs']
        .filter(key => Object.hasOwn(ownerReturn, key)).map(key => [key, ownerReturn[key]])) }, testRuntime?.ownerReturn)
    : bindExactOwnerReturn({
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
    returnReceipts: () => receiver.receipts(),
    ...(hostReturn ? {
      takeHostCommand: receiver.takeHostCommand,
      acceptHostObservation: receiver.acceptHostObservation,
      acceptHostSendResult: receiver.acceptHostSendResult,
      ...(receiver.holdHostReturn ? { holdHostReturn: receiver.holdHostReturn } : {})
    } : {})
  });
}

const bridgePacketLimit = 16384;
const bridgeResultLimit = 262144;
const bridgeConfigKeys = ['packetDir', 'runId', 'phase'];
const bridgePacketKeys = ['schema', 'phase', 'nonce', 'ownerThread', 'runId', 'sourceSha',
  'bindingSha256', 'eventSha256', 'commandSha256', 'expiresAt', 'commandExpiresAt', 'runnerModuleSha256', 'command'];
const bridgeObservationKeys = ['schema', 'phase', 'nonce', 'ownerThread', 'runId', 'sourceSha',
  'bindingSha256', 'eventSha256', 'commandSha256', 'expiresAt', 'commandExpiresAt', 'runnerModuleSha256',
  'toolStartedAt', 'toolCompletedAt', 'runtimeSampledAt', 'toolResultBytes', 'toolResultSha256',
  'classification', 'observation'];
const projectionKeys = ['schema', 'status', 'classification', 'reportedRawJsonBytes',
  'reportedRawJsonUnits', 'rawSizeStatus'];
const projectedObservationKeys = bridgeObservationKeys.filter(key => !['toolResultBytes',
  'toolResultSha256', 'classification', 'observation'].includes(key)).concat([
  'rawToolResultSha256', 'rawIdentityStatus', 'projectionBytes', 'projectionSha256', 'projection']);
const bridgeSourceHash = () => sha(fs.readFileSync(fileURLToPath(import.meta.url)));
const canonicalBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
function bridgeLocation(options) {
  if (!options || !exact(options, bridgeConfigKeys) || !uuid.test(options.runId)
      || ![1, 2].includes(options.phase)) fail('INVALID_NATIVE_HOST_PACKET');
  directory(options.packetDir);
  const dir = path.join(options.packetDir, options.runId + '.bridge');
  directory(dir);
  return dir;
}
function readBridgeJson(file, maximum = bridgePacketLimit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum)
    fail('INVALID_NATIVE_HOST_PACKET');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let data;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev)
      fail('INVALID_NATIVE_HOST_PACKET');
    const bounded = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bounded.length) {
      const count = fs.readSync(fd, bounded, used, bounded.length - used, null);
      if (!count) break;
      used += count;
    }
    data = bounded.subarray(0, used);
  } finally { fs.closeSync(fd); }
  if (data.length !== before.size) fail('INVALID_NATIVE_HOST_PACKET');
  const value = JSON.parse(data.toString('utf8'));
  if (!canonicalBytes(value).equals(data)) fail('INVALID_NATIVE_HOST_PACKET');
  return value;
}
// A complete packet is published by an exclusive hard link. Keep the wx staging
// inode as original evidence; never fall back to an overwrite-capable rename/copy.
function publishBridgeJson(dir, basename, value) {
  const bytes = canonicalBytes(value);
  if (bytes.length > bridgePacketLimit) fail('INVALID_NATIVE_HOST_PACKET');
  const staging = path.join(dir, basename + '.pending');
  const fd = fs.openSync(staging, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(staging, path.join(dir, basename));
}
function commandPacketValid(packet, binding, phase) {
  if (!packet || !exact(packet, bridgePacketKeys) || packet.schema !== 'ops.native-host-command.v1'
      || packet.phase !== phase || !uuid.test(packet.nonce)
      || typeof packet.eventSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(packet.eventSha256)
      || !utc(packet.commandExpiresAt) || Date.parse(packet.commandExpiresAt) > Date.parse(packet.expiresAt)
      || packet.runnerModuleSha256 !== bridgeSourceHash()
      || ['ownerThread', 'runId', 'sourceSha', 'bindingSha256', 'runnerModuleSha256', 'expiresAt']
        .some(key => packet[key] !== binding[key])) return false;
  const cmd = packet.command;
  if (!cmd || !exact(cmd, ['schema', 'kind', 'commandId', 'ownerThread', 'hostId', 'runId',
    'sourceSha', 'bindingSha256', 'eventSha256', 'expiresAt', 'tool', 'arguments'])
      || cmd.schema !== 'jev.host-owner-command.v1' || cmd.hostId !== 'local'
      || typeof cmd.bindingSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(cmd.bindingSha256)
      || cmd.commandId !== packet.runId + '/host-return/' + phase
      || ['ownerThread', 'runId', 'sourceSha', 'eventSha256', 'expiresAt'].some(key => cmd[key] !== packet[key])
      || packet.commandSha256 !== sha(JSON.stringify(cmd))) return false;
  return phase === 1
    ? cmd.kind === 'OBSERVE_OWNER_STATUS' && cmd.tool === 'codex_app.list_threads'
      && exact(cmd.arguments, ['limit']) && cmd.arguments.limit === binding.statusListLimit
    : cmd.kind === 'SEND_OWNER_NOTICE' && cmd.tool === 'codex_app.send_message_to_thread'
      && exact(cmd.arguments, ['threadId', 'hostId', 'prompt'])
      && cmd.arguments.threadId === packet.ownerThread && cmd.arguments.hostId === 'local'
      && typeof cmd.arguments.prompt === 'string' && Buffer.byteLength(cmd.arguments.prompt) <= 2048;
}

// Normal Node entry for the fixed functions driver: data only, no copied brand,
// eval, tool callback injection, process-environment substitution or raw host RPC.
function readBridgeBinding(config, requiredFormat) {
  const dir = bridgeLocation(config);
  const binding = readBridgeJson(path.join(dir, 'binding.json'));
  const projected = binding.schema === 'ops.native-host-bridge.v2';
  if (!exact(binding, ['schema', 'ownerThread', 'runId', 'sourceSha', 'bindingSha256',
    'runnerModuleSha256', 'expiresAt', 'exchangeTimeoutMs', 'statusListLimit',
    ...(projected ? ['observationFormat', 'callerBindingSha256'] : [])])
      || (!projected && binding.schema !== 'ops.native-host-bridge.v1') || binding.runId !== config.runId
      || !uuid.test(binding.ownerThread) || !/^[a-f0-9]{40}$/.test(binding.sourceSha)
      || !/^[a-f0-9]{64}$/.test(binding.bindingSha256) || !utc(binding.expiresAt)
      || binding.runnerModuleSha256 !== bridgeSourceHash()
      || !Number.isInteger(binding.exchangeTimeoutMs) || binding.exchangeTimeoutMs < 1 || binding.exchangeTimeoutMs > 600000
      || !Number.isInteger(binding.statusListLimit) || binding.statusListLimit < 1 || binding.statusListLimit > 50)
    fail('INVALID_NATIVE_HOST_PACKET');
  if ((projected && (binding.observationFormat !== 'projection-v2'
      || !/^[a-f0-9]{64}$/.test(binding.callerBindingSha256)
      || binding.bindingSha256 !== sha(JSON.stringify({ callerBindingSha256: binding.callerBindingSha256,
        observationFormat: binding.observationFormat }))))
      || (requiredFormat && requiredFormat !== (projected ? 'projection-v2' : 'raw-v1')))
    fail('INVALID_NATIVE_HOST_PACKET');
  return { dir, binding, projected };
}
function readHostCommandPacket(options, allowCompletedTool = false, requiredFormat) {
  const config = snapshotJson(options);
  const { dir, binding } = readBridgeBinding(config, requiredFormat);
  const packet = readBridgeJson(path.join(dir, 'phase-' + config.phase + '.command.json'));
  if (!commandPacketValid(packet, binding, config.phase)) fail('INVALID_NATIVE_HOST_PACKET');
  if (!allowCompletedTool && Date.now() >= Math.min(Date.parse(packet.expiresAt), Date.parse(packet.commandExpiresAt)))
    fail('NATIVE_HOST_PACKET_EXPIRED');
  return freeze(packet);
}
export function readFiniteNativeHostCommand(options) { return readHostCommandPacket(options); }
function ownScalar(value, key) {
  const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    && ['string', 'boolean', 'number'].includes(typeof descriptor.value) ? descriptor.value : undefined;
}
function projectHostToolResult(packet, response, completedAt) {
  const common = { ownerThread: packet.ownerThread, hostId: 'local', observedAt: completedAt };
  if (packet.phase === 2) return {
    classification: response?.isError === true ? 'HOST_TOOL_ERROR_REPORTED' : 'SEND_ACK_CONTRACT_UNKNOWN',
    observation: { schema: 'jev.host-owner-send-observation.v1', ...common,
      status: response?.isError === true ? 'failed' : 'unknown' }
  };
  const unknown = { classification: 'STATUS_SHAPE_OR_IDENTITY_UNKNOWN', observation: {
    schema: 'jev.host-owner-status.v1', ...common, status: 'unknown', statusMeaning: 'UNKNOWN' } };
  if (!response || !exact(response, ['content', 'isError']) || response.isError !== false
      || !Array.isArray(response.content) || response.content.length !== 1) return unknown;
  const block = response.content[0];
  if (!block || !exact(block, ['type', 'text']) || block.type !== 'text' || typeof block.text !== 'string') return unknown;
  let root;
  try { root = JSON.parse(block.text); } catch { return unknown; }
  if (!root || !exact(root, ['schemaVersion', 'sidebarPreferences', 'untrustedDataNotice',
    'pinnedThreads', 'threads', 'sections', 'unavailableHosts', 'unavailableSources'])
      || !Array.isArray(root.pinnedThreads) || !Array.isArray(root.threads)
      || root.pinnedThreads.length + root.threads.length > 1000) return unknown;
  const matches = root.pinnedThreads.concat(root.threads).filter(row => row && !Array.isArray(row)
    && ownScalar(row, 'id') === packet.ownerThread && ownScalar(row, 'hostId') === 'local');
  if (matches.length !== 1 || !['idle', 'active', 'notLoaded', 'systemError'].includes(ownScalar(matches[0], 'status')))
    return unknown;
  return { classification: 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL', observation: {
    schema: 'jev.host-owner-status.v1', ...common, status: ownScalar(matches[0], 'status'),
    statusMeaning: 'RUNTIME_TURN_STATUS' } };
}

// Call only after the one genuine, normally approved tool invocation. The raw
// result is not persisted; record its canonical bytes/hash and narrow projection.
// There is deliberately no guessed success-to-ACK mapping for the send tool.
export function submitFiniteNativeHostToolResult(options, toolResult) {
  const config = snapshotJson(options);
  if (!config || !exact(config, bridgeConfigKeys.concat(['toolStartedAt', 'toolCompletedAt']))
      || !utc(config.toolStartedAt) || !utc(config.toolCompletedAt)
      || Date.parse(config.toolStartedAt) > Date.parse(config.toolCompletedAt)
      || Date.parse(config.toolCompletedAt) > Date.now()) fail('INVALID_NATIVE_HOST_PACKET');
  const location = { packetDir: config.packetDir, runId: config.runId, phase: config.phase };
  const packet = readHostCommandPacket(location, true, 'raw-v1'), dir = bridgeLocation(location);
  const result = snapshotJson(toolResult), raw = Buffer.from(JSON.stringify(result));
  const projection = raw.length <= bridgeResultLimit ? projectHostToolResult(packet, result, config.toolCompletedAt)
    : projectHostToolResult(packet, null, config.toolCompletedAt);
  const { command, schema, ...identity } = packet;
  const observation = { schema: 'ops.native-host-observation.v1', ...identity,
    toolStartedAt: config.toolStartedAt, toolCompletedAt: config.toolCompletedAt,
    runtimeSampledAt: null, toolResultBytes: raw.length, toolResultSha256: sha(raw),
    ...projection };
  publishBridgeJson(dir, 'phase-' + config.phase + '.observation.json', observation);
  return Object.freeze({ phase: config.phase, bytes: canonicalBytes(observation).length,
    sha256: sha(canonicalBytes(observation)), classification: projection.classification });
}

// Self-contained normal-functions projection. No Node/FS/crypto, free text output,
// dynamic tool lookup or raw-response transport. The doc's literal uses this code.
export function projectFiniteHostToolResultForDriver(response, ownerThread, phase) {
  const own = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && Object.hasOwn(d, 'value') ? d.value : undefined;
  };
  const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  const output = { schema: 'ops.host-tool-projection.v1', status: 'unknown',
    classification: 'STATUS_SHAPE_OR_IDENTITY_UNKNOWN', reportedRawJsonBytes: null,
    reportedRawJsonUnits: null, rawSizeStatus: 'NOT_MEASURED' };
  if (phase === 2) {
    output.classification = own(response, 'isError') === true ? 'HOST_TOOL_ERROR_REPORTED' : 'SEND_ACK_CONTRACT_UNKNOWN';
    if (own(response, 'isError') === true) output.status = 'failed';
    return output;
  }
  if (phase !== 1 || !exactKeys(response, ['content', 'isError']) || own(response, 'isError') !== false) return output;
  const content = own(response, 'content'), block = own(content, '0');
  if (!Array.isArray(content) || own(content, 'length') !== 1
      || !exactKeys(block, ['type', 'text']) || own(block, 'type') !== 'text') return output;
  const text = own(block, 'text');
  if (typeof text !== 'string') return output;
  if (text.length > 262144) { output.rawSizeStatus = 'OVER_REPORTED_BOUND'; return output; }
  const json = JSON.stringify({ content: [{ type: 'text', text }], isError: false });
  output.reportedRawJsonUnits = json.length;
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < json.length
        && json.charCodeAt(i + 1) >= 0xdc00 && json.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > 262144) { output.rawSizeStatus = 'OVER_REPORTED_BOUND'; return output; }
  }
  output.reportedRawJsonBytes = bytes; output.rawSizeStatus = 'WITHIN_REPORTED_BOUND';
  let root;
  try { root = JSON.parse(text); } catch { return output; }
  if (!exactKeys(root, ['schemaVersion', 'sidebarPreferences', 'untrustedDataNotice',
    'pinnedThreads', 'threads', 'sections', 'unavailableHosts', 'unavailableSources'])) return output;
  const pinned = own(root, 'pinnedThreads'), threads = own(root, 'threads');
  if (!Array.isArray(pinned) || !Array.isArray(threads) || pinned.length + threads.length > 1000) return output;
  const matches = pinned.concat(threads).filter(row => own(row, 'id') === ownerThread && own(row, 'hostId') === 'local');
  if (matches.length !== 1 || !['idle', 'active', 'notLoaded', 'systemError'].includes(own(matches[0], 'status'))) return output;
  output.status = own(matches[0], 'status');
  output.classification = 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL';
  return output;
}

function validateHostProjection(value, phase) {
  if (!value || !exact(value, projectionKeys) || value.schema !== 'ops.host-tool-projection.v1'
      || !['NOT_MEASURED', 'OVER_REPORTED_BOUND', 'WITHIN_REPORTED_BOUND'].includes(value.rawSizeStatus)
      || (value.reportedRawJsonBytes !== null && (!Number.isSafeInteger(value.reportedRawJsonBytes)
        || value.reportedRawJsonBytes < 0 || value.reportedRawJsonBytes > bridgeResultLimit))
      || (value.reportedRawJsonUnits !== null && (!Number.isSafeInteger(value.reportedRawJsonUnits) || value.reportedRawJsonUnits < 0))
      || (value.rawSizeStatus === 'WITHIN_REPORTED_BOUND' && (value.reportedRawJsonBytes === null || value.reportedRawJsonUnits === null))
      || (value.rawSizeStatus === 'NOT_MEASURED' && (value.reportedRawJsonBytes !== null || value.reportedRawJsonUnits !== null))
      || (value.rawSizeStatus === 'OVER_REPORTED_BOUND' && value.reportedRawJsonBytes !== null))
    fail('INVALID_NATIVE_HOST_PACKET');
  const status = phase === 1 && value.classification === 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL'
    && value.rawSizeStatus === 'WITHIN_REPORTED_BOUND' && ['idle', 'active', 'notLoaded', 'systemError'].includes(value.status);
  const unknown = phase === 1 && value.classification === 'STATUS_SHAPE_OR_IDENTITY_UNKNOWN' && value.status === 'unknown';
  const send = phase === 2 && ((value.classification === 'SEND_ACK_CONTRACT_UNKNOWN' && value.status === 'unknown')
    || (value.classification === 'HOST_TOOL_ERROR_REPORTED' && value.status === 'failed'));
  if (!status && !unknown && !send) fail('INVALID_NATIVE_HOST_PACKET');
  return value;
}
function projectionObservation(packet, projection, completedAt) {
  return { schema: packet.phase === 1 ? 'jev.host-owner-status.v1' : 'jev.host-owner-send-observation.v1',
    ownerThread: packet.ownerThread, hostId: 'local', observedAt: completedAt, status: projection.status,
    ...(packet.phase === 1 ? { statusMeaning: projection.classification === 'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL'
      ? 'RUNTIME_TURN_STATUS' : 'UNKNOWN' } : {}) };
}
export function submitFiniteNativeHostProjection(options, inputProjection) {
  const config = snapshotJson(options);
  if (!config || !exact(config, bridgeConfigKeys.concat(['toolStartedAt', 'toolCompletedAt']))
      || !utc(config.toolStartedAt) || !utc(config.toolCompletedAt)
      || Date.parse(config.toolStartedAt) > Date.parse(config.toolCompletedAt)
      || Date.parse(config.toolCompletedAt) > Date.now()) fail('INVALID_NATIVE_HOST_PACKET');
  const location = { packetDir: config.packetDir, runId: config.runId, phase: config.phase };
  const packet = readHostCommandPacket(location, true, 'projection-v2');
  const projection = validateHostProjection(snapshotJson(inputProjection), packet.phase);
  const { command, schema, ...identity } = packet;
  const data = { schema: 'ops.native-host-observation.v2', ...identity,
    toolStartedAt: config.toolStartedAt, toolCompletedAt: config.toolCompletedAt, runtimeSampledAt: null,
    rawToolResultSha256: null, rawIdentityStatus: 'NOT_OBSERVED_BY_NATIVE',
    projectionBytes: canonicalBytes(projection).length, projectionSha256: sha(canonicalBytes(projection)), projection };
  publishBridgeJson(bridgeLocation(location), 'phase-' + packet.phase + '.observation.json', data);
  return Object.freeze({ phase: packet.phase, projectionBytes: data.projectionBytes,
    projectionSha256: data.projectionSha256, rawToolResultSha256: null, rawIdentityStatus: data.rawIdentityStatus });
}

export function awaitFiniteNativeHostCommand(options) {
  const input = snapshotJson(options);
  if (!input || !exact(input, bridgeConfigKeys.concat(['waitMs']))
      || !Number.isSafeInteger(input.waitMs) || input.waitMs < 1 || input.waitMs > 600000)
    fail('INVALID_NATIVE_HOST_PACKET');
  const config = { packetDir: input.packetDir, runId: input.runId, phase: input.phase };
  const { dir, binding, projected } = readBridgeBinding(config);
  return new Promise((resolve, reject) => {
    let watcher, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch {
        try { watcher?.unref(); } catch { /* Do not retry a failed watch cleanup. */ }
        error = new Error('HOST_PACKET_IO');
      }
      if (error) reject(error); else resolve(value);
    };
    const check = () => {
      if (settled) return;
      try {
        const receipt = readBridgeJson(path.join(dir, 'receipt.json'));
        if (!exact(receipt, ['schema', 'ownerThread', 'runId', 'sourceSha', 'bindingSha256',
          'runnerModuleSha256', 'phases', 'status', 'errorCode', 'exchangeElapsedMs', 'runtimeSampledAt',
          'observationAuthority', 'hostLifetime', 'consumptionStatus', 'retries', 'remoteEffects',
          ...(projected ? ['observationFormat', 'rawToolResultSha256', 'rawIdentityStatus'] : [])])
            || receipt.schema !== 'ops.native-host-bridge-receipt.v1'
            || ['ownerThread', 'runId', 'sourceSha', 'bindingSha256', 'runnerModuleSha256']
              .some(key => receipt[key] !== binding[key])
            || !Number.isInteger(receipt.phases) || receipt.phases < 0 || receipt.phases > 2
            || receipt.consumptionStatus !== 'NOT_OBSERVED'
            || (projected && (receipt.observationFormat !== 'projection-v2'
              || receipt.rawToolResultSha256 !== null || receipt.rawIdentityStatus !== 'NOT_OBSERVED_BY_NATIVE')))
          fail('INVALID_NATIVE_HOST_PACKET');
        // A recorded bridge terminal only stops the driver; never echo arbitrary
        // receipt strings or infer owner consumption from a sender's local state.
        return finish(null, Object.freeze({ kind: 'TERMINAL', status: 'HOLD', consumptionStatus: 'NOT_OBSERVED' }));
      } catch (error) { if (error?.code !== 'ENOENT') return finish(error); }
      try { finish(null, Object.freeze({ kind: 'COMMAND', packet: readFiniteNativeHostCommand(config) })); }
      catch (error) { if (error?.code !== 'ENOENT') finish(error); }
    };
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString();
        if (!name || name === 'phase-' + input.phase + '.command.json' || name === 'receipt.json') check();
      });
      watcher.on('error', error => finish(error));
      timer = setTimeout(() => finish(new Error('HOST_EXCHANGE_TIMEOUT')), input.waitMs);
      check(); // Arm first: publication between watch and check cannot be missed.
    } catch (error) { finish(error); }
  });
}

function awaitBridgePacket(dir, phase, timeoutMs) {
  let watcher, timer, settled = false, published = false, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const close = () => { if (timer) clearTimeout(timer); if (watcher) { try { watcher.close(); } catch { /* No retry. */ } } };
  const stop = error => { if (!settled) { settled = true; close(); reject(error); } };
  const expected = 'phase-' + phase + '.observation.json';
  const check = () => {
    if (settled) return;
    try {
      const value = readBridgeJson(path.join(dir, expected));
      if (!published) fail('HOST_PACKET_INVALID');
      settled = true; close(); resolve(value);
    } catch (error) { if (error?.code !== 'ENOENT') stop(error); }
  };
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      try {
        const name = filename?.toString();
        if (name === expected) check();
        else if (!name || !['binding.json', 'binding.json.pending',
          ...[1, 2].flatMap(n => ['phase-' + n + '.command.json', 'phase-' + n + '.command.json.pending']),
          'phase-' + phase + '.observation.json.pending',
          ...(phase === 2 ? ['phase-1.observation.json', 'phase-1.observation.json.pending'] : [])].includes(name))
          stop(new Error('HOST_PACKET_INVALID'));
      } catch (error) { stop(error); }
    });
    watcher.on('error', stop);
    timer = setTimeout(() => stop(new Error('HOST_EXCHANGE_TIMEOUT')), timeoutMs);
  } catch (error) { stop(error); }
  return { promise, publishComplete: () => { published = true; check(); },
    cancel: () => stop(new Error('HOST_PACKET_IO')) };
}

// Own the actual caller and its same-module receiver for the whole exchange.
// The driver is outside this process and transports only the two typed packets.
export async function runFiniteNativeHostBridge(options, value, testRuntime) {
  const input = snapshotJson(options);
  const projected = input?.observationFormat === 'projection-v2';
  if (!input || !exact(input, ['callerOptions', 'packetDir', ...(Object.hasOwn(input, 'observationFormat') ? ['observationFormat'] : [])])
      || (Object.hasOwn(input, 'observationFormat') && !projected)
      || input.callerOptions?.ownerReturn?.transport !== 'host-mcp'
      || !Object.hasOwn(input.callerOptions.ownerReturn, 'exchangeTimeoutMs'))
    fail('INVALID_NATIVE_HOST_BRIDGE');
  const callerOptions = input.callerOptions, host = callerOptions.ownerReturn;
  if (callerOptions.mode === 'live' && testRuntime !== undefined) fail('LIVE_RUNTIME_OVERRIDE');
  const ownerValue = callerOptions.mode === 'live' ? process.env.CODEX_THREAD_ID : testRuntime?.ownerReturn?.ownerThread?.();
  if (ownerValue !== host.ownerThread) fail('OWNER_THREAD_MISMATCH');
  directory(input.packetDir);
  const caller = bindNativeProductCaller(callerOptions, testRuntime);
  const dir = path.join(input.packetDir, callerOptions.runId + '.bridge');
  fs.mkdirSync(dir, { mode: 0o700 }); // Claim before engine execution, never resume/reuse.
  const binding = {
    schema: projected ? 'ops.native-host-bridge.v2' : 'ops.native-host-bridge.v1', ownerThread: host.ownerThread, runId: callerOptions.runId,
    sourceSha: callerOptions.sourceSha, bindingSha256: projected
      ? sha(JSON.stringify({ callerBindingSha256: caller.bindingSha256, observationFormat: input.observationFormat })) : caller.bindingSha256,
    runnerModuleSha256: bridgeSourceHash(), expiresAt: host.expiresAt,
    exchangeTimeoutMs: host.exchangeTimeoutMs, statusListLimit: host.statusListLimit ?? 1,
    ...(projected ? { observationFormat: input.observationFormat, callerBindingSha256: caller.bindingSha256 } : {})
  };
  publishBridgeJson(dir, 'binding.json', binding);
  let result, engineError, rejected = false;
  try { result = await caller.run(value); } catch (error) { engineError = error; rejected = true; }
  const started = performance.now();
  let phases = 0, errorCode = null, statusIssuedAt = null;
  try {
    for (let phase = 1; phase <= 2; phase++) {
      const command = caller.takeHostCommand();
      if (!command) break;
      const issued = performance.now(), issuedAt = Date.now();
      if (phase === 1) statusIssuedAt = issuedAt;
      let receiverFreshUntil = Infinity;
      if (phase === 2) {
        const status = caller.returnReceipts().at(-1);
        if (status?.status !== 'HOST_SEND_PENDING' || status.idleStatus !== 'HOST_PORT_REPORTED_IDLE'
            || !utc(status.statusObservedAt)) fail('HOST_PACKET_INVALID');
        receiverFreshUntil = Date.parse(status.statusObservedAt) + host.timeoutMs;
      }
      const commandExpiresAt = Math.min(Date.parse(binding.expiresAt),
        statusIssuedAt + host.timeoutMs, receiverFreshUntil);
      if (!Number.isFinite(commandExpiresAt) || commandExpiresAt <= issuedAt) fail('HOST_PACKET_INVALID');
      const remaining = Math.floor(binding.exchangeTimeoutMs - (issued - started));
      if (remaining < 1) fail('HOST_EXCHANGE_TIMEOUT');
      for (let future = phase; future <= 2; future++) for (const suffix of ['', '.pending']) {
        try { fs.lstatSync(path.join(dir, 'phase-' + future + '.observation.json' + suffix)); fail('HOST_PACKET_INVALID'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      const packet = { schema: 'ops.native-host-command.v1', phase, nonce: randomUUID(),
        ownerThread: binding.ownerThread, runId: binding.runId, sourceSha: binding.sourceSha,
        bindingSha256: binding.bindingSha256, eventSha256: command.eventSha256,
        commandSha256: sha(JSON.stringify(command)), expiresAt: binding.expiresAt,
        commandExpiresAt: new Date(commandExpiresAt).toISOString(),
        runnerModuleSha256: binding.runnerModuleSha256, command };
      const wait = awaitBridgePacket(dir, phase, remaining);
      let observation;
      try {
        publishBridgeJson(dir, 'phase-' + phase + '.command.json', packet);
        phases++;
        wait.publishComplete();
        observation = await wait.promise;
      } catch (error) { wait.cancel(); await wait.promise.catch(() => {}); throw error; }
      if (performance.now() - started > binding.exchangeTimeoutMs) fail('HOST_EXCHANGE_TIMEOUT');
      if (performance.now() - issued > host.timeoutMs) fail('HOST_PACKET_INVALID');
      if (!exact(observation, projected ? projectedObservationKeys : bridgeObservationKeys)
          || observation.schema !== (projected ? 'ops.native-host-observation.v2' : 'ops.native-host-observation.v1')
          || Object.keys(packet).filter(key => !['schema', 'command'].includes(key)).some(key => observation[key] !== packet[key])
          || observation.runtimeSampledAt !== null || !utc(observation.toolStartedAt) || !utc(observation.toolCompletedAt)
          || Date.parse(observation.toolStartedAt) < issuedAt
          || Date.parse(observation.toolStartedAt) >= Date.parse(packet.commandExpiresAt)
          || Date.parse(observation.toolCompletedAt) < Date.parse(observation.toolStartedAt)
          || Date.parse(observation.toolCompletedAt) > Date.now()
          || (!projected && (!Number.isSafeInteger(observation.toolResultBytes) || observation.toolResultBytes < 0
            || !/^[a-f0-9]{64}$/.test(observation.toolResultSha256)
            || !['HOST_TOOL_ERROR_REPORTED', 'SEND_ACK_CONTRACT_UNKNOWN', 'STATUS_SHAPE_OR_IDENTITY_UNKNOWN',
              'HOST_PORT_REPORTED_STATUS_REQUEST_INTERVAL'].includes(observation.classification)))) fail('HOST_PACKET_INVALID');
      let accepted = observation.observation;
      if (projected) {
        validateHostProjection(observation.projection, phase);
        if (observation.rawToolResultSha256 !== null || observation.rawIdentityStatus !== 'NOT_OBSERVED_BY_NATIVE'
            || observation.projectionBytes !== canonicalBytes(observation.projection).length
            || observation.projectionSha256 !== sha(canonicalBytes(observation.projection))) fail('HOST_PACKET_INVALID');
        accepted = projectionObservation(packet, observation.projection, observation.toolCompletedAt);
      }
      if (phase === 1) caller.acceptHostObservation(command.commandId, accepted);
      else caller.acceptHostSendResult(command.commandId, accepted);
    }
  } catch (error) {
    errorCode = error?.message === 'HOST_EXCHANGE_TIMEOUT' ? 'HOST_EXCHANGE_TIMEOUT'
      : error?.message === 'HOST_PACKET_INVALID' ? 'HOST_PACKET_INVALID' : 'HOST_PACKET_IO';
    caller.holdHostReturn(errorCode);
  }
  const returned = caller.returnReceipts().at(-1);
  const receipt = { schema: 'ops.native-host-bridge-receipt.v1', ownerThread: binding.ownerThread,
    runId: binding.runId, sourceSha: binding.sourceSha, bindingSha256: binding.bindingSha256,
    runnerModuleSha256: binding.runnerModuleSha256, phases, status: errorCode ? 'HOLD' : returned?.status ?? 'HOLD',
    errorCode: errorCode ?? returned?.errorCode ?? null, exchangeElapsedMs: performance.now() - started,
    runtimeSampledAt: null, observationAuthority: 'HOST_PORT_REPORTED_NOT_AUTHENTICATED_BY_LIBRARY',
    hostLifetime: 'NOT_ESTABLISHED_BY_SOURCE', consumptionStatus: 'NOT_OBSERVED', retries: 0,
    remoteEffects: returned?.remoteEffects ?? 'UNKNOWN',
    ...(projected ? { observationFormat: 'projection-v2', rawToolResultSha256: null,
      rawIdentityStatus: 'NOT_OBSERVED_BY_NATIVE' } : {}) };
  try { publishBridgeJson(dir, 'receipt.json', receipt); } catch { /* Preserve engine value/error and partial original artifacts. */ }
  if (rejected) throw engineError;
  return result;
}

// Closed, data-only ordinary-Node helper frontend. Never executes a product,
// tool, source string or arbitrary export. No stdin/body/file wrapper transport.
if (typeof process !== 'undefined' && process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.length > 2) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    if (!['host-command', 'host-observe-projection'].includes(operation)
        || args.length % 2 || process.argv.join('\0').length > 8192) fail('INVALID_NATIVE_HOST_CLI');
    const values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!/^--[a-z-]+$/.test(args[i]) || Object.hasOwn(values, args[i])) fail('INVALID_NATIVE_HOST_CLI');
      values[args[i]] = args[i + 1];
    }
    const common = ['--packet-dir', '--run-id', '--phase'];
    const flags = operation === 'host-command' ? common.concat('--wait-ms') : common.concat([
      '--started-at', '--completed-at', '--status', '--classification', '--raw-bytes', '--raw-units', '--raw-size']);
    if (!exact(values, flags) || /[\0\r\n]/.test(values['--packet-dir'])) fail('INVALID_NATIVE_HOST_CLI');
    const integer = text => { if (!/^(0|[1-9][0-9]*)$/.test(text)) fail('INVALID_NATIVE_HOST_CLI');
      const number = Number(text); if (!Number.isSafeInteger(number)) fail('INVALID_NATIVE_HOST_CLI'); return number; };
    const config = { packetDir: values['--packet-dir'], runId: values['--run-id'], phase: integer(values['--phase']) };
    let output;
    if (operation === 'host-command') {
      // This closed frontend is projection-only. Keep the exported raw-v1 APIs
      // valid, but reject the wrong format before exposing a command to a tool.
      readBridgeBinding(config, 'projection-v2');
      output = await awaitFiniteNativeHostCommand({ ...config, waitMs: integer(values['--wait-ms']) });
    }
    else output = submitFiniteNativeHostProjection({ ...config, toolStartedAt: values['--started-at'],
      toolCompletedAt: values['--completed-at'] }, { schema: 'ops.host-tool-projection.v1', status: values['--status'],
      classification: values['--classification'], reportedRawJsonBytes: values['--raw-bytes'] === 'null' ? null : integer(values['--raw-bytes']),
      reportedRawJsonUnits: values['--raw-units'] === 'null' ? null : integer(values['--raw-units']), rawSizeStatus: values['--raw-size'] });
    const envelope = JSON.stringify({ schema: 'ops.native-host-cli.v1', status: 'OK', output }) + '\n';
    if (Buffer.byteLength(envelope, 'utf8') > 8192) fail('INVALID_NATIVE_HOST_CLI');
    process.stdout.write(envelope);
  } catch {
    process.stdout.write(JSON.stringify({ schema: 'ops.native-host-cli.v1', status: 'HOLD', errorCode: 'HOST_HELPER_FAILED' }) + '\n');
    process.exitCode = 2;
  }
}
