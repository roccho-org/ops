import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeAssertions,
} from './phase2.mjs';
import {
  buildPhase2V4Bundle,
  verifyPhase2V4Bundle,
} from './phase2-v4.mjs';
import {
  sha256Bytes,
  sha256File,
  stableJson,
} from './verify.mjs';

export const PHASE2_V5_RECEIPT_CEILING = 'PACKAGE_COMBINED_SOURCE_RELATIONS_CLOSED_NOT_ORGANIZATION_ADMISSION';

const ASSERTION_KIND = 'ops.packageFieldAssertion.v2';
const CENTRAL_SOURCE_PATH = 'packages/ops-package-contract-bridge/contract/phase2-package-claims.v1.json';
const REGISTRY_SOURCE_PATH = 'build/packages.jsonl';
const LOCAL_METADATA_RELATION = 'declares_local_metadata';
const LOCAL_V4_RELATIONS = new Set(['declares_nix_attrset', 'declares_nix_lambda_metadata']);
const CENTRAL_RELATIONS = new Set(['declares', 'declares_common_boundary', 'declares_package_path']);
const REGISTRY_RELATIONS = new Set(['observes_registry_entry', 'observes_registry_dependencies']);

const fail = (message) => {
  throw new Error(`ops-package-contract-bridge phase2-v5: ${message}`);
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

function sealAssertion(assertion) {
  const sealed = { ...assertion };
  sealed.sourceDigest = canonicalDigest(assertionCore(sealed));
  return sealed;
}

function supportOf(assertion) {
  return {
    sourceRef: assertion.sourceRef,
    sourceFileDigest: assertion.sourceFileDigest,
    sourceDigest: assertion.sourceDigest,
  };
}

function assertionKey(assertion) {
  return `${assertion.packageId}\u0000${assertion.sourceRef}`;
}

function assertionBuckets(assertions) {
  const buckets = new Map();
  for (const assertion of assertions) {
    const key = assertionKey(assertion);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(assertion);
  }
  return buckets;
}

function findSupport(buckets, packageId, sourceRef, support = null) {
  const candidates = buckets.get(`${packageId}\u0000${sourceRef}`) ?? [];
  if (!support) return candidates[0] ?? null;
  return candidates.find((candidate) => candidate.sourceFileDigest === support.sourceFileDigest
    && candidate.sourceDigest === support.sourceDigest) ?? null;
}

function normalizeCombinedAssertions(baseAssertions, claimSource) {
  const direct = baseAssertions.filter((assertion) => assertion.relation !== 'derived_from');
  const directBuckets = assertionBuckets(direct);
  const claimDigest = direct.find((item) => item.sourceRef.startsWith(`${CENTRAL_SOURCE_PATH}#/`))?.sourceFileDigest;
  if (!claimDigest) fail('central claim digest missing');

  const placementAssertions = claimSource.packages.map((item, index) => sealAssertion({
    kind: ASSERTION_KIND,
    packageId: item.packageId,
    field: 'placement',
    value: `packages/${item.packageId}`,
    sourceClass: claimSource.sourceClass,
    sourceRef: `${CENTRAL_SOURCE_PATH}#/packages/${index}/packageId`,
    sourceFileDigest: claimDigest,
    digestKind: 'canonical_assertion_sha256',
    applicability: {
      repository: direct.find((row) => row.packageId === item.packageId)?.applicability.repository ?? 'roccho-org/ops',
      candidateSha: direct.find((row) => row.packageId === item.packageId)?.applicability.candidateSha ?? 'unknown',
      path: `packages/${item.packageId}`,
    },
    claimCeiling: claimSource.claimCeiling,
    relation: 'declares_package_path',
    supports: [],
    explicitNone: false,
  }));

  for (const placement of placementAssertions) {
    const key = assertionKey(placement);
    if (!directBuckets.has(key)) directBuckets.set(key, []);
    directBuckets.get(key).push(placement);
  }

  const normalizedDerived = [];
  for (const assertion of baseAssertions.filter((item) => item.relation === 'derived_from')) {
    if (assertion.field === 'placement') continue;
    const supports = [];
    for (const raw of assertion.supports) {
      const sourceRef = typeof raw === 'string' ? raw : raw?.sourceRef;
      if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
        supports.push({
          sourceRef: 'invalid:missing-source-ref',
          sourceFileDigest: '0'.repeat(64),
          sourceDigest: '0'.repeat(64),
        });
        continue;
      }
      const actual = typeof raw === 'object' && raw !== null
        ? findSupport(directBuckets, assertion.packageId, sourceRef, raw)
        : findSupport(directBuckets, assertion.packageId, sourceRef);
      supports.push(actual ? supportOf(actual) : {
        sourceRef,
        sourceFileDigest: '0'.repeat(64),
        sourceDigest: '0'.repeat(64),
      });
    }
    normalizedDerived.push(sealAssertion({
      ...assertion,
      supports,
    }));
  }

  const combined = [
    ...direct,
    ...placementAssertions,
    ...normalizedDerived,
  ].sort((a, b) => `${a.packageId}:${a.field}:${a.sourceRef}:${a.sourceDigest}`
    .localeCompare(`${b.packageId}:${b.field}:${b.sourceRef}:${b.sourceDigest}`));

  return {
    assertions: combined,
    stats: {
      originalAssertionCount: baseAssertions.length,
      normalizedAssertionCount: combined.length,
      originalDerivedCount: baseAssertions.filter((item) => item.relation === 'derived_from').length,
      structuredDerivedCount: normalizedDerived.length,
      directPlacementCount: placementAssertions.length,
      structuredSupportCount: normalizedDerived.reduce((count, item) => count + item.supports.length, 0),
    },
  };
}

