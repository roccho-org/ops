import fs from 'node:fs';
import path from 'node:path';
import { sha256File, stableJson } from './verify.mjs';
import { PHASE3_RECEIPT_CEILING, fail, readJson, readJsonl, readPhaseInputs } from './phase3-input.mjs';
import { assertProjectionSourceIdentity, computeProjectionSet } from './phase3-projection.mjs';
import { assertExactMappings, mappingRows, mappingSummary } from './phase3-mapping.mjs';
import { importConsumers } from './phase3-runtime-util.mjs';

export async function verifyPhase3Bundle(bundleDir) {
  const root = path.resolve(bundleDir);
  const receipt = readJson(path.join(root, 'phase3-receipt.json'));
  if (receipt.kind !== 'ops.packageContractBridge.phase3Receipt.v2' || receipt.status !== 'PASS'
    || receipt.authority !== false || receipt.phaseClosed !== false) fail('receipt boundary mismatch');
  for (const artifact of receipt.artifacts) {
    const file = path.join(root, artifact.path);
    if (!fs.existsSync(file) || sha256File(file) !== artifact.sha256) fail(`artifact mismatch: ${artifact.path}`);
  }

  const input = readPhaseInputs(path.join(root, 'inputs/phase1'), path.join(root, 'inputs/phase2'));
  if (input.verification.opsCandidateSha !== receipt.source.opsCandidateSha) fail('copied Phase 2 candidate mismatch');
  const consumers = await importConsumers(path.join(root, 'consumer-sources/ui'), path.join(root, 'consumer-sources/apps'));
  const projection = computeProjectionSet({ input, consumers });
  const { models, semanticSources, views, atlases, reduced, proof } = projection;
  const view = readJson(path.join(root, 'ui.contract-model-atlas.view.json'));
  if (stableJson(view) !== stableJson(views.accepted)) fail('stored UI projection is not derivable from copied inputs');
  consumers.ui.assertContractModelAtlasView(view);

  const appsInput = fs.readFileSync(path.join(root, 'apps.atlas-purpose-closure.input.jsonl'), 'utf8');
  if (appsInput !== atlases.accepted.jsonl) fail('stored Apps input is not derivable from copied inputs');
  const appsReduced = consumers.apps.reduceClosure(appsInput);
  if (appsReduced !== reduced.accepted || appsReduced !== fs.readFileSync(path.join(root, 'apps.atlas-purpose-closure.reduced.jsonl'), 'utf8')) {
    fail('Apps reduced output mismatch');
  }

  const identityCheck = assertProjectionSourceIdentity(view, atlases.accepted.rows, semanticSources);
  const expectedMappings = mappingRows(models, view, atlases.accepted.rows);
  const actualMappings = readJsonl(path.join(root, 'projection-mapping.jsonl'));
  assertExactMappings(actualMappings, expectedMappings);
  const expectedMapping = mappingSummary(models, expectedMappings, atlases.accepted, identityCheck);
  const actualMapping = readJson(path.join(root, 'mapping-coverage.json'));
  if (stableJson(actualMapping) !== stableJson(expectedMapping) || actualMapping.unmappedFields.length
    || actualMapping.unmappedPackageFields.length || actualMapping.unexpectedSourceAttributions) {
    fail('mapping coverage mismatch');
  }

  const invariants = readJson(path.join(root, 'append-invariants.json'));
  if (stableJson(invariants) !== stableJson(proof)) fail('append invariant is not recomputed from copied packets and selection');
  const destructive = readJson(path.join(root, 'phase3-destructive-results.json'));
  if (destructive.results.length < 10 || destructive.results.some(item => item.status !== 'REJECTED' || typeof item.error !== 'string' || !item.error)) {
    fail('destructive coverage incomplete');
  }

  return {
    kind: 'ops.packageContractBridge.phase3Verification.v2', status: 'PASS', authority: false, phaseClosed: false,
    claimCeiling: PHASE3_RECEIPT_CEILING, opsCandidateSha: receipt.source.opsCandidateSha,
    packageCount: receipt.coverage.packageCount, sourceCount: receipt.coverage.sourceCount,
    uiElementCount: receipt.coverage.uiElementCount, uiEdgeCount: receipt.coverage.uiEdgeCount,
    appsRowCount: receipt.coverage.appsRowCount, mappingRows: receipt.coverage.mappingRows,
    fillCount: 0, receiptCount: 0, residualCount: 0,
    candidateUnchanged: true, alternateCandidateUnchanged: true, candidateMisselectionRejected: true,
    acceptedChanged: true, acceptedContextAppsUnchanged: true,
    exactProjectionMapping: true, browserReceiptRequired: true,
  };
}
