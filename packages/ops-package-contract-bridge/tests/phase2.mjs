import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase2Bundle,
  directPackageDirs,
  verifyPhase2Bundle,
} from '../src/phase2.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-phase2-'));
const run1 = path.join(temp, 'run1');
const run2 = path.join(temp, 'run2');
const candidateSha = 'f'.repeat(40);

function files(root) {
  const out = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else out.push(relative);
    }
  };
  walk(root);
  return out;
}

try {
  const first = buildPhase2Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    outDir: run1,
  });
  const second = buildPhase2Bundle({
    opsSource: repoRoot,
    opsCandidateSha: candidateSha,
    outDir: run2,
  });
  assert.equal(first.status, 'PASS');
  assert.equal(first.phaseClosed, false);
  assert.equal(first.authority, false);
  assert.equal(first.packageCount, directPackageDirs(repoRoot).length);
  assert.equal(first.unknownCount, 0);
  assert.equal(first.conflictCount, 0);
  assert.equal(first.packageCount * 11, first.fieldCount);
  assert.equal(first.sharedResponsibilityConflict, false);

  const firstFiles = files(run1);
  assert.deepEqual(firstFiles, files(run2));
  for (const relative of firstFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(run1, relative)),
      fs.readFileSync(path.join(run2, relative)),
      `non-deterministic output: ${relative}`,
    );
  }

  const claims = fs.readFileSync(path.join(run1, 'implementation-claims.jsonl'), 'utf8')
    .trim().split(/\n/u).map(JSON.parse);
  assert.equal(claims.some((row) => row.packageId === 'ops-package-contract-bridge'), true);
  assert.equal(claims.every((row) => row.sourceClass === 'implementation_claim'), true);
  assert.equal(claims.every((row) => row.position !== 'required'), true);

  fs.appendFileSync(path.join(run1, 'package-field-coverage.jsonl'), ' ');
  assert.throws(() => verifyPhase2Bundle(run1), /artifact digest mismatch/u);

  process.stdout.write(`${JSON.stringify({
    kind: 'ops.packageContractBridge.phase2UnitReceipt.v1',
    status: 'PASS',
    authority: false,
    packageCount: first.packageCount,
    fieldCount: first.fieldCount,
    destructiveSafe: first.destructiveSafe,
  })}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
