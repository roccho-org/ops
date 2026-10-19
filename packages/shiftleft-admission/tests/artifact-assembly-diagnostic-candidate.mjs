#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  SOURCE_DIGEST_MISMATCH_DIAGNOSTIC_CODE,
  canonicalJson,
  sha256File,
} from "../../artifact-assembly/src/index.mjs";
import {
  evaluateArtifactAssemblyCandidate,
  REQUIRED_DIAGNOSTIC_CODE,
  consumeArtifactAssemblyStderr,
} from "../adapters/artifact_assembly_candidate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliPath = path.join(repoRoot, "packages/artifact-assembly/bin/artifact-assembly.mjs");
const producerPath = path.join(repoRoot, "packages/artifact-assembly/src/assemble.mjs");
const indexPath = path.join(repoRoot, "packages/artifact-assembly/src/index.mjs");
const consumerPath = path.join(repoRoot, "packages/shiftleft-admission/adapters/artifact_assembly_candidate.mjs");
const testPath = fileURLToPath(import.meta.url);
const previousObserverPath = path.join(repoRoot, "packages/shiftleft-admission/adapters/diagnostic_process.mjs");
const diagnosticContractPath = path.join(repoRoot, "packages/structured-diagnostic/contract.json");
const diagnosticContract = JSON.parse(fs.readFileSync(diagnosticContractPath, "utf8"));

const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

const MEANING = Object.freeze({
  subject: {
    obligation_id: "ops.artifact-assembly.source-integrity-diagnostic.v1",
    repository: "roccho-org/ops",
    package_path: "packages/artifact-assembly",
    boundary: "artifact-assembly assemble",
    applies_when: "A required npm-tgz source digest differs from the actual source archive bytes.",
  },
  purpose: "A downstream investigator can distinguish a real assembly source-integrity failure without parsing human message text and use that distinction to choose the next investigation or repair.",
  required: {
    abnormal_result: "Preserve nonzero exit and the existing meaning of the primary result; diagnostics do not turn a failed assembly into success.",
    separation: "Keep diagnostic output separate from primary stdout.",
    diagnostic: "For the selected digest-mismatch condition, produce at least one valid diagnostic/1 record.",
    identification: "A stable machine identity unambiguously denotes source-integrity/digest-mismatch. The concrete token and implementation are owned by W.",
    consumer_use: "An actual receiver uses that identity, without parsing message prose, to produce a typed failure classification or select a next investigation/repair action. Shape validation alone is insufficient.",
    traceability: "The consumed classification or action and its Observation/Receipt refer back to the actual diagnostic, selected source, execution and contract.",
    confidentiality: "Do not include raw source archive bytes, credentials or unnecessary input content in diagnostics.",
    ownership: "Diagnostic values do not own Host identity, ordering, time, lifecycle or final result and do not become Decision authority.",
    compatibility: "Preserve normal assembly primary results, receipt and exit semantics.",
  },
  evidence_profile: {
    grade: "source",
    operation: "artifact-assembly-assemble-npm-source-digest-mismatch",
    readback: true,
    required: "Real producer execution, raw output and actual downstream use; author summaries alone are insufficient.",
  },
  claim_ceiling: "One selected Ops assembly failure route and its causal proof. Full ops#599 cross-repository supply/consumption and contract-diff/Governance final-consumer integration remain open.",
  non_requirements: [
    "Automatic repair effects",
    "Durable storage",
    "Deployment or operational adoption",
    "All commands, languages or repositories",
    "A new schema, comparator or logger framework",
  ],
});

