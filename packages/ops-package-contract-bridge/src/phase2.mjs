import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Bytes,
  sha256File,
  stableJson,
} from './verify.mjs';

export const PHASE2_CLAIM_CEILING = 'REPO_IMPLEMENTATION_CLAIM_NOT_ORGANIZATION_REQUIREMENT';
export const PHASE2_RECEIPT_CEILING = 'PACKAGE_PURPOSE_COVERAGE_PROVEN_NOT_ORGANIZATION_ADMISSION';
export const PHASE2_FIELDS = Object.freeze([
  'position',
  'purpose',
  'contributionMechanism',
  'responsibility',
  'mustNotOwn',
  'placement',
  'input',
  'output',
  'dependency',
  'requiredEvidence',
  'lifecycle',
]);
const CENTRAL_SOURCE_PATH = 'packages/ops-package-contract-bridge/contract/phase2-package-claims.v1.json';
const REGISTRY_SOURCE_PATH = 'build/packages.jsonl';
const ALLOWED_POSITIONS = new Set(['implementation', 'support', 'proof', 'historical']);
const ARRAY_FIELDS = new Set(['input', 'output', 'dependency', 'requiredEvidence']);
const SEMANTIC_FIELDS = new Set(['purpose', 'contributionMechanism', 'responsibility', 'mustNotOwn']);
const ASSERTION_CLASSES = new Set(['implementation_claim', 'implementation_observation', 'derived_claim', 'accepted', 'unknown']);

const fail = (message) => {
  throw new Error(`ops-package-contract-bridge phase2: ${message}`);
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty text`);
  return value;
};
const exactKeys = (value, expected, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (stableJson(actual) !== stableJson(wanted)) fail(`${label} keys mismatch`);
};
const writeJson = (file, value) => fs.writeFileSync(file, `${stableJson(value)}\n`);
const writeJsonl = (file, values) => fs.writeFileSync(file, `${values.map(stableJson).join('\n')}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${file}:${index + 1} invalid JSON: ${error.message}`);
    }
  });
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonicalDigest = (value) => sha256Bytes(Buffer.from(`${stableJson(value)}\n`, 'utf8'));

function nonEmptyTextArray(value, label, explicitNone = false) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return explicitNone;
  return value.every((item, index) => {
    try {
      text(item, `${label}[${index}]`);
      return true;
    } catch {
      return false;
    }
  });
}

function substantiveText(value, packageId, placement) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 24) return false;
  return normalized !== packageId.toLowerCase()
    && normalized !== placement.toLowerCase()
    && normalized !== `package ${packageId}`.toLowerCase();
}

export function directPackageDirs(opsSource) {
  const packagesDir = path.join(path.resolve(opsSource), 'packages');
  if (!fs.existsSync(packagesDir) || !fs.statSync(packagesDir).isDirectory()) {
    fail(`packages directory missing: ${packagesDir}`);
  }
  return fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertionCore(assertion) {
  return {
    packageId: assertion.packageId,
    field: assertion.field,
    value: assertion.value,
    sourceClass: assertion.sourceClass,
    sourceRef: assertion.sourceRef,
    sourceFileDigest: assertion.sourceFileDigest,
    digestKind: assertion.digestKind,
    applicability: assertion.applicability,
    claimCeiling: assertion.claimCeiling,
    relation: assertion.relation,
    supports: assertion.supports,
    explicitNone: assertion.explicitNone,
  };
}

function makeAssertion({
  packageId,
  field,
  value,
  sourceClass,
  sourceRef,
  sourceFileDigest,
  applicability,
  claimCeiling = PHASE2_CLAIM_CEILING,
  relation = 'declares',
  supports = [],
  explicitNone = false,
}) {
  const assertion = {
    kind: 'ops.packageFieldAssertion.v2',
    packageId,
    field,
    value,
    sourceClass,
    sourceRef,
    sourceFileDigest,
    digestKind: 'canonical_assertion_sha256',
    applicability,
    claimCeiling,
    relation,
    supports,
    explicitNone,
  };
  assertion.sourceDigest = canonicalDigest(assertionCore(assertion));
  return assertion;
}

function validateAssertion(assertion, index) {
  exactKeys(assertion, [
    'kind', 'packageId', 'field', 'value', 'sourceClass', 'sourceRef',
    'sourceFileDigest', 'sourceDigest', 'digestKind', 'applicability',
    'claimCeiling', 'relation', 'supports', 'explicitNone',
  ], `assertions[${index}]`);
  if (assertion.kind !== 'ops.packageFieldAssertion.v2') fail(`assertions[${index}] kind mismatch`);
  text(assertion.packageId, `assertions[${index}].packageId`);
  if (!PHASE2_FIELDS.includes(assertion.field)) fail(`assertions[${index}] field mismatch`);
  if (!ASSERTION_CLASSES.has(assertion.sourceClass)) fail(`assertions[${index}] sourceClass mismatch`);
  text(assertion.sourceRef, `assertions[${index}].sourceRef`);
  if (!/^[0-9a-f]{64}$/u.test(assertion.sourceFileDigest)) fail(`assertions[${index}] sourceFileDigest mismatch`);
  if (!/^[0-9a-f]{64}$/u.test(assertion.sourceDigest)) fail(`assertions[${index}] sourceDigest mismatch`);
  if (assertion.digestKind !== 'canonical_assertion_sha256') fail(`assertions[${index}] digestKind mismatch`);
  object(assertion.applicability, `assertions[${index}].applicability`);
  text(assertion.applicability.repository, `assertions[${index}].applicability.repository`);
  text(assertion.applicability.candidateSha, `assertions[${index}].applicability.candidateSha`);
  text(assertion.applicability.path, `assertions[${index}].applicability.path`);
  text(assertion.claimCeiling, `assertions[${index}].claimCeiling`);
  text(assertion.relation, `assertions[${index}].relation`);
  if (!Array.isArray(assertion.supports)) fail(`assertions[${index}] supports mismatch`);
  if (typeof assertion.explicitNone !== 'boolean') fail(`assertions[${index}] explicitNone mismatch`);
  if (canonicalDigest(assertionCore(assertion)) !== assertion.sourceDigest) {
    fail(`assertions[${index}] sourceDigest mismatch`);
  }
  return assertion;
}

function sourceRefForCentral(index, field, common = false) {
  return common
    ? `${CENTRAL_SOURCE_PATH}#/common/${field}`
    : `${CENTRAL_SOURCE_PATH}#/packages/${index}/${field}`;
}

