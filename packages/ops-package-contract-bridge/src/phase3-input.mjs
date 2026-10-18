import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256File, stableJson } from './verify.mjs';

export const PHASE3_RECEIPT_CEILING = 'PACKAGE_PROJECTIONS_CONSUMED_NOT_ORGANIZATION_ADMISSION';
export const SUBJECT_KEY = 'request:02-semantic';
export const RELATIONS = new Set([
  'declares', 'declares_common_boundary', 'declares_local_metadata', 'declares_nix_attrset',
  'declares_nix_lambda_metadata', 'declares_package_path', 'derived_from',
  'observes_registry_dependencies', 'observes_registry_entry',
]);
export const FIELDS = Object.freeze([
  'position', 'purpose', 'contributionMechanism', 'responsibility', 'mustNotOwn',
  'placement', 'input', 'output', 'dependency', 'requiredEvidence', 'lifecycle',
]);
export const fail = message => { throw new Error(`ops-package-contract-bridge phase3: ${message}`); };
export const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
export const text = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty text`);
  return value;
};
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const readJsonl = file => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(line => line.trim()).map(JSON.parse);
export const writeJson = (file, value) => fs.writeFileSync(file, `${stableJson(value)}\n`);
export const writeJsonl = (file, values) => fs.writeFileSync(file, `${values.map(stableJson).join('\n')}\n`);
export const hashValue = value => sha256Bytes(Buffer.from(`${stableJson(value)}\n`, 'utf8'));
export const digest = value => sha256Bytes(Buffer.from(typeof value === 'string' ? value : `${stableJson(value)}\n`, 'utf8'));
export const clone = value => JSON.parse(JSON.stringify(value));
export const sortedUnique = values => [...new Set(values)].sort();
export const uiSafeJson = value => stableJson(value).replaceAll('<', '\\u003c');

export function resolveRoot(bundle, expectedFile) {
  const root = path.resolve(bundle);
  if (fs.existsSync(path.join(root, expectedFile))) return root;
  if (fs.existsSync(path.join(root, 'proof', expectedFile))) return path.join(root, 'proof');
  fail(`bundle file missing: ${expectedFile}`);
}

export function sourceRow(assertion) {
  text(assertion.sourceRef, 'assertion.sourceRef');
  if (!/^[a-f0-9]{64}$/u.test(assertion.sourceDigest)) fail(`invalid source digest: ${assertion.sourceRef}`);
  return {
    sourceRef: `${assertion.sourceRef}@assertion:${assertion.sourceDigest}`,
    sourceDigest: `sha256:${assertion.sourceDigest}`,
  };
}

export function sourceRows(assertions) {
  const byRef = new Map();
  for (const assertion of assertions) {
    const row = sourceRow(assertion);
    const prior = byRef.get(row.sourceRef);
    if (prior && prior.sourceDigest !== row.sourceDigest) fail(`conflicting source revision: ${row.sourceRef}`);
    byRef.set(row.sourceRef, row);
  }
  return [...byRef.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

export function sourceSet(rows) {
  const byRef = new Map();
  for (const source of rows) {
    const prior = byRef.get(source.sourceRef);
    if (prior && prior.sourceDigest !== source.sourceDigest) fail(`source conflict: ${source.sourceRef}`);
    byRef.set(source.sourceRef, source);
  }
  return [...byRef.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

export function currentDecision(packet, subjectKey = SUBJECT_KEY) {
  const matches = packet.currentState?.filter(row => row?.subject_key === subjectKey) ?? [];
  if (matches.length !== 1) fail(`packet must contain one current row for ${subjectKey}`);
  return text(matches[0].decision, `${subjectKey}.decision`);
}

export function packetInfo(root, row, role) {
  object(row, `selection.${role}`);
  const file = path.join(root, text(row.packet, `selection.${role}.packet`));
  if (!fs.existsSync(file)) fail(`${role} packet missing: ${row.packet}`);
  const packetSha256 = sha256File(file);
  if (row.packetSha256 !== packetSha256) fail(`${role} packet digest mismatch`);
  const packet = readJson(file);
  if (row.currentDigest !== packet.currentDigest) fail(`${role} current digest mismatch`);
  if (row.decision !== currentDecision(packet)) fail(`${role} decision mismatch`);
  return binding({ role, row, packet, packetSha256 });
}

export function binding({ role, row, packet, packetSha256 }) {
  if (!/^[a-f0-9]{64}$/u.test(packetSha256)) fail(`${role} packetSha256 invalid`);
  if (row.packetSha256 !== packetSha256) fail(`${role} packet binding mismatch`);
  if (row.currentDigest !== packet.currentDigest) fail(`${role} currentDigest binding mismatch`);
  if (row.decision !== currentDecision(packet)) fail(`${role} decision binding mismatch`);
  return {
    role,
    subjectKey: SUBJECT_KEY,
    rowId: text(row.rowId, `${role}.rowId`),
    decision: row.decision,
    currentDigest: row.currentDigest,
    packet: text(row.packet, `${role}.packet`),
    packetSha256,
    sourceRef: `phase1:${role}:${row.rowId}`,
    sourceDigest: `sha256:${row.currentDigest}`,
    packetValue: packet,
  };
}

export function bindingIdentity(value) {
  return {
    role: value.role,
    rowId: value.rowId,
    decision: value.decision,
    currentDigest: value.currentDigest,
    packet: value.packet,
    packetSha256: value.packetSha256,
  };
}

export function context({ accepted, unadmitted = [] }) {
  const value = { accepted, unadmitted };
  resolveAccepted(value);
  return value;
}

export function contextIdentity(value) {
  return {
    accepted: bindingIdentity(value.accepted),
    unadmitted: value.unadmitted.map(bindingIdentity),
  };
}

export function contextDigest(value) {
  return digest(contextIdentity(value));
}

export function resolveAccepted(value) {
  object(value, 'projection context');
  object(value.accepted, 'projection context.accepted');
  if (!Array.isArray(value.unadmitted)) fail('projection context.unadmitted must be an array');
  const seen = new Set([value.accepted.rowId]);
  for (const item of value.unadmitted) {
    object(item, 'projection context candidate');
    if (seen.has(item.rowId)) fail(`duplicate projection selection row: ${item.rowId}`);
    seen.add(item.rowId);
    if (item.packetSha256 === value.accepted.packetSha256 || item.currentDigest === value.accepted.currentDigest) {
      fail(`candidate is not distinct from accepted: ${item.rowId}`);
    }
  }
  return value.accepted;
}

export function readPhaseInputs(phase1Bundle, phase2Bundle) {
  const p1 = resolveRoot(phase1Bundle, 'accepted-current-selection.json');
  const p2 = resolveRoot(phase2Bundle, 'phase2-v5-verification.json');
  const selection = readJson(path.join(p1, 'accepted-current-selection.json'));
  const selections = {
    before: packetInfo(p1, selection.before, 'before'),
    accepted: packetInfo(p1, selection.accepted, 'accepted'),
    candidate: packetInfo(p1, selection.candidate, 'candidate'),
  };
  const after = object(selection.acceptedCurrentAfterCandidate, 'acceptedCurrentAfterCandidate');
  if (after.sourceRole !== 'accepted'
    || after.packet !== selection.accepted.packet
    || after.packetSha256 !== selection.accepted.packetSha256
    || after.currentDigest !== selection.accepted.currentDigest) fail('acceptedCurrentAfterCandidate mismatch');

  const verification = readJson(path.join(p2, 'phase2-v5-verification.json'));
  if (verification.status !== 'PASS' || verification.authority !== false || verification.phaseClosed !== false) {
    fail('Phase 2 verification boundary mismatch');
  }
  const assertions = readJsonl(path.join(p2, 'relation-valid-source-assertions-v5.jsonl'));
  validateAssertions(assertions);
  const coverage = readJsonl(path.join(p2, 'combined-package-field-coverage-v5.jsonl'));
  const drifts = readJson(path.join(p2, 'combined-drift-findings-v5.json')).findings;
  if (assertions.length !== verification.relationValidAssertionCount) fail('Phase 2 assertion count mismatch');
  if (coverage.length !== verification.packageCount) fail('Phase 2 coverage count mismatch');
  if (drifts.length !== verification.driftCount) fail('Phase 2 drift count mismatch');
  if (coverage.some(row => row.status !== 'COMPLETE')) fail('Phase 2 incomplete package reached Phase 3');
  for (const row of coverage) {
    const keys = Object.keys(object(row.fields, `${row.packageId}.fields`)).sort();
    if (stableJson(keys) !== stableJson([...FIELDS].sort())) fail(`mandatory field set mismatch: ${row.packageId}`);
  }
  return { p1, p2, selection, selections, verification, assertions, coverage, drifts };
}

export function validateAssertions(assertions) {
  for (const assertion of assertions) {
    if (!RELATIONS.has(assertion.relation)) fail(`unsupported Phase 3 relation: ${assertion.relation}`);
    if (!FIELDS.includes(assertion.field)) fail(`unsupported Phase 3 field: ${assertion.field}`);
  }
}

export function purposeGroups(packageId, assertions) {
  const groups = new Map();
  for (const assertion of assertions) {
    const key = stableJson(assertion.value);
    if (!groups.has(key)) groups.set(key, { value: assertion.value, assertions: [] });
    groups.get(key).assertions.push(assertion);
  }
  return [...groups.values()].sort((a, b) => stableJson(a.value).localeCompare(stableJson(b.value))).map(group => {
    const label = typeof group.value === 'string' ? group.value : stableJson(group.value);
    return {
      id: `purpose:package:${packageId}:${hashValue(group.value).slice(0, 16)}`,
      label,
      assertions: group.assertions,
      sources: sourceRows(group.assertions),
    };
  });
}

export function packageModels(coverage) {
  return [...coverage].sort((a, b) => a.packageId.localeCompare(b.packageId)).map((row, index) => {
    const fields = Object.fromEntries(FIELDS.map(field => [field, row.fields[field].map(item => ({
      sourceClass: item.sourceClass,
      sourceRef: item.sourceRef,
      sourceDigest: item.sourceDigest,
      relation: item.relation,
      field: item.field,
      packageId: item.packageId,
      value: item.value,
    }))]));
    const assertions = FIELDS.flatMap(field => fields[field]);
    const purposes = purposeGroups(row.packageId, fields.purpose);
    const dependencies = sortedUnique(fields.dependency
      .flatMap(item => Array.isArray(item.value) ? item.value : [item.value])
      .filter(Boolean).map(String));
    return {
      packageId: row.packageId,
      index,
      nodeId: `pkg_${String(index).padStart(3, '0')}`,
      purposes,
      dependencies,
      fields,
      assertions,
      sources: sourceRows(assertions),
    };
  });
}
