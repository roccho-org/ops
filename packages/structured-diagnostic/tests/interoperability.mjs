#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DiagnosticContractError,
  diagnosticContract,
  encodeDiagnostic,
  parseDiagnosticLine,
} from "../adapters/node.mjs";
import { createBrowserDiagnosticPort } from "../adapters/browser.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(packageRoot, "contract.json");
const corpusPath = path.join(packageRoot, "fixtures", "interchange.json");
const pythonTest = path.join(packageRoot, "tests", "interoperability.py");
const python = process.env.PYTHON ?? "python3";
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
assert.equal(corpus.schema, "diagnostic-interchange-corpus/2");
assert.equal(diagnosticContract.messageBlankRule, "ecmascript-trim");

const sha256File = (file) => `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;

function baseValue() {
  return {
    schema: "diagnostic/1",
    code: "boundary.case",
    level: "info",
    message: "x",
  };
}

function rawJsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function encodedBoundaryValue(target) {
  const value = { ...baseValue(), fields: {} };
  let index = 0;
  while (true) {
    const current = Buffer.byteLength(rawJsonLine(value), "utf8");
    if (current === target) return value;
    assert.ok(current < target && index < 32, `cannot construct encoded boundary ${target}: ${current}`);
    const key = `f${String(index).padStart(2, "0")}`;
    value.fields[key] = "";
    const empty = Buffer.byteLength(rawJsonLine(value), "utf8");
    const room = target - empty;
    assert.ok(room >= 0, `encoded boundary overrun ${target}: ${empty}`);
    value.fields[key] = "x".repeat(Math.min(8192, room));
    index += 1;
  }
}

function generatedValue(test) {
  let value = baseValue();
  switch (test.kind) {
    case "message":
      value.message = test.value;
      break;
    case "code-bytes":
      value.code = "a".repeat(test.size);
      assert.equal(Buffer.byteLength(value.code, "utf8"), test.size);
      break;
    case "message-bytes":
      value.message = "x".repeat(test.size);
      assert.equal(Buffer.byteLength(value.message, "utf8"), test.size);
      break;
    case "field-count":
      value.fields = Object.fromEntries(Array.from({ length: test.size }, (_, index) => [`f${String(index).padStart(2, "0")}`, index]));
      assert.equal(Object.keys(value.fields).length, test.size);
      break;
    case "field-name-bytes": {
      const key = "a".repeat(test.size);
      assert.equal(Buffer.byteLength(key, "utf8"), test.size);
      value.fields = { [key]: "x" };
      break;
    }
    case "field-string-bytes": {
      const field = "x".repeat(test.size);
      assert.equal(Buffer.byteLength(field, "utf8"), test.size);
      value.fields = { value: field };
      break;
    }
    case "encoded-bytes":
      value = encodedBoundaryValue(test.size);
      assert.equal(Buffer.byteLength(rawJsonLine(value), "utf8"), test.size);
      break;
    case "nonfinite-number":
      value.fields = { value: Number.POSITIVE_INFINITY };
      break;
    case "malformed-message":
      value.message = String.fromCharCode(0xd800);
      break;
    default:
      assert.fail(`unknown generated case kind: ${test.kind}`);
  }
  return value;
}

const literalValid = corpus.valid.map((test) => {
  const canonical = encodeDiagnostic(parseDiagnosticLine(test.line));
  assert.equal(canonical, test.canonical, test.id);
  return { id: test.id, canonical };
});
const literalInvalid = corpus.invalid.map((test) => {
  assert.throws(
    () => parseDiagnosticLine(test.line),
    (error) => {
      assert.ok(error instanceof DiagnosticContractError);
      assert.equal(error.code, test.error, test.id);
      return true;
    },
  );
  return { id: test.id, error: test.error };
});
const generated = corpus.generated.map((test) => {
  try {
    const canonical = encodeDiagnostic(generatedValue(test));
    assert.equal(test.accept, true, test.id);
    return { id: test.id, result: "accepted", canonical };
  } catch (error) {
    assert.ok(error instanceof DiagnosticContractError, test.id);
    assert.equal(test.accept, false, test.id);
    assert.equal(error.code, test.error, test.id);
    return { id: test.id, result: "rejected", error: error.code };
  }
});

const browserWrites = [];
const browserPort = createBrowserDiagnosticPort({
  contract: diagnosticContract,
  write(line) {
    browserWrites.push(line);
  },
});
assert.equal(browserPort.emit(parseDiagnosticLine(corpus.valid[0].line)), corpus.valid[0].canonical);
assert.deepEqual(browserWrites, [corpus.valid[0].canonical]);
assert.throws(
  () => browserPort.emit({ schema: "diagnostic/1", code: "bad code", level: "error", message: "x" }),
  (error) => error instanceof DiagnosticContractError && error.code === "DIAGNOSTIC_CODE_INVALID",
);
assert.equal(browserWrites.length, 1, "invalid diagnostic must not partially reach the browser transport");
const transportError = new Error("fixture transport rejected");
const rejectingPort = createBrowserDiagnosticPort({
  contract: diagnosticContract,
  write() {
    throw transportError;
  },
});
assert.throws(() => rejectingPort.emit(parseDiagnosticLine(corpus.valid[0].line)), transportError);

const jsReport = {
  schema: "diagnostic-interchange-report/2",
  literalValid,
  literalInvalid,
  generated,
};

const pythonReportRun = spawnSync(python, [pythonTest, corpusPath], {
  cwd: packageRoot,
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
  env: {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  },
});
assert.equal(pythonReportRun.error, undefined, pythonReportRun.error?.message);
assert.equal(pythonReportRun.status, 0, pythonReportRun.stderr);
const pythonReport = JSON.parse(pythonReportRun.stdout);
assert.deepEqual(pythonReport, jsReport);

const jsProduced = [...literalValid.map(({ canonical }) => canonical), ...generated.filter((row) => row.result === "accepted").map(({ canonical }) => canonical)].join("");
const pythonConsumerRun = spawnSync(python, [pythonTest, "--canonicalize-stdin"], {
  cwd: packageRoot,
  input: jsProduced,
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
  env: {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  },
});
assert.equal(pythonConsumerRun.error, undefined, pythonConsumerRun.error?.message);
assert.equal(pythonConsumerRun.status, 0, pythonConsumerRun.stderr);
assert.equal(pythonConsumerRun.stdout, jsProduced, "JavaScript -> Python interchange drifted");

for (const row of pythonReport.literalValid.concat(
  pythonReport.generated.filter((entry) => entry.result === "accepted"),
)) {
  assert.equal(encodeDiagnostic(parseDiagnosticLine(row.canonical)), row.canonical, `Python -> JavaScript drifted: ${row.id}`);
}

const accepted = literalValid.length + generated.filter((row) => row.result === "accepted").length;
const rejected = literalInvalid.length + generated.filter((row) => row.result === "rejected").length;
const report = {
  schema: "diagnostic-interchange-proof/1",
  status: "PASS",
  authority: false,
  contractSha256: sha256File(contractPath),
  corpusSha256: sha256File(corpusPath),
  implementation: {
    javascript: "packages/structured-diagnostic/lib/diagnostic.mjs",
    python: "packages/structured-diagnostic/lib/diagnostic.py",
    pythonDelegatesToNode: false,
  },
  counts: {
    accepted,
    rejected,
    literalValid: literalValid.length,
    literalInvalid: literalInvalid.length,
    generated: generated.length,
  },
  semantics: {
    feffOnly: "rejected",
    nelOnly: "accepted",
    fixedLimits: "limit-1/limit/limit+1",
    numberThresholds: "ECMAScript JSON number canonicalization",
  },
  interchange: {
    javascriptToPython: "byte-identical",
    pythonToJavascript: "byte-identical",
    rows: accepted,
  },
  browser: {
    callbackWrites: browserWrites.length,
    invalidPartialWrites: 0,
    transportRejectionPropagated: true,
  },
  cases: jsReport,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
