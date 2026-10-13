import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => { throw new Error(`ops-package-contract-bridge: ${message}`); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be non-empty text`);
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

export function verifyPhase1Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receiptPath = path.join(root, 'phase1-receipt.json');
  if (!fs.existsSync(receiptPath)) fail('phase1-receipt.json missing');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  exactKeys(receipt, [
    'kind', 'status', 'authority', 'claimCeiling', 'designVersion', 'phase', 'phaseClosed',
    'source', 'acceptedDecision', 'compiler', 'append', 'supersession', 'candidateIsolation',
    'destructive', 'commonCode', 'artifacts', 'semantic',
  ], 'receipt');
  if (receipt.kind !== 'ops.packageContractBridge.phase1Receipt.v1') fail(`unexpected kind: ${receipt.kind}`);
  if (receipt.status !== 'PASS') fail(`status is not PASS: ${receipt.status}`);
  if (receipt.authority !== false) fail('receipt must be non-authoritative');
  if (receipt.claimCeiling !== 'BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION') fail('claim ceiling mismatch');
  if (receipt.designVersion !== 'CONTRACT_W_632_CLOSURE_DESIGN_V3') fail('design version mismatch');
  if (receipt.phase !== 1 || receipt.phaseClosed !== false) fail('phase state mismatch');

  object(receipt.source, 'source');
  text(receipt.source.opsCandidateSha, 'source.opsCandidateSha');
  text(receipt.source.governanceRevision, 'source.governanceRevision');
  text(receipt.source.governanceTreeDigest, 'source.governanceTreeDigest');
  object(receipt.acceptedDecision, 'acceptedDecision');
  text(receipt.acceptedDecision.decisionDigest, 'acceptedDecision.decisionDigest');
  object(receipt.compiler, 'compiler');
  text(receipt.compiler.sourceDigest, 'compiler.sourceDigest');

  if (receipt.append.l0ToL1 !== 'PASS' || receipt.append.l1ToL2 !== 'PASS') fail('append proof incomplete');
  if (receipt.supersession.beforeDecision === receipt.supersession.afterDecision) fail('supersession did not change current decision');
  if (receipt.supersession.beforeCurrentDigest === receipt.supersession.afterCurrentDigest) fail('supersession did not change current digest');
  if (receipt.candidateIsolation.acceptedCurrentDigest !== receipt.supersession.afterCurrentDigest) fail('accepted current binding mismatch');
  if (receipt.candidateIsolation.candidateCurrentDigest === receipt.candidateIsolation.acceptedCurrentDigest) fail('candidate proof did not differ');
  if (receipt.candidateIsolation.candidateAdmitted !== false || receipt.candidateIsolation.acceptedCurrentUnchanged !== true) fail('candidate isolation failed');
  if (receipt.destructive.rejected !== receipt.destructive.total || receipt.destructive.total < 4) fail('destructive coverage incomplete');
  if (receipt.commonCode.changed !== false) fail('accepted core/compiler source changed');
  if (receipt.semantic.nonEmpty !== true || receipt.semantic.replayEqual !== true) fail('semantic packet proof incomplete');

  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) fail('artifacts required');
  const seen = new Set();
  for (const [index, artifact] of receipt.artifacts.entries()) {
    exactKeys(artifact, ['path', 'sha256'], `artifacts[${index}]`);
    if (seen.has(artifact.path)) fail(`duplicate artifact: ${artifact.path}`);
    seen.add(artifact.path);
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) fail(`invalid artifact digest: ${artifact.path}`);
    const file = safeChild(root, artifact.path);
    if (!fs.statSync(file).isFile()) fail(`artifact missing: ${artifact.path}`);
    const actual = sha256File(file);
    if (actual !== artifact.sha256) fail(`artifact digest mismatch: ${artifact.path}`);
  }

  return {
    kind: 'ops.packageContractBridge.phase1Verification.v1',
    status: 'PASS',
    authority: false,
    claimCeiling: receipt.claimCeiling,
    designVersion: receipt.designVersion,
    phase: 1,
    phaseClosed: false,
    receiptDigest: sha256File(receiptPath),
    artifactCount: receipt.artifacts.length,
  };
}