function pointerValue(root, pointer) {
  if (!pointer.startsWith('/')) return { found: false, value: undefined };
  let value = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key)) return { found: false, value: undefined };
      value = value[Number(key)];
    } else if (value && typeof value === 'object' && Object.hasOwn(value, key)) {
      value = value[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value };
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
      // Not a literal package metadata block.
    }
  }
  return values;
}

function normalizedMetadataValue(field, raw) {
  if (['output', 'requiredEvidence'].includes(field)) {
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }
  return raw;
}

function localMetadataValue(assertion, sourceRoot) {
  const prefix = `packages/${assertion.packageId}/default.nix#ops.packageImplementationMetadata.v1[`;
  if (!assertion.sourceRef.startsWith(prefix)) return { found: false, value: undefined };
  const tail = assertion.sourceRef.slice(prefix.length);
  const match = /^([0-9]+)\]\.([A-Za-z0-9_]+)$/u.exec(tail);
  if (!match) return { found: false, value: undefined };
  const file = path.join(sourceRoot, `packages/${assertion.packageId}/default.nix`);
  if (!fs.existsSync(file)) return { found: false, value: undefined };
  const metadata = parseMetadataBlocks(file)[Number(match[1])];
  if (!metadata || !Object.hasOwn(metadata, match[2])) return { found: false, value: undefined };
  return { found: true, value: normalizedMetadataValue(assertion.field, metadata[match[2]]) };
}

function registryLine(assertion, registryFile) {
  const prefix = `${REGISTRY_SOURCE_PATH}#L`;
  if (!assertion.sourceRef.startsWith(prefix)) return null;
  const lineNumber = Number(assertion.sourceRef.slice(prefix.length));
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const lines = fs.readFileSync(registryFile, 'utf8').split(/\r?\n/u);
  const line = lines[lineNumber - 1];
  if (!line) return null;
  return { line, row: JSON.parse(line) };
}

function finding(assertion, reason) {
  return {
    kind: 'ops.packageCombinedSourceRelationFinding.v1',
    status: 'UNKNOWN',
    packageId: assertion.packageId,
    field: assertion.field,
    sourceRef: assertion.sourceRef,
    sourceDigest: assertion.sourceDigest,
    reason,
  };
}

