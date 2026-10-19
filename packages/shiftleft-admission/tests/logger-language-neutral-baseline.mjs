#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const CANDIDATE = Object.freeze({
  authority: false,
  admitted: false,
  source: {
    repository: "roccho-dev/adrs",
    head: "0cf15457aeb9a53dc4ff202539c5e08ae5f4ef95",
    tree: "6d8cf131b79f2ebe0619023d700cb144ca3e4dce",
    path: "decisions/logger-language-neutral-design-contract-261019.jsonl",
    blob: "1a440a8af43913018d8506cc0ba964ce99499f83",
    rawId: "raw.adrs.logger_language_neutral_design_contract.261019.01",
  },
  meaningSha256: "sha256:77763ee7a3a649c8baa3b96f73e851cb3bccd0a941c8dc6ad0b1742c6489752f",
  obligationId: "ops.logger-language-neutral-design.v1",
});

const BASELINE = Object.freeze({
  repository: "roccho-org/ops",
  revision: "d1ed2594aa6112f931ff3996c89d8fde8aed8690",
  tree: "27c40aee9b923129e0feefa8477da711155c8384",
  files: {
    contract: {
      path: "packages/structured-diagnostic/contract.json",
      gitBlob: "1b3ced4216b9b5b9a767515a8288ad0ce5adb5a5",
    },
    core: {
      path: "packages/structured-diagnostic/lib/diagnostic.mjs",
      gitBlob: "c4c9c1f2c301418ac4d5953ac35001a4e51032f2",
    },
    nodeAdapter: {
      path: "packages/structured-diagnostic/adapters/node.mjs",
      gitBlob: "99ebc19000b7ac248559fc0eb2558a1b97e7956f",
    },
    readme: {
      path: "packages/structured-diagnostic/README.md",
      gitBlob: "54ced105039d314477239d1e4a956538d4d6aa47",
    },
    artifactProducer: {
      path: "packages/artifact-assembly/src/assemble.mjs",
      gitBlob: "63ad8636b16f857a8e0bf8184ad7a9d1507295e0",
    },
    artifactCli: {
      path: "packages/artifact-assembly/bin/artifact-assembly.mjs",
      gitBlob: "8de69fc1f261902152c7a0e68a3c9df57f7176d9",
    },
    artifactConsumer: {
      path: "packages/shiftleft-admission/adapters/artifact_assembly_candidate.mjs",
      gitBlob: "d9dbdc4d75798aae8c10d1f6ee6f1becaebcd2cd",
    },
    artifactProof: {
      path: "packages/shiftleft-admission/tests/artifact-assembly-diagnostic-candidate.mjs",
      gitBlob: "0e04a8b3fd7a23f2c9d275a8749639ec55c8c009",
    },
  },
  priorWholeCi: "https://github.com/roccho-org/ops/actions/runs/39240281947",
});

const REQUIRED = Object.freeze([
  "purpose_scope_coverage",
  "shared_meaning",
  "cross_language_interoperability",
  "pure_application_boundary",
  "environment_transport",
  "host_context_ownership",
  "supply_consumption_binding",
  "actual_data_use",
  "traceable_evidence",
  "bounded_safe_failure",
  "compatibility",
  "causal_design_closure",
  "small_extensible_design",
]);

const PURPOSE_COVERAGE = Object.freeze({
  "迷わず診断を作る": ["shared_meaning", "pure_application_boundary", "small_extensible_design"],
  "言語・環境を変えても意味が同じ": [
    "purpose_scope_coverage",
    "shared_meaning",
    "cross_language_interoperability",
    "environment_transport",
  ],
  "出所・実行・版を追い、実際に使う": [
    "host_context_ownership",
    "supply_consumption_binding",
    "actual_data_use",
    "traceable_evidence",
  ],
  "失敗・欠落を成功扱いしない": ["bounded_safe_failure", "compatibility"],
  "Contractの未達検出が設計を導き完成する": ["causal_design_closure", "purpose_scope_coverage"],
});

