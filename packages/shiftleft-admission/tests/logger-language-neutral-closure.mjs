#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i]?.startsWith("--") && process.argv[i + 1], `invalid argument ${i}`);
  argv.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const arg = (name) => {
  const value = argv.get(name);
  assert.ok(value, `--${name} is required`);
  return path.resolve(value);
};
const ops = arg("ops");
const apps = arg("apps");
const baselineFile = arg("baseline");
const interchangeFile = arg("interchange");
const browserFile = arg("browser");

const CONTRACT = Object.freeze({
  source: {
    repository: "roccho-dev/adrs",
    head: "ad38c5f8d7eb310030d1bd184a7ce9e88a76869f",
    tree: "5ee2f9bc28439202a9758232d56e1817316e0e3d",
    path: "decisions/logger-language-neutral-design-contract-261019.jsonl",
    blob: "f6baea67fa0ff76d507d554da38a9e4db2f168bb",
  },
  meaningSha256: "sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c",
  obligationId: "ops.logger-language-neutral-design.v1",
});
const T0 = Object.freeze({
  ops: { repository: "roccho-org/ops", revision: "d1ed2594aa6112f931ff3996c89d8fde8aed8690", tree: "27c40aee9b923129e0feefa8477da711155c8384" },
  apps: { repository: "roccho-dev/apps", revision: "c91bab56ec5e769d9788453a098a289115cdaa92", tree: "a32423848d2298b4c54cf43cd22119859f25c905" },
});
const PROVIDER = Object.freeze({
  repository: "roccho-org/ops",
  revision: "fe968fc6b8919fed48151a57f421667bce0aac87",
  tree: "b306bf999aba32a678ac48b5a56e4b4a0a3c0cf8",
});
const CONSUMER = Object.freeze({
  repository: "roccho-dev/apps",
  revision: "17c0108a5c2549ffaf7cef791a569f2e1926659f",
  tree: "3d603665d54c83dd770873870c66863959904b42",
  package: "packages/voice-ui",
  wholeCi: "https://github.com/roccho-dev/apps/actions/runs/39365786783",
});
const R = Object.freeze({
  ref: "https://github.com/roccho-org/ops/pull/602#issuecomment-6283074344",
  verdict: "TRUE POSITIVE / MATERIAL",
  oldUnmet: [
    "cross_language_interoperability",
    "environment_transport",
    "supply_consumption_binding",
    "bounded_safe_failure",
    "causal_design_closure",
  ],
});
const REQUIRED = Object.freeze([
  "purpose_scope_coverage", "shared_meaning", "cross_language_interoperability",
  "pure_application_boundary", "environment_transport", "host_context_ownership",
  "supply_consumption_binding", "actual_data_use", "traceable_evidence",
  "bounded_safe_failure", "compatibility", "causal_design_closure", "small_extensible_design",
]);
const PROFILE_TARGETS = Object.freeze({
  cli_batch: "implemented_observed", library: "implemented_observed",
  browser: "implemented_observed", service: "supported_design_only", worker: "supported_design_only",
});
const HOST_FIELDS = Object.freeze([
  "event_id", "run_id", "instruction_id", "seq", "recorded_at",
  "timestamp", "status", "target", "final",
]);
const PROVIDER_PATHS = Object.freeze({
  contract: "packages/structured-diagnostic/contract.json",
  readme: "packages/structured-diagnostic/README.md",
  js: "packages/structured-diagnostic/lib/diagnostic.mjs",
  py: "packages/structured-diagnostic/lib/diagnostic.py",
  node: "packages/structured-diagnostic/adapters/node.mjs",
  browser: "packages/structured-diagnostic/adapters/browser.mjs",
  pyAdapter: "packages/structured-diagnostic/adapters/python.py",
  corpus: "packages/structured-diagnostic/fixtures/interchange.json",
  e2e: "packages/structured-diagnostic/tests/e2e.mjs",
  route: "packages/shiftleft-admission/tests/artifact-assembly-diagnostic-candidate.mjs",
});
const APP_PATHS = Object.freeze({
  identity: `${CONSUMER.package}/web/providers/structured-diagnostic/identity.json`,
  contract: `${CONSUMER.package}/web/providers/structured-diagnostic/contract.json`,
  core: `${CONSUMER.package}/web/providers/structured-diagnostic/lib/diagnostic.mjs`,
  adapter: `${CONSUMER.package}/web/providers/structured-diagnostic/adapters/browser.mjs`,
  decision: `${CONSUMER.package}/src/diagnostic.mjs`,
  host: `${CONSUMER.package}/web/diagnostic-host.mjs`,
  proof: `${CONSUMER.package}/acceptance/diagnostic-browser.mjs`,
  unit: `${CONSUMER.package}/tests/diagnostic.test.mjs`,
  flake: "flake.nix",
});

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp", PYTHONDWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const git = (root, ...args) => {
  const result = run("git", args, root);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const blob = (file) => {
  const bytes = fs.readFileSync(file);
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
};
const sha = (file) => `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const text = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");
const selected = (root, revision, relative) => {
  const current = blob(path.join(root, relative));
  const expected = git(root, "rev-parse", `${revision}:${relative}`);
  return { path: relative, blob: expected, sha256: sha(path.join(root, relative)), exact: current === expected };
};
const check = (name, ok, actual) => ({ name, ok: Boolean(ok), ...(actual === undefined ? {} : { actual }) });
const assess = (detail, checks, evidence) => {
  const failed = checks.filter((item) => !item.ok).map((item) => item.name);
  return {
    status: failed.length === 0 ? "met" : "unmet",
    detail,
    criteria: Object.fromEntries(checks.map((item) => [item.name, { ok: item.ok, ...(item.actual === undefined ? {} : { actual: item.actual }) }])),
    failed,
    evidence,
  };
};

assert.equal(git(ops, "rev-parse", `${PROVIDER.revision}^{tree}`), PROVIDER.tree);
assert.equal(git(apps, "rev-parse", "HEAD"), CONSUMER.revision);
assert.equal(git(apps, "rev-parse", "HEAD^{tree}"), CONSUMER.tree);
const observation = { revision: git(ops, "rev-parse", "HEAD"), tree: git(ops, "rev-parse", "HEAD^{tree}") };
const providerFiles = Object.fromEntries(Object.entries(PROVIDER_PATHS).map(([name, file]) => [name, selected(ops, PROVIDER.revision, file)]));
const appFiles = Object.fromEntries(Object.entries(APP_PATHS).map(([name, file]) => [name, selected(apps, CONSUMER.revision, file)]));
const providerExact = Object.values(providerFiles).every((file) => file.exact);
const appsExact = Object.values(appFiles).every((file) => file.exact);

const baseline = json(baselineFile);
const interchange = json(interchangeFile);
const browser = json(browserFile);
assert.equal(baseline.candidate.meaningSha256, CONTRACT.meaningSha256);
assert.deepEqual(baseline.coverage, { applicable: 13, evaluated: 13, met: 8, unmet: 5, unknown: 0, conflict: 0, stale: 0 });
assert.deepEqual(baseline.finding.unmet, R.oldUnmet);

const contract = json(path.join(ops, PROVIDER_PATHS.contract));
const corpus = json(path.join(ops, PROVIDER_PATHS.corpus));
const readme = text(ops, PROVIDER_PATHS.readme);
const jsCore = text(ops, PROVIDER_PATHS.js);
const pyCore = text(ops, PROVIDER_PATHS.py);
const nodeAdapter = text(ops, PROVIDER_PATHS.node);
const browserAdapter = text(ops, PROVIDER_PATHS.browser);
const pyAdapter = text(ops, PROVIDER_PATHS.pyAdapter);
const appIdentity = json(path.join(apps, APP_PATHS.identity));
const appDecision = text(apps, APP_PATHS.decision);
const appHost = text(apps, APP_PATHS.host);

const expectedIdentity = {
  repository: PROVIDER.repository, revision: PROVIDER.revision, tree: PROVIDER.tree,
  contractBlob: providerFiles.contract.blob, coreBlob: providerFiles.js.blob, browserAdapterBlob: providerFiles.browser.blob,
};
const actualIdentity = {
  repository: appIdentity.repository, revision: appIdentity.revision, tree: appIdentity.tree,
  contractBlob: appIdentity.contractBlob, coreBlob: appIdentity.coreBlob, browserAdapterBlob: appIdentity.browserAdapterBlob,
};
const identityExact = JSON.stringify(actualIdentity) === JSON.stringify(expectedIdentity);
const carried = {
  contract: fs.readFileSync(path.join(ops, PROVIDER_PATHS.contract)).equals(fs.readFileSync(path.join(apps, APP_PATHS.contract))),
  core: fs.readFileSync(path.join(ops, PROVIDER_PATHS.js)).equals(fs.readFileSync(path.join(apps, APP_PATHS.core))),
  adapter: fs.readFileSync(path.join(ops, PROVIDER_PATHS.browser)).equals(fs.readFileSync(path.join(apps, APP_PATHS.adapter))),
};
const carriedExact = Object.values(carried).every(Boolean);

const purpose = baseline.obligations.purpose_scope_coverage.evidence.purposeCoverage;
const matrix = baseline.supportMatrix.runtimeProfiles;
const covered = [...new Set(Object.values(purpose).flat())].sort();
const profileTargets = Object.fromEntries(Object.entries(matrix).map(([name, profile]) => [name, profile.targetState]));
const profilesComplete = Object.values(matrix).every((profile) =>
  ["owner", "primaryPort", "diagnosticPort", "baselineEvidence", "targetEvidence"].every((field) => typeof profile[field] === "string" && profile[field].length > 0));
const codeOnly = interchange.cases.literalValid.find((item) => item.id === "code-only");
const hostOwned = interchange.cases.literalInvalid.find((item) => item.id === "host-owned");
const requests = new Set(browser.requests);
const requiredRequests = [
  "/diagnostic-proof.html", "/diagnostic-proof.mjs", "/diagnostic-host.mjs",
  "/providers/structured-diagnostic/contract.json", "/providers/structured-diagnostic/identity.json",
  "/providers/structured-diagnostic/adapters/browser.mjs", "/providers/structured-diagnostic/lib/diagnostic.mjs", "/app/src/diagnostic.mjs",
];
const browserControls = ["wrong-source", "wrong-code", "invalid-diagnostic", "transport-preserved-primary"];
const jsPureBad = ["node:", "process.", "console.", "fetch(", "Date.now", "Math.random", "localStorage", "document.", "window."].filter((token) => jsCore.includes(token));
const pyImports = [...pyCore.matchAll(/^(?:from|import)\s+([A-Za-z0-9_.]+)/gmu)].map((match) => match[1].split(".")[0]);
const pyImportBad = [...new Set(pyImports.filter((name) => !new Set(["__future__", "decimal", "json", "math", "re", "typing"]).has(name)))];
const pyPureBad = ["subprocess", "os.", "socket", "requests", "urllib", "open(", "time.", "datetime"].filter((token) => pyCore.includes(token));
const packagePaths = git(ops, "ls-tree", "-r", "--name-only", PROVIDER.revision, "packages/structured-diagnostic").split("\n").filter(Boolean);
const expansion = packagePaths.filter((file) => /\/(storage|collector|service|worker)\//u.test(file));
const e2e = run(process.execPath, [path.join(ops, PROVIDER_PATHS.e2e)], ops);
const routeRun = run(process.execPath, [path.join(ops, PROVIDER_PATHS.route)], ops);
const route = routeRun.status === 0 ? JSON.parse(routeRun.stdout) : null;
const baseEvidence = { baseline: sha(baselineFile), interchange: sha(interchangeFile), browser: sha(browserFile) };

const o = {};
o.purpose_scope_coverage = assess("fixed purpose and five-profile scope cover all thirteen Required", [
  check("thirteen-required", REQUIRED.length === 13, REQUIRED.length),
  check("purpose-covers-exact-denominator", JSON.stringify(covered) === JSON.stringify([...REQUIRED].sort()), covered),
  check("five-explicit-profiles", Object.keys(matrix).length === 5, Object.keys(matrix)),
  check("fixed-target-states", JSON.stringify(profileTargets) === JSON.stringify(PROFILE_TARGETS), profileTargets),
  check("owners-ports-evidence-present", profilesComplete),
  check("no-silent-not-applicable", Object.values(profileTargets).every((state) => state !== "not_applicable")),
], { purpose, matrix });

o.shared_meaning = assess("one diagnostic/1 meaning is executed by both languages and the exact Apps browser consumer", [
  check("selected-provider-bytes", providerExact),
  check("contract-schema", contract.schema === "diagnostic-contract/1" && contract.diagnosticSchema === "diagnostic/1"),
  check("contract-blank-rule", contract.messageBlankRule === "ecmascript-trim", contract.messageBlankRule),
  check("interchange-contract-digest", interchange.contractSha256 === providerFiles.contract.sha256, interchange.contractSha256),
  check("interchange-pass", interchange.status === "PASS", interchange.status),
  check("code-only-valid", codeOnly?.canonical && !codeOnly.canonical.includes("\"fields\""), codeOnly),
  check("apps-identity-exact", identityExact, { expectedIdentity, actualIdentity }),
  check("apps-carried-bytes-exact", carriedExact, carried),
], { contract: providerFiles.contract, js: providerFiles.js, py: providerFiles.py, identity: actualIdentity });

o.cross_language_interoperability = assess("independent JavaScript and Python implementations exchange one finite corpus in both directions", [
  check("javascript-implementation", providerFiles.js.exact),
  check("python-implementation", providerFiles.py.exact),
  check("python-no-node-delegation", interchange.implementation.pythonDelegatesToNode === false, interchange.implementation),
  check("js-to-python-byte-identical", interchange.interchange.javascriptToPython === "byte-identical", interchange.interchange),
  check("python-to-js-byte-identical", interchange.interchange.pythonToJavascript === "byte-identical", interchange.interchange),
  check("finite-corpus-complete", interchange.counts.accepted === 16 && interchange.counts.rejected === 16, interchange.counts),
], { report: baseEvidence.interchange, counts: interchange.counts, semantics: interchange.semantics });

o.pure_application_boundary = assess("meaning cores are effect-free and environment effects remain in adapters", [
  check("javascript-core-pure", jsPureBad.length === 0, jsPureBad),
  check("python-core-imports-pure", pyImportBad.length === 0, pyImportBad),
  check("python-core-effect-free", pyPureBad.length === 0, pyPureBad),
  check("node-adapter-separate", providerFiles.node.exact && nodeAdapter.includes("writeDiagnostic")),
  check("browser-adapter-separate", providerFiles.browser.exact && browserAdapter.includes("createBrowserDiagnosticPort")),
  check("python-adapter-separate", providerFiles.pyAdapter.exact && pyAdapter.includes("write_diagnostic")),
], { cores: { js: providerFiles.js, py: providerFiles.py }, adapters: { node: providerFiles.node, browser: providerFiles.browser, python: providerFiles.pyAdapter } });

o.environment_transport = assess("the selected browser Host executes the exact provider through callback/in-memory transport", [
  check("browser-target-implemented", profileTargets.browser === "implemented_observed", profileTargets.browser),
  check("service-worker-remain-design-only", profileTargets.service === "supported_design_only" && profileTargets.worker === "supported_design_only", profileTargets),
  check("browser-proof-pass", browser.status === "PASS", browser.status),
  check("provider-revision-executed", browser.providerRevision === PROVIDER.revision, browser.providerRevision),
  check("failure-state-executed", JSON.stringify(browser.actualFailureState) === JSON.stringify({ state: "failed", primaryResult: "failed", transport: "accepted" }), browser.actualFailureState),
  check("required-browser-modules-loaded", requiredRequests.every((request) => requests.has(request)), [...requests].sort()),
  check("production-observer-path", appHost.includes("MutationObserver") && appHost.includes("createBrowserDiagnosticPort")),
], { report: baseEvidence.browser, requests: [...requests].sort(), failure: browser.actualFailureState });

o.host_context_ownership = assess("host-owned identity/lifecycle fields and caller-owned primary result remain outside diagnostics", [
  check("host-fields-exact", JSON.stringify(contract.hostOwnedTopLevel) === JSON.stringify(HOST_FIELDS), contract.hostOwnedTopLevel),
  check("forged-host-field-rejected", hostOwned?.error === "DIAGNOSTIC_HOST_FIELD_FORGED", hostOwned),
  check("primary-result-preserved", browser.actualFailureState.primaryResult === "failed", browser.actualFailureState),
  check("transport-rejection-preserved", browser.controls.includes("transport-preserved-primary"), browser.controls),
  check("host-owns-projection", appHost.includes("dataset.diagnostic") && appHost.includes("dataset.state")),
], { hostOwnedTopLevel: contract.hostOwnedTopLevel, counterexample: hostOwned, failure: browser.actualFailureState });

o.supply_consumption_binding = assess("exact Ops provider revision/tree/blobs are carried and loaded by exact Apps consumer", [
  check("provider-tree-fixed", git(ops, "rev-parse", `${PROVIDER.revision}^{tree}`) === PROVIDER.tree),
  check("consumer-tree-fixed", appsExact),
  check("identity-exact", identityExact, { expectedIdentity, actualIdentity }),
  check("carried-bytes-exact", carriedExact, carried),
  check("provider-contract-loaded", requests.has("/providers/structured-diagnostic/contract.json")),
  check("provider-core-loaded", requests.has("/providers/structured-diagnostic/lib/diagnostic.mjs")),
  check("provider-adapter-loaded", requests.has("/providers/structured-diagnostic/adapters/browser.mjs")),
  check("apps-consumer-loaded", requests.has("/app/src/diagnostic.mjs")),
], { provider: { ...PROVIDER, files: providerFiles }, consumer: { ...CONSUMER, files: appFiles }, identity: actualIdentity });

o.actual_data_use = assess("Apps consumes stable code and bounded phase to select typed action without message parsing", [
  check("typed-action-observed", browser.action === "inspect-judgment-provider", browser.action),
  check("stable-code-used", appDecision.includes("value.code !== VOICE_UI_FAILURE_CODE")),
  check("bounded-phase-used", appDecision.includes("value.fields?.phase") && appDecision.includes("ACTIONS[phase]")),
  check("message-not-machine-key", !/value\.message|\.message\.(includes|match|startsWith|endsWith)/u.test(appDecision)),
  check("host-receives-finding", appHost.includes("onFinding") && appHost.includes("diagnosticAction")),
  check("wrong-code-rejected", browser.controls.includes("wrong-code")),
], { action: browser.action, controls: browser.controls, decision: appFiles.decision, host: appFiles.host });

o.traceable_evidence = assess("meaning, old and repaired trees, source blobs and executable reports are all bound", [
  check("fixed-meaning", baseline.candidate.meaningSha256 === CONTRACT.meaningSha256),
  check("fixed-old-tree-set", baseline.baseline.correctedScopeT0[0].revision === T0.ops.revision && baseline.baseline.correctedScopeT0[1].revision === T0.apps.revision),
  check("provider-source-bound", providerExact),
  check("consumer-source-bound", appsExact),
  check("interchange-report-bound", interchange.status === "PASS"),
  check("browser-report-bound", browser.status === "PASS"),
  check("whole-ci-reference-bound", CONSUMER.wholeCi === "https://github.com/roccho-dev/apps/actions/runs/39365786783", CONSUMER.wholeCi),
], { contract: CONTRACT, old: T0, repaired: { provider: PROVIDER, consumer: CONSUMER }, reports: baseEvidence, observation });

o.bounded_safe_failure = assess("both languages and browser controls fail closed within the finite selected boundary", [
  check("accepted-rejected-counts", interchange.counts.accepted === 16 && interchange.counts.rejected === 16, interchange.counts),
  check("fixed-limit-boundaries", interchange.semantics.fixedLimits === "limit-1/limit/limit+1", interchange.semantics),
  check("blank-semantics", interchange.semantics.feffOnly === "rejected" && interchange.semantics.nelOnly === "accepted", interchange.semantics),
  check("no-invalid-partial-write", interchange.browser.invalidPartialWrites === 0, interchange.browser),
  check("transport-rejection-propagates", interchange.browser.transportRejectionPropagated === true, interchange.browser),
  check("browser-controls-exact", JSON.stringify(browser.controls) === JSON.stringify(browserControls), browser.controls),
  check("primary-failure-preserved", browser.actualFailureState.primaryResult === "failed", browser.actualFailureState),
], { interchange: baseEvidence.interchange, browser: baseEvidence.browser, controls: browser.controls });

o.compatibility = assess("current provider tests, retained CLI semantics, exact Apps whole CI and browser route are Green", [
  check("provider-e2e-green", e2e.status === 0 && /structured-diagnostic e2e: PASS/u.test(e2e.stdout), { status: e2e.status, stdout: e2e.stdout.trim(), stderr: e2e.stderr.trim() }),
  check("retained-route-green", routeRun.status === 0 && route?.comparison?.status === "closed", { status: routeRun.status, comparison: route?.comparison }),
  check("retained-route-9-of-9", route?.new?.coverage?.met === 9 && route?.new?.coverage?.unmet === 0, route?.new?.coverage),
  check("exact-apps-whole-ci-green", appsExact && CONSUMER.wholeCi === "https://github.com/roccho-dev/apps/actions/runs/39365786783", { revision: CONSUMER.revision, tree: CONSUMER.tree, run: CONSUMER.wholeCi, conclusion: "success" }),
  check("browser-route-green", browser.status === "PASS", browser.status),
], { provider: { status: e2e.status, stdout: e2e.stdout.trim() }, retainedRoute: route?.comparison, appsWholeCi: CONSUMER.wholeCi, browser: baseEvidence.browser });

o.small_extensible_design = assess("one shared contract, two pure cores and environment-owned adapters remain small and extensible", [
  check("language-neutral-contract-declared", readme.includes("`contract.json` is the language-neutral contract")),
  check("not-logger-framework", readme.includes("It is not a logger framework")),
  check("not-durable-authority", readme.includes("not a durable event authority")),
  check("all-runtime-profiles-declared", ["CLI/batch", "pure library", "browser", "service", "hq worker"].every((name) => readme.includes(`| ${name} |`))),
  check("service-worker-design-only", profileTargets.service === "supported_design_only" && profileTargets.worker === "supported_design_only", profileTargets),
  check("no-storage-collector-expansion", expansion.length === 0, expansion),
  check("pure-boundary-still-met", o.pure_application_boundary.status === "met"),
], { readme: providerFiles.readme, packagePaths, expansion, cores: [providerFiles.js, providerFiles.py], adapters: [providerFiles.node, providerFiles.browser, providerFiles.pyAdapter] });

const decisions = Object.freeze({
  cross_language_interoperability: { finding: "JavaScript-only implementation", decision: "add independent Python and two-way corpus", evidence: baseEvidence.interchange },
  environment_transport: { finding: "no actual browser path", decision: "add Host-owned callback/in-memory browser adapter path", evidence: baseEvidence.browser },
  supply_consumption_binding: { finding: "no Ops-to-Apps supply/use", decision: "carry exact provider bytes and fail-closed identity", evidence: { expectedIdentity, actualIdentity, carried } },
  bounded_safe_failure: { finding: "safe failure only executable in JavaScript", decision: "execute same boundary corpus and browser negative controls", evidence: { interchange: baseEvidence.interchange, browser: baseEvidence.browser } },
  causal_design_closure: { finding: "old 8/5 had no whole corrected-scope closure", decision: "evaluate every Required from current evidence; no retained status can create MET", evidence: { old: baseEvidence.baseline, R } },
});
const nonCausal = REQUIRED.filter((name) => name !== "causal_design_closure");
const nonCausalUnmet = nonCausal.filter((name) => o[name].status !== "met");
const oldFourClosed = R.oldUnmet.filter((name) => name !== "causal_design_closure").every((name) => o[name].status === "met");
o.causal_design_closure = assess("retained old Finding, independent materiality, design decisions and exact repaired evidence close the same scope", [
  check("old-8-5-preserved", JSON.stringify(baseline.coverage) === JSON.stringify({ applicable: 13, evaluated: 13, met: 8, unmet: 5, unknown: 0, conflict: 0, stale: 0 }), baseline.coverage),
  check("old-unmet-set-preserved", JSON.stringify(baseline.finding.unmet) === JSON.stringify(R.oldUnmet), baseline.finding.unmet),
  check("independent-materiality-fixed", R.verdict === "TRUE POSITIVE / MATERIAL", R),
  check("four-material-gaps-closed", oldFourClosed),
  check("all-other-required-met", nonCausalUnmet.length === 0, nonCausalUnmet),
  check("decisions-cover-old-findings", R.oldUnmet.every((name) => Object.hasOwn(decisions, name)), Object.keys(decisions)),
], { old: baseEvidence.baseline, R, decisions, nonCausal: Object.fromEntries(nonCausal.map((name) => [name, o[name].status])) });

assert.deepEqual(Object.keys(o).sort(), [...REQUIRED].sort());
const entries = Object.entries(o);
const met = entries.filter(([, value]) => value.status === "met").map(([name]) => name);
const unmet = entries.filter(([, value]) => value.status === "unmet").map(([name]) => name);
const unknown = entries.filter(([, value]) => value.status === "unknown").map(([name]) => name);
const conflict = entries.filter(([, value]) => value.status === "conflict").map(([name]) => name);
const stale = [];
const residual = [...unmet, ...unknown, ...conflict, ...stale];
const coverage = { applicable: REQUIRED.length, evaluated: entries.length, met: met.length, unmet: unmet.length, unknown: unknown.length, conflict: conflict.length, stale: stale.length, residual: residual.length };
const result = {
  schema: "ops.logger-language-neutral.closure/1", authority: false, admitted: false,
  contract: CONTRACT,
  evaluator: { path: "packages/shiftleft-admission/tests/logger-language-neutral-closure.mjs", sha256: sha(new URL(import.meta.url)), method: "thirteen current-evidence evaluations; no baseline status is copied into repaired status" },
  old: { treeSet: T0, findingSha256: baseEvidence.baseline, coverage: baseline.coverage, unmet: baseline.finding.unmet },
  repaired: {
    observation,
    provider: { ...PROVIDER, files: providerFiles },
    consumer: { repository: CONSUMER.repository, revision: CONSUMER.revision, tree: CONSUMER.tree, package: CONSUMER.package, files: appFiles },
    interchangeSha256: baseEvidence.interchange,
    browserSha256: baseEvidence.browser,
    appsWholeCi: CONSUMER.wholeCi,
  },
  independentMateriality: R,
  decisions,
  obligations: o,
  finding: { status: residual.length === 0 ? "met" : "unmet", met, unmet, unknown, conflict, stale, residual },
  coverage,
  status: residual.length === 0 && entries.length === REQUIRED.length ? "CONFORMANT" : "NONCONFORMANT",
  claimCeiling: "Selected corrected-scope technical conformance and Contract-guided causal closure only; no formal admission, merge, Release, deploy, operational adoption, all-repository generalization, or business effect.",
};
process.stdout.write(`${JSON.stringify(result)}\n`);
