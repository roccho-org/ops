import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPhase3Bundle, verifyPhase3Bundle } from '../src/phase3.mjs';

const [phase1Bundle, phase2Bundle, uiSource, appsSource, uiRevision, appsRevision, packageMapCommand, packageMapViewer, opsCandidateSha] = process.argv.slice(2);
if ([phase1Bundle, phase2Bundle, uiSource, appsSource, uiRevision, appsRevision, packageMapCommand, packageMapViewer, opsCandidateSha].some(value => !value)) {
  throw new Error('usage: phase3.mjs PHASE1 PHASE2 UI_SOURCE APPS_SOURCE UI_REV APPS_REV MAP_COMMAND MAP_VIEWER OPS_SHA');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-phase3-'));
const run1 = path.join(temp, 'run1');
const run2 = path.join(temp, 'run2');
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const expectedPackages = fs.readdirSync(path.join(sourceRoot, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const inputAssertions = fs.readFileSync(path.join(phase2Bundle, 'relation-valid-source-assertions-v5.jsonl'), 'utf8')
  .trim().split(/\r?\n/u).map(JSON.parse);
const expectedSources = [...new Map(inputAssertions.map(row => [
  `${row.sourceRef}@assertion:${row.sourceDigest}`,
  { sourceRef: `${row.sourceRef}@assertion:${row.sourceDigest}`, sourceDigest: `sha256:${row.sourceDigest}` },
])).values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
const expectedEdges = [...new Set(inputAssertions.filter(row => row.field === 'dependency')
  .flatMap(row => (Array.isArray(row.value) ? row.value : [row.value])
    .filter(value => expectedPackages.includes(value)).map(value => `${row.packageId}\0${value}`)))].sort();
const inputDrifts = JSON.parse(fs.readFileSync(path.join(phase2Bundle, 'combined-drift-findings-v5.json'), 'utf8')).findings;

function files(root, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(absolute, relative));
    else out.push(relative);
  }
  return out;
}

try {
  const args = { phase1Bundle, phase2Bundle, uiSource, appsSource, uiRevision, appsRevision, packageMapCommand, packageMapViewer, opsCandidateSha };
  const first = await buildPhase3Bundle({ ...args, outDir: run1 });
  const second = await buildPhase3Bundle({ ...args, outDir: run2 });

  assert.equal(first.status, 'PASS');
  assert.equal(first.authority, false);
  assert.equal(first.phaseClosed, false);
  assert.equal(first.packageCount, expectedPackages.length);
  assert.equal(first.sourceCount, expectedSources.length);
  assert.equal(first.uiElementCount, expectedPackages.length + 1);
  assert.equal(first.uiEdgeCount, expectedEdges.length);
  assert.ok(first.appsRowCount > 0);
  assert.ok(first.mappingRows >= expectedSources.length);
  assert.equal(first.fillCount, 0);
  assert.equal(first.receiptCount, 0);
  assert.equal(first.residualCount, 0);
  assert.equal(first.candidateUnchanged, true);
  assert.equal(first.alternateCandidateUnchanged, true);
  assert.equal(first.candidateMisselectionRejected, true);
  assert.equal(first.acceptedContextAppsUnchanged, true);
  assert.equal(first.exactProjectionMapping, true);
  assert.equal(first.browserReceiptRequired, true);

  const run1Files = files(run1);
  assert.deepEqual(run1Files, files(run2));
  for (const relative of run1Files) {
    assert.deepEqual(fs.readFileSync(path.join(run1, relative)), fs.readFileSync(path.join(run2, relative)), `non-deterministic output: ${relative}`);
  }

  const mapping = JSON.parse(fs.readFileSync(path.join(run1, 'mapping-coverage.json'), 'utf8'));
  assert.deepEqual(mapping.unmappedFields, []);
  assert.deepEqual(mapping.unmappedPackageFields, []);
  assert.equal(mapping.unexpectedSourceAttributions, 0);
  assert.equal(mapping.apps.inventedFillReceiptResidual, false);
  assert.equal(mapping.apps.exactSourceAttribution, true);
  assert.equal(mapping.ui.exactSourceAttribution, true);

  const append = JSON.parse(fs.readFileSync(path.join(run1, 'append-invariants.json'), 'utf8'));
  assert.equal(append.unadmittedCandidate.exactCandidateInputDistinct, true);
  assert.equal(append.unadmittedCandidate.exactCandidateAcceptedUiUnchanged, true);
  assert.equal(append.unadmittedCandidate.exactCandidateAcceptedAppsUnchanged, true);
  assert.equal(append.unadmittedCandidate.mutatedCandidateInputDistinct, true);
  assert.equal(append.unadmittedCandidate.mutatedCandidateAcceptedUiUnchanged, true);
  assert.equal(append.unadmittedCandidate.mutatedCandidateAcceptedAppsUnchanged, true);
  assert.equal(append.candidatePromotion.detected, true);
  assert.equal(append.acceptedChange.uiChanged, true);
  assert.equal(append.acceptedChange.appsChanged, false);
  assert.notEqual(append.contextInputs.accepted.digest, append.contextInputs.candidateOverlay.digest);
  assert.notEqual(append.contextInputs.candidateOverlay.digest, append.contextInputs.mutatedCandidateOverlay.digest);

  const view = JSON.parse(fs.readFileSync(path.join(run1, 'ui.contract-model-atlas.view.json'), 'utf8'));
  assert.deepEqual(view.elements.filter(element => element.packageId).map(element => element.packageId).sort(), expectedPackages);
  assert.deepEqual(view.sourceIdentity.sources, expectedSources);
  const packageIdsByElement = new Map(view.elements.filter(element => element.packageId).map(element => [element.id, element.packageId]));
  assert.deepEqual(view.edges.map(edge => `${packageIdsByElement.get(edge.from)}\0${packageIdsByElement.get(edge.to)}`).sort(), expectedEdges);
  assert.ok(view.elements.every(element => !element.packageId || Object.keys(element.contractFields).length === 11));
  assert.equal(view.edges.some(edge => edge.from === 'decision_current' || edge.to === 'decision_current'), false);
  assert.equal(view.diagnostics.filter(item => item.kind === 'visible_drift').length, inputDrifts.length);

  const atlasRows = fs.readFileSync(path.join(run1, 'apps.atlas-purpose-closure.input.jsonl'), 'utf8').trim().split(/\r?\n/u).slice(1).map(JSON.parse);
  assert.equal(atlasRows.some(row => row.kind === 'purpose' && row.id.startsWith('purpose:decision:')), false);
  assert.ok(atlasRows.filter(row => row.kind === 'purpose').every(row => row.parents.length === 0));

  const destructive = JSON.parse(fs.readFileSync(path.join(run1, 'phase3-destructive-results.json'), 'utf8'));
  assert.ok(destructive.results.length >= 10);
  assert.ok(destructive.results.every(row => row.status === 'REJECTED' && row.error));
  const collision = destructive.results.find(row => row.case === 'candidate-context-input-collision');
  assert.ok(collision);
  assert.match(collision.error, /candidate is not distinct from accepted/u);

  const tampered = path.join(run1, 'ui.contract-model-atlas.view.json');
  const original = fs.readFileSync(tampered);
  fs.appendFileSync(tampered, '\n');
  await assert.rejects(() => verifyPhase3Bundle(run1), /artifact mismatch/u);
  fs.writeFileSync(tampered, original);
  const verified = await verifyPhase3Bundle(run1);
  assert.equal(verified.status, 'PASS');

  process.stdout.write(`${JSON.stringify({
    kind: 'ops.packageContractBridge.phase3UnitReceipt.v2', status: 'PASS', authority: false,
    packageCount: first.packageCount, sourceCount: first.sourceCount,
    uiElementCount: first.uiElementCount, uiEdgeCount: first.uiEdgeCount,
    appsRowCount: first.appsRowCount, mappingRows: first.mappingRows,
    candidateIsolation: 'RECOMPUTED', exactProjectionMapping: true,
  })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
