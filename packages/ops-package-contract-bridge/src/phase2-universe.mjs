import fs from 'node:fs';
import path from 'node:path';
import {
  PHASE2_FIELDS,
  analyzeAssertions,
  buildPhase2Bundle,
  directPackageDirs,
  verifyPhase2Bundle,
} from './phase2.mjs';
import {
  sha256Bytes,
  sha256File,
  stableJson,
} from './verify.mjs';

export const PHASE2_V3_RECEIPT_CEILING = 'PACKAGE_SOURCE_UNIVERSE_CLOSED_NOT_ORGANIZATION_ADMISSION';
const UNIVERSE_KIND = 'ops.contract632.phase2LocalSourceUniverse.v1';
const ASSERTION_KIND = 'ops.packageFieldAssertion.v2';
const LOCAL_CEILING = 'REPOSITORY_LOCAL_CLAIM_NOT_ORGANIZATION_REQUIREMENT';
const SEMANTIC_ATTRS = Object.freeze([
  'packageRole',
  'mission',
  'responsibility',
  'forbiddenResponsibility',
  'primaryTarget',
  'provides',
  'requires',
  'requiredOutputs',
  'requiredChecks',
  'publicInterface',
  'sourceLayout',
  'checkPackageContract',
  'productScopePurposeContribution',
  'allowedPaths',
  'forbiddenPaths',
]);

const fail = (message) => {
  throw new Error(`ops-package-contract-bridge phase2-v3: ${message}`);
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty text`);
  return value;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8')
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const writeJson = (file, value) => fs.writeFileSync(file, `${stableJson(value)}\n`);
const writeJsonl = (file, values) => fs.writeFileSync(file, `${values.map(stableJson).join('\n')}\n`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonicalDigest = (value) => sha256Bytes(Buffer.from(`${stableJson(value)}\n`, 'utf8'));

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
  sourceRef,
  sourceFileDigest,
  repository,
  candidateSha,
  relation = 'declares_nix_attrset',
  explicitNone = false,
}) {
  const assertion = {
    kind: ASSERTION_KIND,
    packageId,
    field,
    value,
    sourceClass: 'implementation_claim',
    sourceRef,
    sourceFileDigest,
    digestKind: 'canonical_assertion_sha256',
    applicability: {
      repository,
      candidateSha,
      path: `packages/${packageId}`,
    },
    claimCeiling: LOCAL_CEILING,
    relation,
    supports: [],
    explicitNone,
  };
  assertion.sourceDigest = canonicalDigest(assertionCore(assertion));
  return assertion;
}

function strings(value) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const name = typeof item.name === 'string' ? item.name : null;
      const kind = typeof item.kind === 'string' ? item.kind : null;
      const contract = typeof item.contract === 'string' ? item.contract : null;
      if (name || kind || contract) return [name, kind, contract].filter(Boolean).join(' | ');
    }
    return stableJson(item);
  }).filter((item) => item.trim().length > 0);
}

function semanticText(value) {
  if (typeof value === 'string') return value;
  const values = strings(value);
  return values.length ? values.join('; ') : null;
}

function unsupported(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.hasOwn(value, '__unsupportedType') || Object.hasOwn(value, '__evaluationError');
}

function scanPotentialMarkers(body) {
  return SEMANTIC_ATTRS.filter((key) => new RegExp(`^\\s*${key}\\s*=`, 'mu').test(body));
}

function expectedFieldsForAttr(key, metadata = {}) {
  if (key === 'packageRole') return ['position'];
  if (key === 'mission') return ['purpose'];
  if (key === 'responsibility') return ['responsibility'];
  if (key === 'forbiddenResponsibility') return ['mustNotOwn'];
  if (key === 'primaryTarget') return ['placement'];
  if (key === 'provides' || key === 'requiredOutputs' || key === 'publicInterface') return ['output'];
  if (key === 'requires') return ['dependency'];
  if (key === 'requiredChecks') return ['requiredEvidence'];
  if (key === 'sourceLayout' || key === 'allowedPaths') return ['placement'];
  if (key === 'forbiddenPaths') return ['mustNotOwn'];
  if (key === 'checkPackageContract') {
    const fields = [];
    if (metadata?.inputs !== undefined) fields.push('input');
    if (metadata?.evidence !== undefined || metadata?.guarantees !== undefined) fields.push('requiredEvidence');
    if (metadata?.failureModes !== undefined) fields.push('mustNotOwn');
    return fields.length ? fields : ['requiredEvidence'];
  }
  if (key === 'productScopePurposeContribution') {
    const fields = [];
    if (metadata?.productScope !== undefined) fields.push('responsibility');
    if (metadata?.contribution !== undefined || metadata?.ultimatePurpose !== undefined) fields.push('contributionMechanism');
    if (metadata?.scopeBoundary !== undefined) fields.push('mustNotOwn');
    return fields.length ? fields : ['contributionMechanism'];
  }
  return [];
}

function addAssertion(out, record, field, value, attrPath, options = {}) {
  if (value === null || value === undefined) return;
  const arrayValue = ['input', 'output', 'dependency', 'requiredEvidence'].includes(field);
  const normalized = arrayValue ? strings(value) : semanticText(value);
  if (arrayValue && normalized.length === 0 && options.explicitNone !== true) return;
  if (!arrayValue && (!normalized || normalized.trim().length === 0)) return;
  out.push(makeAssertion({
    packageId: record.packageId,
    field,
    value: normalized,
    sourceRef: `${record.relativePath}#nix.attr.${attrPath}`,
    sourceFileDigest: record.sourceFileDigest,
    repository: record.repository,
    candidateSha: record.candidateSha,
    relation: options.relation,
    explicitNone: arrayValue && normalized.length === 0,
  }));
}

