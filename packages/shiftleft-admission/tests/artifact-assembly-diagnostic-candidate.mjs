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
  canonicalJson,
  sha256File,
} from "../../artifact-assembly/src/index.mjs";
import {
  evaluateArtifactAssemblyCandidate,
  REQUIRED_DIAGNOSTIC_CODE,
} from "../adapters/artifact_assembly_candidate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliPath = path.join(repoRoot, "packages/artifact-assembly/bin/artifact-assembly.mjs");
const producerPath = path.join(repoRoot, "packages/artifact-assembly/src/assemble.mjs");
const previousObserverPath = path.join(repoRoot, "packages/shiftleft-admission/adapters/diagnostic_process.mjs");
const diagnosticContractPath = path.join(repoRoot, "packages/structured-diagnostic/contract.json");
const diagnosticContract = JSON.parse(fs.readFileSync(diagnosticContractPath, "utf8"));

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

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha = (file) => {
  const bytes = fs.readFileSync(file);
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
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

const writeLock = (root, sha256Value) => {
  const lock = {
    id: "module-a",
    kind: "npm-tgz",
    name: "@example/module",
    note: "ops#599 finite proof selected source",
    owner: "upstream",
    required: true,
    revision: "0123456789abcdef0123456789abcdef01234567",
    sha256: sha256Value,
    status: "locked",
    target: "modules/module-a/package",
    version: "1.2.3",
    export: ".",
    shim: "modules/module-a/index.mjs",
  };
  const lockPath = path.join(root, `lock-${sha256Value.slice(0, 8)}.jsonl`);
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
  let receiptStatus = null;
  if (receiptExists) receiptStatus = JSON.parse(fs.readFileSync(receiptPath, "utf8")).status ?? null;
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
    receiptExists,
    receiptStatus,
  };
};

const canonicalMeaning = canonicalJson(MEANING);
assert.equal(Buffer.byteLength(canonicalMeaning), 2331);
assert.equal(sha256(Buffer.from(canonicalMeaning, "utf8")), CANDIDATE.meaningSha256.slice("sha256:".length));
assert.equal(gitBlobSha(cliPath), CANDIDATE.target.cli.gitBlob);
assert.equal(gitBlobSha(producerPath), CANDIDATE.target.producer.gitBlob);
assert.equal(gitBlobSha(previousObserverPath), CANDIDATE.target.priorObserver.gitBlob);
assert.equal(gitBlobSha(diagnosticContractPath), CANDIDATE.target.diagnosticContract.gitBlob);
assert.match(REQUIRED_DIAGNOSTIC_CODE, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

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

  const failure = runAssembly({
    lockPath: writeLock(root, mismatchedLockSha256),
    outputDir: path.join(root, "failed-output"),
    receiptPath: path.join(root, "failed-receipt.json"),
    sourcePath,
  });
  const success = runAssembly({
    lockPath: writeLock(root, actualSourceSha256),
    outputDir: path.join(root, "success-output"),
    receiptPath: path.join(root, "success-receipt.json"),
    sourcePath,
  });

  const report = evaluateArtifactAssemblyCandidate({
    candidate: CANDIDATE,
    contract: diagnosticContract,
    failure,
    success,
    source: {
      id: "module-a",
      actualSha256: actualSourceSha256,
      lockSha256: mismatchedLockSha256,
      sentinel,
    },
  });

  assert.equal(failure.status, 1);
  assert.equal(failure.signal, null);
  assert.equal(failure.stdout, "");
  assert.equal(failure.receiptExists, false);
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal(success.receiptExists, true);
  assert.equal(success.receiptStatus, "PASS");
  assert.equal(report.finding.status, "unmet");
  assert.equal(report.finding.messageParsingUsed, false);
  assert.deepEqual(report.finding.unmet, ["diagnostic", "identification", "consumer_use", "traceability"]);
  assert.deepEqual(report.coverage, {
    applicable: 9,
    evaluated: 9,
    met: 5,
    unmet: 4,
    unknown: 0,
    conflict: 0,
    stale: 0,
  });
  assert.equal(report.obligations.abnormal_result.status, "met");
  assert.equal(report.obligations.separation.status, "met");
  assert.equal(report.obligations.confidentiality.status, "met");
  assert.equal(report.obligations.ownership.status, "met");
  assert.equal(report.obligations.compatibility.status, "met");
  assert.equal(report.obligations.diagnostic.status, "unmet");
  assert.equal(report.obligations.identification.status, "unmet");
  assert.equal(report.obligations.consumer_use.status, "unmet");
  assert.equal(report.obligations.traceability.status, "unmet");
  assert.equal(report.candidate.source.head, CANDIDATE.source.head);
  assert.equal(report.candidate.meaningSha256, CANDIDATE.meaningSha256);
  assert.equal(report.target.revision, CANDIDATE.target.revision);
  assert.equal(report.authority, false);
  assert.equal(report.admittedNormativeViolation, false);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