function relationFindings({
  assertions,
  claimSourceFile,
  registryFile,
  localSourceRoot,
  validatedLocalAssertions,
}) {
  const claimSource = readJson(claimSourceFile);
  const claimDigest = sha256File(claimSourceFile);
  const validatedLocal = new Set(validatedLocalAssertions.map(stableJson));
  const buckets = assertionBuckets(assertions.filter((item) => item.relation !== 'derived_from'));
  const findings = [];

  for (const assertion of assertions) {
    try {
      if (assertion.sourceDigest !== canonicalDigest(assertionCore(assertion))) {
        fail(`assertion digest mismatch: ${assertion.sourceRef}`);
      }

      if (assertion.relation === 'derived_from') {
        if (!assertion.sourceRef.startsWith('derived:')) fail(`derived sourceRef mismatch: ${assertion.sourceRef}`);
        if (!Array.isArray(assertion.supports) || assertion.supports.length === 0) {
          fail(`derived assertion missing supports: ${assertion.sourceRef}`);
        }
        for (const raw of assertion.supports) {
          const support = object(raw, `support for ${assertion.sourceRef}`);
          text(support.sourceRef, 'support sourceRef');
          text(support.sourceFileDigest, 'support sourceFileDigest');
          text(support.sourceDigest, 'support sourceDigest');
          if (!findSupport(buckets, assertion.packageId, support.sourceRef, support)) {
            fail(`derived support unresolved or digest mismatch: ${support.sourceRef}`);
          }
        }
        continue;
      }

      if (!Array.isArray(assertion.supports) || assertion.supports.length !== 0) {
        fail(`direct assertion has supports: ${assertion.sourceRef}`);
      }

      if (CENTRAL_RELATIONS.has(assertion.relation)) {
        if (assertion.sourceFileDigest !== claimDigest) fail(`central source digest mismatch: ${assertion.sourceRef}`);
        const prefix = `${CENTRAL_SOURCE_PATH}#`;
        if (!assertion.sourceRef.startsWith(prefix)) fail(`central sourceRef mismatch: ${assertion.sourceRef}`);
        const resolved = pointerValue(claimSource, assertion.sourceRef.slice(prefix.length));
        if (!resolved.found) fail(`central sourceRef unresolved: ${assertion.sourceRef}`);
        const expected = assertion.relation === 'declares_package_path'
          ? `packages/${resolved.value}`
          : resolved.value;
        if (stableJson(assertion.value) !== stableJson(expected)) {
          fail(`central source value mismatch: ${assertion.sourceRef}`);
        }
        continue;
      }

      if (REGISTRY_RELATIONS.has(assertion.relation)) {
        const resolved = registryLine(assertion, registryFile);
        if (!resolved) fail(`registry sourceRef unresolved: ${assertion.sourceRef}`);
        const digest = sha256Bytes(Buffer.from(`${resolved.line}\n`, 'utf8'));
        if (digest !== assertion.sourceFileDigest) fail(`registry source digest mismatch: ${assertion.sourceRef}`);
        const expected = assertion.relation === 'observes_registry_entry'
          ? resolved.row.entry
          : resolved.row.deps;
        if (stableJson(assertion.value) !== stableJson(expected)) {
          fail(`registry source value mismatch: ${assertion.sourceRef}`);
        }
        continue;
      }

      if (assertion.relation === LOCAL_METADATA_RELATION) {
        const file = path.join(localSourceRoot, `packages/${assertion.packageId}/default.nix`);
        if (!fs.existsSync(file) || sha256File(file) !== assertion.sourceFileDigest) {
          fail(`local metadata source digest mismatch: ${assertion.sourceRef}`);
        }
        const resolved = localMetadataValue(assertion, localSourceRoot);
        if (!resolved.found) fail(`local metadata sourceRef unresolved: ${assertion.sourceRef}`);
        if (stableJson(assertion.value) !== stableJson(resolved.value)) {
          fail(`local metadata value mismatch: ${assertion.sourceRef}`);
        }
        continue;
      }

      if (LOCAL_V4_RELATIONS.has(assertion.relation)) {
        if (!validatedLocal.has(stableJson(assertion))) {
          fail(`local v4 assertion not in validated partition: ${assertion.sourceRef}`);
        }
        continue;
      }

      fail(`unsupported relation: ${assertion.relation}`);
    } catch (error) {
      findings.push(finding(assertion, error.message));
    }
  }

  return findings.sort((a, b) => `${a.packageId}:${a.sourceRef}:${a.reason}`
    .localeCompare(`${b.packageId}:${b.sourceRef}:${b.reason}`));
}