function assertionsFromMetadata(record) {
  const metadata = record.metadata;
  const out = [];
  if (Object.hasOwn(metadata, 'packageRole')) {
    const role = metadata.packageRole;
    const mapped = role === 'implementation' ? 'implementation'
      : role === 'support' ? 'support'
        : ['check', 'proof'].includes(role) ? 'proof'
          : ['historical', 'deprecated'].includes(role) ? 'historical'
            : null;
    if (mapped) addAssertion(out, record, 'position', mapped, 'packageRole');
  }
  addAssertion(out, record, 'purpose', metadata.mission, 'mission');
  addAssertion(out, record, 'responsibility', metadata.responsibility, 'responsibility');
  addAssertion(out, record, 'mustNotOwn', metadata.forbiddenResponsibility, 'forbiddenResponsibility');
  addAssertion(out, record, 'placement', metadata.primaryTarget, 'primaryTarget');
  addAssertion(out, record, 'output', metadata.provides, 'provides');
  addAssertion(out, record, 'dependency', metadata.requires, 'requires');
  addAssertion(out, record, 'output', metadata.requiredOutputs, 'requiredOutputs');
  addAssertion(out, record, 'requiredEvidence', metadata.requiredChecks, 'requiredChecks');

  const publicInterface = metadata.publicInterface;
  if (publicInterface && typeof publicInterface === 'object' && !unsupported(publicInterface)) {
    addAssertion(out, record, 'output', publicInterface.exports, 'publicInterface.exports');
  }

  const sourceLayout = metadata.sourceLayout;
  if (sourceLayout && typeof sourceLayout === 'object' && !unsupported(sourceLayout)) {
    addAssertion(out, record, 'placement', `source layout: ${stableJson(sourceLayout)}`, 'sourceLayout');
  }

  const contract = metadata.checkPackageContract;
  if (contract && typeof contract === 'object' && !unsupported(contract)) {
    addAssertion(out, record, 'input', contract.inputs, 'checkPackageContract.inputs');
    const evidence = [...strings(contract.evidence), ...strings(contract.guarantees)];
    addAssertion(out, record, 'requiredEvidence', evidence, 'checkPackageContract.evidence+guarantees');
    if (contract.failureModes !== undefined) {
      addAssertion(out, record, 'mustNotOwn', `Must prevent: ${strings(contract.failureModes).join('; ')}`, 'checkPackageContract.failureModes');
    }
  }

  const purpose = metadata.productScopePurposeContribution;
  if (purpose && typeof purpose === 'object' && !unsupported(purpose)) {
    addAssertion(out, record, 'responsibility', purpose.productScope, 'productScopePurposeContribution.productScope');
    const contribution = [...strings(purpose.contribution), ...strings(purpose.ultimatePurpose)];
    addAssertion(out, record, 'contributionMechanism', contribution.join('; '), 'productScopePurposeContribution.contribution+ultimatePurpose');
    addAssertion(out, record, 'mustNotOwn', purpose.scopeBoundary, 'productScopePurposeContribution.scopeBoundary');
  }

  if (metadata.allowedPaths !== undefined) {
    addAssertion(out, record, 'placement', `allowed paths: ${strings(metadata.allowedPaths).join('; ')}`, 'allowedPaths');
  }
  if (metadata.forbiddenPaths !== undefined) {
    addAssertion(out, record, 'mustNotOwn', `Forbidden paths/effects: ${strings(metadata.forbiddenPaths).join('; ')}`, 'forbiddenPaths');
  }
  return out;
}

