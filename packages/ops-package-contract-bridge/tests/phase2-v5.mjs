import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase2V5Bundle,
  verifyPhase2V5Bundle,
} from '../src/phase2-v5.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const universeFile = process.argv[2];
if (!universeFile) throw new Error('local source universe file argument is required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-phase2-v5-'));
const run1 = path.join(temp, 'run1');
const run2 = path.join(temp, 'run2');
const candidateSha = '9'.repeat(40);

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

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

try {
  const first = buildPhase2V5Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    localSourceUniverseFile: universeFile,
    outDir: run1,
  });
  const second = buildPhase2V5Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    localSourceUniverseFile: universeFile,
    outDir: run2,
  });

  assert.equal(first.status, 'PASS');
  assert.equal(first.authority, false);
  assert.equal(first.phaseClosed, false);
  assert.equal(first.relationFindingCount, 0);
  assert.equal(first.unresolvedSupportCount, 0);
  assert.equal(first.combinedAssertionCount, first.relationValidAssertionCount);
  assert.equal(first.directPlacementCount, first.packageCount);
  assert.equal(first.originalDerivedCount, 180);
  assert.equal(first.structuredDerivedCount, 120);
  assert.equal(first.structuredSupportCount, 300);

  const assertions = readJsonl(path.join(run1, 'combined-source-assertions-v5.jsonl'));
  const derived = assertions.filter((item) => item.relation === 'derived_from');
  assert.equal(derived.length, 120);
  assert.ok(derived.every((item) => item.supports.length > 0
    && item.supports.every((support) => support
      && typeof support === 'object'
      && /^[0-9a-f]{64}$/u.test(support.sourceFileDigest)
      && /^[0-9a-f]{64}$/u.test(support.sourceDigest))));
  assert.equal(assertions.filter((item) => item.field === 'placement'
    && item.relation === 'derived_from').length, 0);
  assert.equal(assertions.filter((item) => item.relation === 'declares_package_path').length, first.packageCount);

  const destructive = JSON.parse(fs.readFileSync(path.join(run1, 'phase2-v5-destructive-results.json'), 'utf8'));
  assert.deepEqual(new Map(destructive.results.map((item) => [item.case, item.status])), new Map([
    ['base-derived-missing-support', 'REJECTED'],
    ['base-derived-support-digest-mismatch', 'REJECTED'],
    ['unresolved-package-level-support', 'REJECTED'],
    ['relation-invalid-assertion-excluded-from-coverage', 'BLOCKED_UNKNOWN'],
  ]));

  const run1Files = files(run1);
  assert.deepEqual(run1Files, files(run2));
  for (const relative of run1Files) {
    assert.deepEqual(
      fs.readFileSync(path.join(run1, relative)),
      fs.readFileSync(path.join(run2, relative)),
      `non-deterministic output: ${relative}`,
    );
  }

  const relationFile = path.join(run1, 'combined-source-relation-findings-v5.json');
  fs.appendFileSync(relationFile, '\n');
  assert.throws(() => verifyPhase2V5Bundle(run1), /artifact digest mismatch/u);

  process.stdout.write(`${JSON.stringify({
    kind: 'ops.packageContractBridge.phase2V5UnitReceipt.v1',
    status: 'PASS',
    authority: false,
    packageCount: first.packageCount,
    combinedAssertionCount: first.combinedAssertionCount,
    relationValidAssertionCount: first.relationValidAssertionCount,
    structuredDerivedCount: first.structuredDerivedCount,
    structuredSupportCount: first.structuredSupportCount,
    directPlacementCount: first.directPlacementCount,
    relationFindingCount: first.relationFindingCount,
    unresolvedSupportCount: first.unresolvedSupportCount,
  })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