const CANDIDATE = Object.freeze({
  authority: false,
  admitted: false,
  source: {
    repository: "roccho-dev/adrs",
    head: "912be7a7451703b7fe861d7f245ef84b59006c07",
    tree: "96d288c761852fcf2585bb7a3de6326059920f5f",
    path: "decisions/logger-assembly-failure-diagnostic-contract-261019.jsonl",
    blob: "1afdf31a76bbe13e9d43d675efc179fa4e19baaa",
    rawId: "raw.adrs.logger_assembly_failure_diagnostic_contract.261019.01",
  },
  meaning: MEANING,
  meaningSha256: "sha256:90ae68ac0aa6f9482f3cdcf5c1b2762fe7817116d5efbf144716d0d5243628e0",
  target: {
    repository: "roccho-org/ops",
    revision: "bf471794a48f2f638dd02898f547cecddc6bda98",
    tree: "d2544994461fe50580716f695bcc85606e73ea96",
    cli: {
      path: "packages/artifact-assembly/bin/artifact-assembly.mjs",
      gitBlob: "a6633595db2c0ab5f439a80c5d996f30caedd8f5",
    },
    producer: {
      path: "packages/artifact-assembly/src/assemble.mjs",
      gitBlob: "bb2d9c71bc25a079d383d2fbfba9dd28ee13c34e",
    },
    priorObserver: {
      path: "packages/shiftleft-admission/adapters/diagnostic_process.mjs",
      gitBlob: "8ff0b48e481291e6250cdf926dd273d8e332835d",
    },
    diagnosticContract: {
      path: "packages/structured-diagnostic/contract.json",
      gitBlob: "1b3ced4216b9b5b9a767515a8288ad0ce5adb5a5",
    },
  },
});

const RETAINED_T0_FINDING = Object.freeze({
  authority: false,
  admittedNormativeViolation: false,
  candidateMeaningSha256: CANDIDATE.meaningSha256,
  targetRevision: CANDIDATE.target.revision,
  boundary: {
    repository: MEANING.subject.repository,
    packagePath: MEANING.subject.package_path,
    command: MEANING.subject.boundary,
    appliesWhen: MEANING.subject.applies_when,
  },
  applicable: 9,
  evidence: {
    rVerdict: "https://github.com/roccho-org/ops/issues/599#issuecomment-6262968418",
    pContinuation: "https://github.com/roccho-org/ops/issues/599#issuecomment-6263021767",
    run: "https://github.com/roccho-org/ops/actions/runs/39221274319",
    head: "1173dc430d304f728e89faae1b797ac3a209156b",
    tree: "5bab20409c221b73d7ab155fb58188b1f259d5d4",
    evaluatorBlob: "49fc09c38a3a3f5e275e6783f49bac4b9ff1ca89",
    testBlob: "8becb163ae066f3a1dbdbc25d92156497d7f354f",
  },
  execution: {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "artifact-assembly: lock module-a: npm tgz digest mismatch\n",
    passReceiptExists: false,
  },
  finding: {
    status: "unmet",
    code: "candidate-contract-unmet",
    unmet: ["diagnostic", "identification", "consumer_use", "traceability"],
    messageParsingUsed: false,
  },
  coverage: {
    applicable: 9,
    evaluated: 9,
    met: 5,
    unmet: 4,
    unknown: 0,
    conflict: 0,
    stale: 0,
  },
});

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const gitBlobSha = (file) => {
  const bytes = fs.readFileSync(file);
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
};

const fileIdentity = (file, repoPath) => {
  const bytes = fs.readFileSync(file);
  return {
    path: repoPath,
    gitBlob: gitBlobSha(file),
    sha256: sha256(bytes),
  };
};

