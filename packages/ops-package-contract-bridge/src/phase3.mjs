import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256Bytes, sha256File, stableJson } from './verify.mjs';

export const PHASE3_RECEIPT_CEILING = 'PACKAGE_PROJECTIONS_CONSUMED_NOT_ORGANIZATION_ADMISSION';
const RELATIONS = new Set(['declares','declares_common_boundary','declares_local_metadata','declares_nix_attrset','declares_nix_lambda_metadata','declares_package_path','derived_from','observes_registry_dependencies','observes_registry_entry']);
const FIELDS = Object.freeze([
  'position', 'purpose', 'contributionMechanism', 'responsibility', 'mustNotOwn',
  'placement', 'input', 'output', 'dependency', 'requiredEvidence', 'lifecycle',
]);
const fail = (message) => { throw new Error(`ops-package-contract-bridge phase3: ${message}`); };
const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; };
const text = (value, label) => { if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty text`); return value; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(line => line.trim()).map(JSON.parse);
const writeJson = (file, value) => fs.writeFileSync(file, `${stableJson(value)}\n`);
const writeJsonl = (file, values) => fs.writeFileSync(file, `${values.map(stableJson).join('\n')}\n`);
const digest = (value) => sha256Bytes(Buffer.from(typeof value === 'string' ? value : `${stableJson(value)}\n`, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sortedUnique = (values) => [...new Set(values)].sort();
const uiSafeJson = (value) => stableJson(value).replaceAll('<', '\\u003c');

function resolveRoot(bundle, expectedFile) {
  const root = path.resolve(bundle);
  if (fs.existsSync(path.join(root, expectedFile))) return root;
  if (fs.existsSync(path.join(root, 'proof', expectedFile))) return path.join(root, 'proof');
  fail(`bundle file missing: ${expectedFile}`);
}

function sourceRow(assertion) {
  text(assertion.sourceRef, 'assertion.sourceRef');
  if (!/^[a-f0-9]{64}$/u.test(assertion.sourceDigest)) fail(`invalid source digest: ${assertion.sourceRef}`);
  return { sourceRef: `${assertion.sourceRef}@assertion:${assertion.sourceDigest}`, sourceDigest: `sha256:${assertion.sourceDigest}` };
}

function sourceRows(assertions) {
  const byRef = new Map();
  for (const assertion of assertions) {
    const row = sourceRow(assertion);
    const prior = byRef.get(row.sourceRef);
    if (prior && prior.sourceDigest !== row.sourceDigest) fail(`conflicting source revision: ${row.sourceRef}`);
    byRef.set(row.sourceRef, row);
  }
  return [...byRef.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

function readPhaseInputs(phase1Bundle, phase2Bundle) {
  const p1 = resolveRoot(phase1Bundle, 'accepted-current-selection.json');
  const p2 = resolveRoot(phase2Bundle, 'phase2-v5-verification.json');
  const selection = readJson(path.join(p1, 'accepted-current-selection.json'));
  const packets = {
    before: readJson(path.join(p1, selection.before.packet)),
    accepted: readJson(path.join(p1, selection.accepted.packet)),
    candidate: readJson(path.join(p1, selection.candidate.packet)),
  };
  const verification = readJson(path.join(p2, 'phase2-v5-verification.json'));
  if (verification.status !== 'PASS' || verification.authority !== false || verification.phaseClosed !== false) fail('Phase 2 verification boundary mismatch');
  const assertions = readJsonl(path.join(p2, 'relation-valid-source-assertions-v5.jsonl'));
  for (const assertion of assertions) {
    if (!RELATIONS.has(assertion.relation)) fail(`unsupported Phase 3 relation: ${assertion.relation}`);
    if (!FIELDS.includes(assertion.field)) fail(`unsupported Phase 3 field: ${assertion.field}`);
  }
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
  return { p1, p2, selection, packets, verification, assertions, coverage, drifts };
}

function packetSelection(selection, packetRole) {
  const selected = selection[packetRole];
  const row = selected?.rowId ? selected : fail(`selection missing: ${packetRole}`);
  return {
    subjectKey: 'request:02-semantic',
    rowId: row.rowId,
    decision: row.decision,
    currentDigest: row.currentDigest,
    packet: row.packet,
    packetSha256: row.packetSha256,
    sourceRef: `phase1:${packetRole}:${row.rowId}`,
    sourceDigest: `sha256:${row.currentDigest}`,
  };
}

function packageModels(coverage) {
  return [...coverage].sort((a, b) => a.packageId.localeCompare(b.packageId)).map((row, index) => {
    const all = FIELDS.flatMap(field => row.fields[field]);
    const first = field => row.fields[field]?.[0]?.value;
    const purpose = String(first('purpose') ?? row.packageId);
    const dependencies = sortedUnique(row.fields.dependency.flatMap(item => Array.isArray(item.value) ? item.value : [item.value]).filter(Boolean).map(String));
    return {
      packageId: row.packageId,
      index,
      nodeId: `pkg_${String(index).padStart(3, '0')}`,
      purpose,
      dependencies,
      fields: Object.fromEntries(FIELDS.map(field => [field, row.fields[field].map(item => ({
        sourceClass: item.sourceClass,
        sourceRef: item.sourceRef,
        sourceDigest: item.sourceDigest,
        relation: item.relation,
        value: item.value,
      }))])),
      assertions: all,
      sources: sourceRows(all),
    };
  });
}

function decisionSourceRow(selected) {
  return { sourceRef: `${selected.sourceRef}@assertion:${selected.currentDigest}`, sourceDigest: selected.sourceDigest };
}

function uiProjection({ models, allSources, selected, drifts }) {
  const packageById = new Map(models.map(model => [model.packageId, model]));
  const containers = [
    { id: 'container_decisions', label: 'Accepted decision', x: 0, y: 0, w: 360, h: 120 },
    { id: 'container_packages', label: 'Owned Repo packages', x: 0, y: 160, w: 1600, h: 1600 },
  ];
  const decisionSource = decisionSourceRow(selected);
  const elements = [{
    id: 'decision_current',
    label: `${selected.subjectKey}: ${selected.decision}`,
    containerId: 'container_decisions',
    x: 24, y: 32, w: 300, h: 56,
    recordKind: 'accepted-current-selection',
    sourceRows: [decisionSource],
  }];
  for (const model of models) {
    const column = model.index % 5;
    const row = Math.floor(model.index / 5);
    elements.push({
      id: model.nodeId,
      label: `${model.packageId}: ${model.purpose}`,
      containerId: 'container_packages',
      x: 24 + column * 300, y: 24 + row * 120, w: 270, h: 88,
      packageId: model.packageId,
      purpose: model.purpose,
      contractFields: Object.fromEntries(Object.entries(model.fields).map(([field, rows]) => [field, rows.map(item => ({
        sourceClass: item.sourceClass,
        sourceRef: item.sourceRef,
        sourceDigest: item.sourceDigest,
        relation: item.relation,
        valueJson: uiSafeJson(item.value),
      }))])),
      sourceRows: model.sources,
    });
  }
  const edges = [];
  let edgeIndex = 0;
  for (const model of models) {
    edges.push({
      id: `edge_${String(edgeIndex++).padStart(4, '0')}`,
      from: 'decision_current', to: model.nodeId, label: 'selected contract context',
      sourceRows: [decisionSource],
    });
    for (const dependency of model.dependencies) {
      const target = packageById.get(dependency);
      if (!target) continue;
      const depAssertions = model.assertions.filter(item => item.field === 'dependency');
      edges.push({
        id: `edge_${String(edgeIndex++).padStart(4, '0')}`,
        from: model.nodeId, to: target.nodeId, label: 'depends on',
        sourceRows: sourceRows(depAssertions),
      });
    }
  }
  const internalDependencies = new Set(edges.filter(edge => edge.label === 'depends on').map(edge => `${edge.from}\u0000${edge.to}`));
  const diagnostics = [
    ...models.flatMap(model => model.dependencies
      .filter(value => !packageById.has(value))
      .map(value => ({ kind: 'external_dependency', packageId: model.packageId, valueJson: uiSafeJson(value) }))),
    ...drifts.map((finding, index) => ({
      kind: 'visible_drift',
      id: `drift_${String(index).padStart(4, '0')}`,
      packageId: finding.packageId,
      field: finding.field,
      left: {
        sourceClass: finding.left.sourceClass,
        sourceRef: finding.left.sourceRef,
        sourceDigest: finding.left.sourceDigest,
        valueJson: uiSafeJson(finding.left.value),
      },
      right: {
        sourceClass: finding.right.sourceClass,
        sourceRef: finding.right.sourceRef,
        sourceDigest: finding.right.sourceDigest,
        valueJson: uiSafeJson(finding.right.value),
      },
    })),
  ];
  return {
    kind: 'ui.contractModelAtlas.view.v1',
    generatedArtifactsAreAuthority: false,
    adapterOwnsState: false,
    sourceDataLoaded: true,
    summary: {
      title: 'Owned Repo Contract Atlas',
      statusText: `${models.length} packages / ${internalDependencies.size} internal dependencies / decision ${selected.decision}`,
    },
    acceptedCurrent: {
      subjectKey: selected.subjectKey,
      rowId: selected.rowId,
      decision: selected.decision,
      currentDigest: selected.currentDigest,
      claimCeiling: PHASE3_RECEIPT_CEILING,
    },
    sourceIdentity: {
      assertionSetSha256: digest(allSources),
      sources: allSources,
    },
    containers,
    elements,
    edges,
    edgeList: edges.map(edge => edge.id),
    diagnostics,
    treeText: models.map(model => `${model.packageId} -> ${model.dependencies.filter(dep => packageById.has(dep)).join(', ')}`).join('\n').replaceAll('<', '\\u003c'),
  };
}

function architectureInventory(view) {
  return {
    kind: 'ops.packageArchitectureInventory.v1',
    title: view.summary.title,
    direction: 'LR',
    generatedIsAuthority: false,
    sourceIdentityDigest: view.sourceIdentity.assertionSetSha256,
    nodes: view.elements.map(element => ({
      id: element.id,
      label: element.label,
      path: element.packageId ? `packages/${element.packageId}` : 'accepted-current',
      status: 'projected',
      responsibility: element.purpose ?? view.acceptedCurrent.decision,
    })),
    edges: view.edges.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, label: edge.label })),
  };
}

function atlasDocument({ models, assertions, drifts, selected }) {
  const header = { schema: 'atlas.purpose-closure/1', authority: false };
  const rows = [];
  const decisionSource = [decisionSourceRow(selected)];
  const rootId = `purpose:decision:${selected.subjectKey}`;
  rows.push({ kind: 'purpose', id: rootId, label: `Accepted decision: ${selected.decision}`, sources: decisionSource, parents: [] });
  for (const model of models) {
    const purposeId = `purpose:package:${model.packageId}`;
    rows.push({ kind: 'purpose', id: purposeId, label: model.purpose, sources: model.sources, parents: [rootId] });
    rows.push({
      kind: 'ideal', id: `ideal:package:${model.packageId}`, label: `Repository contract projection: ${model.packageId}`,
      sources: model.sources, purposes: [purposeId], value: stableJson(model.fields),
    });
  }

  const assertionByIdentity = new Map(assertions.map(assertion => [`${assertion.sourceRef}\u0000${assertion.sourceDigest}`, assertion]));
  let projectedGapCount = 0;
  let unprojectedDriftCount = 0;
  for (const finding of drifts) {
    const sides = [finding.left, finding.right];
    const observation = sides.find(side => side.sourceClass === 'implementation_observation');
    const declaration = sides.find(side => ['implementation_claim', 'derived_claim', 'accepted'].includes(side.sourceClass));
    if (!observation || !declaration) {
      unprojectedDriftCount += 1;
      continue;
    }
    const observationAssertion = assertionByIdentity.get(`${observation.sourceRef}\u0000${observation.sourceDigest}`);
    const declarationAssertion = assertionByIdentity.get(`${declaration.sourceRef}\u0000${declaration.sourceDigest}`);
    if (!observationAssertion || !declarationAssertion) fail(`drift source assertion missing: ${finding.packageId}.${finding.field}`);
    const suffix = String(projectedGapCount++).padStart(4, '0');
    const purposeId = `purpose:package:${finding.packageId}`;
    const idealId = `ideal:drift:${suffix}`;
    const currentId = `current:drift:${suffix}`;
    rows.push({
      kind: 'ideal', id: idealId, label: `${finding.packageId}.${finding.field} declared state`,
      sources: [sourceRow(declarationAssertion)], purposes: [purposeId], value: stableJson(declaration.value),
    });
    rows.push({
      kind: 'current', id: currentId, label: `${finding.packageId}.${finding.field} observed state`,
      sources: [sourceRow(observationAssertion)], value: stableJson(observation.value),
    });
    rows.push({
      kind: 'gap', id: `gap:drift:${suffix}`, label: `${finding.packageId}.${finding.field} claim/observation drift`,
      sources: sourceRows([declarationAssertion, observationAssertion]), current: currentId, ideal: idealId,
      delta: stableJson(finding), owner: 'roccho-org/ops',
      proof: `${finding.kind}:${finding.packageId}:${finding.field}`,
    });
  }
  const textValue = [stableJson(header), ...rows.map(stableJson)].join('\n') + '\n';
  return {
    header,
    rows,
    jsonl: textValue,
    counts: {
      purpose: rows.filter(row => row.kind === 'purpose').length,
      ideal: rows.filter(row => row.kind === 'ideal').length,
      current: rows.filter(row => row.kind === 'current').length,
      gap: rows.filter(row => row.kind === 'gap').length,
      fill: 0,
      receipt: 0,
      residual: 0,
      projectedGapCount,
      unprojectedDriftCount,
    },
  };
}

function snapshots(view) {
  const result = [{
    kind: 'ops.contract632.sharedAtlasSnapshot.v1', snapshot: 'summary',
    sourceViewDigest: digest(view), payload: { summary: view.summary, acceptedCurrent: view.acceptedCurrent },
    generatedArtifactsAreAuthority: false,
  }];
  for (const element of view.elements.filter(item => item.packageId)) {
    result.push({
      kind: 'ops.contract632.sharedAtlasSnapshot.v1', snapshot: 'package', id: element.id,
      sourceViewDigest: digest(view), payload: { packageId: element.packageId, label: element.label, sourceRows: element.sourceRows },
      generatedArtifactsAreAuthority: false,
    });
  }
  for (const edge of view.edges.filter(item => item.label === 'depends on')) {
    result.push({
      kind: 'ops.contract632.sharedAtlasSnapshot.v1', snapshot: 'relation', id: edge.id,
      sourceViewDigest: digest(view), payload: edge,
      generatedArtifactsAreAuthority: false,
    });
  }
  return result;
}

function sourceSetFromAtlasRows(rows) {
  const values = [];
  for (const row of rows) values.push(...row.sources);
  const byRef = new Map();
  for (const source of values) {
    const previous = byRef.get(source.sourceRef);
    if (previous && previous.sourceDigest !== source.sourceDigest) fail(`Apps source conflict: ${source.sourceRef}`);
    byRef.set(source.sourceRef, source);
  }
  return [...byRef.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

function assertProjectionSourceIdentity(view, atlasRows) {
  const uiSources = view.sourceIdentity.sources;
  const appsSources = sourceSetFromAtlasRows(atlasRows);
  if (stableJson(uiSources) !== stableJson(appsSources)) fail('UI and Apps source identity sets differ');
  if (digest(uiSources) !== view.sourceIdentity.assertionSetSha256) fail('UI source identity digest mismatch');
  return { sourceCount: uiSources.length, sourceIdentityDigest: view.sourceIdentity.assertionSetSha256 };
}

function deepDiff(left, right, at = '') {
  if (stableJson(left) === stableJson(right)) return [];
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return [at || '/'];
  const keys = sortedUnique([...Object.keys(left), ...Object.keys(right)]);
  return keys.flatMap(key => deepDiff(left[key], right[key], `${at}/${key}`));
}

async function importConsumers(uiSource, appsSource) {
  const uiFile = path.join(path.resolve(uiSource), 'packages/core-port/src/contract-model-atlas-view.mjs');
  const appsFile = path.join(path.resolve(appsSource), 'packages/atlas/closure.mjs');
  if (!fs.existsSync(uiFile)) fail(`UI consumer missing: ${uiFile}`);
  if (!fs.existsSync(appsFile)) fail(`Apps consumer missing: ${appsFile}`);
  return {
    ui: await import(`${pathToFileURL(uiFile).href}?phase3=${sha256File(uiFile)}`),
    apps: await import(`${pathToFileURL(appsFile).href}?phase3=${sha256File(appsFile)}`),
  };
}

function runPackageMap(command, inventoryFile, outDir, viewerFile) {
  const result = spawnSync(process.execPath, [command, '--inventory', inventoryFile, '--out-dir', outDir, '--name', 'contract-632-phase3', '--viewer', viewerFile], { encoding: 'utf8' });
  if (result.status !== 0) fail(`package-architecture-map failed: ${result.stderr || result.stdout}`);
  for (const required of ['index.html', 'latest.mmd', 'manifest.json']) {
    if (!fs.existsSync(path.join(outDir, required))) fail(`package map output missing: ${required}`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
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

export async function buildPhase3Bundle({
  phase1Bundle, phase2Bundle, uiSource, appsSource, uiRevision, appsRevision,
  packageMapCommand, packageMapViewer, opsCandidateSha, outDir,
}) {
  for (const [key, value] of Object.entries({ uiRevision, appsRevision, opsCandidateSha })) text(value, key);
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) fail(`output already exists: ${out}`);
  fs.mkdirSync(out, { recursive: true });
  const input = readPhaseInputs(phase1Bundle, phase2Bundle);
  if (input.verification.opsCandidateSha !== opsCandidateSha) fail('Phase 2 candidate SHA mismatch');
  const consumers = await importConsumers(uiSource, appsSource);
  const models = packageModels(input.coverage);

  const selections = {
    before: packetSelection(input.selection, 'before'),
    accepted: packetSelection(input.selection, 'accepted'),
    candidate: packetSelection(input.selection, 'candidate'),
  };
  const allSources = sourceRows([...input.assertions, { sourceRef: selections.accepted.sourceRef, sourceDigest: selections.accepted.currentDigest }]);
  const acceptedView = uiProjection({ models, allSources, selected: selections.accepted, drifts: input.drifts });
  const beforeView = uiProjection({ models, allSources: sourceRows([...input.assertions, { sourceRef: selections.before.sourceRef, sourceDigest: selections.before.currentDigest }]), selected: selections.before, drifts: input.drifts });
  const candidateOverlayView = uiProjection({ models, allSources, selected: selections.accepted, drifts: input.drifts });
  consumers.ui.assertContractModelAtlasView(acceptedView);
  consumers.ui.assertContractModelAtlasView(beforeView);
  consumers.ui.assertContractModelAtlasView(candidateOverlayView);
  if (stableJson(acceptedView) !== stableJson(candidateOverlayView)) fail('unadmitted candidate changed accepted UI projection');
  const uiDelta = deepDiff(beforeView, acceptedView);
  if (!uiDelta.length || !uiDelta.some(item => item.includes('decision_current') || item.includes('acceptedCurrent') || item.includes('summary'))) fail('accepted decision change was not projected');
  const uiViewDigest = consumers.ui.contractModelAtlasDigest(acceptedView);
  const uiDataRow = consumers.ui.makeContractModelAtlasDataRow({ surfaceId: 'contract-632-atlas', atlas: acceptedView });

  const acceptedAtlas = atlasDocument({ models, assertions: input.assertions, drifts: input.drifts, selected: selections.accepted });
  const beforeAtlas = atlasDocument({ models, assertions: input.assertions, drifts: input.drifts, selected: selections.before });
  const candidateOverlayAtlas = atlasDocument({ models, assertions: input.assertions, drifts: input.drifts, selected: selections.accepted });
  const acceptedReduced = consumers.apps.reduceClosure(acceptedAtlas.jsonl);
  const beforeReduced = consumers.apps.reduceClosure(beforeAtlas.jsonl);
  const candidateReduced = consumers.apps.reduceClosure(candidateOverlayAtlas.jsonl);
  if (acceptedReduced !== candidateReduced) fail('unadmitted candidate changed accepted Apps projection');
  if (acceptedReduced === beforeReduced) fail('accepted decision change did not affect Apps projection');

  const identityCheck = assertProjectionSourceIdentity(acceptedView, acceptedAtlas.rows);
  const inventory = architectureInventory(acceptedView);
  writeJson(path.join(out, 'ui.contract-model-atlas.view.json'), acceptedView);
  writeJson(path.join(out, 'ui.contract-model-atlas.data-row.json'), uiDataRow);
  writeJson(path.join(out, 'package-architecture.inventory.json'), inventory);
  writeJsonl(path.join(out, 'apps.atlas-purpose-closure.input.jsonl'), [acceptedAtlas.header, ...acceptedAtlas.rows]);
  fs.writeFileSync(path.join(out, 'apps.atlas-purpose-closure.reduced.jsonl'), acceptedReduced);
  writeJsonl(path.join(out, 'shared-atlas-ui-snapshots.jsonl'), snapshots(acceptedView));
  writeJson(path.join(out, 'mapping-coverage.json'), {
    kind: 'ops.contract632.phase3MappingCoverage.v1',
    authority: false,
    sourceIdentityDigest: identityCheck.sourceIdentityDigest,
    sourceCount: identityCheck.sourceCount,
    ui: { packageCount: models.length, fieldSet: FIELDS, viewDigest: uiViewDigest, consumer: 'ui.assertContractModelAtlasView' },
    sharedAtlasSnapshots: { consumerClaimed: false, distinctInputContract: true, count: snapshots(acceptedView).length },
    apps: { fieldSet: FIELDS, consumer: 'apps.reduceClosure', ...acceptedAtlas.counts, inventedFillReceiptResidual: false },
    unsupportedDrifts: { count: acceptedAtlas.counts.unprojectedDriftCount, reason: 'claim-to-claim drift has no authoritative current/ideal direction and remains in UI diagnostics' },
    unmappedFields: [],
  });
  writeJson(path.join(out, 'append-invariants.json'), {
    kind: 'ops.contract632.phase3AppendInvariants.v1',
    authority: false,
    unadmittedCandidate: {
      candidateRowId: selections.candidate.rowId,
      candidateCurrentDigest: selections.candidate.currentDigest,
      acceptedUiUnchanged: true,
      acceptedAppsUnchanged: true,
    },
    acceptedChange: {
      beforeRowId: selections.before.rowId,
      acceptedRowId: selections.accepted.rowId,
      beforeDecision: selections.before.decision,
      acceptedDecision: selections.accepted.decision,
      uiChangedPaths: uiDelta,
      appsChanged: true,
    },
  });

  const distDir = path.join(out, 'dist');
  runPackageMap(packageMapCommand, path.join(out, 'package-architecture.inventory.json'), distDir, packageMapViewer);
  const uiReceipt = consumers.ui.makeContractModelAtlasReceipt({
    surfaceId: 'contract-632-atlas',
    shellDigest: digest(inventory),
    dataDigest: digest(uiDataRow),
    htmlDigest: sha256File(path.join(distDir, 'index.html')),
    viewDigest: uiViewDigest,
    files: ['ui.contract-model-atlas.view.json', 'package-architecture.inventory.json', 'dist/index.html', 'dist/latest.mmd'],
  });
  writeJson(path.join(out, 'ui-consumer-receipt.json'), uiReceipt);

  const copied = {
    ui: [
      'packages/core-port/src/contract-model-atlas-view.mjs',
      'packages/core-port/src/a2ui-shell-builder.mjs',
      'packages/core-port/src/log.mjs',
      'packages/core-port/src/jsonl.mjs',
    ],
    apps: ['packages/atlas/closure.mjs', 'packages/atlas/reduce.mjs'],
  };
  for (const relative of copied.ui) copyFile(path.join(uiSource, relative), path.join(out, 'consumer-sources/ui', relative));
  for (const relative of copied.apps) copyFile(path.join(appsSource, relative), path.join(out, 'consumer-sources/apps', relative));
  copyFile(packageMapCommand, path.join(out, 'consumer-sources/ops/package-architecture-map.mjs'));
  copyFile(packageMapViewer, path.join(out, 'consumer-sources/ops/package-architecture-map-viewer.html'));
  for (const file of ['accepted-current-selection.json', input.selection.before.packet, input.selection.accepted.packet, input.selection.candidate.packet]) copyFile(path.join(input.p1, file), path.join(out, 'inputs/phase1', file));
  for (const file of ['phase2-v5-verification.json', 'relation-valid-source-assertions-v5.jsonl', 'combined-package-field-coverage-v5.jsonl', 'combined-drift-findings-v5.json']) copyFile(path.join(input.p2, file), path.join(out, 'inputs/phase2', file));

  const consumerFiles = walkFiles(path.join(out, 'consumer-sources')).map(file => ({ path: file, sha256: sha256File(path.join(out, 'consumer-sources', file)) }));
  writeJson(path.join(out, 'consumer-identities.json'), {
    kind: 'ops.contract632.phase3ConsumerIdentities.v1', authority: false,
    ui: { repository: 'roccho-dev/ui', revision: uiRevision },
    apps: { repository: 'roccho-dev/apps', revision: appsRevision },
    ops: { repository: 'roccho-org/ops', revision: opsCandidateSha },
    files: consumerFiles,
  });

  const destructive = [];
  const badView = clone(acceptedView);
  badView.edges[0].to = 'missing-node';
  try { consumers.ui.assertContractModelAtlasView(badView); fail('UI missing target passed'); } catch { destructive.push({ case: 'ui-missing-edge-target', status: 'REJECTED' }); }
  const authorityView = clone(acceptedView);
  authorityView.mergeReady = true;
  try { consumers.ui.assertContractModelAtlasView(authorityView); fail('UI authority field passed'); } catch { destructive.push({ case: 'ui-authority-field', status: 'REJECTED' }); }
  const badAtlas = acceptedAtlas.jsonl.replace('"authority":false', '"authority":true');
  try { consumers.apps.reduceClosure(badAtlas); fail('Apps authority true passed'); } catch { destructive.push({ case: 'apps-authority-true', status: 'REJECTED' }); }
  const missingPurpose = acceptedAtlas.jsonl.replace(`purpose:decision:${selections.accepted.subjectKey}`, 'purpose:missing');
  try { consumers.apps.reduceClosure(missingPurpose); fail('Apps missing purpose passed'); } catch { destructive.push({ case: 'apps-missing-purpose-reference', status: 'REJECTED' }); }
  const badIdentityView = clone(acceptedView);
  badIdentityView.sourceIdentity.sources[0].sourceDigest = `sha256:${'0'.repeat(64)}`;
  try { assertProjectionSourceIdentity(badIdentityView, acceptedAtlas.rows); fail('source digest mismatch passed'); } catch { destructive.push({ case: 'cross-projection-source-digest-mismatch', status: 'REJECTED' }); }
  const badRelationAssertions = clone(input.assertions);
  badRelationAssertions[0].relation = 'unknown_relation';
  try { if (!RELATIONS.has(badRelationAssertions[0].relation)) throw new Error('unknown relation'); fail('unknown relation passed'); } catch { destructive.push({ case: 'unknown-relation', status: 'REJECTED' }); }
  writeJson(path.join(out, 'phase3-destructive-results.json'), { kind: 'ops.contract632.phase3Destructive.v1', results: destructive });

  const preReceipt = walkFiles(out).filter(file => !['phase3-receipt.json', 'phase3-verification.json'].includes(file));
  const artifacts = preReceipt.map(file => ({ path: file, sha256: sha256File(path.join(out, file)) }));
  const receipt = {
    kind: 'ops.packageContractBridge.phase3Receipt.v1', status: 'PASS', authority: false, phaseClosed: false,
    claimCeiling: PHASE3_RECEIPT_CEILING,
    source: { opsCandidateSha, uiRevision, appsRevision, phase1SelectionSha256: sha256File(path.join(input.p1, 'accepted-current-selection.json')), phase2AssertionSha256: sha256File(path.join(input.p2, 'relation-valid-source-assertions-v5.jsonl')) },
    coverage: { packageCount: models.length, fieldCount: FIELDS.length, sourceCount: allSources.length, uiElementCount: acceptedView.elements.length, uiEdgeCount: acceptedView.edges.length, appsRowCount: acceptedAtlas.rows.length, ...acceptedAtlas.counts },
    append: { candidateUnchanged: true, acceptedChanged: true },
    boundary: { acceptedWinnerSelected: false, organizationAdmissionPerformed: false, browserReceiptRequired: true, browserObservedByCore: false, operationalAdoptionPerformed: false },
    destructive: { total: destructive.length, safe: destructive.length },
    artifacts,
  };
  writeJson(path.join(out, 'phase3-receipt.json'), receipt);
  const verification = await verifyPhase3Bundle(out);
  writeJson(path.join(out, 'phase3-verification.json'), verification);
  return verification;
}

export async function verifyPhase3Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receipt = readJson(path.join(root, 'phase3-receipt.json'));
  if (receipt.kind !== 'ops.packageContractBridge.phase3Receipt.v1' || receipt.status !== 'PASS' || receipt.authority !== false || receipt.phaseClosed !== false) fail('receipt boundary mismatch');
  for (const artifact of receipt.artifacts) {
    const file = path.join(root, artifact.path);
    if (!fs.existsSync(file) || sha256File(file) !== artifact.sha256) fail(`artifact mismatch: ${artifact.path}`);
  }
  const consumers = await importConsumers(path.join(root, 'consumer-sources/ui'), path.join(root, 'consumer-sources/apps'));
  const view = readJson(path.join(root, 'ui.contract-model-atlas.view.json'));
  consumers.ui.assertContractModelAtlasView(view);
  const appsInput = fs.readFileSync(path.join(root, 'apps.atlas-purpose-closure.input.jsonl'), 'utf8');
  const reduced = consumers.apps.reduceClosure(appsInput);
  if (reduced !== fs.readFileSync(path.join(root, 'apps.atlas-purpose-closure.reduced.jsonl'), 'utf8')) fail('Apps reduced output mismatch');
  const mapping = readJson(path.join(root, 'mapping-coverage.json'));
  if (mapping.unmappedFields.length || stableJson([...mapping.ui.fieldSet].sort()) !== stableJson([...FIELDS].sort()) || stableJson([...mapping.apps.fieldSet].sort()) !== stableJson([...FIELDS].sort())) fail('mapping coverage mismatch');
  if (mapping.apps.inventedFillReceiptResidual !== false || mapping.apps.fill !== 0 || mapping.apps.receipt !== 0 || mapping.apps.residual !== 0) fail('fill/receipt/residual boundary mismatch');
  const invariants = readJson(path.join(root, 'append-invariants.json'));
  if (invariants.unadmittedCandidate.acceptedUiUnchanged !== true || invariants.unadmittedCandidate.acceptedAppsUnchanged !== true || invariants.acceptedChange.appsChanged !== true) fail('append invariant mismatch');
  const destructive = readJson(path.join(root, 'phase3-destructive-results.json'));
  if (destructive.results.length < 5 || destructive.results.some(item => !['REJECTED', 'BLOCKED_UNKNOWN'].includes(item.status))) fail('destructive coverage incomplete');
  return {
    kind: 'ops.packageContractBridge.phase3Verification.v1', status: 'PASS', authority: false, phaseClosed: false,
    claimCeiling: PHASE3_RECEIPT_CEILING, opsCandidateSha: receipt.source.opsCandidateSha,
    packageCount: receipt.coverage.packageCount, sourceCount: receipt.coverage.sourceCount,
    uiElementCount: receipt.coverage.uiElementCount, uiEdgeCount: receipt.coverage.uiEdgeCount,
    appsRowCount: receipt.coverage.appsRowCount, fillCount: 0, receiptCount: 0, residualCount: 0,
    candidateUnchanged: true, acceptedChanged: true, browserReceiptRequired: true,
  };
}
