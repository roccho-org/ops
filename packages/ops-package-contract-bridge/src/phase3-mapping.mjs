import { stableJson } from './verify.mjs';
import { FIELDS, fail, sortedUnique, sourceRow, sourceRows, uiSafeJson } from './phase3-input.mjs';
import { dependencyAssertions } from './phase3-projection.mjs';

export function mappingRows(models, view, atlasRows) {
  const elements = new Map(view.elements.filter(row => row.packageId).map(row => [row.packageId, row]));
  const atlas = new Map(atlasRows.map(row => [row.id, row]));
  const edges = new Map(view.edges.map(row => [`${row.from}\u0000${row.to}`, row]));
  const modelById = new Map(models.map(model => [model.packageId, model]));
  const rows = [];

  for (const model of models) {
    const element = elements.get(model.packageId);
    if (!element) fail(`UI package element missing: ${model.packageId}`);
    const ideal = atlas.get(`ideal:package:${model.packageId}`);
    if (!ideal) fail(`Apps package ideal missing: ${model.packageId}`);
    const idealValue = JSON.parse(ideal.value);

    for (const field of FIELDS) {
      if (!Array.isArray(element.contractFields?.[field]) || !Array.isArray(idealValue?.[field])) {
        fail(`field projection missing: ${model.packageId}.${field}`);
      }
      for (const [index, assertion] of model.fields[field].entries()) {
        const expectedUi = {
          sourceClass: assertion.sourceClass,
          sourceRef: assertion.sourceRef,
          sourceDigest: assertion.sourceDigest,
          relation: assertion.relation,
          valueJson: uiSafeJson(assertion.value),
        };
        if (stableJson(element.contractFields[field][index]) !== stableJson(expectedUi)) {
          fail(`UI field mapping mismatch: ${model.packageId}.${field}[${index}]`);
        }
        if (stableJson(idealValue[field][index]) !== stableJson(assertion)) {
          fail(`Apps field mapping mismatch: ${model.packageId}.${field}[${index}]`);
        }
        const source = sourceRow(assertion);
        rows.push({
          kind: 'field', packageId: model.packageId, field, relation: assertion.relation,
          sourceRef: source.sourceRef, sourceDigest: source.sourceDigest,
          ui: { recordId: element.id, path: `/contractFields/${field}/${index}` },
          apps: { recordId: ideal.id, path: `/value/${field}/${index}` },
        });
      }
    }

    if (stableJson(element.sourceRows) !== stableJson(model.sources)) fail(`UI package source attribution mismatch: ${model.packageId}`);
    if (stableJson(ideal.sources) !== stableJson(model.sources)) fail(`Apps ideal source attribution mismatch: ${model.packageId}`);
    if (element.purposeClaims.length !== model.purposes.length) fail(`UI purpose claim count mismatch: ${model.packageId}`);

    for (const purpose of model.purposes) {
      const uiPurpose = element.purposeClaims.find(row => row.id === purpose.id);
      const appsPurpose = atlas.get(purpose.id);
      if (!uiPurpose || uiPurpose.label !== purpose.label || stableJson(uiPurpose.sourceRows) !== stableJson(purpose.sources)) {
        fail(`UI purpose provenance mismatch: ${model.packageId}:${purpose.id}`);
      }
      if (!appsPurpose || appsPurpose.kind !== 'purpose' || appsPurpose.label !== purpose.label
        || stableJson(appsPurpose.parents) !== '[]' || stableJson(appsPurpose.sources) !== stableJson(purpose.sources)) {
        fail(`Apps purpose provenance mismatch: ${model.packageId}:${purpose.id}`);
      }
      for (const source of purpose.sources) {
        rows.push({
          kind: 'purpose-label', packageId: model.packageId, field: 'purpose', relation: 'supports_exact_purpose_label',
          sourceRef: source.sourceRef, sourceDigest: source.sourceDigest,
          ui: { recordId: element.id, path: `/purposeClaims/${purpose.id}` },
          apps: { recordId: purpose.id, path: '/label' },
        });
      }
    }

    for (const dependency of model.dependencies) {
      const target = modelById.get(dependency);
      if (!target) continue;
      const edge = edges.get(`${model.nodeId}\u0000${target.nodeId}`);
      if (!edge) fail(`UI dependency edge missing: ${model.packageId} -> ${dependency}`);
      const exact = sourceRows(dependencyAssertions(model, dependency));
      if (!exact.length || stableJson(edge.sourceRows) !== stableJson(exact)) {
        fail(`UI dependency edge provenance mismatch: ${model.packageId} -> ${dependency}`);
      }
      for (const source of exact) {
        rows.push({
          kind: 'dependency-edge', packageId: model.packageId, field: 'dependency', relation: 'supports_exact_dependency_target',
          sourceRef: source.sourceRef, sourceDigest: source.sourceDigest,
          ui: { recordId: edge.id, path: '/sourceRows' },
          apps: { recordId: ideal.id, path: '/value/dependency' },
        });
      }
    }
  }

  if (view.edges.some(edge => edge.from === 'decision_current' || edge.to === 'decision_current')) {
    fail('compiler context must not create package semantic edges');
  }
  if (atlasRows.some(row => row.kind === 'purpose' && row.id.startsWith('purpose:decision:'))) {
    fail('compiler classification must not become Apps Purpose');
  }
  return rows.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

export function assertExactMappings(actual, expected) {
  if (stableJson(actual) !== stableJson(expected)) fail('projection mapping mismatch');
}

export function mappingSummary(models, mappings, acceptedAtlas, identityCheck) {
  const fieldMappings = mappings.filter(row => row.kind === 'field');
  const mappedFields = sortedUnique(fieldMappings.map(row => row.field));
  const unmappedPackageFields = [];
  for (const model of models) {
    for (const field of FIELDS) {
      if (!fieldMappings.some(row => row.packageId === model.packageId && row.field === field)) {
        unmappedPackageFields.push(`${model.packageId}.${field}`);
      }
    }
  }
  return {
    kind: 'ops.contract632.phase3MappingCoverage.v2',
    authority: false,
    sourceIdentityDigest: identityCheck.sourceIdentityDigest,
    sourceCount: identityCheck.sourceCount,
    mappingRows: mappings.length,
    fieldMappings: fieldMappings.length,
    purposeLabelMappings: mappings.filter(row => row.kind === 'purpose-label').length,
    dependencyEdgeMappings: mappings.filter(row => row.kind === 'dependency-edge').length,
    ui: { packageCount: models.length, fieldSet: mappedFields, consumer: 'ui.assertContractModelAtlasView', exactSourceAttribution: true },
    sharedAtlasSnapshots: { consumerClaimed: false, distinctInputContract: true },
    apps: { fieldSet: mappedFields, consumer: 'apps.reduceClosure', ...acceptedAtlas.counts, inventedFillReceiptResidual: false, exactSourceAttribution: true },
    unsupportedDrifts: { count: acceptedAtlas.counts.unprojectedDriftCount, reason: 'claim-to-claim drift has no authoritative current/ideal direction and remains in UI diagnostics' },
    unmappedFields: FIELDS.filter(field => !mappedFields.includes(field)),
    unmappedPackageFields,
    unexpectedSourceAttributions: 0,
  };
}