function relationValidAssertions(assertions, findings) {
  const invalid = new Set(findings.map((item) => item.sourceDigest));
  return assertions.filter((assertion) => !invalid.has(assertion.sourceDigest));
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
  for (const item of artifacts) {
    const file = path.join(root, item.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`artifact missing: ${item.path}`);
    if (sha256File(file) !== item.sha256) fail(`artifact digest mismatch: ${item.path}`);
  }
}

function relationMustReject(input, expectedPattern) {
  const findings = relationFindings(input);
  if (!findings.some((item) => expectedPattern.test(item.reason))) {
    fail(`combined relation destructive case did not reject: ${expectedPattern}`);
  }
}

function destructiveCases(context) {
  const {
    assertions,
    claimSourceFile,
    registryFile,
    localSourceRoot,
    validatedLocalAssertions,
    packageDirs,
    expectedRecords,
  } = context;
  const results = [];
  const derived = assertions.find((item) => item.relation === 'derived_from');
  if (!derived) fail('structured derived assertion missing');

  const missingSupport = sealAssertion({ ...clone(derived), supports: [] });
  relationMustReject({
    ...context,
    assertions: assertions.map((item) => item.sourceDigest === derived.sourceDigest ? missingSupport : item),
  }, /missing supports/u);
  results.push({ case: 'base-derived-missing-support', status: 'REJECTED' });

  const badDigest = clone(derived);
  badDigest.supports[0].sourceDigest = '0'.repeat(64);
  const badDigestSealed = sealAssertion(badDigest);
  relationMustReject({
    ...context,
    assertions: assertions.map((item) => item.sourceDigest === derived.sourceDigest ? badDigestSealed : item),
  }, /unresolved or digest mismatch/u);
  results.push({ case: 'base-derived-support-digest-mismatch', status: 'REJECTED' });

  const placementDirect = assertions.find((item) => item.relation === 'declares_package_path');
  if (!placementDirect) fail('direct package placement assertion missing');
  const unresolvedPlacement = sealAssertion({
    ...placementDirect,
    sourceClass: 'derived_claim',
    sourceRef: `derived:${placementDirect.packageId}:placement:v5-negative`,
    relation: 'derived_from',
    supports: [{
      sourceRef: `${CENTRAL_SOURCE_PATH}#/packages/0`,
      sourceFileDigest: placementDirect.sourceFileDigest,
      sourceDigest: '0'.repeat(64),
    }],
  });
  relationMustReject({
    ...context,
    assertions: [...assertions, unresolvedPlacement],
  }, /unresolved or digest mismatch/u);
  results.push({ case: 'unresolved-package-level-support', status: 'REJECTED' });

  const lifecycle = assertions.find((item) => item.field === 'lifecycle'
    && item.relation === 'declares_common_boundary');
  if (!lifecycle) fail('lifecycle direct assertion missing');
  const invalidLifecycle = sealAssertion({
    ...lifecycle,
    sourceRef: `${lifecycle.sourceRef}:missing`,
  });
  const withInvalid = assertions.map((item) => item.sourceDigest === lifecycle.sourceDigest ? invalidLifecycle : item);
  const findings = relationFindings({
    assertions: withInvalid,
    claimSourceFile,
    registryFile,
    localSourceRoot,
    validatedLocalAssertions,
  });
  const valid = relationValidAssertions(withInvalid, findings);
  const analysis = analyzeAssertions(valid, packageDirs, expectedRecords);
  if (!findings.some((item) => item.sourceDigest === invalidLifecycle.sourceDigest)
    || !analysis.unknown.some((item) => item.packageId === lifecycle.packageId && item.field === 'lifecycle')) {
    fail('relation-invalid assertion contributed to COMPLETE coverage');
  }
  results.push({ case: 'relation-invalid-assertion-excluded-from-coverage', status: 'BLOCKED_UNKNOWN' });

  return {
    kind: 'ops.packageContractBridge.phase2CombinedRelationDestructive.v1',
    results,
  };
}