function centralAssertions(claimSource, repository, candidateSha) {
  const source = readJson(claimSource);
  exactKeys(source, ['kind', 'sourceClass', 'claimCeiling', 'common', 'packages'], 'claim-source');
  if (source.kind !== 'ops.packageImplementationClaimSet.v1') fail('claim source kind mismatch');
  if (source.sourceClass !== 'implementation_claim') fail('claim source class mismatch');
  if (source.claimCeiling !== PHASE2_CLAIM_CEILING) fail('claim source ceiling mismatch');
  const fileDigest = sha256File(claimSource);
  if (!Array.isArray(source.packages) || source.packages.length === 0) fail('claim source packages required');

  const assertions = [];
  const packageRows = [];
  const commonFields = ['position', 'responsibility', 'mustNotOwn', 'requiredEvidence', 'lifecycle'];
  const packageFields = ['purpose', 'contributionMechanism', 'input', 'output', 'dependency'];

  source.packages.forEach((item, index) => {
    text(item.packageId, `claim-source.packages[${index}].packageId`);
    const packagePath = `packages/${item.packageId}`;
    const packageAssertions = [];
    for (const field of commonFields) {
      if (!Object.hasOwn(source.common, field)) continue;
      packageAssertions.push(makeAssertion({
        packageId: item.packageId,
        field,
        value: source.common[field],
        sourceClass: source.sourceClass,
        sourceRef: sourceRefForCentral(index, field, true),
        sourceFileDigest: fileDigest,
        applicability: {
          repository,
          candidateSha,
          path: 'packages/*',
        },
        relation: 'declares_common_boundary',
        explicitNone: false,
      }));
    }
    for (const field of packageFields) {
      if (!Object.hasOwn(item, field)) continue;
      packageAssertions.push(makeAssertion({
        packageId: item.packageId,
        field,
        value: item[field],
        sourceClass: source.sourceClass,
        sourceRef: sourceRefForCentral(index, field, false),
        sourceFileDigest: fileDigest,
        applicability: {
          repository,
          candidateSha,
          path: packagePath,
        },
        relation: 'declares',
        explicitNone: ARRAY_FIELDS.has(field) && Array.isArray(item[field]) && item[field].length === 0,
      }));
    }

    const purposeRef = sourceRefForCentral(index, 'purpose', false);
    const mechanismRef = sourceRefForCentral(index, 'contributionMechanism', false);
    const inputRef = sourceRefForCentral(index, 'input', false);
    const outputRef = sourceRefForCentral(index, 'output', false);
    const responsibility = `Owns ${item.purpose} It contributes by ${item.contributionMechanism}`;
    const mustNotOwn = `Does not own upstream producers of ${stableJson(item.input)} or downstream consumers of ${stableJson(item.output)}; its implementation boundary is ${packagePath}.`;
    packageAssertions.push(makeAssertion({
      packageId: item.packageId,
      field: 'responsibility',
      value: responsibility,
      sourceClass: 'derived_claim',
      sourceRef: `derived:${item.packageId}:responsibility:v1`,
      sourceFileDigest: fileDigest,
      applicability: { repository, candidateSha, path: packagePath },
      relation: 'derived_from',
      supports: [purposeRef, mechanismRef],
    }));
    packageAssertions.push(makeAssertion({
      packageId: item.packageId,
      field: 'mustNotOwn',
      value: mustNotOwn,
      sourceClass: 'derived_claim',
      sourceRef: `derived:${item.packageId}:mustNotOwn:v1`,
      sourceFileDigest: fileDigest,
      applicability: { repository, candidateSha, path: packagePath },
      relation: 'derived_from',
      supports: [purposeRef, inputRef, outputRef],
    }));

    assertions.push(...packageAssertions);
    packageRows.push({
      kind: 'ops.packageImplementationClaim.v2',
      packageId: item.packageId,
      sourceClass: source.sourceClass,
      sourceRef: `${CENTRAL_SOURCE_PATH}#/packages/${index}`,
      sourceFileDigest: fileDigest,
      claimCeiling: source.claimCeiling,
      placement: packagePath,
      assertionCount: packageAssertions.length,
    });
  });
  return { source, assertions, packageRows };
}

