import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildExpectedSelection,
  sha256File,
  stableJson,
  verifyPhase1Bundle,
} from '../src/verify.mjs';

const CEILING = 'BOUNDED_COMPILER_PROOF_NOT_ORGANIZATION_ADMISSION';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-package-contract-bridge-'));
const write = (name, value) => fs.writeFileSync(path.join(dir, name), `${stableJson(value)}\n`);
const packet = (label, ledger, ledgerSha256, decision, currentDigest, semanticDigest) => ({
  kind: 'ops.packageContractBridge.compilerPacket.v2',
  label,
  authority: false,
  claimCeiling: CEILING,
  input: { ledger, ledgerSha256 },
  semanticDigest,
  currentDigest,
  replayDigest: currentDigest,
  replayEqual: true,
  currentState: [{ subject_key: 'request:02-semantic', decision }],
  decisionCount: 1,
  promotionCount: 1,
});

try {
  const selector = {
    kind: 'governance.packageContractPhase1Selector.v1',
    selectorId: 'adrs-632-phase1-v2',
    authority: false,
    claimCeiling: 'BOUNDED_PHASE1_SELECTION_NOT_ORGANIZATION_ADMISSION',
    designVersion: 'CONTRACT_W_632_CLOSURE_DESIGN_V3',
    source: { rAcceptance: 'r', pBoundary: 'p' },
    acceptedDecision: {
      decisionId: 'decision',
      decisionDigest: 'd'.repeat(64),
      acceptedMerge: 'm'.repeat(40),
      source: 'adrs',
      release: 'release',
      status: 'accepted',
    },
    governanceSource: {
      repository: 'roccho-dev/governance',
      revision: 'g'.repeat(40),
      treeSha: 't'.repeat(40),
    },
    selection: {
      subjectKey: 'request:02-semantic',
      before: { ledger: 'L0', rowId: 'request:02-semantic' },
      accepted: { ledger: 'L1', rowId: 'request:02-semantic:v2', supersedes: 'request:02-semantic' },
      candidate: { ledger: 'L2', rowId: 'request:02-semantic:v3', supersedes: 'request:02-semantic:v2' },
    },
  };
  write('phase1-selector.json', selector);
  fs.writeFileSync(path.join(dir, 'L0.jsonl'), '{"id":"request:02-semantic"}\n');
  fs.writeFileSync(path.join(dir, 'L1.jsonl'), '{"id":"request:02-semantic"}\n{"id":"request:02-semantic:v2"}\n');
  fs.writeFileSync(path.join(dir, 'L2.jsonl'), '{"id":"request:02-semantic"}\n{"id":"request:02-semantic:v2"}\n{"id":"request:02-semantic:v3"}\n');
  write('append-l0-l1.json', { status: 'pass' });
  write('append-l1-l2.json', { status: 'pass' });

  const inputs = {
    kind: 'ops.packageContractBridge.phase1Inputs.v2',
    claimCeiling: CEILING,
    selector: { path: 'phase1-selector.json', sha256: sha256File(path.join(dir, 'phase1-selector.json')), selectorId: selector.selectorId },
    manifests: Object.fromEntries(['L0', 'L1', 'L2'].map((label) => [label, {
      ledger: `${label}.jsonl`,
      ledgerSha256: sha256File(path.join(dir, `${label}.jsonl`)),
    }])),
  };
  write('input-manifests.json', inputs);

  const packets = {
    AC0: packet('AC0', 'L0.jsonl', inputs.manifests.L0.ledgerSha256, 'before', '1'.repeat(64), 'a'.repeat(64)),
    AC1: packet('AC1', 'L1.jsonl', inputs.manifests.L1.ledgerSha256, 'accepted', '2'.repeat(64), 'b'.repeat(64)),
    BC1: packet('BC1', 'L2.jsonl', inputs.manifests.L2.ledgerSha256, 'candidate', '3'.repeat(64), 'c'.repeat(64)),
  };
  for (const [label, value] of Object.entries(packets)) write(`${label}.compiler-packet.json`, value);

  const packetInfo = Object.fromEntries(Object.keys(packets).map((label) => [label, {
    relative: `${label}.compiler-packet.json`,
    packet: packets[label],
    sha256: sha256File(path.join(dir, `${label}.compiler-packet.json`)),
  }]));
  const selection = buildExpectedSelection(dir, selector, inputs, packetInfo);
  write('accepted-current-selection.json', selection);

  const compilerResults = ['missing-parent', 'cross-subject', 'cycle', 'duplicate-active']
    .map((caseName) => ({ case: caseName, status: 'REJECTED', error: 'rejected' }));
  const selectorResults = ['missing', 'tamper', 'wrong-digest', 'self-admission']
    .map((caseName) => ({ case: caseName, status: 'REJECTED', error: 'rejected' }));
  write('destructive-results.json', { kind: 'ops.packageContractBridge.phase1CompilerDestructive.v2', results: compilerResults });
  write('selector-destructive-results.json', { kind: 'ops.packageContractBridge.phase1SelectorDestructive.v2', results: selectorResults });
  write('source-identities.json', {
    kind: 'ops.packageContractBridge.sourceIdentities.v2',
    ops: { candidateSha: 'o'.repeat(40), selectedFiles: [{ path: 'selector', gitBlobSha: 'x'.repeat(40), sha256: '9'.repeat(64) }] },
    governance: {
      repository: selector.governanceSource.repository,
      revision: selector.governanceSource.revision,
      treeSha: selector.governanceSource.treeSha,
      selectedFileSetSha256: 'f'.repeat(64),
      selectedFiles: [{ path: 'engine', gitBlobSha: 'y'.repeat(40), sha256: '8'.repeat(64) }],
    },
  });

  const names = [
    'phase1-selector.json', 'L0.jsonl', 'L1.jsonl', 'L2.jsonl', 'append-l0-l1.json', 'append-l1-l2.json',
    'AC0.compiler-packet.json', 'AC1.compiler-packet.json', 'BC1.compiler-packet.json',
    'destructive-results.json', 'selector-destructive-results.json', 'source-identities.json',
    'input-manifests.json', 'accepted-current-selection.json',
  ];
  const artifacts = names.map((name) => ({ path: name, sha256: sha256File(path.join(dir, name)) }));
  const receipt = {
    kind: 'ops.packageContractBridge.phase1Receipt.v2',
    status: 'PASS',
    authority: false,
    claimCeiling: CEILING,
    designVersion: 'CONTRACT_W_632_CLOSURE_DESIGN_V3',
    phase: 1,
    phaseClosed: false,
    source: {
      opsCandidateSha: 'o'.repeat(40),
      governanceRepository: selector.governanceSource.repository,
      governanceRevision: selector.governanceSource.revision,
      governanceTreeSha: selector.governanceSource.treeSha,
      governanceSelectedFileSetSha256: 'f'.repeat(64),
    },
    acceptedDecision: selector.acceptedDecision,
    selector: {
      selectorId: selector.selectorId,
      sourcePath: 'governance/contract-632-phase1-selector.v1.json',
      bundlePath: 'phase1-selector.json',
      sha256: sha256File(path.join(dir, 'phase1-selector.json')),
      authority: false,
      claimCeiling: selector.claimCeiling,
    },
    compiler: { version: 'compiler.v1', selectedFileSetSha256: 'f'.repeat(64) },
    append: { l0ToL1: 'PASS', l1ToL2: 'PASS' },
    supersession: {
      subjectKey: selector.selection.subjectKey,
      beforeRowId: selector.selection.before.rowId,
      afterRowId: selector.selection.accepted.rowId,
      beforeDecision: 'before',
      afterDecision: 'accepted',
      beforeCurrentDigest: '1'.repeat(64),
      afterCurrentDigest: '2'.repeat(64),
    },
    selection: {
      path: 'accepted-current-selection.json',
      sha256: sha256File(path.join(dir, 'accepted-current-selection.json')),
      acceptedCurrentDigest: '2'.repeat(64),
      candidateCurrentDigest: '3'.repeat(64),
    },
    destructive: {
      compiler: { total: compilerResults.length, rejected: compilerResults.length },
      selector: { total: selectorResults.length, rejected: selectorResults.length },
    },
    commonCode: { changed: false, verifiedSourceCount: 2 },
    artifacts,
    semantic: {
      nonEmpty: true,
      replayEqual: true,
      ac0SemanticDigest: 'a'.repeat(64),
      ac1SemanticDigest: 'b'.repeat(64),
      bc1SemanticDigest: 'c'.repeat(64),
    },
  };
  write('phase1-receipt.json', receipt);

  const verified = verifyPhase1Bundle(dir);
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.acceptedCurrentDigest, '2'.repeat(64));
  assert.equal(verified.candidateCurrentDigest, '3'.repeat(64));

  const changed = JSON.parse(fs.readFileSync(path.join(dir, 'accepted-current-selection.json'), 'utf8'));
  changed.acceptedCurrentAfterCandidate.currentDigest = '3'.repeat(64);
  write('accepted-current-selection.json', changed);
  assert.throws(() => verifyPhase1Bundle(dir), /artifact digest mismatch|selection is not derivable/u);

  process.stdout.write(`${stableJson({ kind: 'ops.packageContractBridge.unitReceipt.v2', status: 'PASS', authority: false })}\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