function localUniverseAudit({
  sourceRoot,
  universe,
  packageDirs,
  repository,
  candidateSha,
}) {
  object(universe, 'source universe');
  if (universe.kind !== UNIVERSE_KIND || universe.authority !== false) fail('source universe boundary mismatch');
  if (!Array.isArray(universe.packages)) fail('source universe packages required');
  const expected = [...packageDirs].sort();
  const ids = universe.packages.map((item) => item.packageId).sort();
  if (stableJson(ids) !== stableJson(expected)) fail('source universe package set mismatch');

  const assertions = [];
  const records = [];
  const findings = [];
  const seen = new Set();
  let defaultNixPresentCount = 0;
  let attrsetSourceCount = 0;
  let lambdaSourceCount = 0;

  for (const raw of [...universe.packages].sort((a, b) => a.packageId.localeCompare(b.packageId))) {
    const item = object(raw, `source universe ${raw?.packageId ?? '?'}`);
    text(item.packageId, 'source universe packageId');
    if (seen.has(item.packageId)) fail(`duplicate source universe package: ${item.packageId}`);
    seen.add(item.packageId);
    const relativePath = `packages/${item.packageId}/default.nix`;
    if (item.relativePath !== relativePath) fail(`source universe path mismatch: ${item.packageId}`);
    const file = path.join(sourceRoot, relativePath);
    const actualExists = fs.existsSync(file) && fs.statSync(file).isFile();
    if (actualExists !== item.exists) fail(`source universe existence mismatch: ${item.packageId}`);
    if (!actualExists) continue;
    defaultNixPresentCount += 1;
    const body = fs.readFileSync(file, 'utf8');
    const fileDigest = sha256File(file);
    const scannedMarkers = scanPotentialMarkers(body);
    const attrNames = Array.isArray(item.attrNames) ? item.attrNames : [];
    const semanticAttrs = SEMANTIC_ATTRS.filter((key) => attrNames.includes(key));
    const discoveredAttrs = [...new Set([...semanticAttrs, ...scannedMarkers])].sort();
    if (item.valueType === 'set') attrsetSourceCount += 1;
    if (item.valueType === 'lambda') lambdaSourceCount += 1;

    const record = {
      packageId: item.packageId,
      relativePath,
      sourceRef: `${relativePath}#nix.attr.`,
      sourceFileDigest: fileDigest,
      sourceClass: 'implementation_claim',
      evaluationStatus: item.valueType,
      attrNames,
      discoveredAttrs,
      fields: [],
    };

    const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? item.metadata
      : {};
    const normalizedRecord = {
      ...record,
      metadata,
      repository,
      candidateSha,
    };

    if (discoveredAttrs.length > 0 && item.valueType !== 'set') {
      findings.push({
        kind: 'ops.packageSourceUniverseFinding.v1',
        status: 'UNKNOWN',
        packageId: item.packageId,
        sourceRef: relativePath,
        sourceFileDigest: fileDigest,
        reason: `semantic source exists but Nix evaluation type is ${item.valueType}`,
        discoveredAttrs,
      });
    }

    const missingMetadata = semanticAttrs.filter((key) => !Object.hasOwn(metadata, key) || unsupported(metadata[key]));
    for (const key of missingMetadata) {
      findings.push({
        kind: 'ops.packageSourceUniverseFinding.v1',
        status: 'UNKNOWN',
        packageId: item.packageId,
        sourceRef: `${relativePath}#nix.attr.${key}`,
        sourceFileDigest: fileDigest,
        reason: 'Nix attr exists but could not be normalized',
        discoveredAttrs: [key],
      });
    }

    const packageAssertions = item.valueType === 'set' ? assertionsFromMetadata(normalizedRecord) : [];
    const representedAttrs = new Set(packageAssertions.map((assertion) => assertion.sourceRef.split('#nix.attr.')[1]?.split('.')[0]));
    for (const key of semanticAttrs) {
      const expectedFields = expectedFieldsForAttr(key, metadata[key]);
      if (expectedFields.length > 0 && !representedAttrs.has(key)) {
        findings.push({
          kind: 'ops.packageSourceUniverseFinding.v1',
          status: 'UNKNOWN',
          packageId: item.packageId,
          sourceRef: `${relativePath}#nix.attr.${key}`,
          sourceFileDigest: fileDigest,
          reason: 'semantic attr was discovered but emitted no assertion',
          discoveredAttrs: [key],
        });
      }
    }

    record.fields = [...new Set(packageAssertions.map((assertion) => assertion.field))].sort();
    if (discoveredAttrs.length > 0) records.push(record);
    assertions.push(...packageAssertions);
  }

  return {
    assertions: assertions.sort((a, b) => `${a.packageId}:${a.field}:${a.sourceRef}`.localeCompare(`${b.packageId}:${b.field}:${b.sourceRef}`)),
    records: records.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
    findings: findings.sort((a, b) => `${a.packageId}:${a.sourceRef}:${a.reason}`.localeCompare(`${b.packageId}:${b.sourceRef}:${b.reason}`)),
    stats: {
      directPackageCount: packageDirs.length,
      defaultNixPresentCount,
      attrsetSourceCount,
      lambdaSourceCount,
      semanticSourceCount: records.length,
      semanticAssertionCount: assertions.length,
      sourceUniverseFindingCount: findings.length,
    },
  };
}

