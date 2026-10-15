import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase2V4Bundle,
  verifyPhase2V4Bundle,
} from '../src/phase2-v4.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const universeFile = process.argv[2];
if (!universeFile) throw new Error('local source universe file argument is required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-phase2-v4-'));
const run1 = path.join(temp, 'run1');
const run2 = path.join(temp, 'run2');
const candidateSha = 'f'.repeat(40);

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
  const first = buildPhase2V4Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    localSourceUniverseFile: universeFile,
    outDir: run1,
  });
  const second = buildPhase2V4Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    localSourceUniverseFile: universeFile,
    outDir: run2,
  });

  assert.equal(first.status, 'PASS');
  assert.equal(first.authority, false);
  assert.equal(first.phaseClosed, false);
  assert.equal(first.unknownCount, 0);
  assert.equal(first.conflictCount, 0);
  assert.equal(first.omissionCount, 0);
  assert.equal(first.sourceUniverseFindingCount, 0);
  assert.equal(first.sourceRelationFindingCount, 0);
  assert.equal(first.compositeSourceRefCount, 0);
  assert.ok(first.billingLocalAssertionCount > 0);
  assert.ok(first.functionalCoreLocalAssertionCount > 0);
  assert.ok(first.cdpTtyLambdaAssertionCount > 0);
  assert.ok(first.lambdaMetadataSourceCount > 0);

  const assertions = readJsonl(path.join(run1, 'local-source-assertions-v4.jsonl'));
  assert.ok(assertions.every((item) => !item.sourceRef.includes('+')));
  const cdp = assertions.find((item) => item.packageId === 'cdp-tty'
    && item.sourceRef === 'packages/cdp-tty/default.nix#nix.lambda.meta.description');
  assert.equal(cdp?.value, 'Attach-only Chrome page I/O for a Kitty-capable terminal');
  assert.equal(cdp?.relation, 'declares_nix_lambda_metadata');

  const destructive = JSON.parse(fs.readFileSync(path.join(run1, 'phase2-v4-destructive-results.json'), 'utf8'));
  assert.deepEqual(new Map(destructive.results.map((item) => [item.case, item.status])), new Map([
    ['nonexistent-exact-source-ref', 'REJECTED'],
    ['derived-assertion-missing-support', 'REJECTED'],
    ['derived-support-digest-mismatch', 'REJECTED'],
    ['lambda-explicit-metadata-omitted', 'BLOCKED_UNKNOWN'],
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

  const cdpCopy = path.join(run1, 'local-source-files/packages/cdp-tty/default.nix');
  fs.appendFileSync(cdpCopy, '\n# tampered\n');
  assert.throws(() => verifyPhase2V4Bundle(run1), /artifact digest mismatch|local source index mismatch/u);

  process.stdout.write(`${JSON.stringify({
    kind: 'ops.packageContractBridge.phase2V4UnitReceipt.v1',
    status: 'PASS',
    authority: false,
    packageCount: first.packageCount,
    semanticSourceCount: first.semanticSourceCount,
    semanticAssertionCount: first.semanticAssertionCount,
    lambdaMetadataSourceCount: first.lambdaMetadataSourceCount,
    lambdaMetadataAssertionCount: first.lambdaMetadataAssertionCount,
    sourceRelationFindingCount: first.sourceRelationFindingCount,
    compositeSourceRefCount: first.compositeSourceRefCount,
    cdpTtyLambdaAssertionCount: first.cdpTtyLambdaAssertionCount,
  })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