function buildState(baseV4Dir) {
  const baseAssertions = readJsonl(path.join(baseV4Dir, 'combined-source-assertions.jsonl'));
  const claimSourceFile = path.join(baseV4Dir, 'base-v2/claim-source.json');
  const claimSource = readJson(claimSourceFile);
  const normalized = normalizeCombinedAssertions(baseAssertions, claimSource);
  const validatedLocalAssertions = readJsonl(path.join(baseV4Dir, 'local-source-assertions-v4.jsonl'));
  const claimFile = claimSourceFile;
  const registryFile = path.join(baseV4Dir, 'base-v2/registry-source.jsonl');
  const localSourceRoot = path.join(baseV4Dir, 'local-source-files');
  const findings = relationFindings({
    assertions: normalized.assertions,
    claimSourceFile: claimFile,
    registryFile,
    localSourceRoot,
    validatedLocalAssertions,
  });
  const validAssertions = relationValidAssertions(normalized.assertions, findings);
  const direct = readJson(path.join(baseV4Dir, 'base-v2/direct-packages.json'));
  const packageDirs = direct.packages.map((item) => item.packageId);
  const baseIndex = readJson(path.join(baseV4Dir, 'base-v2/local-source-index.json'));
  const localIndex = readJson(path.join(baseV4Dir, 'local-source-index-v4.json'));
  const expectedRecords = [...baseIndex.records, ...localIndex.records]
    .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  const analysis = analyzeAssertions(validAssertions, packageDirs, expectedRecords);
  const context = {
    assertions: normalized.assertions,
    claimSourceFile: claimFile,
    registryFile,
    localSourceRoot,
    validatedLocalAssertions,
    packageDirs,
    expectedRecords,
  };
  return {
    ...context,
    normalized,
    findings,
    validAssertions,
    analysis,
    destructive: destructiveCases(context),
  };
}