function copyLocalSources(sourceRoot, outRoot, packageDirs) {
  for (const packageId of packageDirs) {
    const relative = `packages/${packageId}/default.nix`;
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(outRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function walkFiles(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolute, relative));
    else result.push(relative);
  }
  return result;
}

function verifyArtifacts(root, artifacts) {
  const seen = new Set();
  for (const item of artifacts) {
    if (seen.has(item.path)) fail(`duplicate artifact: ${item.path}`);
    seen.add(item.path);
    const file = path.join(root, item.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`artifact missing: ${item.path}`);
    if (sha256File(file) !== item.sha256) fail(`artifact digest mismatch: ${item.path}`);
  }
}

function runUniverseDestructiveCases({ universe, packageDirs, sourceRoot, repository, candidateSha, combinedAssertions, expectedRecords }) {
  const results = [];
  const billing = universe.packages.find((item) => item.packageId === 'billing-channel-config');
  if (!billing) fail('billing-channel-config universe record missing');

  const missingRecord = clone(universe);
  missingRecord.packages = missingRecord.packages.filter((item) => item.packageId !== 'billing-channel-config');
  try {
    localUniverseAudit({ sourceRoot, universe: missingRecord, packageDirs, repository, candidateSha });
    fail('missing universe record passed');
  } catch {
    results.push({ case: 'missing-default-nix-universe-record', status: 'REJECTED' });
  }

  const unsupported = clone(universe);
  const unsupportedBilling = unsupported.packages.find((item) => item.packageId === 'billing-channel-config');
  unsupportedBilling.valueType = 'lambda';
  unsupportedBilling.attrNames = [];
  unsupportedBilling.metadata = {};
  const unsupportedAudit = localUniverseAudit({ sourceRoot, universe: unsupported, packageDirs, repository, candidateSha });
  if (!unsupportedAudit.findings.some((item) => item.packageId === 'billing-channel-config')) fail('unsupported known source did not block');
  results.push({ case: 'known-legacy-attrset-unreadable', status: 'BLOCKED_UNKNOWN' });

  const missingMetadata = clone(universe);
  const missingMission = missingMetadata.packages.find((item) => item.packageId === 'billing-channel-config');
  delete missingMission.metadata.mission;
  const missingMetadataAudit = localUniverseAudit({ sourceRoot, universe: missingMetadata, packageDirs, repository, candidateSha });
  if (!missingMetadataAudit.findings.some((item) => item.packageId === 'billing-channel-config')) fail('missing metadata did not block');
  results.push({ case: 'discovered-attr-not-normalized', status: 'BLOCKED_UNKNOWN' });

  const billingRecord = expectedRecords.find((record) => record.packageId === 'billing-channel-config'
    && record.sourceRef.includes('#nix.attr.'));
  if (!billingRecord) fail('billing source record missing');
  const omitted = combinedAssertions.filter((item) => !(item.packageId === billingRecord.packageId
    && item.sourceRef.startsWith(billingRecord.sourceRef)));
  const omissionAnalysis = analyzeAssertions(omitted, packageDirs, expectedRecords);
  if (omissionAnalysis.unknown.length === 0) fail('known local source omission did not block');
  results.push({ case: 'known-local-source-assertions-omitted', status: 'BLOCKED_UNKNOWN' });

  return {
    kind: 'ops.packageContractBridge.phase2UniverseDestructive.v1',
    results,
  };
}