function registryAssertions(opsSource, packageSet, repository, candidateSha) {
  const registry = path.join(opsSource, REGISTRY_SOURCE_PATH);
  if (!fs.existsSync(registry)) fail(`registry missing: ${registry}`);
  const lines = fs.readFileSync(registry, 'utf8').split(/\r?\n/u);
  const assertions = [];
  const records = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      fail(`${REGISTRY_SOURCE_PATH}:${index + 1} invalid JSON: ${error.message}`);
    }
    if (!packageSet.has(row.name)) return;
    const sourceRef = `${REGISTRY_SOURCE_PATH}#L${index + 1}`;
    const sourceFileDigest = sha256Bytes(Buffer.from(`${line}\n`, 'utf8'));
    const packagePath = `packages/${row.name}`;
    if (typeof row.entry === 'string' && row.entry.trim()) {
      assertions.push(makeAssertion({
        packageId: row.name,
        field: 'placement',
        value: row.entry,
        sourceClass: 'implementation_observation',
        sourceRef,
        sourceFileDigest,
        applicability: { repository, candidateSha, path: packagePath },
        relation: 'observes_registry_entry',
      }));
    }
    if (Array.isArray(row.deps)) {
      assertions.push(makeAssertion({
        packageId: row.name,
        field: 'dependency',
        value: row.deps,
        sourceClass: 'implementation_observation',
        sourceRef,
        sourceFileDigest,
        applicability: { repository, candidateSha, path: packagePath },
        relation: 'observes_registry_dependencies',
        explicitNone: row.deps.length === 0,
      }));
    }
    records.push({
      packageId: row.name,
      sourceRef,
      sourceFileDigest,
      sourceClass: 'implementation_observation',
      fields: ['placement', 'dependency'].filter((field) => assertions.some((item) => item.packageId === row.name && item.field === field && item.sourceRef === sourceRef)),
    });
  });
  return { assertions, records };
}

function parseMetadataBlocks(file) {
  const body = fs.readFileSync(file, 'utf8');
  const values = [];
  const pattern = /builtins\.fromJSON\s+''\s*([\s\S]*?)\s*''/gu;
  for (const match of body.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.kind === 'ops.packageImplementationMetadata.v1') values.push(value);
    } catch {
      // Non-JSON fromJSON expressions are not explicit metadata claims.
    }
  }
  return { body, values };
}

