import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './verify.mjs';
import { FIELDS, PHASE3_RECEIPT_CEILING, fail, readPhaseInputs, text, writeJson, writeJsonl } from './phase3-input.mjs';
import { architectureInventory, assertProjectionSourceIdentity, computeProjectionSet, snapshots } from './phase3-projection.mjs';
import { mappingRows, mappingSummary } from './phase3-mapping.mjs';
import { copyFile, destructiveProof, importConsumers, runPackageMap, walkFiles } from './phase3-runtime-util.mjs';
import { verifyPhase3Bundle } from './phase3-verify.mjs';

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
  const projection = computeProjectionSet({ input, consumers });
  const { models, semanticSources, views, atlases, reduced, proof } = projection;
  const acceptedView = views.accepted;
  const acceptedAtlas = atlases.accepted;
  const acceptedReduced = reduced.accepted;

  const identityCheck = assertProjectionSourceIdentity(acceptedView, acceptedAtlas.rows, semanticSources);
  const mappings = mappingRows(models, acceptedView, acceptedAtlas.rows);
  const mapping = mappingSummary(models, mappings, acceptedAtlas, identityCheck);
  if (mapping.unmappedFields.length || mapping.unmappedPackageFields.length || mapping.unexpectedSourceAttributions) {
    fail('mapping coverage incomplete');
  }

  const inventory = architectureInventory(acceptedView);
  const uiDataRow = consumers.ui.makeContractModelAtlasDataRow({ surfaceId: 'contract-632-atlas', atlas: acceptedView });
  writeJson(path.join(out, 'ui.contract-model-atlas.view.json'), acceptedView);
  writeJson(path.join(out, 'ui.contract-model-atlas.data-row.json'), uiDataRow);
  writeJson(path.join(out, 'package-architecture.inventory.json'), inventory);
  writeJsonl(path.join(out, 'apps.atlas-purpose-closure.input.jsonl'), [acceptedAtlas.header, ...acceptedAtlas.rows]);
  fs.writeFileSync(path.join(out, 'apps.atlas-purpose-closure.reduced.jsonl'), acceptedReduced);
  writeJsonl(path.join(out, 'shared-atlas-ui-snapshots.jsonl'), snapshots(acceptedView));
  writeJsonl(path.join(out, 'projection-mapping.jsonl'), mappings);
  writeJson(path.join(out, 'mapping-coverage.json'), mapping);
  writeJson(path.join(out, 'append-invariants.json'), proof);
  writeJson(path.join(out, 'candidate-mutation.json'), projection.mutated.artifact);

  const distDir = path.join(out, 'dist');
  runPackageMap(packageMapCommand, path.join(out, 'package-architecture.inventory.json'), distDir, packageMapViewer);
  const uiReceipt = consumers.ui.makeContractModelAtlasReceipt({
    surfaceId: 'contract-632-atlas',
    shellDigest: projection.proof.outputs.acceptedUiDigest,
    dataDigest: projection.proof.outputs.acceptedUiDigest,
    htmlDigest: sha256File(path.join(distDir, 'index.html')),
    viewDigest: consumers.ui.contractModelAtlasDigest(acceptedView),
    files: ['ui.contract-model-atlas.view.json', 'package-architecture.inventory.json', 'dist/index.html', 'dist/latest.mmd'],
  });
  writeJson(path.join(out, 'ui-consumer-receipt.json'), uiReceipt);

  const copied = {
    ui: ['packages/core-port/src/contract-model-atlas-view.mjs','packages/core-port/src/a2ui-shell-builder.mjs','packages/core-port/src/log.mjs','packages/core-port/src/jsonl.mjs'],
    apps: ['packages/atlas/closure.mjs','packages/atlas/reduce.mjs'],
  };
  for (const relative of copied.ui) copyFile(path.join(uiSource, relative), path.join(out, 'consumer-sources/ui', relative));
  for (const relative of copied.apps) copyFile(path.join(appsSource, relative), path.join(out, 'consumer-sources/apps', relative));
  copyFile(packageMapCommand, path.join(out, 'consumer-sources/ops/package-architecture-map.mjs'));
  copyFile(packageMapViewer, path.join(out, 'consumer-sources/ops/package-architecture-map-viewer.html'));
  for (const file of ['accepted-current-selection.json', input.selection.before.packet, input.selection.accepted.packet, input.selection.candidate.packet]) {
    copyFile(path.join(input.p1, file), path.join(out, 'inputs/phase1', file));
  }
  for (const file of ['phase2-v5-verification.json','relation-valid-source-assertions-v5.jsonl','combined-package-field-coverage-v5.jsonl','combined-drift-findings-v5.json']) {
    copyFile(path.join(input.p2, file), path.join(out, 'inputs/phase2', file));
  }

  const consumerFiles = walkFiles(path.join(out, 'consumer-sources')).map(file => ({ path: file, sha256: sha256File(path.join(out, 'consumer-sources', file)) }));
  writeJson(path.join(out, 'consumer-identities.json'), {
    kind: 'ops.contract632.phase3ConsumerIdentities.v2', authority: false,
    ui: { repository: 'roccho-dev/ui', revision: uiRevision },
    apps: { repository: 'roccho-dev/apps', revision: appsRevision },
    ops: { repository: 'roccho-org/ops', revision: opsCandidateSha },
    files: consumerFiles,
  });

  const destructive = destructiveProof({ input, consumers, projection, mappings });
  writeJson(path.join(out, 'phase3-destructive-results.json'), { kind: 'ops.contract632.phase3Destructive.v2', results: destructive });

  const preReceipt = walkFiles(out).filter(file => !['phase3-receipt.json', 'phase3-verification.json'].includes(file));
  const artifacts = preReceipt.map(file => ({ path: file, sha256: sha256File(path.join(out, file)) }));
  const receipt = {
    kind: 'ops.packageContractBridge.phase3Receipt.v2', status: 'PASS', authority: false, phaseClosed: false,
    claimCeiling: PHASE3_RECEIPT_CEILING,
    source: {
      opsCandidateSha, uiRevision, appsRevision,
      phase1SelectionSha256: sha256File(path.join(input.p1, 'accepted-current-selection.json')),
      phase2AssertionSha256: sha256File(path.join(input.p2, 'relation-valid-source-assertions-v5.jsonl')),
    },
    coverage: {
      packageCount: models.length, fieldCount: FIELDS.length, sourceCount: semanticSources.length,
      uiElementCount: acceptedView.elements.length, uiEdgeCount: acceptedView.edges.length,
      appsRowCount: acceptedAtlas.rows.length, mappingRows: mappings.length, ...acceptedAtlas.counts,
    },
    append: {
      candidateUnchanged: true, alternateCandidateUnchanged: true,
      candidateMisselectionRejected: true, acceptedContextAppsUnchanged: true,
    },
    mapping: { exact: true, unmappedFields: 0, unexpectedSourceAttributions: 0 },
    boundary: {
      acceptedWinnerSelected: false, organizationAdmissionPerformed: false,
      browserReceiptRequired: true, browserObservedByCore: false, operationalAdoptionPerformed: false,
    },
    destructive: { total: destructive.length, safe: destructive.length },
    artifacts,
  };
  writeJson(path.join(out, 'phase3-receipt.json'), receipt);
  const verification = await verifyPhase3Bundle(out);
  writeJson(path.join(out, 'phase3-verification.json'), verification);
  return verification;
}

