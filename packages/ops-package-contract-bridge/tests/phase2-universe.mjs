import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase2V3Bundle,
  verifyPhase2V3Bundle,
} from '../src/phase2-universe.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const universeFile = process.argv[2];
if (!universeFile) throw new Error('local source universe file argument is required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-phase2-v3-'));
const run1 = path.join(temp, 'run1');
const run2 = path.join(temp, 'run2');
const candidateSha = 'e'.repeat(40);

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
  const first = buildPhase2V3Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    localSourceUniverseFile: universeFile,
    outDir: run1,
  });
  const second = buildPhase2V3Bundle({
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
  assert.ok(first.billingLocalAssertionCount > 0);
  assert.ok(first.functionalCoreLocalAssertionCount > 0);

  const run1Files = files(run1);
  assert.deepEqual(run1Files, files(run2));
  for (const relative of run1Files) {
    assert.deepEqual(
      fs.readFileSync(path.join(run1, relative)),
      fs.readFileSync(path.join(run2, relative)),
      `non-deterministic output: ${relative}`,
    );
  }

  const billingCopy = path.join(run1, 'local-source-files/packages/billing-channel-config/default.nix');
  fs.appendFileSync(billingCopy, '\n# tampered\n');
  assert.throws(() => verifyPhase2V3Bundle(run1), /artifact digest mismatch|local source index mismatch/u);

  process.stdout.write(`${JSON.stringify({
    kind: 'ops.packageContractBridge.phase2UniverseUnitReceipt.v1',
    status: 'PASS',
    authority: false,
    packageCount: first.packageCount,
    defaultNixPresentCount: first.defaultNixPresentCount,
    semanticSourceCount: first.semanticSourceCount,
    semanticAssertionCount: first.semanticAssertionCount,
    driftCount: first.driftCount,
    billingLocalAssertionCount: first.billingLocalAssertionCount,
    functionalCoreLocalAssertionCount: first.functionalCoreLocalAssertionCount,
  })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