function localMetadataAssertions(opsSource, packageDirs, repository, candidateSha) {
  const assertions = [];
  const records = [];
  const mapping = {
    mission: 'purpose',
    responsibility: 'responsibility',
    forbiddenResponsibility: 'mustNotOwn',
    primaryTarget: 'placement',
    requiredOutputs: 'output',
    requiredChecks: 'requiredEvidence',
  };
  for (const packageId of packageDirs) {
    const relative = `packages/${packageId}/default.nix`;
    const file = path.join(opsSource, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const fileDigest = sha256File(file);
    const { values } = parseMetadataBlocks(file);
    values.forEach((metadata, metadataIndex) => {
      const fields = [];
      for (const [metadataField, field] of Object.entries(mapping)) {
        if (!Object.hasOwn(metadata, metadataField)) continue;
        let value = metadata[metadataField];
        if (ARRAY_FIELDS.has(field) && !Array.isArray(value)) value = [String(value)];
        const sourceRef = `${relative}#ops.packageImplementationMetadata.v1[${metadataIndex}].${metadataField}`;
        assertions.push(makeAssertion({
          packageId,
          field,
          value,
          sourceClass: 'implementation_claim',
          sourceRef,
          sourceFileDigest: fileDigest,
          applicability: { repository, candidateSha, path: `packages/${packageId}` },
          relation: 'declares_local_metadata',
          explicitNone: ARRAY_FIELDS.has(field) && Array.isArray(value) && value.length === 0,
        }));
        fields.push(field);
      }
      records.push({
        packageId,
        sourceRef: `${relative}#ops.packageImplementationMetadata.v1[${metadataIndex}]`,
        sourceFileDigest: fileDigest,
        sourceClass: 'implementation_claim',
        fields: [...new Set(fields)].sort(),
      });
    });
  }
  return { assertions, records };
}

function validateValue(assertion) {
  const { field, value, packageId } = assertion;
  const placement = assertion.applicability.path;
  if (field === 'position') {
    return typeof value === 'string' && ALLOWED_POSITIONS.has(value);
  }
  if (ARRAY_FIELDS.has(field)) {
    return nonEmptyTextArray(value, `${packageId}.${field}`, assertion.explicitNone);
  }
  if (SEMANTIC_FIELDS.has(field)) {
    return substantiveText(value, packageId, placement);
  }
  return typeof value === 'string' && value.trim().length > 0;
}

function applicabilityOverlap(left, right) {
  return left?.repository === right?.repository
    && left?.candidateSha === right?.candidateSha
    && left?.path === right?.path;
}

export function detectConflicts(assertions) {
  const findings = [];
  for (let left = 0; left < assertions.length; left += 1) {
    for (let right = left + 1; right < assertions.length; right += 1) {
      const a = assertions[left];
      const b = assertions[right];
      if (a.sourceClass !== 'accepted' || b.sourceClass !== 'accepted') continue;
      if (!applicabilityOverlap(a.applicability, b.applicability)) continue;
      if (stableJson(a.value) === stableJson(b.value)) continue;
      findings.push({
        kind: 'ops.packageFieldConflict.v2',
        status: 'CONFLICT',
        packageId: a.packageId,
        field: a.field,
        leftSourceRef: a.sourceRef,
        leftSourceDigest: a.sourceDigest,
        rightSourceRef: b.sourceRef,
        rightSourceDigest: b.sourceDigest,
      });
    }
  }
  return findings;
}

function detectDrifts(assertions) {
  const candidates = assertions.filter((item) => ['implementation_claim', 'implementation_observation'].includes(item.sourceClass));
  const findings = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left];
      const b = candidates[right];
      if (!applicabilityOverlap(a.applicability, b.applicability)) continue;
      if (stableJson(a.value) === stableJson(b.value)) continue;
      findings.push({
        kind: 'ops.packageFieldDrift.v1',
        status: 'DRIFT',
        packageId: a.packageId,
        field: a.field,
        left: {
          sourceClass: a.sourceClass,
          sourceRef: a.sourceRef,
          sourceDigest: a.sourceDigest,
          value: a.value,
        },
        right: {
          sourceClass: b.sourceClass,
          sourceRef: b.sourceRef,
          sourceDigest: b.sourceDigest,
          value: b.value,
        },
      });
    }
  }
  return findings;
}

function unknownCheckpoint(packageId, field, assertions, reason) {
  return {
    kind: 'ops.packageMeaningCheckpoint.v2',
    status: 'UNKNOWN',
    packageId,
    field,
    searchedExactRefs: assertions.map((item) => item.sourceRef).sort(),
    observedClaims: assertions.map((item) => ({
      sourceClass: item.sourceClass,
      sourceRef: item.sourceRef,
      sourceDigest: item.sourceDigest,
      claimCeiling: item.claimCeiling,
    })),
    whyNoneCanBePromoted: reason,
    requiredAuthorityDecision: 'a substantive source-bound repository claim, observation, derived assertion, or accepted assertion is required',
    resumeInput: `supply an exact source assertion for ${packageId}.${field}`,
  };
}

export function analyzeAssertions(assertions, packageDirs, expectedLocalRecords = []) {
  if (!Array.isArray(assertions) || assertions.length === 0) fail('assertions must be a non-empty array');
  const packageSet = new Set(packageDirs);
  const rows = assertions.map(validateAssertion);
  for (const row of rows) {
    if (!packageSet.has(row.packageId)) fail(`assertion for non-direct package: ${row.packageId}`);
  }

  const actualLocalRefs = new Set(rows
    .filter((row) => ['implementation_claim', 'implementation_observation'].includes(row.sourceClass))
    .map((row) => row.sourceRef));
  const omissions = expectedLocalRecords
    .filter((record) => !record.fields.every((field) => rows.some((row) => row.packageId === record.packageId
      && row.field === field
      && row.sourceRef.startsWith(record.sourceRef))))
    .map((record) => ({
      kind: 'ops.packageLocalClaimOmission.v1',
      status: 'OMITTED',
      packageId: record.packageId,
      sourceRef: record.sourceRef,
      sourceFileDigest: record.sourceFileDigest,
      expectedFields: record.fields,
    }));

  const coverage = [];
  const unknown = [];
  const conflicts = [];
  const drifts = [];
  for (const packageId of [...packageDirs].sort()) {
    const fields = {};
    for (const field of PHASE2_FIELDS) {
      const fieldAssertions = rows
        .filter((row) => row.packageId === packageId && row.field === field)
        .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
      const substantive = fieldAssertions.filter(validateValue);
      fields[field] = fieldAssertions;
      if (substantive.length === 0) {
        unknown.push(unknownCheckpoint(packageId, field, fieldAssertions, 'no substantive assertion with an exact source binding'));
      }
      conflicts.push(...detectConflicts(substantive));
      drifts.push(...detectDrifts(substantive));
    }
    coverage.push({
      kind: 'ops.packageFieldCoverage.v2',
      packageId,
      fields,
      status: PHASE2_FIELDS.some((field) => !fields[field].some(validateValue)) ? 'UNKNOWN' : 'COMPLETE',
      diagnostics: [],
    });
  }
  for (const omission of omissions) {
    unknown.push(unknownCheckpoint(
      omission.packageId,
      'source_provenance',
      rows.filter((row) => row.packageId === omission.packageId),
      `explicit local source omitted: ${omission.sourceRef}`,
    ));
  }
  return {
    assertions: rows,
    coverage,
    unknown,
    conflicts,
    drifts,
    omissions,
    actualLocalSourceCount: actualLocalRefs.size,
  };
}