export function buildPhase2V5Bundle({
  opsSource,
  opsCandidateSha,
  localSourceUniverseFile,
  outDir,
  repository = 'roccho-org/ops',
}) {
  text(opsCandidateSha, 'opsCandidateSha');
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) fail(`output already exists: ${out}`);
  fs.mkdirSync(out, { recursive: true });

  const baseV4Dir = path.join(out, 'base-v4');
  buildPhase2V4Bundle({
    opsSource,
    opsCandidateSha,
    localSourceUniverseFile,
    outDir: baseV4Dir,
    repository,
  });
  verifyPhase2V4Bundle(baseV4Dir);

  const state = buildState(baseV4Dir);
  writeJsonl(path.join(out, 'combined-source-assertions-v5.jsonl'), state.normalized.assertions);
  writeJson(path.join(out, 'combined-source-relation-findings-v5.json'), {
    kind: 'ops.packageCombinedSourceRelationFindings.v1',
    findings: state.findings,
  });
  writeJsonl(path.join(out, 'relation-valid-source-assertions-v5.jsonl'), state.validAssertions);
  writeJsonl(path.join(out, 'combined-package-field-coverage-v5.jsonl'), state.analysis.coverage);
  writeJson(path.join(out, 'combined-unknown-checkpoints-v5.json'), {
    kind: 'ops.packageMeaningCheckpoints.v5',
    checkpoints: state.analysis.unknown,
  });
  writeJson(path.join(out, 'combined-conflict-findings-v5.json'), {
    kind: 'ops.packageFieldConflicts.v5',
    findings: state.analysis.conflicts,
  });
  writeJson(path.join(out, 'combined-drift-findings-v5.json'), {
    kind: 'ops.packageFieldDrifts.v5',
    findings: state.analysis.drifts,
  });
  writeJson(path.join(out, 'combined-local-source-omissions-v5.json'), {
    kind: 'ops.packageLocalClaimOmissions.v5',
    findings: state.analysis.omissions,
  });
  writeJson(path.join(out, 'phase2-v5-destructive-results.json'), state.destructive);

  const status = state.findings.length === 0
    && state.analysis.unknown.length === 0
    && state.analysis.conflicts.length === 0
    && state.analysis.omissions.length === 0
    ? 'PASS'
    : 'BLOCK';
  const preReceipt = walkFiles(out).filter((item) => ![
    'phase2-v5-receipt.json',
    'phase2-v5-verification.json',
  ].includes(item));
  const artifacts = preReceipt.map((item) => ({
    path: item,
    sha256: sha256File(path.join(out, item)),
  }));
  const receipt = {
    kind: 'ops.packageContractBridge.phase2Receipt.v5',
    status,
    authority: false,
    phase: 2,
    phaseClosed: false,
    claimCeiling: PHASE2_V5_RECEIPT_CEILING,
    source: {
      repository,
      opsCandidateSha,
      localSourceUniverseSha256: sha256File(localSourceUniverseFile),
    },
    coverage: {
      packageCount: state.packageDirs.length,
      combinedAssertionCount: state.normalized.assertions.length,
      relationValidAssertionCount: state.validAssertions.length,
      relationFindingCount: state.findings.length,
      unknownCount: state.analysis.unknown.length,
      conflictCount: state.analysis.conflicts.length,
      omissionCount: state.analysis.omissions.length,
      driftCount: state.analysis.drifts.length,
      originalDerivedCount: state.normalized.stats.originalDerivedCount,
      structuredDerivedCount: state.normalized.stats.structuredDerivedCount,
      structuredSupportCount: state.normalized.stats.structuredSupportCount,
      directPlacementCount: state.normalized.stats.directPlacementCount,
      unresolvedSupportCount: state.findings.filter((item) => item.reason.includes('support')).length,
    },
    boundary: {
      acceptedWinnerSelected: false,
      requiredPromotionPerformed: false,
      organizationAdmissionPerformed: false,
      operationalAdoptionPerformed: false,
    },
    destructive: state.destructive,
    artifacts,
  };
  writeJson(path.join(out, 'phase2-v5-receipt.json'), receipt);
  const verification = verifyPhase2V5Bundle(out);
  writeJson(path.join(out, 'phase2-v5-verification.json'), verification);
  return verification;
}