export function buildPhase2V3Bundle({
  opsSource,
  opsCandidateSha,
  localSourceUniverseFile,
  outDir,
  repository = 'roccho-org/ops',
}) {
  text(opsCandidateSha, 'opsCandidateSha');
  const source = path.resolve(opsSource);
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) fail(`output already exists: ${out}`);
  fs.mkdirSync(out, { recursive: true });

  const baseDir = path.join(out, 'base-v2');
  buildPhase2Bundle({ opsSource: source, opsCandidateSha, outDir: baseDir, repository });
  verifyPhase2Bundle(baseDir);

  const packageDirs = directPackageDirs(source);
  const universe = readJson(localSourceUniverseFile);
  fs.copyFileSync(localSourceUniverseFile, path.join(out, 'local-source-universe.json'));
  const sourceFilesRoot = path.join(out, 'local-source-files');
  copyLocalSources(source, sourceFilesRoot, packageDirs);
  const audit = localUniverseAudit({
    sourceRoot: source,
    universe,
    packageDirs,
    repository,
    candidateSha: opsCandidateSha,
  });

  const baseAssertions = readJsonl(path.join(baseDir, 'source-assertions.jsonl'));
  const combinedAssertions = [...baseAssertions, ...audit.assertions]
    .sort((a, b) => `${a.packageId}:${a.field}:${a.sourceRef}`.localeCompare(`${b.packageId}:${b.field}:${b.sourceRef}`));
  const baseIndex = readJson(path.join(baseDir, 'local-source-index.json'));
  const expectedRecords = [...baseIndex.records, ...audit.records]
    .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  const analysis = analyzeAssertions(combinedAssertions, packageDirs, expectedRecords);
  const destructive = runUniverseDestructiveCases({
    universe,
    packageDirs,
    sourceRoot: source,
    repository,
    candidateSha: opsCandidateSha,
    combinedAssertions,
    expectedRecords,
  });

  writeJson(path.join(out, 'local-source-index-v3.json'), {
    kind: 'ops.packageLocalSourceIndex.v3',
    stats: audit.stats,
    records: audit.records,
  });
  writeJsonl(path.join(out, 'local-source-assertions-v3.jsonl'), audit.assertions);
  writeJson(path.join(out, 'source-universe-findings.json'), {
    kind: 'ops.packageSourceUniverseFindings.v1',
    findings: audit.findings,
  });
  writeJsonl(path.join(out, 'combined-source-assertions.jsonl'), combinedAssertions);
  writeJsonl(path.join(out, 'combined-package-field-coverage.jsonl'), analysis.coverage);
  writeJson(path.join(out, 'combined-unknown-checkpoints.json'), {
    kind: 'ops.packageMeaningCheckpoints.v3',
    checkpoints: analysis.unknown,
  });
  writeJson(path.join(out, 'combined-conflict-findings.json'), {
    kind: 'ops.packageFieldConflicts.v3',
    findings: analysis.conflicts,
  });
  writeJson(path.join(out, 'combined-drift-findings.json'), {
    kind: 'ops.packageFieldDrifts.v3',
    findings: analysis.drifts,
  });
  writeJson(path.join(out, 'combined-local-source-omissions.json'), {
    kind: 'ops.packageLocalClaimOmissions.v3',
    findings: analysis.omissions,
  });
  writeJson(path.join(out, 'phase2-v3-destructive-results.json'), destructive);

  const billingCount = audit.assertions.filter((item) => item.packageId === 'billing-channel-config').length;
  const functionalCount = audit.assertions.filter((item) => item.packageId === 'functional-core-governance-gate').length;
  const registryRecords = baseIndex.records.filter((item) => item.sourceRef.startsWith('build/packages.jsonl#')).length;
  const metadataRecords = baseIndex.records.length - registryRecords;
  const status = audit.findings.length === 0
    && analysis.unknown.length === 0
    && analysis.conflicts.length === 0
    && analysis.omissions.length === 0
    && billingCount > 0
    && functionalCount > 0
    ? 'PASS'
    : 'BLOCK';

  const preReceiptFiles = walkFiles(out).filter((item) => !['phase2-v3-receipt.json', 'phase2-v3-verification.json'].includes(item));
  const artifacts = preReceiptFiles.map((item) => ({ path: item, sha256: sha256File(path.join(out, item)) }));
  const receipt = {
    kind: 'ops.packageContractBridge.phase2Receipt.v3',
    status,
    authority: false,
    phase: 2,
    phaseClosed: false,
    claimCeiling: PHASE2_V3_RECEIPT_CEILING,
    source: {
      repository,
      opsCandidateSha,
      localSourceUniverseSha256: sha256File(localSourceUniverseFile),
    },
    coverage: {
      directPackageCount: packageDirs.length,
      defaultNixPresentCount: audit.stats.defaultNixPresentCount,
      attrsetSourceCount: audit.stats.attrsetSourceCount,
      lambdaSourceCount: audit.stats.lambdaSourceCount,
      semanticSourceCount: audit.stats.semanticSourceCount,
      semanticAssertionCount: audit.stats.semanticAssertionCount,
      baseRegistryRecordCount: registryRecords,
      baseMetadataRecordCount: metadataRecords,
      combinedAssertionCount: combinedAssertions.length,
      unknownCount: analysis.unknown.length,
      conflictCount: analysis.conflicts.length,
      driftCount: analysis.drifts.length,
      omissionCount: analysis.omissions.length,
      sourceUniverseFindingCount: audit.findings.length,
      billingLocalAssertionCount: billingCount,
      functionalCoreLocalAssertionCount: functionalCount,
    },
    boundary: {
      acceptedWinnerSelected: false,
      requiredPromotionPerformed: false,
      organizationAdmissionPerformed: false,
      operationalAdoptionPerformed: false,
    },
    destructive,
    artifacts,
  };
  writeJson(path.join(out, 'phase2-v3-receipt.json'), receipt);
  const verification = verifyPhase2V3Bundle(out);
  writeJson(path.join(out, 'phase2-v3-verification.json'), verification);
  return verification;
}