const writeOctal = (header, offset, length, value) => {
  const body = value.toString(8).padStart(length - 1, "0");
  header.write(body, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
};

const tarHeader = ({ body = Buffer.alloc(0), name, type = "0" }) => {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
  return header;
};

const makeTgz = (filePath, entries) => {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "", "utf8");
    chunks.push(tarHeader({ ...entry, body }), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
};

const writeLock = (root, sha256Value, name) => {
  const lock = {
    id: "module-a",
    kind: "npm-tgz",
    name: "@example/module",
    note: "ops#599 finite proof selected source",
    owner: "upstream",
    required: true,
    revision: SOURCE_REVISION,
    sha256: sha256Value,
    status: "locked",
    target: "modules/module-a/package",
    version: "1.2.3",
    export: ".",
    shim: "modules/module-a/index.mjs",
  };
  const lockPath = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(lockPath, `${canonicalJson(lock)}\n`);
  return lockPath;
};

const runAssembly = ({ lockPath, outputDir, receiptPath, sourcePath }) => {
  const child = spawnSync(process.execPath, [
    cliPath,
    "assemble",
    "--lock", lockPath,
    "--output", outputDir,
    "--receipt", receiptPath,
    "--source", `module-a=${sourcePath}`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  const receiptExists = fs.existsSync(receiptPath);
  let receipt = null;
  let receiptStatus = null;
  let receiptSha256 = null;
  if (receiptExists) {
    const receiptText = fs.readFileSync(receiptPath, "utf8");
    receipt = JSON.parse(receiptText);
    receiptStatus = receipt.status ?? null;
    receiptSha256 = sha256(Buffer.from(receiptText, "utf8"));
  }
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
    receiptExists,
    receiptStatus,
    receiptSha256,
    receipt,
  };
};

const canonicalMeaning = canonicalJson(MEANING);
assert.equal(Buffer.byteLength(canonicalMeaning), 2331);
assert.equal(sha256(Buffer.from(canonicalMeaning, "utf8")), CANDIDATE.meaningSha256);
assert.equal(gitBlobSha(previousObserverPath), CANDIDATE.target.priorObserver.gitBlob);
assert.equal(gitBlobSha(diagnosticContractPath), CANDIDATE.target.diagnosticContract.gitBlob);
assert.notEqual(gitBlobSha(cliPath), CANDIDATE.target.cli.gitBlob);
assert.notEqual(gitBlobSha(producerPath), CANDIDATE.target.producer.gitBlob);
assert.equal(REQUIRED_DIAGNOSTIC_CODE, SOURCE_DIGEST_MISMATCH_DIAGNOSTIC_CODE);
assert.match(REQUIRED_DIAGNOSTIC_CODE, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

const implementation = {
  repository: "roccho-org/ops",
  cli: fileIdentity(cliPath, "packages/artifact-assembly/bin/artifact-assembly.mjs"),
  producer: fileIdentity(producerPath, "packages/artifact-assembly/src/assemble.mjs"),
  index: fileIdentity(indexPath, "packages/artifact-assembly/src/index.mjs"),
  consumer: fileIdentity(consumerPath, "packages/shiftleft-admission/adapters/artifact_assembly_candidate.mjs"),
  test: fileIdentity(testPath, "packages/shiftleft-admission/tests/artifact-assembly-diagnostic-candidate.mjs"),
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-599-artifact-diagnostic-"));
try {
  const sentinel = "source-bytes-sentinel-must-not-appear-in-diagnostics";
  const sourcePath = path.join(root, "module-a.tgz");
  const manifest = canonicalJson({
    exports: { ".": "./index.mjs" },
    name: "@example/module",
    type: "module",
    version: "1.2.3",
  });
  makeTgz(sourcePath, [
    { name: "package/", type: "5" },
    { body: `${manifest}\n`, name: "package/package.json" },
    { body: `export const marker = ${JSON.stringify(sentinel)};\n`, name: "package/index.mjs" },
  ]);
  const actualSourceSha256 = sha256File(sourcePath);
  const mismatchedLockSha256 = "0".repeat(64);
  assert.notEqual(actualSourceSha256, mismatchedLockSha256);

  const source = {
    id: "module-a",
    kind: "npm-tgz",
    revision: SOURCE_REVISION,
    actualSha256: actualSourceSha256,
    lockSha256: mismatchedLockSha256,
    sentinel,
  };

  const failure = runAssembly({
    lockPath: writeLock(root, mismatchedLockSha256, "lock-mismatch"),
    outputDir: path.join(root, "failed-output"),
    receiptPath: path.join(root, "failed-receipt.json"),
    sourcePath,
  });
  const success = runAssembly({
    lockPath: writeLock(root, actualSourceSha256, "lock-success"),
    outputDir: path.join(root, "success-output"),
    receiptPath: path.join(root, "success-receipt.json"),
    sourcePath,
  });

  const report = evaluateArtifactAssemblyCandidate({
    candidate: CANDIDATE,
    contract: diagnosticContract,
    failure,
    implementation,
    source,
    success,
  });

  assert.equal(failure.status, 1);
  assert.equal(failure.signal, null);
  assert.equal(failure.stdout, "");
  assert.equal(failure.receiptExists, false);
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal(success.stderr, "");
  assert.equal(success.receiptExists, true);
  assert.equal(success.receiptStatus, "PASS");
  assert.equal(report.finding.status, "met");
  assert.equal(report.finding.messageParsingUsed, false);
  assert.deepEqual(report.finding.unmet, []);
  assert.deepEqual(report.coverage, {
    applicable: 9,
    evaluated: 9,
    met: 9,
    unmet: 0,
    unknown: 0,
    conflict: 0,
    stale: 0,
  });
  for (const [name, result] of Object.entries(report.obligations)) {
    assert.equal(result.status, "met", `${name}: ${result.detail}`);
  }
  assert.equal(report.execution.invalidDiagnosticRows.length, 0);
  assert.equal(report.execution.hostOwnedFieldClaims.length, 0);
  assert.equal(report.execution.diagnosticRows.length, 1);
  assert.equal(report.execution.diagnosticRows[0].value.code, REQUIRED_DIAGNOSTIC_CODE);
  assert.equal(report.execution.diagnosticRows[0].value.fields.source_id, source.id);
  assert.equal(report.execution.diagnosticRows[0].value.fields.source_revision, source.revision);
  assert.equal(report.execution.diagnosticRows[0].value.fields.expected_sha256, source.lockSha256);
  assert.equal(report.execution.diagnosticRows[0].value.fields.actual_sha256, source.actualSha256);
  assert.equal(report.classification.type, "artifact-source-integrity/digest-mismatch");
  assert.equal(report.classification.nextAction, "inspect-selected-source-or-lock");
  assert.equal(report.classification.messageParsingUsed, false);
  assert.equal(report.classification.binding.contractMeaningSha256, CANDIDATE.meaningSha256);
  assert.equal(report.candidate.source.head, CANDIDATE.source.head);
  assert.equal(report.candidate.meaningSha256, CANDIDATE.meaningSha256);
  assert.equal(report.target.revision, CANDIDATE.target.revision);
  assert.equal(report.authority, false);
  assert.equal(report.admittedNormativeViolation, false);

  const successConsumption = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: success.stderr,
  });
  assert.equal(successConsumption.accepted, null);
  assert.equal(successConsumption.diagnostics.length, 0);

  const missingSource = runAssembly({
    lockPath: writeLock(root, actualSourceSha256, "lock-missing-source"),
    outputDir: path.join(root, "missing-source-output"),
    receiptPath: path.join(root, "missing-source-receipt.json"),
    sourcePath: path.join(root, "does-not-exist.tgz"),
  });
  const missingSourceConsumption = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: missingSource.stderr,
  });
  assert.equal(missingSource.status, 1);
  assert.equal(missingSourceConsumption.accepted, null);
  assert.equal(missingSourceConsumption.diagnostics.length, 0);
  assert.equal(missingSourceConsumption.invalid.length, 1);

  const similarProse = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: "artifact-assembly: lock module-a: npm tgz digest mismatch\n",
  });
  assert.equal(similarProse.accepted, null);
  assert.equal(similarProse.diagnostics.length, 0);
  assert.equal(similarProse.invalid.length, 1);

  const expectedFields = {
    actual_sha256: source.actualSha256,
    expected_sha256: source.lockSha256,
    source_id: source.id,
    source_kind: source.kind,
    source_revision: source.revision,
  };
  const differentCode = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: `${JSON.stringify({
      schema: "diagnostic/1",
      code: "artifact-assembly.package-export-invalid",
      level: "error",
      message: "lock module-a: npm tgz digest mismatch",
      fields: expectedFields,
    })}\n`,
  });
  assert.equal(differentCode.accepted, null);
  assert.equal(differentCode.diagnostics.length, 1);
  assert.equal(differentCode.consumptions[0].result.reason, "diagnostic-code");

  const actualDiagnostic = report.execution.diagnosticRows[0].value;
  const wrongSource = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: `${JSON.stringify({
      ...actualDiagnostic,
      fields: { ...actualDiagnostic.fields, source_id: "module-b" },
    })}\n`,
  });
  assert.equal(wrongSource.accepted, null);
  assert.equal(wrongSource.consumptions[0].result.reason, "source-binding");
  assert.deepEqual(wrongSource.consumptions[0].result.differences.map(({ field }) => field), ["source_id"]);

  const wrongRevision = consumeArtifactAssemblyStderr({
    contract: diagnosticContract,
    contractMeaningSha256: CANDIDATE.meaningSha256,
    source,
    stderr: `${JSON.stringify({
      ...actualDiagnostic,
      fields: { ...actualDiagnostic.fields, source_revision: "f".repeat(40) },
    })}\n`,
  });
  assert.equal(wrongRevision.accepted, null);
  assert.equal(wrongRevision.consumptions[0].result.reason, "source-binding");
  assert.deepEqual(wrongRevision.consumptions[0].result.differences.map(({ field }) => field), ["source_revision"]);

  assert.equal(RETAINED_T0_FINDING.candidateMeaningSha256, report.candidate.meaningSha256);
  assert.equal(RETAINED_T0_FINDING.targetRevision, report.target.revision);
  assert.equal(RETAINED_T0_FINDING.applicable, report.coverage.applicable);
  const closed = RETAINED_T0_FINDING.finding.unmet.filter((name) => report.obligations[name].status === "met");
  const residual = Object.entries(report.obligations)
    .filter(([, value]) => value.status !== "met")
    .map(([name]) => name);
  assert.deepEqual(closed, RETAINED_T0_FINDING.finding.unmet);
  assert.deepEqual(residual, []);

  const counterexamples = {
    normalSuccess: {
      exitCode: success.status,
      diagnostics: successConsumption.diagnostics.length,
      classified: successConsumption.accepted !== null,
    },
    otherNonzero: {
      exitCode: missingSource.status,
      diagnostics: missingSourceConsumption.diagnostics.length,
      invalidRows: missingSourceConsumption.invalid.length,
      classified: missingSourceConsumption.accepted !== null,
    },
    similarProse: {
      diagnostics: similarProse.diagnostics.length,
      invalidRows: similarProse.invalid.length,
      classified: similarProse.accepted !== null,
    },
    differentCode: {
      diagnostics: differentCode.diagnostics.length,
      rejection: differentCode.consumptions[0].result.reason,
      classified: differentCode.accepted !== null,
    },
    wrongSource: {
      rejection: wrongSource.consumptions[0].result.reason,
      differences: wrongSource.consumptions[0].result.differences,
      classified: wrongSource.accepted !== null,
    },
    wrongRevision: {
      rejection: wrongRevision.consumptions[0].result.reason,
      differences: wrongRevision.consumptions[0].result.differences,
      classified: wrongRevision.accepted !== null,
    },
  };
  assert.equal(Object.values(counterexamples).some(({ classified }) => classified), false);

  const comparisonFrame = {
    sameMeaning: RETAINED_T0_FINDING.candidateMeaningSha256 === report.candidate.meaningSha256,
    sameTargetBaseline: RETAINED_T0_FINDING.targetRevision === report.target.revision,
    sameBoundary: JSON.stringify(RETAINED_T0_FINDING.boundary) === JSON.stringify({
      repository: MEANING.subject.repository,
      packagePath: MEANING.subject.package_path,
      command: MEANING.subject.boundary,
      appliesWhen: MEANING.subject.applies_when,
    }),
    sameApplicable: RETAINED_T0_FINDING.applicable === report.coverage.applicable,
  };
  assert.equal(Object.values(comparisonFrame).every(Boolean), true);
  const comparisonClosed = Object.values(comparisonFrame).every(Boolean)
    && closed.length === RETAINED_T0_FINDING.finding.unmet.length
    && residual.length === 0;

  const proof = {
    kind: "ops.logger-finite-proof.old-new-comparison",
    authority: false,
    admittedNormativeViolation: false,
    design: {
      messageParsingUsed: false,
      decisions: [
        {
          fromUnmet: "diagnostic",
          decision: "emit one valid diagnostic/1 row on stderr from the real npm-tgz digest-mismatch boundary",
        },
        {
          fromUnmet: "identification",
          decision: `use stable machine identity ${REQUIRED_DIAGNOSTIC_CODE}`,
        },
        {
          fromUnmet: "consumer_use",
          decision: "receiver maps code and machine fields to a typed classification and next investigation action",
        },
        {
          fromUnmet: "traceability",
          decision: "diagnostic fields and the observation bind Contract meaning, source id/kind/revision, expected/actual digest, execution, classification, and receipt control",
        },
      ],
    },
    old: RETAINED_T0_FINDING,
    new: report,
    comparison: {
      ...comparisonFrame,
      closed,
      residual,
      status: comparisonClosed ? "closed" : "open",
    },
    counterexamples,
    claimCeiling: "One selected Ops assembly failure route. No formal Contract adoption, normative Gate, merge, Release, deploy, cross-repository closure, or business effect is claimed.",
  };
  process.stdout.write(`${JSON.stringify(proof)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
