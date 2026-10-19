#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const appsRoot = path.resolve(process.env.APPS_BASELINE ?? "");
assert.notEqual(process.env.APPS_BASELINE, undefined, "APPS_BASELINE must name the exact Apps T0 checkout");

const CANDIDATE = Object.freeze({
  authority: false,
  admitted: false,
  source: {
    repository: "roccho-dev/adrs",
    head: "ad38c5f8d7eb310030d1bd184a7ce9e88a76869f",
    tree: "5ee2f9bc28439202a9758232d56e1817316e0e3d",
    path: "decisions/logger-language-neutral-design-contract-261019.jsonl",
    blob: "f6baea67fa0ff76d507d554da38a9e4db2f168bb",
    rawId: "raw.adrs.logger_language_neutral_design_contract.261019.02",
  },
  meaningSha256: "sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c",
  obligationId: "ops.logger-language-neutral-design.v1",
});

const OPS_T0 = Object.freeze({
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

const APPS_T0 = Object.freeze({
  repository: "roccho-dev/apps",
  branch: "proposals",
  revision: "c91bab56ec5e769d9788453a098a289115cdaa92",
  tree: "a32423848d2298b4c54cf43cd22119859f25c905",
  selectedConsumerPackage: "packages/voice-ui",
  files: {
    flake: {
      path: "flake.nix",
      gitBlob: "7799f645f74e682b4aef40495a0902b0908c18df",
    },
    pureLog: {
      path: "packages/voice-ui/src/log.mjs",
      gitBlob: "32631681e3ce95374e53f0fb6efab0b5c6554855",
    },
    browserHost: {
      path: "packages/voice-ui/web/app.mjs",
      gitBlob: "38883c826603e28c76a72d3cf760622412e9855f",
    },
  },
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

const PROFILE_STATES = new Set([
  "implemented_observed",
  "supported_design_only",
  "explicitly_unsupported",
  "not_applicable",
  "future_profile_only",
]);

const PROFILE_MATRIX = Object.freeze({
  cli_batch: {
    baselineState: "implemented_observed",
    targetState: "implemented_observed",
    owner: "roccho-org/ops artifact-assembly CLI host",
    primaryPort: "stdout + exit status + PASS receipt",
    diagnosticPort: "stderr diagnostic/1 JSONL",
    baselineEvidence: "real npm-tgz digest-mismatch and matching-digest control",
    targetEvidence: "same route remains compatible under the corrected whole-design tree set",
  },
  library: {
    baselineState: "implemented_observed",
    targetState: "implemented_observed",
    owner: "caller package owns return/callback; structured-diagnostic owns validation and canonical encoding",
    primaryPort: "return value / typed domain result",
    diagnosticPort: "returned diagnostic value or caller-supplied in-memory port",
    baselineEvidence: "Ops provider API and separately located executable test consumers",
    targetEvidence: "same meaning remains usable independently of CLI and without environment effects in core",
  },
  browser: {
    baselineState: "supported_design_only",
    targetState: "implemented_observed",
    owner: "roccho-dev/apps voice-ui browser host",
    primaryPort: "UI state / callback result",
    diagnosticPort: "browser-owned callback or in-memory sink; console is projection only",
    baselineEvidence: "declared profile and exact Apps T0 with no provider supply/use",
    targetEvidence: "actual Ops provider package supplied to and executed by Apps voice-ui with callback consumption",
  },
  service: {
    baselineState: "supported_design_only",
    targetState: "supported_design_only",
    owner: "service host",
    primaryPort: "response or queue result",
    diagnosticPort: "host sink or existing event contract",
    baselineEvidence: "meaning/port/owner declaration only",
    targetEvidence: "resolved extension contract; no implemented service claim",
  },
  worker: {
    baselineState: "supported_design_only",
    targetState: "supported_design_only",
    owner: "worker host",
    primaryPort: "canonical worker result",
    diagnosticPort: "worker-owned transient mapping",
    baselineEvidence: "meaning/port/owner declaration only",
    targetEvidence: "resolved extension contract; no implemented worker claim",
  },
});

for (const profile of Object.values(PROFILE_MATRIX)) {
  assert.ok(PROFILE_STATES.has(profile.baselineState));
  assert.ok(PROFILE_STATES.has(profile.targetState));
  assert.equal(typeof profile.owner, "string");
  assert.equal(typeof profile.primaryPort, "string");
  assert.equal(typeof profile.diagnosticPort, "string");
  assert.equal(typeof profile.baselineEvidence, "string");
  assert.equal(typeof profile.targetEvidence, "string");
}
assert.equal(Object.keys(PROFILE_MATRIX).length, 5);
assert.equal(Object.values(PROFILE_MATRIX).some((profile) => profile.baselineState === "not_applicable"), false);
assert.equal(Object.values(PROFILE_MATRIX).some((profile) => profile.targetState === "not_applicable"), false);

const opsFile = (relative) => path.join(repoRoot, relative);
const appsFile = (relative) => path.join(appsRoot, relative);
const readOps = (relative) => fs.readFileSync(opsFile(relative), "utf8");
const readApps = (relative) => fs.readFileSync(appsFile(relative), "utf8");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const gitBlobSha = (absolute) => {
  const bytes = fs.readFileSync(absolute);
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
};

const run = (command, args, cwd = repoRoot) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
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

for (const identity of Object.values(OPS_T0.files)) {
  assert.equal(gitBlobSha(opsFile(identity.path)), identity.gitBlob, `${identity.path} drifted from fixed Ops T0`);
}
for (const identity of Object.values(APPS_T0.files)) {
  assert.equal(gitBlobSha(appsFile(identity.path)), identity.gitBlob, `${identity.path} drifted from fixed Apps T0`);
}

const appsHead = run("git", ["rev-parse", "HEAD"], appsRoot);
const appsTree = run("git", ["rev-parse", "HEAD^{tree}"], appsRoot);
assert.equal(appsHead.status, 0, appsHead.stderr);
assert.equal(appsTree.status, 0, appsTree.stderr);
assert.equal(appsHead.stdout.trim(), APPS_T0.revision);
assert.equal(appsTree.stdout.trim(), APPS_T0.tree);

const contract = JSON.parse(readOps(OPS_T0.files.contract.path));
const coreSource = readOps(OPS_T0.files.core.path);
const adapterSource = readOps(OPS_T0.files.nodeAdapter.path);
const readme = readOps(OPS_T0.files.readme.path);
const appsFlake = readApps(APPS_T0.files.flake.path);
const appsPureLog = readApps(APPS_T0.files.pureLog.path);
const appsBrowserHost = readApps(APPS_T0.files.browserHost.path);

const structuredRun = run(process.execPath, [opsFile("packages/structured-diagnostic/tests/e2e.mjs")]);
assert.equal(structuredRun.status, 0, structuredRun.stderr);
assert.equal(structuredRun.signal, null);
assert.match(structuredRun.stdout, /structured-diagnostic e2e: PASS/u);

const artifactRun = run(process.execPath, [opsFile(OPS_T0.files.artifactProof.path)]);
assert.equal(artifactRun.status, 0, artifactRun.stderr);
assert.equal(artifactRun.signal, null);
const artifactProof = JSON.parse(artifactRun.stdout);
assert.equal(artifactProof.kind, "ops.logger-finite-proof.old-new-comparison");
assert.equal(artifactProof.new.coverage.met, 9);
assert.equal(artifactProof.new.coverage.unmet, 0);
assert.equal(artifactProof.comparison.status, "closed");
assert.equal(artifactProof.new.classification.messageParsingUsed, false);

const { validateDiagnostic } = await import(pathToFileURL(opsFile(OPS_T0.files.core.path)).href);
const codeOnly = validateDiagnostic({
  schema: "diagnostic/1",
  code: "example.code-only",
  level: "info",
  message: "valid without fields",
}, contract);
assert.equal(Object.hasOwn(codeOnly, "fields"), false);

const coverageNames = new Set(Object.values(PURPOSE_COVERAGE).flat());
assert.deepEqual([...coverageNames].sort(), [...REQUIRED].sort());

const providerLocalFeatureConsumers = [
  "packages/shiftleft-admission/fixtures/diagnostic/good/program.mjs",
  "packages/shiftleft-admission/fixtures/diagnostic/false-positive/program.mjs",
].map((relative) => {
  const source = readOps(relative);
  assert.match(source, /structured-diagnostic\/adapters\/node\.mjs/u);
  return {
    repository: OPS_T0.repository,
    path: relative,
    gitBlob: gitBlobSha(opsFile(relative)),
    support: "executed-test-consumer",
    consumes: "provider feature",
  };
});

const pythonImplementationPaths = [
  "packages/structured-diagnostic/lib/diagnostic.py",
  "packages/structured-diagnostic/adapters/python.py",
];
const pythonImplementations = pythonImplementationPaths.filter((relative) => fs.existsSync(opsFile(relative)));
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

const appsProviderSearch = run(
  "git",
  ["grep", "-n", "-E", "structured-diagnostic|diagnostic/1", "HEAD", "--", "flake.nix", APPS_T0.selectedConsumerPackage],
  appsRoot,
);
assert.equal(appsProviderSearch.status, 1, `Apps T0 unexpectedly contains provider use:\n${appsProviderSearch.stdout}`);
assert.equal(appsProviderSearch.stdout, "");
assert.equal(appsFlake.includes("structured-diagnostic"), false);
assert.equal(appsPureLog.includes("diagnostic/1"), false);
assert.equal(appsBrowserHost.includes("diagnostic/1"), false);

const status = (value, detail, evidence = {}) => ({ status: value, detail, evidence });

const supportMatrix = {
  frozenBeforeFinding: true,
  languages: {
    javascript: {
      baselineState: "implemented_observed",
      targetState: "implemented_observed",
      owner: OPS_T0.repository,
      contract: OPS_T0.files.contract,
      core: OPS_T0.files.core,
      adapter: OPS_T0.files.nodeAdapter,
      execution: {
        status: structuredRun.status,
        stdout: structuredRun.stdout,
        stderr: structuredRun.stderr,
      },
      delegatesMeaningToAnotherLanguage: false,
    },
    python: {
      baselineState: "future_profile_only",
      targetState: "implemented_observed",
      owner: OPS_T0.repository,
      expectedMinimalRole: "independent validate/encode/parse using Python standard library without Node delegation",
      searchedPaths: pythonImplementationPaths,
      observedPaths: pythonImplementations,
    },
  },
  runtimeProfiles: PROFILE_MATRIX,
  crossRepository: {
    provider: {
      repository: OPS_T0.repository,
      package: "packages/structured-diagnostic",
      meaningContract: OPS_T0.files.contract,
      executableImplementation: OPS_T0.files.core,
    },
    consumer: {
      repository: APPS_T0.repository,
      package: APPS_T0.selectedConsumerPackage,
      baselineTree: APPS_T0.tree,
      selectedHost: APPS_T0.files.browserHost,
      baselineProviderReferences: [],
      targetUse: "actual browser callback/in-memory-port feature and diagnostic-data consumption",
    },
    baselineStatus: "unmet",
    targetStatus: "implemented_observed",
  },
  consumption: {
    providerLocalFeature: providerLocalFeatureConsumers,
    routeData: {
      repository: OPS_T0.repository,
      path: OPS_T0.files.artifactConsumer.path,
      gitBlob: OPS_T0.files.artifactConsumer.gitBlob,
      classification: artifactProof.new.classification,
      support: "actual route-specific diagnostic-data consumer retained as baseline fact, not corrected-contract causality",
    },
    appsFeature: null,
    appsDiagnosticData: null,
  },
};

const obligations = {
  purpose_scope_coverage: status("met", "all 13 Required appear in the fixed purpose coverage and the five-profile baseline/target matrix is frozen without NA", {
    purposeCoverage: PURPOSE_COVERAGE,
    required: REQUIRED,
    profileMatrix: PROFILE_MATRIX,
  }),
  shared_meaning: status("met", "one diagnostic/1 contract and one executable JavaScript reference share stable fields and limits; code-only diagnostics remain valid", {
    schema: contract.diagnosticSchema,
    contract: OPS_T0.files.contract,
    core: OPS_T0.files.core,
    nodeAdapter: OPS_T0.files.nodeAdapter,
    codeOnlyDiagnostic: codeOnly,
    providerTest: "PASS",
  }),
  cross_language_interoperability: status("unmet", "only one independent implementation language is present; no two-way JavaScript/Python corpus run exists", {
    implementedLanguages: ["javascript"],
    selectedMissingLanguage: "python",
    delegatedNodeExecutionAllowed: false,
  }),
  pure_application_boundary: status("met", "the shared meaning core has no environment-effect dependency and accepts the contract explicitly", {
    core: OPS_T0.files.core,
    forbiddenTokensObserved: pureViolations,
  }),
  environment_transport: status("unmet", "all five profiles now have fixed owner/ports/states, but the selected browser target has no actual non-CLI provider-to-consumer execution in Apps T0", {
    profileMatrix: PROFILE_MATRIX,
    actualCliPath: OPS_T0.files.artifactCli.path,
    selectedNonCliProfile: "browser",
    externalNonCliPathObserved: false,
  }),
  host_context_ownership: status("met", "the contract reserves host identity/order/time/lifecycle/final fields and executable tests reject forged ownership", {
    hostOwnedTopLevel: contract.hostOwnedTopLevel,
    providerTest: "PASS",
  }),
  supply_consumption_binding: status("unmet", "Ops provider-local feature/data consumption exists, but the mandatory Ops provider-package to Apps voice-ui package supply/use is absent at the fixed Apps T0", {
    canonicalMeaningContract: OPS_T0.files.contract,
    executableImplementation: OPS_T0.files.core,
    providerLocalFeatureConsumers,
    routeDataConsumer: supportMatrix.consumption.routeData,
    requiredCrossRepository: supportMatrix.crossRepository,
    appsSearch: {
      pattern: "structured-diagnostic|diagnostic/1",
      exitCode: appsProviderSearch.status,
      stdout: appsProviderSearch.stdout,
    },
  }),
  actual_data_use: status("met", "an existing real receiver uses stable code and required source fields to select a typed classification and next action without prose parsing; code-only validity is not denied", {
    classification: artifactProof.new.classification,
    counterexamples: artifactProof.counterexamples,
    codeOnlyDiagnostic: codeOnly,
    causalUseUnderCorrectedContract: false,
  }),
  traceable_evidence: status("met", "the baseline observation binds the corrected meaning, exact Ops/Apps tree set, selected files, execution and constituent route evidence", {
    candidate: CANDIDATE,
    treeSet: [OPS_T0, APPS_T0],
    constituentRouteObservationId: artifactProof.new.observationId,
    diagnosticSha256: artifactProof.new.classification.diagnosticSha256,
  }),
  bounded_safe_failure: status("unmet", "strict size/encoding/rejection semantics are executable only in JavaScript and are not yet shown by an independent second-language implementation or interchange", {
    javascriptProviderTest: "PASS",
    secondLanguageImplementationObserved: false,
    primaryOutputPreservedOnInvalidJavaScriptInput: true,
  }),
  compatibility: status("met", "existing provider tests, retained CLI result semantics and exact Ops T0 whole CI are Green; Apps T0 is observation-only and unchanged", {
    providerTest: "PASS",
    cliRouteCoverage: artifactProof.new.coverage,
    opsWholeCi: OPS_T0.priorWholeCi,
    appsBaseline: {
      revision: APPS_T0.revision,
      tree: APPS_T0.tree,
      changedByThisObservation: false,
    },
  }),
  causal_design_closure: status("unmet", "the corrected 13-obligation Contract has produced this pre-repair baseline Finding, but R has not yet accepted its materiality and no corrected-scope Finding-to-design-to-old/new closure exists", {
    oldCliProofRetainedUnderOriginalMeaning: true,
    correctedMeaning: CANDIDATE.meaningSha256,
    correctedTreeSet: [OPS_T0.tree, APPS_T0.tree],
    repairAllowedBeforeRMateriality: false,
  }),
  small_extensible_design: status("met", "the target remains one shared contract, independent conforming implementations and environment-owned adapters; no universal logger/storage authority is introduced", {
    readme: OPS_T0.files.readme,
    languageNeutralContractDeclared: readme.includes("`contract.json` is the language-neutral contract"),
    notLoggerFrameworkDeclared: readme.includes("It is not a logger framework"),
    adapterUsesBoundContract: adapterSource.includes("encodeDiagnosticCore(value, diagnosticContract)"),
    targetProfiles: PROFILE_MATRIX,
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
  "supply_consumption_binding",
  "bounded_safe_failure",
  "causal_design_closure",
]);
assert.equal(met.length, 8);
assert.equal(unknown.length, 0);
assert.equal(conflict.length, 0);

const observationCore = {
  candidateMeaningSha256: CANDIDATE.meaningSha256,
  treeSet: [OPS_T0.tree, APPS_T0.tree],
  required: REQUIRED,
  supportMatrix,
  obligations,
};

const report = {
  kind: "ops.logger-language-neutral.baseline-finding",
  authority: false,
  admittedNormativeViolation: false,
  candidate: CANDIDATE,
  baseline: {
    correctedScopeT0: [OPS_T0, APPS_T0],
    legacyCliBoundary: "retained as pre-existing T0 fact under its original nine-obligation meaning; not counted as corrected-contract causality",
  },
  observationId: sha256(Buffer.from(JSON.stringify(observationCore), "utf8")),
  supportMatrix,
  finding: {
    status: "unmet",
    code: "candidate-common-design-unmet",
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
  nextBoundary: "independent R review of corrected source, purpose coverage, frozen profile matrix, evaluator criteria and material true-positive status before any change claimed as Finding-guided repair",
  claimCeiling: "Unmodified exact Ops+Apps corrected-scope baseline. No Python implementation, Apps provider supply/use, browser diagnostic path, corrected-scope repair, formal adoption, merge, Release or deploy is claimed.",
};

process.stdout.write(`${JSON.stringify(report)}\n`);
