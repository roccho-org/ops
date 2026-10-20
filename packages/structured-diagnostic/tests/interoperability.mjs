#!/usr/bin/env node
import assert from "node:assert/strict";
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
const corpusPath = path.join(packageRoot, "fixtures", "interchange.json");
const pythonTest = path.join(packageRoot, "tests", "interoperability.py");
const python = process.env.PYTHON ?? "python3";
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
assert.equal(corpus.schema, "diagnostic-interchange-corpus/1");

const valid = corpus.valid.map((test) => {
  const canonical = encodeDiagnostic(parseDiagnosticLine(test.line));
  assert.equal(canonical, test.canonical, test.id);
  return { id: test.id, canonical };
});
const invalid = corpus.invalid.map((test) => {
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
  schema: "diagnostic-interchange-report/1",
  valid,
  invalid,
};

const pythonReportRun = spawnSync(python, [pythonTest, corpusPath], {
  cwd: packageRoot,
  encoding: "utf8",
  timeout: 30_000,
  env: {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  },
});
assert.equal(pythonReportRun.error, undefined, pythonReportRun.error?.message);
assert.equal(pythonReportRun.status, 0, pythonReportRun.stderr);
assert.deepEqual(JSON.parse(pythonReportRun.stdout), jsReport);

const jsProduced = valid.map(({ canonical }) => canonical).join("");
const pythonConsumerRun = spawnSync(python, [pythonTest, "--canonicalize-stdin"], {
  cwd: packageRoot,
  input: jsProduced,
  encoding: "utf8",
  timeout: 30_000,
  env: {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  },
});
assert.equal(pythonConsumerRun.error, undefined, pythonConsumerRun.error?.message);
assert.equal(pythonConsumerRun.status, 0, pythonConsumerRun.stderr);
assert.equal(pythonConsumerRun.stdout, jsProduced, "JavaScript -> Python interchange drifted");

for (const { id, canonical } of JSON.parse(pythonReportRun.stdout).valid) {
  assert.equal(encodeDiagnostic(parseDiagnosticLine(canonical)), canonical, `Python -> JavaScript drifted: ${id}`);
}

process.stdout.write(
  `structured-diagnostic interoperability: PASS ${valid.length} valid, ${invalid.length} invalid, JS<->Python\n`,
);
