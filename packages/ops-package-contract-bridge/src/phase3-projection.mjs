import { stableJson } from './verify.mjs';
import {
  FIELDS, PHASE3_RECEIPT_CEILING, SUBJECT_KEY, binding, bindingIdentity, clone, context, contextDigest, digest, fail, hashValue,
  packageModels, resolveAccepted, sortedUnique, sourceRow, sourceRows, sourceSet, uiSafeJson,
} from './phase3-input.mjs';

export function decisionSourceRow(selected) {
  return { sourceRef: `${selected.sourceRef}@assertion:${selected.currentDigest}`, sourceDigest: selected.sourceDigest };
}

export function dependencyValues(assertion) {
  return (Array.isArray(assertion.value) ? assertion.value : [assertion.value]).filter(Boolean).map(String);
}

export function dependencyAssertions(model, dependency) {
  return model.fields.dependency.filter(assertion => dependencyValues(assertion).includes(dependency));
}

export function uiFieldRows(rows) {
  return rows.map(item => ({
    sourceClass: item.sourceClass,
    sourceRef: item.sourceRef,
    sourceDigest: item.sourceDigest,
    relation: item.relation,
    valueJson: uiSafeJson(item.value),
  }));
}

export function packagePurposeSummary(model) {
  return model.purposes.map(item => item.label).join(' | ');
}

export function uiProjection({ models, semanticSources, selectionContext, drifts }) {
  const selected = resolveAccepted(selectionContext);
  const packageById = new Map(models.map(model => [model.packageId, model]));
  const containers = [
    { id: 'container_decisions', label: 'Bounded compiler context', x: 0, y: 0, w: 420, h: 120 },
    { id: 'container_packages', label: 'Owned Repo packages', x: 0, y: 160, w: 1600, h: 1600 },
  ];
  const elements = [{
    id: 'decision_current',
    label: `${selected.subjectKey}: ${selected.decision}`,
    containerId: 'container_decisions',
    x: 24, y: 32, w: 360, h: 56,
    recordKind: 'accepted-current-selection-context',
    sourceRows: [decisionSourceRow(selected)],
  }];
  for (const model of models) {
    const column = model.index % 5;
    const row = Math.floor(model.index / 5);
    elements.push({
      id: model.nodeId,
      label: model.packageId,
      containerId: 'container_packages',
      x: 24 + column * 300, y: 24 + row * 120, w: 270, h: 88,
      packageId: model.packageId,
      purposeClaims: model.purposes.map(item => ({ id: item.id, label: item.label, sourceRows: item.sources })),
      contractFields: Object.fromEntries(FIELDS.map(field => [field, uiFieldRows(model.fields[field])])),
      sourceRows: model.sources,
    });
  }
  const edges = [];
  let edgeIndex = 0;
  for (const model of models) {
    for (const dependency of model.dependencies) {
      const target = packageById.get(dependency);
      if (!target) continue;
      const exact = dependencyAssertions(model, dependency);
      if (!exact.length) fail(`dependency edge has no exact source: ${model.packageId} -> ${dependency}`);
      edges.push({
        id: `edge_${String(edgeIndex++).padStart(4, '0')}`,
        from: model.nodeId,
        to: target.nodeId,
        label: 'depends on',
        sourceRows: sourceRows(exact),
      });
    }
  }
  const diagnostics = [
    ...models.flatMap(model => model.dependencies
      .filter(value => !packageById.has(value))
      .map(value => ({
        kind: 'external_dependency',
        packageId: model.packageId,
        valueJson: uiSafeJson(value),
        sourceRows: sourceRows(dependencyAssertions(model, value)),
      }))),
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
      statusText: `${models.length} packages / ${edges.length} internal dependencies / compiler context ${selected.decision}`,
    },
    acceptedCurrent: {
      subjectKey: selected.subjectKey,
      rowId: selected.rowId,
      decision: selected.decision,
      currentDigest: selected.currentDigest,
      claimCeiling: PHASE3_RECEIPT_CEILING,
      semanticParentOfPackages: false,
    },
    sourceIdentity: {
      assertionSetSha256: digest(semanticSources),
      sources: semanticSources,
      excludesBoundedCompilerContext: true,
    },
    containers,
    elements,
    edges,
    edgeList: edges.map(edge => edge.id),
    diagnostics,
    treeText: models.map(model => `${model.packageId} -> ${model.dependencies.filter(dep => packageById.has(dep)).join(', ')}`).join('\n').replaceAll('<', '\\u003c'),
  };
}