export function verifyPhase2V3Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receipt = readJson(path.join(root, 'phase2-v3-receipt.json'));
  if (receipt.kind !== 'ops.packageContractBridge.phase2Receipt.v3') fail('receipt kind mismatch');
  if (receipt.status !== 'PASS' || receipt.authority !== false || receipt.phaseClosed !== false) fail('receipt state mismatch');
  if (receipt.claimCeiling !== PHASE2_V3_RECEIPT_CEILING) fail('receipt ceiling mismatch');
  verifyArtifacts(root, receipt.artifacts);
  verifyPhase2Bundle(path.join(root, 'base-v2'));

  const direct = readJson(path.join(root, 'base-v2/direct-packages.json'));
  const packageDirs = direct.packages.map((item) => item.packageId);
  const universeFile = path.join(root, 'local-source-universe.json');
  if (sha256File(universeFile) !== receipt.source.localSourceUniverseSha256) fail('source universe digest mismatch');
  const universe = readJson(universeFile);
  const audit = localUniverseAudit({
    sourceRoot: path.join(root, 'local-source-files'),
    universe,
    packageDirs,
    repository: receipt.source.repository,
    candidateSha: receipt.source.opsCandidateSha,
  });
  const storedIndex = readJson(path.join(root, 'local-source-index-v3.json'));
  if (stableJson(storedIndex.records) !== stableJson(audit.records) || stableJson(storedIndex.stats) !== stableJson(audit.stats)) {
    fail('local source index mismatch');
  }
  if (stableJson(readJsonl(path.join(root, 'local-source-assertions-v3.jsonl'))) !== stableJson(audit.assertions)) {
    fail('local source assertions mismatch');
  }
  if (stableJson(readJson(path.join(root, 'source-universe-findings.json')).findings) !== stableJson(audit.findings)) {
    fail('source universe findings mismatch');
  }

  const combinedAssertions = readJsonl(path.join(root, 'combined-source-assertions.jsonl'));
  const baseAssertions = readJsonl(path.join(root, 'base-v2/source-assertions.jsonl'));
  const expectedCombined = [...baseAssertions, ...audit.assertions]
    .sort((a, b) => `${a.packageId}:${a.field}:${a.sourceRef}`.localeCompare(`${b.packageId}:${b.field}:${b.sourceRef}`));
  if (stableJson(combinedAssertions) !== stableJson(expectedCombined)) fail('combined assertions mismatch');
  const baseIndex = readJson(path.join(root, 'base-v2/local-source-index.json'));
  const expectedRecords = [...baseIndex.records, ...audit.records].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  const analysis = analyzeAssertions(combinedAssertions, packageDirs, expectedRecords);
  if (stableJson(readJsonl(path.join(root, 'combined-package-field-coverage.jsonl'))) !== stableJson(analysis.coverage)) fail('combined coverage mismatch');
  if (stableJson(readJson(path.join(root, 'combined-unknown-checkpoints.json')).checkpoints) !== stableJson(analysis.unknown)) fail('combined unknown mismatch');
  if (stableJson(readJson(path.join(root, 'combined-conflict-findings.json')).findings) !== stableJson(analysis.conflicts)) fail('combined conflict mismatch');
  if (stableJson(readJson(path.join(root, 'combined-drift-findings.json')).findings) !== stableJson(analysis.drifts)) fail('combined drift mismatch');
  if (stableJson(readJson(path.join(root, 'combined-local-source-omissions.json')).findings) !== stableJson(analysis.omissions)) fail('combined omission mismatch');
  if (audit.findings.length || analysis.unknown.length || analysis.conflicts.length || analysis.omissions.length) fail('source universe coverage incomplete');

  const billingCount = audit.assertions.filter((item) => item.packageId === 'billing-channel-config').length;
  const functionalCount = audit.assertions.filter((item) => item.packageId === 'functional-core-governance-gate').length;
  if (billingCount === 0 || functionalCount === 0) fail('known legacy local source not collected');
  if (!Array.isArray(receipt.destructive.results)
    || !receipt.destructive.results.some((item) => item.case === 'known-legacy-attrset-unreadable' && item.status === 'BLOCKED_UNKNOWN')
    || !receipt.destructive.results.some((item) => item.case === 'known-local-source-assertions-omitted' && item.status === 'BLOCKED_UNKNOWN')) {
    fail('source universe destructive coverage incomplete');
  }
  if (Object.values(receipt.boundary).some((value) => value !== false)) fail('authority boundary mismatch');

  return {
    kind: 'ops.packageContractBridge.phase2Verification.v3',
    status: 'PASS',
    authority: false,
    phaseClosed: false,
    claimCeiling: PHASE2_V3_RECEIPT_CEILING,
    repository: receipt.source.repository,
    opsCandidateSha: receipt.source.opsCandidateSha,
    packageCount: packageDirs.length,
    defaultNixPresentCount: audit.stats.defaultNixPresentCount,
    semanticSourceCount: audit.stats.semanticSourceCount,
    semanticAssertionCount: audit.stats.semanticAssertionCount,
    combinedAssertionCount: combinedAssertions.length,
    unknownCount: 0,
    conflictCount: 0,
    omissionCount: 0,
    sourceUniverseFindingCount: 0,
    driftCount: analysis.drifts.length,
    billingLocalAssertionCount: billingCount,
    functionalCoreLocalAssertionCount: functionalCount,
  };
}