export function verifyPhase2V5Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receipt = readJson(path.join(root, 'phase2-v5-receipt.json'));
  if (receipt.kind !== 'ops.packageContractBridge.phase2Receipt.v5') fail('receipt kind mismatch');
  if (receipt.status !== 'PASS' || receipt.authority !== false || receipt.phaseClosed !== false) {
    fail('receipt state mismatch');
  }
  if (receipt.claimCeiling !== PHASE2_V5_RECEIPT_CEILING) fail('receipt ceiling mismatch');
  verifyArtifacts(root, receipt.artifacts);
  const baseV4Dir = path.join(root, 'base-v4');
  verifyPhase2V4Bundle(baseV4Dir);
  const state = buildState(baseV4Dir);

  if (stableJson(readJsonl(path.join(root, 'combined-source-assertions-v5.jsonl')))
    !== stableJson(state.normalized.assertions)) fail('normalized assertions mismatch');
  if (stableJson(readJson(path.join(root, 'combined-source-relation-findings-v5.json')).findings)
    !== stableJson(state.findings)) fail('combined relation findings mismatch');
  if (stableJson(readJsonl(path.join(root, 'relation-valid-source-assertions-v5.jsonl')))
    !== stableJson(state.validAssertions)) fail('relation-valid assertions mismatch');
  if (stableJson(readJsonl(path.join(root, 'combined-package-field-coverage-v5.jsonl')))
    !== stableJson(state.analysis.coverage)) fail('combined coverage mismatch');
  if (stableJson(readJson(path.join(root, 'combined-unknown-checkpoints-v5.json')).checkpoints)
    !== stableJson(state.analysis.unknown)) fail('combined unknown mismatch');
  if (stableJson(readJson(path.join(root, 'combined-conflict-findings-v5.json')).findings)
    !== stableJson(state.analysis.conflicts)) fail('combined conflict mismatch');
  if (stableJson(readJson(path.join(root, 'combined-drift-findings-v5.json')).findings)
    !== stableJson(state.analysis.drifts)) fail('combined drift mismatch');
  if (stableJson(readJson(path.join(root, 'combined-local-source-omissions-v5.json')).findings)
    !== stableJson(state.analysis.omissions)) fail('combined omission mismatch');
  if (stableJson(readJson(path.join(root, 'phase2-v5-destructive-results.json')))
    !== stableJson(state.destructive)) fail('destructive evidence mismatch');

  if (state.findings.length || state.analysis.unknown.length
    || state.analysis.conflicts.length || state.analysis.omissions.length) {
    fail('combined source relation coverage incomplete');
  }
  if (state.validAssertions.length !== state.normalized.assertions.length) {
    fail('relation-invalid assertion reached coverage');
  }

  const derived = state.normalized.assertions.filter((item) => item.relation === 'derived_from');
  if (derived.length === 0
    || derived.some((item) => item.supports.some((support) => typeof support !== 'object'))) {
    fail('structured derived support closure incomplete');
  }
  if (state.normalized.assertions.some((item) => item.field === 'placement'
    && item.relation === 'derived_from')) fail('unresolved placement derivation remains');
  const directPlacementCount = state.normalized.assertions
    .filter((item) => item.relation === 'declares_package_path').length;
  if (directPlacementCount !== state.packageDirs.length) fail('direct package placement coverage mismatch');

  const cases = new Map(state.destructive.results.map((item) => [item.case, item.status]));
  if (cases.get('base-derived-missing-support') !== 'REJECTED'
    || cases.get('base-derived-support-digest-mismatch') !== 'REJECTED'
    || cases.get('unresolved-package-level-support') !== 'REJECTED'
    || cases.get('relation-invalid-assertion-excluded-from-coverage') !== 'BLOCKED_UNKNOWN') {
    fail('combined relation destructive coverage incomplete');
  }
  if (Object.values(receipt.boundary).some((value) => value !== false)) {
    fail('authority boundary mismatch');
  }

  return {
    kind: 'ops.packageContractBridge.phase2Verification.v5',
    status: 'PASS',
    authority: false,
    phaseClosed: false,
    claimCeiling: PHASE2_V5_RECEIPT_CEILING,
    repository: receipt.source.repository,
    opsCandidateSha: receipt.source.opsCandidateSha,
    packageCount: state.packageDirs.length,
    combinedAssertionCount: state.normalized.assertions.length,
    relationValidAssertionCount: state.validAssertions.length,
    relationFindingCount: 0,
    unknownCount: 0,
    conflictCount: 0,
    omissionCount: 0,
    driftCount: state.analysis.drifts.length,
    originalDerivedCount: state.normalized.stats.originalDerivedCount,
    structuredDerivedCount: state.normalized.stats.structuredDerivedCount,
    structuredSupportCount: state.normalized.stats.structuredSupportCount,
    directPlacementCount,
    unresolvedSupportCount: 0,
  };
}