export function architectureInventory(view) {
  return {
    kind: 'ops.packageArchitectureInventory.v1',
    title: view.summary.title,
    direction: 'LR',
    generatedIsAuthority: false,
    sourceIdentityDigest: view.sourceIdentity.assertionSetSha256,
    nodes: view.elements.map(element => ({
      id: element.id,
      label: element.packageId ?? element.label,
      path: element.packageId ? `packages/${element.packageId}` : 'accepted-current-context',
      status: 'projected',
      responsibility: element.packageId
        ? element.purposeClaims.map(item => item.label).join(' | ')
        : 'bounded compiler context only; not a package purpose parent',
    })),
    edges: view.edges.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, label: edge.label })),
  };
}

export function atlasDocument({ models, assertions, drifts }) {
  const header = { schema: 'atlas.purpose-closure/1', authority: false };
  const rows = [];
  for (const model of models) {
    const purposeIds = model.purposes.map(item => item.id).sort();
    for (const purpose of model.purposes) {
      rows.push({ kind: 'purpose', id: purpose.id, label: purpose.label, sources: purpose.sources, parents: [] });
    }
    rows.push({
      kind: 'ideal',
      id: `ideal:package:${model.packageId}`,
      label: `Repository contract projection: ${model.packageId}`,
      sources: model.sources,
      purposes: purposeIds,
      value: stableJson(model.fields),
    });
  }

  const assertionByIdentity = new Map(assertions.map(assertion => [`${assertion.sourceRef}\u0000${assertion.sourceDigest}`, assertion]));
  const modelByPackage = new Map(models.map(model => [model.packageId, model]));
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
    const model = modelByPackage.get(finding.packageId);
    if (!model) fail(`drift package missing: ${finding.packageId}`);
    const suffix = String(projectedGapCount++).padStart(4, '0');
    const idealId = `ideal:drift:${suffix}`;
    const currentId = `current:drift:${suffix}`;
    rows.push({
      kind: 'ideal',
      id: idealId,
      label: `${finding.packageId}.${finding.field} declared state`,
      sources: sourceRows([declarationAssertion, ...model.fields.purpose]),
      purposes: model.purposes.map(item => item.id).sort(),
      value: stableJson(declaration.value),
    });
    rows.push({
      kind: 'current',
      id: currentId,
      label: `${finding.packageId}.${finding.field} observed state`,
      sources: [sourceRow(observationAssertion)],
      value: stableJson(observation.value),
    });
    rows.push({
      kind: 'gap',
      id: `gap:drift:${suffix}`,
      label: `${finding.packageId}.${finding.field} claim/observation drift`,
      sources: sourceRows([declarationAssertion, observationAssertion]),
      current: currentId,
      ideal: idealId,
      delta: stableJson(finding),
      owner: 'roccho-org/ops',
      proof: `${finding.kind}:${finding.packageId}:${finding.field}`,
    });
  }
  const jsonl = [stableJson(header), ...rows.map(stableJson)].join('\n') + '\n';
  return {
    header,
    rows,
    jsonl,
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

export function appsProjection({ models, assertions, drifts, selectionContext }) {
  resolveAccepted(selectionContext);
  return atlasDocument({ models, assertions, drifts });
}

export function snapshots(view) {
  const result = [{
    kind: 'ops.contract632.sharedAtlasSnapshot.v1',
    snapshot: 'summary',
    sourceViewDigest: digest(view),
    payload: { summary: view.summary, acceptedCurrent: view.acceptedCurrent },
    generatedArtifactsAreAuthority: false,
  }];
  for (const element of view.elements.filter(item => item.packageId)) {
    result.push({
      kind: 'ops.contract632.sharedAtlasSnapshot.v1',
      snapshot: 'package',
      id: element.id,
      sourceViewDigest: digest(view),
      payload: {
        packageId: element.packageId,
        label: element.label,
        purposeClaims: element.purposeClaims,
        sourceRows: element.sourceRows,
      },
      generatedArtifactsAreAuthority: false,
    });
  }
  for (const edge of view.edges.filter(item => item.label === 'depends on')) {
    result.push({
      kind: 'ops.contract632.sharedAtlasSnapshot.v1',
      snapshot: 'relation',
      id: edge.id,
      sourceViewDigest: digest(view),
      payload: edge,
      generatedArtifactsAreAuthority: false,
    });
  }
  return result;
}

export function sourceSetFromAtlasRows(rows) {
  return sourceSet(rows.flatMap(row => row.sources));
}

export function assertProjectionSourceIdentity(view, atlasRows, expectedSources) {
  const uiSources = view.sourceIdentity.sources;
  const appsSources = sourceSetFromAtlasRows(atlasRows);
  if (stableJson(uiSources) !== stableJson(expectedSources)) fail('UI semantic source identity set mismatch');
  if (stableJson(appsSources) !== stableJson(expectedSources)) fail('Apps semantic source identity set mismatch');
  if (digest(uiSources) !== view.sourceIdentity.assertionSetSha256) fail('UI source identity digest mismatch');
  return { sourceCount: expectedSources.length, sourceIdentityDigest: view.sourceIdentity.assertionSetSha256 };
}

export function deepDiff(left, right, at = '') {
  if (stableJson(left) === stableJson(right)) return [];
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return [at || '/'];
  const keys = sortedUnique([...Object.keys(left), ...Object.keys(right)]);
  return keys.flatMap(key => deepDiff(left[key], right[key], `${at}/${key}`));
}

export function mutateCandidate(candidate) {
  const packet = clone(candidate.packetValue);
  const row = packet.currentState.find(item => item.subject_key === SUBJECT_KEY);
  const before = row.decision;
  const options = ['add_semantic_term', 'extend_existing', 'add_projection', 'add_query_contract', 'create_new_model'];
  row.decision = options.find(value => value !== before);
  const currentDigest = hashValue(packet.currentState);
  packet.currentDigest = currentDigest;
  packet.replayDigest = currentDigest;
  packet.semanticDigest = hashValue({ proofMutation: true, currentState: packet.currentState });
  packet.label = 'BC1-MUTATED-PROOF';
  const packetSha256 = hashValue(packet);
  const selection = {
    rowId: `${candidate.rowId}:mutation-proof`,
    decision: row.decision,
    currentDigest,
    packet: 'BC1-mutated-proof.packet.json',
    packetSha256,
  };
  return {
    binding: binding({ role: 'candidate-variant', row: selection, packet, packetSha256 }),
    artifact: {
      kind: 'ops.contract632.phase3CandidateMutation.v1',
      authority: false,
      base: bindingIdentity(candidate),
      mutation: { subjectKey: SUBJECT_KEY, before, after: row.decision },
      packet,
      packetSha256,
      selection,
    },
  };
}

export function computeProjectionSet({ input, consumers }) {
  const models = packageModels(input.coverage);
  const semanticSources = sourceRows(input.assertions);
  const mutated = mutateCandidate(input.selections.candidate);
  const contexts = {
    before: context({ accepted: input.selections.before }),
    accepted: context({ accepted: input.selections.accepted }),
    candidateOverlay: context({ accepted: input.selections.accepted, unadmitted: [input.selections.candidate] }),
    mutatedCandidateOverlay: context({ accepted: input.selections.accepted, unadmitted: [mutated.binding] }),
    candidateSelected: context({ accepted: input.selections.candidate }),
  };

  const views = Object.fromEntries(Object.entries(contexts).map(([key, selectionContext]) => [
    key,
    uiProjection({ models, semanticSources, selectionContext, drifts: input.drifts }),
  ]));
  for (const view of Object.values(views)) consumers.ui.assertContractModelAtlasView(view);

  const atlases = Object.fromEntries(Object.entries(contexts).map(([key, selectionContext]) => [
    key,
    appsProjection({ models, assertions: input.assertions, drifts: input.drifts, selectionContext }),
  ]));
  const reduced = Object.fromEntries(Object.entries(atlases).map(([key, atlas]) => [key, consumers.apps.reduceClosure(atlas.jsonl)]));

  if (stableJson(views.accepted) !== stableJson(views.candidateOverlay)) fail('exact unadmitted candidate changed accepted UI projection');
  if (stableJson(views.accepted) !== stableJson(views.mutatedCandidateOverlay)) fail('mutated unadmitted candidate changed accepted UI projection');
  if (reduced.accepted !== reduced.candidateOverlay) fail('exact unadmitted candidate changed accepted Apps projection');
  if (reduced.accepted !== reduced.mutatedCandidateOverlay) fail('mutated unadmitted candidate changed accepted Apps projection');
  if (stableJson(views.accepted) === stableJson(views.candidateSelected)) fail('candidate promotion did not change UI projection');
  if (reduced.accepted !== reduced.candidateSelected) fail('bounded compiler context leaked into Apps semantic projection');

  const uiDelta = deepDiff(views.before, views.accepted);
  if (!uiDelta.length || !uiDelta.some(item => item.includes('decision_current') || item.includes('acceptedCurrent') || item.includes('summary'))) {
    fail('accepted compiler context change was not projected to UI context');
  }
  if (reduced.before !== reduced.accepted) fail('compiler context changed Apps semantic projection');

  const proof = {
    kind: 'ops.contract632.phase3AppendInvariants.v2',
    authority: false,
    bindings: {
      before: bindingIdentity(input.selections.before),
      accepted: bindingIdentity(input.selections.accepted),
      candidate: bindingIdentity(input.selections.candidate),
      mutatedCandidate: bindingIdentity(mutated.binding),
    },
    contextInputs: Object.fromEntries(Object.entries(contexts).map(([key, value]) => [key, {
      digest: contextDigest(value),
      acceptedRowId: value.accepted.rowId,
      unadmittedRowIds: value.unadmitted.map(item => item.rowId),
    }])),
    unadmittedCandidate: {
      exactCandidateInputDistinct: contextDigest(contexts.accepted) !== contextDigest(contexts.candidateOverlay),
      exactCandidateAcceptedUiUnchanged: stableJson(views.accepted) === stableJson(views.candidateOverlay),
      exactCandidateAcceptedAppsUnchanged: reduced.accepted === reduced.candidateOverlay,
      mutatedCandidateInputDistinct: contextDigest(contexts.candidateOverlay) !== contextDigest(contexts.mutatedCandidateOverlay),
      mutatedCandidateAcceptedUiUnchanged: stableJson(views.accepted) === stableJson(views.mutatedCandidateOverlay),
      mutatedCandidateAcceptedAppsUnchanged: reduced.accepted === reduced.mutatedCandidateOverlay,
    },
    candidatePromotion: {
      selectedRowId: contexts.candidateSelected.accepted.rowId,
      uiChanged: stableJson(views.accepted) !== stableJson(views.candidateSelected),
      appsChanged: reduced.accepted !== reduced.candidateSelected,
      detected: stableJson(views.accepted) !== stableJson(views.candidateSelected) || reduced.accepted !== reduced.candidateSelected,
    },
    acceptedChange: {
      beforeRowId: input.selections.before.rowId,
      acceptedRowId: input.selections.accepted.rowId,
      beforeDecision: input.selections.before.decision,
      acceptedDecision: input.selections.accepted.decision,
      uiChangedPaths: uiDelta,
      uiChanged: true,
      appsChanged: false,
      appsReason: 'bounded compiler classification is projection context, not a Package purpose relation',
    },
    outputs: {
      acceptedUiDigest: digest(views.accepted),
      acceptedAppsDigest: digest(reduced.accepted),
      candidateSelectedUiDigest: digest(views.candidateSelected),
      candidateSelectedAppsDigest: digest(reduced.candidateSelected),
    },
  };
  return { models, semanticSources, mutated, contexts, views, atlases, reduced, proof, uiDelta };
}