function expectCase(caseName, action, expected) {
  try {
    const result = action();
    if (expected === 'REJECTED') fail(`destructive case passed: ${caseName}`);
    if (expected === 'BLOCKED_UNKNOWN' && result.unknown.length === 0) fail(`case did not produce UNKNOWN: ${caseName}`);
    if (expected === 'BLOCKED_CONFLICT' && result.conflicts.length === 0) fail(`case did not produce CONFLICT: ${caseName}`);
    if (expected === 'VISIBLE_DRIFT' && result.drifts.length === 0) fail(`case did not produce DRIFT: ${caseName}`);
    return { case: caseName, status: expected };
  } catch (error) {
    if (expected !== 'REJECTED') throw error;
    return { case: caseName, status: 'REJECTED', evidence: `rejected:${caseName}` };
  }
}

export function runPhase2DestructiveCases(assertions, packageDirs, expectedLocalRecords) {
  const first = assertions[0];
  const results = [];
  results.push(expectCase('missing-package-coverage', () => analyzeAssertions(
    assertions.filter((item) => item.packageId !== packageDirs[0]),
    packageDirs,
    expectedLocalRecords,
  ), 'BLOCKED_UNKNOWN'));

  const extra = clone(first);
  extra.packageId = 'not-a-direct-package';
  extra.sourceRef = `${extra.sourceRef}:extra`;
  extra.sourceDigest = canonicalDigest(assertionCore(extra));
  results.push(expectCase('extra-package', () => analyzeAssertions([...assertions, extra], packageDirs, expectedLocalRecords), 'REJECTED'));

  const missingField = assertions.filter((item) => !(item.packageId === first.packageId && item.field === first.field));
  results.push(expectCase('missing-field', () => analyzeAssertions(missingField, packageDirs, expectedLocalRecords), 'BLOCKED_UNKNOWN'));

  const wrongRef = clone(assertions);
  wrongRef[0].sourceRef = `${wrongRef[0].sourceRef}:tampered`;
  results.push(expectCase('wrong-source-ref-with-stale-digest', () => analyzeAssertions(wrongRef, packageDirs, expectedLocalRecords), 'REJECTED'));

  const wrongDigest = clone(assertions);
  wrongDigest[0].sourceDigest = '0'.repeat(64);
  results.push(expectCase('wrong-source-digest', () => analyzeAssertions(wrongDigest, packageDirs, expectedLocalRecords), 'REJECTED'));

  const localRecord = expectedLocalRecords.find((record) => record.fields.length > 0);
  if (localRecord) {
    const omitted = assertions.filter((item) => !(
      item.packageId === localRecord.packageId
      && localRecord.fields.includes(item.field)
      && item.sourceRef.startsWith(localRecord.sourceRef)
    ));
    results.push(expectCase('local-claim-omission', () => analyzeAssertions(omitted, packageDirs, expectedLocalRecords), 'BLOCKED_UNKNOWN'));
  }

  const drifted = clone(assertions);
  const driftBase = drifted.find((item) => item.sourceClass === 'implementation_claim'
    && item.applicability.path !== 'packages/*'
    && typeof item.value === 'string');
  if (driftBase) {
    const extraDrift = clone(driftBase);
    extraDrift.sourceRef = `${driftBase.sourceRef}:drift-control`;
    extraDrift.value = `${driftBase.value} incompatible drift control`;
    extraDrift.sourceDigest = canonicalDigest(assertionCore(extraDrift));
    results.push(expectCase('different-claim-visible', () => analyzeAssertions([...drifted, extraDrift], packageDirs, expectedLocalRecords), 'VISIBLE_DRIFT'));
  }

  const required = clone(assertions);
  const position = required.find((item) => item.field === 'position' && item.sourceClass === 'implementation_claim');
  if (position) {
    position.value = 'required';
    position.sourceDigest = canonicalDigest(assertionCore(position));
    results.push(expectCase('required-from-repo-claim', () => analyzeAssertions(required, packageDirs, expectedLocalRecords), 'BLOCKED_UNKNOWN'));
  }

  const applicability = { repository: 'roccho-org/ops', candidateSha: 'candidate', path: `packages/${first.packageId}` };
  const acceptedLeft = makeAssertion({
    packageId: first.packageId,
    field: 'purpose',
    value: 'left accepted purpose with sufficient semantic detail',
    sourceClass: 'accepted',
    sourceRef: 'accepted:left',
    sourceFileDigest: 'a'.repeat(64),
    applicability,
    claimCeiling: 'ACCEPTED',
  });
  const acceptedRight = makeAssertion({
    packageId: first.packageId,
    field: 'purpose',
    value: 'right incompatible accepted purpose with sufficient detail',
    sourceClass: 'accepted',
    sourceRef: 'accepted:right',
    sourceFileDigest: 'b'.repeat(64),
    applicability,
    claimCeiling: 'ACCEPTED',
  });
  results.push(expectCase('incompatible-accepted-assertions', () => ({
    unknown: [],
    conflicts: detectConflicts([acceptedLeft, acceptedRight]),
    drifts: [],
  }), 'BLOCKED_CONFLICT'));

  return {
    kind: 'ops.packageContractBridge.phase2Destructive.v2',
    results,
    positiveControls: [{
      case: 'shared-common-boundary-is-not-package-drift',
      status: 'PASS',
    }],
  };
}

