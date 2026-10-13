import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CEILING = 'BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION';
const SELECTOR_CEILING = 'BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION';
const DESIGN = 'CONTRACT_W_632_CLOSURE_DESIGN_V3';
const ROLE_PROTOCOL = {
  before: { ledger: 'L0', packet: 'AC0' },
  accepted: { ledger: 'L1', packet: 'AC1' },
  candidate: { ledger: 'L2', packet: 'BC1' },
};

const fail = (message) => { throw new Error(`ops-package-contract-bridge: ${message}`); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be non-empty text`);
  return value;
};
const digest = (value, label) => {
  text(value, label);
  if (!/^[0-9a-f]{64}$/u.test(value)) fail(`${label} must be sha256 hex`);
  return value;
};
const exactKeys = (value, expected, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} keys mismatch: ${actual.join(',')}`);
};

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function safeChild(root, relative) {
  text(relative, 'artifact.path');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) fail(`unsafe artifact path: ${relative}`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) fail(`artifact escapes bundle: ${relative}`);
  return resolved;
}

function readJson(root, relative) {
  const file = safeChild(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`file missing: ${relative}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findCurrentDecision(packet, subject, label) {
  const rows = packet.currentState.filter((row) => row?.subject_key === subject);
  if (rows.length !== 1 || typeof rows[0].decision !== 'string') fail(`${label}: expected one current decision for ${subject}`);
  return rows[0].decision;
}

function verifyArtifacts(root, receipt) {
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) fail('artifacts required');
  const seen = new Set();
  const byPath = new Map();
  for (const [index, artifact] of receipt.artifacts.entries()) {
    exactKeys(artifact, ['path', 'sha256'], `artifacts[${index}]`);
    if (seen.has(artifact.path)) fail(`duplicate artifact: ${artifact.path}`);
    seen.add(artifact.path);
    digest(artifact.sha256, `artifacts[${index}].sha256`);
    const file = safeChild(root, artifact.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`artifact missing: ${artifact.path}`);
    const actual = sha256File(file);
    if (actual !== artifact.sha256) fail(`artifact digest mismatch: ${artifact.path}`);
    byPath.set(artifact.path, artifact.sha256);
  }
  return byPath;
}

function verifySelector(selector, receipt) {
  exactKeys(selector, [
    'kind', 'selectorId', 'authority', 'claimCeiling', 'designVersion', 'source',
    'acceptedDecision', 'governanceSource', 'selection',
  ], 'selector');
  if (selector.kind !== 'governance.packageContractPhase1Selector.v1') fail('selector kind mismatch');
  if (selector.selectorId !== receipt.selector.selectorId) fail('selector id mismatch');
  if (selector.authority !== false || selector.claimCeiling !== SELECTOR_CEILING) fail('selector authority boundary mismatch');
  if (selector.designVersion !== DESIGN) fail('selector design mismatch');
  exactKeys(selector.source, ['rAcceptance', 'pBoundary'], 'selector.source');
  text(selector.source.rAcceptance, 'selector.source.rAcceptance');
  text(selector.source.pBoundary, 'selector.source.pBoundary');
  if (stableJson(selector.acceptedDecision) !== stableJson(receipt.acceptedDecision)) fail('selector accepted decision mismatch');
  exactKeys(selector.governanceSource, ['repository', 'revision', 'treeSha'], 'selector.governanceSource');
  if (selector.governanceSource.repository !== receipt.source.governanceRepository
    || selector.governanceSource.revision !== receipt.source.governanceRevision
    || selector.governanceSource.treeSha !== receipt.source.governanceTreeSha) fail('selector governance source mismatch');
  exactKeys(selector.selection, ['subjectKey', 'before', 'accepted', 'candidate'], 'selector.selection');
  text(selector.selection.subjectKey, 'selector.selection.subjectKey');
  for (const [role, protocol] of Object.entries(ROLE_PROTOCOL)) {
    const entry = selector.selection[role];
    exactKeys(entry, role === 'before' ? ['ledger', 'rowId'] : ['ledger', 'rowId', 'supersedes'], `selector.selection.${role}`);
    if (entry.ledger !== protocol.ledger) fail(`selector ${role} ledger mismatch`);
    text(entry.rowId, `selector.selection.${role}.rowId`);
    if (role !== 'before') text(entry.supersedes, `selector.selection.${role}.supersedes`);
  }
  if (selector.selection.accepted.supersedes !== selector.selection.before.rowId) fail('selector accepted supersession mismatch');
  if (selector.selection.candidate.supersedes !== selector.selection.accepted.rowId) fail('selector candidate supersession mismatch');
}

function verifyInputs(root, receipt, selector) {
  const inputs = readJson(root, 'input-manifests.json');
  exactKeys(inputs, ['kind', 'claimCeiling', 'selector', 'manifests'], 'input-manifests');
  if (inputs.kind !== 'ops.packageContractBridge.phase1Inputs.v2' || inputs.claimCeiling !== CEILING) fail('input manifest boundary mismatch');
  exactKeys(inputs.selector, ['path', 'sha256', 'selectorId'], 'input-manifests.selector');
  if (inputs.selector.path !== receipt.selector.bundlePath
    || inputs.selector.sha256 !== receipt.selector.sha256
    || inputs.selector.selectorId !== selector.selectorId) fail('input selector binding mismatch');
  exactKeys(inputs.manifests, ['L0', 'L1', 'L2'], 'input-manifests.manifests');
  for (const label of ['L0', 'L1', 'L2']) {
    const item = inputs.manifests[label];
    exactKeys(item, ['ledger', 'ledgerSha256'], `input-manifests.${label}`);
    if (item.ledger !== `${label}.jsonl`) fail(`${label} ledger path mismatch`);
    digest(item.ledgerSha256, `${label}.ledgerSha256`);
    if (sha256File(safeChild(root, item.ledger)) !== item.ledgerSha256) fail(`${label} ledger digest mismatch`);
  }
  return inputs;
}

function verifyPacket(root, label, protocol, inputs) {
  const relative = `${label}.compiler-packet.json`;
  const packet = readJson(root, relative);
  exactKeys(packet, [
    'kind', 'label', 'authority', 'claimCeiling', 'input', 'semanticDigest', 'currentDigest',
    'replayDigest', 'replayEqual', 'currentState', 'decisionCount', 'promotionCount',
  ], label);
  if (packet.kind !== 'ops.packageContractBridge.compilerPacket.v2' || packet.label !== label) fail(`${label} packet identity mismatch`);
  if (packet.authority !== false || packet.claimCeiling !== CEILING) fail(`${label} authority boundary mismatch`);
  exactKeys(packet.input, ['ledger', 'ledgerSha256'], `${label}.input`);
  const expectedManifest = inputs.manifests[protocol.ledger];
  if (packet.input.ledger !== expectedManifest.ledger || packet.input.ledgerSha256 !== expectedManifest.ledgerSha256) fail(`${label} input binding mismatch`);
  digest(packet.semanticDigest, `${label}.semanticDigest`);
  digest(packet.currentDigest, `${label}.currentDigest`);
  digest(packet.replayDigest, `${label}.replayDigest`);
  if (packet.replayEqual !== true || !Array.isArray(packet.currentState) || packet.currentState.length === 0) fail(`${label} semantic packet incomplete`);
  return { relative, packet, sha256: sha256File(safeChild(root, relative)) };
}

export function buildExpectedSelection(root, selector, inputs, packets) {
  const subject = selector.selection.subjectKey;
  const value = {
    kind: 'ops.packageContractBridge.phase1Selection.v2',
    authority: false,
    claimCeiling: CEILING,
    selector: {
      path: 'phase1-selector.json',
      sha256: sha256File(safeChild(root, 'phase1-selector.json')),
      selectorId: selector.selectorId,
    },
  };
  for (const [role, protocol] of Object.entries(ROLE_PROTOCOL)) {
    const packetInfo = packets[protocol.packet];
    const manifest = inputs.manifests[protocol.ledger];
    value[role] = {
      ledger: manifest.ledger,
      ledgerSha256: manifest.ledgerSha256,
      rowId: selector.selection[role].rowId,
      packet: packetInfo.relative,
      packetSha256: packetInfo.sha256,
      decision: findCurrentDecision(packetInfo.packet, subject, protocol.packet),
      currentDigest: packetInfo.packet.currentDigest,
    };
  }
  value.acceptedCurrentAfterCandidate = {
    sourceRole: 'accepted',
    packet: value.accepted.packet,
    packetSha256: value.accepted.packetSha256,
    currentDigest: value.accepted.currentDigest,
  };
  return value;
}

function verifyDestructive(root, relative, kind, minimum) {
  const report = readJson(root, relative);
  exactKeys(report, ['kind', 'results'], relative);
  if (report.kind !== kind || !Array.isArray(report.results) || report.results.length < minimum) fail(`${relative} coverage incomplete`);
  for (const [index, result] of report.results.entries()) {
    exactKeys(result, ['case', 'status', 'error'], `${relative}.results[${index}]`);
    if (result.status !== 'REJECTED') fail(`${relative} contains non-rejection`);
    text(result.case, `${relative}.case`);
    text(result.error, `${relative}.error`);
  }
  return report.results.length;
}

export function verifyPhase1Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receiptPath = path.join(root, 'phase1-receipt.json');
  if (!fs.existsSync(receiptPath)) fail('phase1-receipt.json missing');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  exactKeys(receipt, [
    'kind', 'status', 'authority', 'claimCeiling', 'designVersion', 'phase', 'phaseClosed',
    'source', 'acceptedDecision', 'selector', 'compiler', 'append', 'supersession', 'selection',
    'destructive', 'commonCode', 'artifacts', 'semantic',
  ], 'receipt');
  if (receipt.kind !== 'ops.packageContractBridge.phase1Receipt.v2') fail(`unexpected kind: ${receipt.kind}`);
  if (receipt.status !== 'PASS' || receipt.authority !== false) fail('receipt state mismatch');
  if (receipt.claimCeiling !== CEILING || receipt.designVersion !== DESIGN) fail('receipt boundary mismatch');
  if (receipt.phase !== 1 || receipt.phaseClosed !== false) fail('phase state mismatch');

  exactKeys(receipt.source, [
    'opsCandidateSha', 'governanceRepository', 'governanceRevision', 'governanceTreeSha',
    'governanceSelectedFileSetSha256',
  ], 'source');
  text(receipt.source.opsCandidateSha, 'source.opsCandidateSha');
  text(receipt.source.governanceRepository, 'source.governanceRepository');
  text(receipt.source.governanceRevision, 'source.governanceRevision');
  text(receipt.source.governanceTreeSha, 'source.governanceTreeSha');
  digest(receipt.source.governanceSelectedFileSetSha256, 'source.governanceSelectedFileSetSha256');

  exactKeys(receipt.acceptedDecision, ['decisionId', 'decisionDigest', 'acceptedMerge', 'source', 'release', 'status'], 'acceptedDecision');
  digest(receipt.acceptedDecision.decisionDigest, 'acceptedDecision.decisionDigest');
  exactKeys(receipt.selector, ['selectorId', 'sourcePath', 'bundlePath', 'sha256', 'authority', 'claimCeiling'], 'receipt.selector');
  if (receipt.selector.authority !== false || receipt.selector.claimCeiling !== SELECTOR_CEILING) fail('receipt selector boundary mismatch');
  digest(receipt.selector.sha256, 'receipt.selector.sha256');
  exactKeys(receipt.compiler, ['version', 'selectedFileSetSha256'], 'compiler');
  if (receipt.compiler.selectedFileSetSha256 !== receipt.source.governanceSelectedFileSetSha256) fail('compiler file-set binding mismatch');

  const artifactDigests = verifyArtifacts(root, receipt);
  if (artifactDigests.get(receipt.selector.bundlePath) !== receipt.selector.sha256) fail('selector artifact binding mismatch');
  const selector = readJson(root, receipt.selector.bundlePath);
  verifySelector(selector, receipt);
  const inputs = verifyInputs(root, receipt, selector);
  const packets = {};
  for (const protocol of Object.values(ROLE_PROTOCOL)) {
    packets[protocol.packet] = verifyPacket(root, protocol.packet, protocol, inputs);
  }

  const expectedSelection = buildExpectedSelection(root, selector, inputs, packets);
  const actualSelection = readJson(root, receipt.selection.path);
  if (stableJson(actualSelection) !== stableJson(expectedSelection)) fail('accepted-current selection is not derivable from selector and packets');
  if (sha256File(safeChild(root, receipt.selection.path)) !== receipt.selection.sha256) fail('selection digest mismatch');
  if (receipt.selection.acceptedCurrentDigest !== expectedSelection.accepted.currentDigest
    || receipt.selection.candidateCurrentDigest !== expectedSelection.candidate.currentDigest) fail('receipt selection digest binding mismatch');
  if (expectedSelection.accepted.currentDigest === expectedSelection.candidate.currentDigest) fail('candidate packet did not differ');
  if (expectedSelection.acceptedCurrentAfterCandidate.currentDigest !== expectedSelection.accepted.currentDigest) fail('candidate changed externally selected current');

  if (receipt.append.l0ToL1 !== 'PASS' || receipt.append.l1ToL2 !== 'PASS') fail('append proof incomplete');
  if (receipt.supersession.subjectKey !== selector.selection.subjectKey
    || receipt.supersession.beforeRowId !== selector.selection.before.rowId
    || receipt.supersession.afterRowId !== selector.selection.accepted.rowId) fail('supersession selector binding mismatch');
  if (receipt.supersession.beforeDecision !== expectedSelection.before.decision
    || receipt.supersession.afterDecision !== expectedSelection.accepted.decision) fail('supersession decision mismatch');
  if (receipt.supersession.beforeCurrentDigest !== expectedSelection.before.currentDigest
    || receipt.supersession.afterCurrentDigest !== expectedSelection.accepted.currentDigest) fail('supersession current mismatch');
  if (receipt.supersession.beforeDecision === receipt.supersession.afterDecision
    || receipt.supersession.beforeCurrentDigest === receipt.supersession.afterCurrentDigest) fail('accepted supersession did not change current');

  const compilerCases = verifyDestructive(root, 'destructive-results.json', 'ops.packageContractBridge.phase1CompilerDestructive.v2', 4);
  const selectorCases = verifyDestructive(root, 'selector-destructive-results.json', 'ops.packageContractBridge.phase1SelectorDestructive.v2', 4);
  if (receipt.destructive.compiler.rejected !== compilerCases || receipt.destructive.compiler.total !== compilerCases) fail('compiler destructive receipt mismatch');
  if (receipt.destructive.selector.rejected !== selectorCases || receipt.destructive.selector.total !== selectorCases) fail('selector destructive receipt mismatch');

  const identities = readJson(root, 'source-identities.json');
  exactKeys(identities, ['kind', 'ops', 'governance'], 'source-identities');
  if (identities.kind !== 'ops.packageContractBridge.sourceIdentities.v2') fail('source identities kind mismatch');
  if (identities.ops.candidateSha !== receipt.source.opsCandidateSha) fail('ops candidate identity mismatch');
  if (identities.governance.repository !== receipt.source.governanceRepository
    || identities.governance.revision !== receipt.source.governanceRevision
    || identities.governance.treeSha !== receipt.source.governanceTreeSha
    || identities.governance.selectedFileSetSha256 !== receipt.source.governanceSelectedFileSetSha256) fail('governance identity mismatch');
  if (!Array.isArray(identities.ops.selectedFiles) || !Array.isArray(identities.governance.selectedFiles)) fail('selected source files missing');

  if (receipt.commonCode.changed !== false) fail('accepted core/compiler source changed');
  if (receipt.semantic.nonEmpty !== true || receipt.semantic.replayEqual !== true) fail('semantic packet proof incomplete');
  if (receipt.semantic.ac0SemanticDigest !== packets.AC0.packet.semanticDigest
    || receipt.semantic.ac1SemanticDigest !== packets.AC1.packet.semanticDigest
    || receipt.semantic.bc1SemanticDigest !== packets.BC1.packet.semanticDigest) fail('semantic digest binding mismatch');

  return {
    kind: 'ops.packageContractBridge.phase1Verification.v2',
    status: 'PASS',
    authority: false,
    claimCeiling: receipt.claimCeiling,
    designVersion: receipt.designVersion,
    phase: 1,
    phaseClosed: false,
    receiptDigest: sha256File(receiptPath),
    selectorDigest: receipt.selector.sha256,
    selectionDigest: receipt.selection.sha256,
    acceptedCurrentDigest: expectedSelection.accepted.currentDigest,
    candidateCurrentDigest: expectedSelection.candidate.currentDigest,
    artifactCount: receipt.artifacts.length,
  };
}
