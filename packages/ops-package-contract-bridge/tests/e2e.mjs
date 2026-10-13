import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256File, stableJson, verifyPhase1Bundle } from '../src/verify.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-bridge-'));
try {
  fs.writeFileSync(path.join(dir, 'artifact.json'), '{"ok":true}\n');
  const digest = sha256File(path.join(dir, 'artifact.json'));
  const receipt = {
    kind: 'ops.packageContractBridge.phase1Receipt.v1',
    status: 'PASS',
    authority: false,
    claimCeiling: 'BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION',
    designVersion: 'CONTRACT_W_632_CLOSURE_DESIGN_V3',
    phase: 1,
    phaseClosed: false,
    source: { opsCandidateSha: 'a'.repeat(40), governanceRevision: 'b'.repeat(40), governanceTreeDigest: 'c'.repeat(64) },
    acceptedDecision: { decisionDigest: 'd'.repeat(64) },
    compiler: { sourceDigest: 'e'.repeat(64) },
    append: { l0ToL1: 'PASS', l1ToL2: 'PASS' },
    supersession: { beforeDecision: 'add_semantic_term', afterDecision: 'extend_existing', beforeCurrentDigest: '1'.repeat(64), afterCurrentDigest: '2'.repeat(64) },
    candidateIsolation: { acceptedCurrentDigest: '2'.repeat(64), candidateCurrentDigest: '3'.repeat(64), candidateAdmitted: false, acceptedCurrentUnchanged: true },
    destructive: { rejected: 4, total: 4 },
    commonCode: { changed: false },
    artifacts: [{ path: 'artifact.json', sha256: digest }],
    semantic: { nonEmpty: true, replayEqual: true },
  };
  fs.writeFileSync(path.join(dir, 'phase1-receipt.json'), `${stableJson(receipt)}\n`);
  const verified = verifyPhase1Bundle(dir);
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.artifactCount, 1);

  fs.writeFileSync(path.join(dir, 'artifact.json'), '{"ok":false}\n');
  assert.throws(() => verifyPhase1Bundle(dir), /artifact digest mismatch/u);
  process.stdout.write(`${stableJson({ kind: 'ops.packageContractBridge.unitReceipt.v1', status: 'PASS', authority: false })}\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