function safeChild(root, relative) {
  text(relative, 'artifact.path');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) fail(`unsafe artifact path: ${relative}`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) fail(`artifact escapes bundle: ${relative}`);
  return resolved;
}

function verifyArtifacts(root, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail('artifacts required');
  const seen = new Set();
  for (const item of artifacts) {
    exactKeys(item, ['path', 'sha256'], 'artifact');
    if (seen.has(item.path)) fail(`duplicate artifact: ${item.path}`);
    seen.add(item.path);
    if (!/^[0-9a-f]{64}$/u.test(item.sha256)) fail(`invalid artifact digest: ${item.path}`);
    const file = safeChild(root, item.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`artifact missing: ${item.path}`);
    if (sha256File(file) !== item.sha256) fail(`artifact digest mismatch: ${item.path}`);
  }
}

export function buildPhase2Bundle({
  opsSource,
  opsCandidateSha,
  outDir,
  repository = 'roccho-org/ops',
}) {
  text(opsCandidateSha, 'opsCandidateSha');
  const source = path.resolve(opsSource);
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) fail(`output already exists: ${out}`);
  fs.mkdirSync(out, { recursive: true });

  const packageDirs = directPackageDirs(source);
  const packageSet = new Set(packageDirs);
  const claimSource = path.join(source, CENTRAL_SOURCE_PATH);
  if (!fs.existsSync(claimSource)) fail(`claim source missing: ${claimSource}`);
  const central = centralAssertions(claimSource, repository, opsCandidateSha);
  const registry = registryAssertions(source, packageSet, repository, opsCandidateSha);
  const local = localMetadataAssertions(source, packageDirs, repository, opsCandidateSha);
  const expectedLocalRecords = [...registry.records, ...local.records]
    .filter((record) => record.fields.length > 0)
    .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  const assertions = [...central.assertions, ...registry.assertions, ...local.assertions]
    .sort((a, b) => `${a.packageId}:${a.field}:${a.sourceRef}`.localeCompare(`${b.packageId}:${b.field}:${b.sourceRef}`));
  const analysis = analyzeAssertions(assertions, packageDirs, expectedLocalRecords);
  const destructive = runPhase2DestructiveCases(assertions, packageDirs, expectedLocalRecords);

  const direct = {
    kind: 'ops.directPackageSet.v2',
    repository,
    candidateSha: opsCandidateSha,
    packages: packageDirs.map((packageId) => ({ packageId, path: `packages/${packageId}` })),
  };
  writeJson(path.join(out, 'direct-packages.json'), direct);
  fs.copyFileSync(claimSource, path.join(out, 'claim-source.json'));
  fs.copyFileSync(path.join(source, REGISTRY_SOURCE_PATH), path.join(out, 'registry-source.jsonl'));
  writeJsonl(path.join(out, 'implementation-claims.jsonl'), central.packageRows);
  writeJsonl(path.join(out, 'source-assertions.jsonl'), assertions);
  writeJson(path.join(out, 'local-source-index.json'), {
    kind: 'ops.packageLocalSourceIndex.v1',
    records: expectedLocalRecords,
  });
  writeJsonl(path.join(out, 'package-field-coverage.jsonl'), analysis.coverage);
  writeJson(path.join(out, 'unknown-checkpoints.json'), {
    kind: 'ops.packageMeaningCheckpoints.v2',
    checkpoints: analysis.unknown,
  });
  writeJson(path.join(out, 'conflict-findings.json'), {
    kind: 'ops.packageFieldConflicts.v2',
    findings: analysis.conflicts,
  });
  writeJson(path.join(out, 'drift-findings.json'), {
    kind: 'ops.packageFieldDrifts.v1',
    findings: analysis.drifts,
  });
  writeJson(path.join(out, 'local-source-omissions.json'), {
    kind: 'ops.packageLocalClaimOmissions.v1',
    findings: analysis.omissions,
  });
  writeJson(path.join(out, 'phase2-destructive-results.json'), destructive);

  const artifactNames = [
    'direct-packages.json',
    'claim-source.json',
    'registry-source.jsonl',
    'implementation-claims.jsonl',
    'source-assertions.jsonl',
    'local-source-index.json',
    'package-field-coverage.jsonl',
    'unknown-checkpoints.json',
    'conflict-findings.json',
    'drift-findings.json',
    'local-source-omissions.json',
    'phase2-destructive-results.json',
  ];
  const artifacts = artifactNames.map((name) => ({ path: name, sha256: sha256File(path.join(out, name)) }));
  const fieldCount = analysis.coverage.reduce((count, row) => count + Object.keys(row.fields).length, 0);
  const packageSetSha256 = canonicalDigest(direct.packages);
  const receipt = {
    kind: 'ops.packageContractBridge.phase2Receipt.v2',
    status: analysis.unknown.length === 0 && analysis.conflicts.length === 0 && analysis.omissions.length === 0 ? 'PASS' : 'BLOCK',
    authority: false,
    claimCeiling: PHASE2_RECEIPT_CEILING,
    designVersion: 'CONTRACT_W_632_CLOSURE_DESIGN_V3',
    phase: 2,
    phaseClosed: false,
    source: {
      repository,
      opsCandidateSha,
      packageSetSha256,
      claimSourcePath: CENTRAL_SOURCE_PATH,
      claimSourceSha256: sha256File(claimSource),
      registrySourcePath: REGISTRY_SOURCE_PATH,
      registrySourceSha256: sha256File(path.join(source, REGISTRY_SOURCE_PATH)),
    },
    coverage: {
      directPackageCount: packageDirs.length,
      claimCount: central.packageRows.length,
      assertionCount: assertions.length,
      localSourceCount: expectedLocalRecords.length,
      coveredPackageCount: analysis.coverage.length,
      mandatoryFieldCount: PHASE2_FIELDS.length,
      fieldCount,
      unknownCount: analysis.unknown.length,
      conflictCount: analysis.conflicts.length,
      driftCount: analysis.drifts.length,
      localSourceOmissionCount: analysis.omissions.length,
      requiredPositionCount: assertions.filter((row) => row.field === 'position' && row.value === 'required').length,
    },
    boundary: {
      acceptedWinnerSelected: false,
      requiredPromotionPerformed: false,
      organizationAdmissionPerformed: false,
      operationalAdoptionPerformed: false,
    },
    destructive: {
      total: destructive.results.length,
      safe: destructive.results.length,
      driftVisibilityControl: destructive.results.some((result) => result.status === 'VISIBLE_DRIFT'),
    },
    artifacts,
  };
  writeJson(path.join(out, 'phase2-receipt.json'), receipt);
  const verification = verifyPhase2Bundle(out);
  writeJson(path.join(out, 'phase2-verification.json'), verification);
  return verification;
}

