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
const ROW_KEYS = Object.freeze([
  'kind',
  'packageId',
  'sourceClass',
  'sourceRef',
  'claimCeiling',
  ...PHASE2_FIELDS,
]);
const ALLOWED_POSITIONS = new Set(['implementation', 'support', 'proof', 'historical']);

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
const readJsonl = (file) => {
  const body = fs.readFileSync(file, 'utf8');
  const lines = body.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${file}:${index + 1} invalid JSON: ${error.message}`);
    }
  });
};
const clone = (value) => JSON.parse(JSON.stringify(value));

const CLAIM_SET_KEYS = Object.freeze(['kind', 'sourceClass', 'claimCeiling', 'common', 'packages']);
const COMMON_KEYS = Object.freeze(['position', 'responsibility', 'mustNotOwn', 'requiredEvidence', 'lifecycle']);
const PACKAGE_KEYS = Object.freeze(['packageId', 'purpose', 'contributionMechanism', 'input', 'output', 'dependency']);

export function expandClaimSource(file) {
  const source = readJson(file);
  exactKeys(source, CLAIM_SET_KEYS, 'claim-source');
  if (source.kind !== 'ops.packageImplementationClaimSet.v1') fail('claim source kind mismatch');
  if (source.sourceClass !== 'implementation_claim') fail('claim source class mismatch');
  if (source.claimCeiling !== PHASE2_CLAIM_CEILING) fail('claim source ceiling mismatch');
  exactKeys(source.common, COMMON_KEYS, 'claim-source.common');
  if (!Array.isArray(source.packages) || source.packages.length === 0) fail('claim source packages required');
  return source.packages.map((item, index) => {
    exactKeys(item, PACKAGE_KEYS, `claim-source.packages[${index}]`);
    text(item.packageId, `claim-source.packages[${index}].packageId`);
    return {
      kind: 'ops.packageImplementationClaim.v1',
      packageId: item.packageId,
      sourceClass: source.sourceClass,
      sourceRef: `packages/${item.packageId}`,
      claimCeiling: source.claimCeiling,
      position: source.common.position,
      purpose: item.purpose,
      contributionMechanism: item.contributionMechanism,
      responsibility: source.common.responsibility,
      mustNotOwn: source.common.mustNotOwn,
      placement: `packages/${item.packageId}`,
      input: item.input,
      output: item.output,
      dependency: item.dependency,
      requiredEvidence: source.common.requiredEvidence,
      lifecycle: source.common.lifecycle,
    };
  });
}

function nonEmptyTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) return false;
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
        kind: 'ops.packageFieldConflict.v1',
        status: 'CONFLICT',
        leftSourceRef: a.sourceRef,
        rightSourceRef: b.sourceRef,
      });
    }
  }
  return findings;
}

function structuralClaim(row, index) {
  exactKeys(row, ROW_KEYS, `claims[${index}]`);
  if (row.kind !== 'ops.packageImplementationClaim.v1') fail(`claims[${index}] kind mismatch`);
  text(row.packageId, `claims[${index}].packageId`);
  if (row.sourceClass !== 'implementation_claim') fail(`claims[${index}] unsupported sourceClass`);
  if (row.claimCeiling !== PHASE2_CLAIM_CEILING) fail(`claims[${index}] claim ceiling mismatch`);
  text(row.sourceRef, `claims[${index}].sourceRef`);
  if (row.sourceRef !== `packages/${row.packageId}`) fail(`claims[${index}] sourceRef mismatch`);
  text(row.placement, `claims[${index}].placement`);
  if (row.placement !== `packages/${row.packageId}`) fail(`claims[${index}] placement mismatch`);
  return row;
}

function unknownCheckpoint(row, field, reason) {
  return {
    kind: 'ops.packageMeaningCheckpoint.v1',
    status: 'UNKNOWN',
    packageId: row.packageId,
    field,
    searchedExactRefs: [row.sourceRef],
    observedClaims: [{
      sourceClass: row.sourceClass,
      sourceRef: row.sourceRef,
      claimCeiling: row.claimCeiling,
    }],
    whyNoneCanBePromoted: reason,
    requiredAuthorityDecision: row.position === 'required'
      ? 'accepted source must establish required position and required semantic fields'
      : 'a substantive source-bound repository claim or accepted assertion is required',
    resumeInput: `supply an exact source assertion for ${row.packageId}.${field}`,
  };
}

function analyzeField(row, field, repository, candidateSha) {
  const value = row[field];
  let complete = true;
  let reason = '';
  if (field === 'position') {
    complete = typeof value === 'string' && ALLOWED_POSITIONS.has(value);
    if (!complete) reason = 'repository claim cannot establish required or unknown position';
  } else if (['input', 'output', 'dependency', 'requiredEvidence'].includes(field)) {
    complete = nonEmptyTextArray(value, `${row.packageId}.${field}`);
    if (!complete) reason = 'missing field was not converted to an empty or not-applicable default';
  } else if (['purpose', 'contributionMechanism', 'responsibility', 'mustNotOwn'].includes(field)) {
    complete = substantiveText(value, row.packageId, row.placement);
    if (!complete) reason = 'path or package name alone is not substantive package meaning';
  } else {
    complete = typeof value === 'string' && value.trim().length > 0;
    if (!complete) reason = 'missing field has no allowed source';
  }

  if (!complete) {
    return {
      assertion: {
        value: null,
        sourceClass: 'unknown',
        sourceRef: row.sourceRef,
        sourceDigest: null,
        applicability: {
          repository,
          candidateSha,
          path: row.placement,
        },
        claimCeiling: PHASE2_CLAIM_CEILING,
      },
      checkpoint: unknownCheckpoint(row, field, reason),
    };
  }

  const rowDigest = sha256Bytes(Buffer.from(`${stableJson(row)}\n`, 'utf8'));
  return {
    assertion: {
      value,
      sourceClass: row.sourceClass,
      sourceRef: row.sourceRef,
      sourceDigest: rowDigest,
      applicability: {
        repository,
        candidateSha,
        path: row.placement,
      },
      claimCeiling: row.claimCeiling,
    },
    checkpoint: null,
  };
}

export function analyzeClaims(claims, packageDirs, {
  repository = 'roccho-org/ops',
  candidateSha = 'candidate',
} = {}) {
  if (!Array.isArray(claims) || claims.length === 0) fail('claims must be a non-empty array');
  const rows = claims.map(structuralClaim);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.packageId)) fail(`duplicate package claim: ${row.packageId}`);
    seen.add(row.packageId);
  }
  const expected = [...packageDirs].sort();
  const actual = [...seen].sort();
  const missing = expected.filter((name) => !seen.has(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    fail(`package set mismatch missing=${missing.join(',')} extra=${extra.join(',')}`);
  }

  const coverage = [];
  const unknown = [];
  const conflicts = [];
  for (const row of [...rows].sort((a, b) => a.packageId.localeCompare(b.packageId))) {
    const fields = {};
    for (const field of PHASE2_FIELDS) {
      const analyzed = analyzeField(row, field, repository, candidateSha);
      fields[field] = [analyzed.assertion];
      if (analyzed.checkpoint) unknown.push(analyzed.checkpoint);
      conflicts.push(...detectConflicts(fields[field]));
    }
    coverage.push({
      kind: 'ops.packageFieldCoverage.v1',
      packageId: row.packageId,
      sourceRef: row.sourceRef,
      fields,
      status: Object.values(fields).some((items) => items.some((item) => item.sourceClass === 'unknown'))
        ? 'UNKNOWN'
        : 'COMPLETE',
      diagnostics: [],
    });
  }
  return { coverage, unknown, conflicts };
}

function expectSafeResult(caseName, action, expectedStatus) {
  try {
    const result = action();
    if (expectedStatus === 'REJECTED') fail(`destructive case passed: ${caseName}`);
    if (expectedStatus === 'BLOCKED_UNKNOWN' && result.unknown.length === 0) {
      fail(`destructive case did not produce UNKNOWN: ${caseName}`);
    }
    if (expectedStatus === 'BLOCKED_CONFLICT' && result.conflicts.length === 0) {
      fail(`destructive case did not produce CONFLICT: ${caseName}`);
    }
    return { case: caseName, status: expectedStatus, evidence: expectedStatus };
  } catch (error) {
    if (expectedStatus !== 'REJECTED') throw error;
    return { case: caseName, status: 'REJECTED', evidence: `rejected:${caseName}` };
  }
}

export function runPhase2DestructiveCases(claims, packageDirs, options) {
  const first = claims[0];
  const results = [];

  results.push(expectSafeResult('missing-package', () => analyzeClaims(claims.slice(1), packageDirs, options), 'REJECTED'));
  results.push(expectSafeResult('extra-package', () => analyzeClaims([
    ...claims,
    { ...clone(first), packageId: 'not-a-direct-package', placement: 'packages/not-a-direct-package', sourceRef: 'packages/not-a-direct-package' },
  ], packageDirs, options), 'REJECTED'));
  results.push(expectSafeResult('duplicate-package', () => analyzeClaims([...claims, clone(first)], packageDirs, options), 'REJECTED'));

  const missingField = clone(claims);
  delete missingField[0].purpose;
  results.push(expectSafeResult('missing-field', () => {
    const patched = missingField.map((row, index) => index === 0 ? { ...row, purpose: '' } : row);
    return analyzeClaims(patched, packageDirs, options);
  }, 'BLOCKED_UNKNOWN'));

  const emptyField = clone(claims);
  emptyField[0].dependency = [];
  results.push(expectSafeResult('empty-array-field', () => analyzeClaims(emptyField, packageDirs, options), 'BLOCKED_UNKNOWN'));

  const pathOnly = clone(claims);
  pathOnly[0].purpose = pathOnly[0].packageId;
  results.push(expectSafeResult('path-name-only', () => analyzeClaims(pathOnly, packageDirs, options), 'BLOCKED_UNKNOWN'));

  const requiredFromClaim = clone(claims);
  requiredFromClaim[0].position = 'required';
  results.push(expectSafeResult('required-from-repo-claim', () => analyzeClaims(requiredFromClaim, packageDirs, options), 'BLOCKED_UNKNOWN'));

  const unknownSource = clone(claims);
  unknownSource[0].sourceClass = 'invented';
  results.push(expectSafeResult('unknown-source-class', () => analyzeClaims(unknownSource, packageDirs, options), 'REJECTED'));

  const applicability = {
    repository: options.repository,
    candidateSha: options.candidateSha,
    path: first.placement,
  };
  const acceptedConflict = detectConflicts([
    {
      value: 'left accepted purpose',
      sourceClass: 'accepted',
      sourceRef: 'accepted:left',
      sourceDigest: 'a'.repeat(64),
      applicability,
      claimCeiling: 'ACCEPTED',
    },
    {
      value: 'right incompatible purpose',
      sourceClass: 'accepted',
      sourceRef: 'accepted:right',
      sourceDigest: 'b'.repeat(64),
      applicability,
      claimCeiling: 'ACCEPTED',
    },
  ]);
  results.push(expectSafeResult('incompatible-accepted-assertions', () => ({
    unknown: [],
    conflicts: acceptedConflict,
  }), 'BLOCKED_CONFLICT'));

  const sharedResponsibility = detectConflicts([
    {
      value: 'shared transport responsibility',
      sourceClass: 'implementation_claim',
      sourceRef: claims[0].sourceRef,
      sourceDigest: 'c'.repeat(64),
      applicability,
      claimCeiling: PHASE2_CLAIM_CEILING,
    },
    {
      value: 'shared transport responsibility',
      sourceClass: 'implementation_claim',
      sourceRef: claims[1].sourceRef,
      sourceDigest: 'd'.repeat(64),
      applicability: { ...applicability, path: claims[1].placement },
      claimCeiling: PHASE2_CLAIM_CEILING,
    },
  ]);
  if (sharedResponsibility.length !== 0) fail('shared responsibility was treated as conflict');

  return {
    kind: 'ops.packageContractBridge.phase2Destructive.v1',
    results,
    positiveControls: [{
      case: 'shared-responsibility-is-not-conflict',
      status: 'PASS',
      conflictCount: 0,
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

  const claimSource = path.join(source, 'packages/ops-package-contract-bridge/contract/phase2-package-claims.v1.json');
  if (!fs.existsSync(claimSource)) fail(`claim source missing: ${claimSource}`);
  const claims = expandClaimSource(claimSource);
  const packageDirs = directPackageDirs(source);
  const analysis = analyzeClaims(claims, packageDirs, { repository, candidateSha: opsCandidateSha });
  const destructive = runPhase2DestructiveCases(claims, packageDirs, { repository, candidateSha: opsCandidateSha });

  const direct = {
    kind: 'ops.directPackageSet.v1',
    repository,
    candidateSha: opsCandidateSha,
    packages: packageDirs.map((packageId) => ({ packageId, path: `packages/${packageId}` })),
  };
  writeJson(path.join(out, 'direct-packages.json'), direct);
  fs.copyFileSync(claimSource, path.join(out, 'claim-source.json'));
  writeJsonl(path.join(out, 'implementation-claims.jsonl'), claims);
  writeJsonl(path.join(out, 'package-field-coverage.jsonl'), analysis.coverage);
  writeJson(path.join(out, 'unknown-checkpoints.json'), {
    kind: 'ops.packageMeaningCheckpoints.v1',
    checkpoints: analysis.unknown,
  });
  writeJson(path.join(out, 'conflict-findings.json'), {
    kind: 'ops.packageFieldConflicts.v1',
    findings: analysis.conflicts,
  });
  writeJson(path.join(out, 'phase2-destructive-results.json'), destructive);

  const artifactNames = [
    'direct-packages.json',
    'claim-source.json',
    'implementation-claims.jsonl',
    'package-field-coverage.jsonl',
    'unknown-checkpoints.json',
    'conflict-findings.json',
    'phase2-destructive-results.json',
  ];
  const artifacts = artifactNames.map((name) => ({
    path: name,
    sha256: sha256File(path.join(out, name)),
  }));
  const fieldCount = analysis.coverage.reduce((count, row) => count + Object.keys(row.fields).length, 0);
  const packageSetSha256 = sha256Bytes(Buffer.from(stableJson(direct.packages), 'utf8'));
  const receipt = {
    kind: 'ops.packageContractBridge.phase2Receipt.v1',
    status: analysis.unknown.length === 0 && analysis.conflicts.length === 0 ? 'PASS' : 'BLOCK',
    authority: false,
    claimCeiling: PHASE2_RECEIPT_CEILING,
    designVersion: 'CONTRACT_W_632_CLOSURE_DESIGN_V3',
    phase: 2,
    phaseClosed: false,
    source: {
      repository,
      opsCandidateSha,
      packageSetSha256,
      claimSourcePath: 'packages/ops-package-contract-bridge/contract/phase2-package-claims.v1.json',
      claimSourceSha256: sha256File(claimSource),
    },
    coverage: {
      directPackageCount: packageDirs.length,
      claimCount: claims.length,
      coveredPackageCount: analysis.coverage.length,
      mandatoryFieldCount: PHASE2_FIELDS.length,
      fieldCount,
      unknownCount: analysis.unknown.length,
      conflictCount: analysis.conflicts.length,
      requiredPositionCount: claims.filter((row) => row.position === 'required').length,
      implementationClaimCount: claims.filter((row) => row.sourceClass === 'implementation_claim').length,
    },
    boundary: {
      acceptedWinnerSelected: false,
      requiredPromotionPerformed: false,
      organizationAdmissionPerformed: false,
      operationalAdoptionPerformed: false,
    },
    destructive: {
      total: destructive.results.length,
      safe: destructive.results.filter((result) => ['REJECTED', 'BLOCKED_UNKNOWN', 'BLOCKED_CONFLICT'].includes(result.status)).length,
      sharedResponsibilityControl: destructive.positiveControls[0].status,
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
  if (receipt.kind !== 'ops.packageContractBridge.phase2Receipt.v1') fail('receipt kind mismatch');
  if (receipt.status !== 'PASS' || receipt.authority !== false) fail('receipt state mismatch');
  if (receipt.claimCeiling !== PHASE2_RECEIPT_CEILING) fail('receipt claim ceiling mismatch');
  if (receipt.designVersion !== 'CONTRACT_W_632_CLOSURE_DESIGN_V3') fail('receipt design mismatch');
  if (receipt.phase !== 2 || receipt.phaseClosed !== false) fail('phase state mismatch');
  verifyArtifacts(root, receipt.artifacts);

  const direct = readJson(path.join(root, 'direct-packages.json'));
  exactKeys(direct, ['kind', 'repository', 'candidateSha', 'packages'], 'direct-packages');
  if (direct.kind !== 'ops.directPackageSet.v1') fail('direct package kind mismatch');
  if (direct.repository !== receipt.source.repository || direct.candidateSha !== receipt.source.opsCandidateSha) {
    fail('direct package source mismatch');
  }
  const packageDirs = direct.packages.map((item, index) => {
    exactKeys(item, ['packageId', 'path'], `direct-packages[${index}]`);
    if (item.path !== `packages/${item.packageId}`) fail(`direct package path mismatch: ${item.packageId}`);
    return item.packageId;
  });
  if (sha256Bytes(Buffer.from(stableJson(direct.packages), 'utf8')) !== receipt.source.packageSetSha256) {
    fail('package set digest mismatch');
  }

  const claimSourceFile = path.join(root, 'claim-source.json');
  const claimsFile = path.join(root, 'implementation-claims.jsonl');
  if (receipt.source.claimSourcePath !== 'packages/ops-package-contract-bridge/contract/phase2-package-claims.v1.json') {
    fail('claim source path mismatch');
  }
  if (sha256File(claimSourceFile) !== receipt.source.claimSourceSha256) fail('claim source digest mismatch');
  const claims = expandClaimSource(claimSourceFile);
  const derivedClaims = readJsonl(claimsFile);
  if (stableJson(derivedClaims) !== stableJson(claims)) fail('implementation claims are not derivable from claim source');
  const analysis = analyzeClaims(claims, packageDirs, {
    repository: receipt.source.repository,
    candidateSha: receipt.source.opsCandidateSha,
  });
  const actualCoverage = readJsonl(path.join(root, 'package-field-coverage.jsonl'));
  if (stableJson(actualCoverage) !== stableJson(analysis.coverage)) fail('coverage is not derivable from claims');
  const unknown = readJson(path.join(root, 'unknown-checkpoints.json'));
  const conflicts = readJson(path.join(root, 'conflict-findings.json'));
  if (stableJson(unknown.checkpoints) !== stableJson(analysis.unknown)) fail('unknown checkpoint mismatch');
  if (stableJson(conflicts.findings) !== stableJson(analysis.conflicts)) fail('conflict finding mismatch');
  if (analysis.unknown.length !== 0 || analysis.conflicts.length !== 0) fail('coverage is incomplete');

  const destructive = readJson(path.join(root, 'phase2-destructive-results.json'));
  if (destructive.kind !== 'ops.packageContractBridge.phase2Destructive.v1') fail('destructive kind mismatch');
  const safeStatuses = new Set(['REJECTED', 'BLOCKED_UNKNOWN', 'BLOCKED_CONFLICT']);
  if (!Array.isArray(destructive.results) || destructive.results.length < 9
    || destructive.results.some((result) => !safeStatuses.has(result.status))) {
    fail('destructive coverage incomplete');
  }
  if (destructive.positiveControls?.[0]?.status !== 'PASS') fail('shared responsibility control missing');

  const fieldCount = actualCoverage.reduce((count, row) => count + Object.keys(row.fields).length, 0);
  if (receipt.coverage.directPackageCount !== packageDirs.length
    || receipt.coverage.claimCount !== claims.length
    || receipt.coverage.coveredPackageCount !== actualCoverage.length
    || receipt.coverage.mandatoryFieldCount !== PHASE2_FIELDS.length
    || receipt.coverage.fieldCount !== fieldCount
    || receipt.coverage.unknownCount !== 0
    || receipt.coverage.conflictCount !== 0
    || receipt.coverage.requiredPositionCount !== 0
    || receipt.coverage.implementationClaimCount !== claims.length) {
    fail('coverage summary mismatch');
  }
  if (Object.values(receipt.boundary).some((value) => value !== false)) fail('authority boundary mismatch');
  if (receipt.destructive.total !== destructive.results.length
    || receipt.destructive.safe !== destructive.results.length
    || receipt.destructive.sharedResponsibilityControl !== 'PASS') {
    fail('destructive summary mismatch');
  }

  return {
    kind: 'ops.packageContractBridge.phase2Verification.v1',
    status: 'PASS',
    authority: false,
    phaseClosed: false,
    claimCeiling: PHASE2_RECEIPT_CEILING,
    repository: receipt.source.repository,
    opsCandidateSha: receipt.source.opsCandidateSha,
    packageSetSha256: receipt.source.packageSetSha256,
    claimSourceSha256: receipt.source.claimSourceSha256,
    packageCount: packageDirs.length,
    fieldCount,
    unknownCount: 0,
    conflictCount: 0,
    destructiveSafe: destructive.results.length,
    sharedResponsibilityConflict: false,
  };
}