const FEATURE_CONSUMERS = Object.freeze([
  "packages/shiftleft-admission/fixtures/diagnostic/good/program.mjs",
  "packages/shiftleft-admission/fixtures/diagnostic/false-positive/program.mjs",
]);

const file = (relative) => path.join(repoRoot, relative);
const read = (relative) => fs.readFileSync(file(relative), "utf8");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const gitBlobSha = (relative) => {
  const bytes = fs.readFileSync(file(relative));
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

for (const identity of Object.values(BASELINE.files)) {
  assert.equal(gitBlobSha(identity.path), identity.gitBlob, `${identity.path} drifted from fixed baseline`);
}

const contract = JSON.parse(read(BASELINE.files.contract.path));
const coreSource = read(BASELINE.files.core.path);
const adapterSource = read(BASELINE.files.nodeAdapter.path);
const readme = read(BASELINE.files.readme.path);

const structuredRun = run(process.execPath, [file("packages/structured-diagnostic/tests/e2e.mjs")]);
assert.equal(structuredRun.status, 0, structuredRun.stderr);
assert.equal(structuredRun.signal, null);
assert.match(structuredRun.stdout, /structured-diagnostic e2e: PASS/u);

const artifactRun = run(process.execPath, [file(BASELINE.files.artifactProof.path)]);
assert.equal(artifactRun.status, 0, artifactRun.stderr);
assert.equal(artifactRun.signal, null);
const artifactProof = JSON.parse(artifactRun.stdout);
assert.equal(artifactProof.kind, "ops.logger-finite-proof.old-new-comparison");
assert.equal(artifactProof.new.coverage.met, 9);
assert.equal(artifactProof.new.coverage.unmet, 0);
assert.equal(artifactProof.comparison.status, "closed");
assert.equal(artifactProof.new.classification.messageParsingUsed, false);

const coverageNames = new Set(Object.values(PURPOSE_COVERAGE).flat());
assert.deepEqual([...coverageNames].sort(), [...REQUIRED].sort());

const featureConsumers = FEATURE_CONSUMERS.map((relative) => {
  const source = read(relative);
  assert.match(source, /structured-diagnostic\/adapters\/node\.mjs/u);
  return {
    path: relative,
    gitBlob: gitBlobSha(relative),
    support: "executed-test-consumer",
    consumes: "provider feature",
  };
});

const pythonImplementationPaths = [
  "packages/structured-diagnostic/lib/diagnostic.py",
  "packages/structured-diagnostic/adapters/python.py",
];
const pythonImplementations = pythonImplementationPaths.filter((relative) => fs.existsSync(file(relative)));
assert.deepEqual(pythonImplementations, []);

const namedProfiles = ["CLI/batch", "pure library", "browser", "service", "hq worker"];
for (const profile of namedProfiles) assert.ok(readme.includes(`| ${profile} |`), `missing runtime profile: ${profile}`);

const pureForbidden = ["node:", "process.", "console.", "Date(", "Date.now", "Math.random", "fetch("];
const pureViolations = pureForbidden.filter((token) => coreSource.includes(token));
assert.deepEqual(pureViolations, []);

const expectedHostFields = [
  "event_id",
  "run_id",
  "instruction_id",
  "seq",
  "recorded_at",
  "timestamp",
  "status",
  "target",
  "final",
];
assert.deepEqual(contract.hostOwnedTopLevel, expectedHostFields);

const status = (value, detail, evidence = {}) => ({ status: value, detail, evidence });

const supportMatrix = {
  languages: {
    javascript: {
      status: "implemented-reference",
      contract: BASELINE.files.contract,
      core: BASELINE.files.core,
      adapter: BASELINE.files.nodeAdapter,
      execution: {
        status: structuredRun.status,
        stdout: structuredRun.stdout,
        stderr: structuredRun.stderr,
      },
      delegatesMeaningToAnotherLanguage: false,
    },
    python: {
      status: "not-implemented",
      expectedMinimalRole: "independent validate/encode/parse without Node delegation",
      searchedPaths: pythonImplementationPaths,
      observedPaths: pythonImplementations,
    },
  },
  runtimeProfiles: {
    cliBatch: {
      designStatus: "declared",
      implementationStatus: "observed",
      primaryPort: "stdout / process result",
      diagnosticPort: "stderr JSONL",
      evidence: BASELINE.files.artifactCli.path,
    },
    library: {
      designStatus: "declared",
      implementationStatus: "provider API and test consumers only",
      primaryPort: "return value",
      diagnosticPort: "return value or caller-supplied port",
      externalNonTestConsumerObserved: false,
    },
    browser: {
      designStatus: "declared",
      implementationStatus: "not-evidenced",
      primaryPort: "UI/callback",
      diagnosticPort: "callback",
    },
    service: {
      designStatus: "declared",
      implementationStatus: "not-evidenced",
      primaryPort: "response/queue",
      diagnosticPort: "host sink or existing event contract",
    },
    worker: {
      designStatus: "declared",
      implementationStatus: "not-evidenced",
      primaryPort: "canonical result",
      diagnosticPort: "worker-owned transient mapping",
    },
  },
  consumption: {
    feature: featureConsumers,
    data: {
      path: BASELINE.files.artifactConsumer.path,
      gitBlob: BASELINE.files.artifactConsumer.gitBlob,
      classification: artifactProof.new.classification,
      support: "actual route-specific data consumer",
    },
  },
};

const obligations = {
  purpose_scope_coverage: status("met", "all 13 Required appear in the fixed purpose coverage without unknown references", {
    purposeCoverage: PURPOSE_COVERAGE,
    required: REQUIRED,
  }),
  shared_meaning: status("met", "one diagnostic/1 contract and one executable JavaScript reference share stable fields and limits", {
    schema: contract.diagnosticSchema,
    contract: BASELINE.files.contract,
    core: BASELINE.files.core,
    nodeAdapter: BASELINE.files.nodeAdapter,
    providerTest: "PASS",
  }),
  cross_language_interoperability: status("unmet", "only one independent implementation language is present; no two-way cross-language corpus run exists", {
    implementedLanguages: ["javascript"],
    missingSelectedLanguage: "python",
    delegatedNodeExecutionAllowed: false,
  }),
  pure_application_boundary: status("met", "the shared meaning core has no environment-effect dependency and accepts the contract explicitly", {
    core: BASELINE.files.core,
    forbiddenTokensObserved: pureViolations,
  }),
  environment_transport: status("unmet", "runtime profiles are described, but no external non-CLI producer-to-consumer path and no exact implemented support matrix exist", {
    declaredProfiles: namedProfiles,
    actualCliPath: BASELINE.files.artifactCli.path,
    externalNonCliPathObserved: false,
  }),
  host_context_ownership: status("met", "the contract reserves host identity/order/time/lifecycle/final fields and executable tests reject forged ownership", {
    hostOwnedTopLevel: contract.hostOwnedTopLevel,
    providerTest: "PASS",
  }),
  supply_consumption_binding: status("met", "provider feature consumption and diagnostic data consumption are both executable, external to the provider core, and separately identified", {
    providerContract: BASELINE.files.contract,
    implementationProvider: BASELINE.files.nodeAdapter,
    featureConsumers,
    dataConsumer: supportMatrix.consumption.data,
  }),
  actual_data_use: status("met", "an actual receiver uses stable code and source fields to select a typed classification and next action without prose parsing", {
    classification: artifactProof.new.classification,
    counterexamples: artifactProof.counterexamples,
  }),
  traceable_evidence: status("met", "the baseline observation binds fixed corrected meaning, exact implementation bytes, execution and constituent route evidence", {
    candidate: CANDIDATE,
    baseline: BASELINE,
    constituentRouteObservationId: artifactProof.new.observationId,
    diagnosticSha256: artifactProof.new.classification.diagnosticSha256,
  }),
  bounded_safe_failure: status("unmet", "strict size/encoding/rejection semantics are executable only in JavaScript and are not yet shown across a second language boundary", {
    javascriptProviderTest: "PASS",
    secondLanguageImplementationObserved: false,
    primaryOutputPreservedOnInvalidJavaScriptInput: true,
  }),
  compatibility: status("met", "existing provider tests, the retained CLI route, normal result semantics and prior exact-head whole CI remain Green", {
    providerTest: "PASS",
    cliRouteCoverage: artifactProof.new.coverage,
    priorWholeCi: BASELINE.priorWholeCi,
  }),
  causal_design_closure: status("unmet", "the corrected 13-obligation Contract has now produced a baseline Finding, but no R-accepted corrected-scope Finding-to-repair-to-old/new closure exists yet", {
    oldCliProofRetainedUnderOriginalMeaning: true,
    correctedMeaning: CANDIDATE.meaningSha256,
    repairAllowedBeforeRMateriality: false,
  }),
  small_extensible_design: status("met", "the current design is one contract, one pure meaning core and environment adapters; it rejects a universal logger/storage authority", {
    readme: BASELINE.files.readme,
    languageNeutralContractDeclared: readme.includes("`contract.json` is the language-neutral contract"),
    notLoggerFrameworkDeclared: readme.includes("It is not a logger framework"),
    adapterUsesBoundContract: adapterSource.includes("encodeDiagnosticCore(value, diagnosticContract)"),
  }),
};

assert.deepEqual(Object.keys(obligations).sort(), [...REQUIRED].sort());
const entries = Object.entries(obligations);
const unmet = entries.filter(([, value]) => value.status === "unmet").map(([name]) => name);
const unknown = entries.filter(([, value]) => value.status === "unknown").map(([name]) => name);
const conflict = entries.filter(([, value]) => value.status === "conflict").map(([name]) => name);
const met = entries.filter(([, value]) => value.status === "met").map(([name]) => name);

assert.deepEqual(unmet, [
  "cross_language_interoperability",
  "environment_transport",
  "bounded_safe_failure",
  "causal_design_closure",
]);
assert.equal(met.length, 9);
assert.equal(unknown.length, 0);
assert.equal(conflict.length, 0);

const observationCore = {
  candidateMeaningSha256: CANDIDATE.meaningSha256,
  baselineRevision: BASELINE.revision,
  baselineTree: BASELINE.tree,
  required: REQUIRED,
  supportMatrix,
  obligations,
};

const report = {
  kind: "ops.logger-language-neutral.baseline-finding",
  authority: false,
  admittedNormativeViolation: false,
  candidate: CANDIDATE,
  baseline: BASELINE,
  observationId: sha256(Buffer.from(JSON.stringify(observationCore), "utf8")),
  supportMatrix,
  finding: {
    status: unmet.length > 0 ? "unmet" : "met",
    code: unmet.length > 0 ? "candidate-common-design-unmet" : "candidate-common-design-met",
    met,
    unmet,
  },
  coverage: {
    applicable: REQUIRED.length,
    evaluated: entries.length,
    met: met.length,
    unmet: unmet.length,
    unknown: unknown.length,
    conflict: conflict.length,
    stale: 0,
  },
  obligations,
  repairAllowed: false,
  nextBoundary: "independent R review of purpose coverage, evaluation criteria and material true-positive status before broad producer/consumer repair",
  claimCeiling: "Unmodified current implementation baseline under the corrected candidate meaning. No second-language implementation, non-CLI repair, formal adoption, merge, Release or deploy is claimed.",
};

process.stdout.write(`${JSON.stringify(report)}\n`);