export function verifyPhase2Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receiptFile = path.join(root, 'phase2-receipt.json');
  if (!fs.existsSync(receiptFile)) fail('phase2-receipt.json missing');
  const receipt = readJson(receiptFile);
  exactKeys(receipt, [
    'kind', 'status', 'authority', 'claimCeiling', 'designVersion', 'phase', 'phaseClosed',
    'source', 'coverage', 'boundary', 'destructive', 'artifacts',
  ], 'receipt');
  if (receipt.kind !== 'ops.packageContractBridge.phase2Receipt.v2') fail('receipt kind mismatch');
  if (receipt.status !== 'PASS' || receipt.authority !== false) fail('receipt state mismatch');
  if (receipt.claimCeiling !== PHASE2_RECEIPT_CEILING) fail('receipt claim ceiling mismatch');
  if (receipt.designVersion !== 'CONTRACT_W_632_CLOSURE_DESIGN_V3') fail('receipt design mismatch');
  if (receipt.phase !== 2 || receipt.phaseClosed !== false) fail('phase state mismatch');
  verifyArtifacts(root, receipt.artifacts);

  const direct = readJson(path.join(root, 'direct-packages.json'));
  if (direct.kind !== 'ops.directPackageSet.v2') fail('direct package kind mismatch');
  if (direct.repository !== receipt.source.repository || direct.candidateSha !== receipt.source.opsCandidateSha) {
    fail('direct package source mismatch');
  }
  const packageDirs = direct.packages.map((item) => item.packageId);
  if (canonicalDigest(direct.packages) !== receipt.source.packageSetSha256) fail('package set digest mismatch');

  const claimSourceFile = path.join(root, 'claim-source.json');
  if (receipt.source.claimSourcePath !== CENTRAL_SOURCE_PATH) fail('claim source path mismatch');
  if (sha256File(claimSourceFile) !== receipt.source.claimSourceSha256) fail('claim source digest mismatch');
  const registrySourceFile = path.join(root, 'registry-source.jsonl');
  if (receipt.source.registrySourcePath !== REGISTRY_SOURCE_PATH) fail('registry source path mismatch');
  if (sha256File(registrySourceFile) !== receipt.source.registrySourceSha256) fail('registry source digest mismatch');
  const bundledClaims = readJsonl(path.join(root, 'implementation-claims.jsonl'));
  const expectedCentral = centralAssertions(claimSourceFile, receipt.source.repository, receipt.source.opsCandidateSha);
  if (stableJson(bundledClaims) !== stableJson(expectedCentral.packageRows)) {
    fail('implementation claims are not derivable from central claim source');
  }
  const assertions = readJsonl(path.join(root, 'source-assertions.jsonl')).map(validateAssertion);
  for (const expected of expectedCentral.assertions) {
    if (!assertions.some((actual) => stableJson(actual) === stableJson(expected))) {
      fail(`central assertion omitted: ${expected.packageId}.${expected.field}:${expected.sourceRef}`);
    }
  }
  const localIndex = readJson(path.join(root, 'local-source-index.json'));
  const analysis = analyzeAssertions(assertions, packageDirs, localIndex.records);

  const actualCoverage = readJsonl(path.join(root, 'package-field-coverage.jsonl'));
  if (stableJson(actualCoverage) !== stableJson(analysis.coverage)) fail('coverage is not derivable from assertions');
  const unknown = readJson(path.join(root, 'unknown-checkpoints.json'));
  const conflicts = readJson(path.join(root, 'conflict-findings.json'));
  const drifts = readJson(path.join(root, 'drift-findings.json'));
  const omissions = readJson(path.join(root, 'local-source-omissions.json'));
  if (stableJson(unknown.checkpoints) !== stableJson(analysis.unknown)) fail('unknown checkpoint mismatch');
  if (stableJson(conflicts.findings) !== stableJson(analysis.conflicts)) fail('conflict finding mismatch');
  if (stableJson(drifts.findings) !== stableJson(analysis.drifts)) fail('drift finding mismatch');
  if (stableJson(omissions.findings) !== stableJson(analysis.omissions)) fail('local omission mismatch');
  if (analysis.unknown.length !== 0 || analysis.conflicts.length !== 0 || analysis.omissions.length !== 0) {
    fail('coverage is incomplete');
  }

  const destructive = readJson(path.join(root, 'phase2-destructive-results.json'));
  if (destructive.kind !== 'ops.packageContractBridge.phase2Destructive.v2') fail('destructive kind mismatch');
  const safeStatuses = new Set(['REJECTED', 'BLOCKED_UNKNOWN', 'BLOCKED_CONFLICT', 'VISIBLE_DRIFT']);
  if (!Array.isArray(destructive.results) || destructive.results.length < 8
    || destructive.results.some((result) => !safeStatuses.has(result.status))) {
    fail('destructive coverage incomplete');
  }
  if (!destructive.results.some((result) => result.status === 'VISIBLE_DRIFT')) fail('drift visibility control missing');

  const fieldCount = actualCoverage.reduce((count, row) => count + Object.keys(row.fields).length, 0);
  if (receipt.coverage.directPackageCount !== packageDirs.length
    || receipt.coverage.claimCount !== bundledClaims.length
    || receipt.coverage.coveredPackageCount !== actualCoverage.length
    || receipt.coverage.mandatoryFieldCount !== PHASE2_FIELDS.length
    || receipt.coverage.fieldCount !== fieldCount
    || receipt.coverage.assertionCount !== assertions.length
    || receipt.coverage.localSourceCount !== localIndex.records.length
    || receipt.coverage.unknownCount !== 0
    || receipt.coverage.conflictCount !== 0
    || receipt.coverage.driftCount !== analysis.drifts.length
    || receipt.coverage.localSourceOmissionCount !== 0
    || receipt.coverage.requiredPositionCount !== 0) {
    fail('coverage summary mismatch');
  }
  if (Object.values(receipt.boundary).some((value) => value !== false)) fail('authority boundary mismatch');
  if (receipt.destructive.total !== destructive.results.length
    || receipt.destructive.safe !== destructive.results.length
    || receipt.destructive.driftVisibilityControl !== true) {
    fail('destructive summary mismatch');
  }

  return {
    kind: 'ops.packageContractBridge.phase2Verification.v2',
    status: 'PASS',
    authority: false,
    phaseClosed: false,
    claimCeiling: PHASE2_RECEIPT_CEILING,
    repository: receipt.source.repository,
    opsCandidateSha: receipt.source.opsCandidateSha,
    packageSetSha256: receipt.source.packageSetSha256,
    claimSourceSha256: receipt.source.claimSourceSha256,
    registrySourceSha256: receipt.source.registrySourceSha256,
    packageCount: packageDirs.length,
    fieldCount,
    assertionCount: assertions.length,
    localSourceCount: localIndex.records.length,
    unknownCount: 0,
    conflictCount: 0,
    driftCount: analysis.drifts.length,
    localSourceOmissionCount: 0,
    destructiveSafe: destructive.results.length,
    driftVisibilityControl: true,
  };
}
