import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256File } from './verify.mjs';
import { RELATIONS, clone, context, fail, sourceRows } from './phase3-input.mjs';
import { assertProjectionSourceIdentity, dependencyAssertions } from './phase3-projection.mjs';
import { assertExactMappings, mappingRows } from './phase3-mapping.mjs';

export async function importConsumers(uiSource, appsSource) {
  const uiFile = path.join(path.resolve(uiSource), 'packages/core-port/src/contract-model-atlas-view.mjs');
  const appsFile = path.join(path.resolve(appsSource), 'packages/atlas/closure.mjs');
  if (!fs.existsSync(uiFile)) fail(`UI consumer missing: ${uiFile}`);
  if (!fs.existsSync(appsFile)) fail(`Apps consumer missing: ${appsFile}`);
  return {
    ui: await import(`${pathToFileURL(uiFile).href}?phase3=${sha256File(uiFile)}`),
    apps: await import(`${pathToFileURL(appsFile).href}?phase3=${sha256File(appsFile)}`),
  };
}

export function runPackageMap(command, inventoryFile, outDir, viewerFile) {
  const result = spawnSync(process.execPath, [command, '--inventory', inventoryFile, '--out-dir', outDir, '--name', 'contract-632-phase3', '--viewer', viewerFile], { encoding: 'utf8' });
  if (result.status !== 0) fail(`package-architecture-map failed: ${result.stderr || result.stdout}`);
  for (const required of ['index.html', 'latest.mmd', 'manifest.json']) {
    if (!fs.existsSync(path.join(outDir, required))) fail(`package map output missing: ${required}`);
  }
}

export function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function walkFiles(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolute, relative));
    else result.push(relative);
  }
  return result;
}

function rejection(results, name, fn) {
  try { fn(); }
  catch (error) {
    results.push({ case: name, status: 'REJECTED', error: error.message });
    return;
  }
  fail(`${name} passed`);
}

function findUnrelatedSource(model, related) {
  const refs = new Set(related.map(row => row.sourceRef));
  return model.sources.find(row => !refs.has(row.sourceRef));
}

export function destructiveProof({ input, consumers, projection, mappings }) {
  const { models, semanticSources, views, atlases, contexts } = projection;
  const acceptedView = views.accepted;
  const acceptedAtlas = atlases.accepted;
  const results = [];

  const missingTarget = clone(acceptedView);
  missingTarget.edges[0].to = 'missing-node';
  rejection(results, 'ui-missing-edge-target', () => consumers.ui.assertContractModelAtlasView(missingTarget));

  const authorityView = clone(acceptedView);
  authorityView.mergeReady = true;
  rejection(results, 'ui-authority-field', () => consumers.ui.assertContractModelAtlasView(authorityView));

  rejection(results, 'apps-authority-true', () => consumers.apps.reduceClosure(acceptedAtlas.jsonl.replace('"authority":false', '"authority":true')));
  const firstPurpose = acceptedAtlas.rows.find(row => row.kind === 'purpose');
  rejection(results, 'apps-missing-purpose-reference', () => consumers.apps.reduceClosure(acceptedAtlas.jsonl.replace(firstPurpose.id, 'purpose:missing')));

  const badIdentityView = clone(acceptedView);
  badIdentityView.sourceIdentity.sources[0].sourceDigest = `sha256:${'0'.repeat(64)}`;
  rejection(results, 'cross-projection-source-digest-mismatch', () => assertProjectionSourceIdentity(badIdentityView, acceptedAtlas.rows, semanticSources));

  rejection(results, 'unknown-relation', () => {
    const bad = clone(input.assertions);
    bad[0].relation = 'unknown_relation';
    if (!RELATIONS.has(bad[0].relation)) throw new Error('unknown relation');
  });

  rejection(results, 'candidate-misselection', () => {
    if (contexts.candidateSelected.accepted.role !== 'accepted') throw new Error('unadmitted candidate selected as current');
  });

  const edge = acceptedView.edges[0];
  const sourceModel = models.find(model => model.nodeId === edge.from);
  const targetModel = models.find(model => model.nodeId === edge.to);
  const exactDependency = dependencyAssertions(sourceModel, targetModel.packageId);
  const unrelatedDependencySource = findUnrelatedSource(sourceModel, sourceRows(exactDependency));
  if (!unrelatedDependencySource) fail('destructive dependency fixture missing unrelated source');
  const unrelatedEdgeView = clone(acceptedView);
  unrelatedEdgeView.edges.find(row => row.id === edge.id).sourceRows.push(unrelatedDependencySource);
  rejection(results, 'unrelated-dependency-source-attribution', () => mappingRows(models, unrelatedEdgeView, acceptedAtlas.rows));

  const purposeModel = models.find(model => model.purposes.some(purpose => findUnrelatedSource(model, purpose.sources)));
  if (!purposeModel) fail('destructive purpose fixture missing unrelated source');
  const purpose = purposeModel.purposes.find(item => findUnrelatedSource(purposeModel, item.sources));
  const unrelatedPurposeSource = findUnrelatedSource(purposeModel, purpose.sources);
  const unrelatedPurposeRows = clone(acceptedAtlas.rows);
  unrelatedPurposeRows.find(row => row.id === purpose.id).sources.push(unrelatedPurposeSource);
  rejection(results, 'unrelated-purpose-source-attribution', () => mappingRows(models, acceptedView, unrelatedPurposeRows));

  rejection(results, 'field-relation-mapping-omission', () => assertExactMappings(mappings.slice(1), mappings));

  const accepted = contexts.accepted.accepted;
  const collisionCandidate = {
    ...accepted,
    role: 'candidate-collision',
    rowId: `${accepted.rowId}:collision`,
  };
  rejection(results, 'candidate-context-input-collision', () => {
    context({ accepted, unadmitted: [collisionCandidate] });
  });

  return results;
}
