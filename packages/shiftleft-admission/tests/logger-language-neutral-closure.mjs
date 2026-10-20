#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(key?.startsWith("--") && value, `invalid argument at ${index}`);
  args.set(key.slice(2), value);
}

const requireArg = (name) => {
  const value = args.get(name);
  assert.ok(value, `--${name} is required`);
  return path.resolve(value);
};

const opsRoot = requireArg("ops");
const appsRoot = requireArg("apps");
const baselinePath = requireArg("baseline");
const interchangePath = requireArg("interchange");
const browserPath = requireArg("browser");

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
  ops: {
    revision: "d1ed2594aa6112f931ff3996c89d8fde8aed8690",
    tree: "27c40aee9b923129e0feefa8477da711155c8384",
  },
  apps: {
    revision: "c91bab56ec5e769d9788453a098a289115cdaa92",
    tree: "a32423848d2298b4c54cf43cd22119859f25c905",
  },
});

const PROVIDER = Object.freeze({
  repository: "roccho-org/ops",
  revision: "fe968fc6b8919fed48151a57f421667bce0aac87",
  tree: "b306bf999aba32a678ac48b5a56e4b4a0a3c0cf8",
  files: {
    contract: {
      path: "packages/structured-diagnostic/contract.json",
      blob: "8df122c2e3205328a0f922c3397e7246ae1e0e16",
    },
    core: {
      path: "packages/structured-diagnostic/lib/diagnostic.mjs",
      blob: "135ec3331f82af2ab310518cc8b4a356ccefcf3f",
    },
    browserAdapter: {
      path: "packages/structured-diagnostic/adapters/browser.mjs",
      blob: "f9dfe0616a3abf64fe4af06b949d377ea5de96b2",
    },
  },
});

const APPS_REPAIR = Object.freeze({
  repository: "roccho-dev/apps",
  revision: "17c0108a5c2549ffaf7cef791a569f2e1926659f",
  tree: "3d603665d54c83dd770873870c66863959904b42",
  package: "packages/voice-ui",
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

const run = (command, commandArgs, cwd) => {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};

const git = (root, ...commandArgs) => {
  const result = run("git", commandArgs, root);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const gitBlob = (file) => {
  const bytes = fs.readFileSync(file);
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
};

const sha256File = (file) => `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

assert.equal(git(appsRoot, "rev-parse", "HEAD"), APPS_REPAIR.revision);
assert.equal(git(appsRoot, "rev-parse", "HEAD^{tree}"), APPS_REPAIR.tree);
assert.equal(git(opsRoot, "rev-parse", `${PROVIDER.revision}^{tree}`), PROVIDER.tree);

const providerFiles = Object.fromEntries(Object.entries(PROVIDER.files).map(([name, identity]) => {
  const current = path.join(opsRoot, identity.path);
  assert.equal(git(opsRoot, "rev-parse", `${PROVIDER.revision}:${identity.path}`), identity.blob, `${name} provider blob drifted`);
  assert.equal(gitBlob(current), identity.blob, `${name} current bytes differ from selected provider revision`);
  return [name, { ...identity, sha256: sha256File(current) }];
}));

const identityPath = path.join(appsRoot, APPS_REPAIR.package, "web/providers/structured-diagnostic/identity.json");
const appsIdentity = readJson(identityPath);
assert.deepEqual(
  {
    repository: appsIdentity.repository,
    revision: appsIdentity.revision,
    tree: appsIdentity.tree,
    contractBlob: appsIdentity.contractBlob,
    coreBlob: appsIdentity.coreBlob,
    browserAdapterBlob: appsIdentity.browserAdapterBlob,
  },
  {
    repository: PROVIDER.repository,
    revision: PROVIDER.revision,
    tree: PROVIDER.tree,
    contractBlob: PROVIDER.files.contract.blob,
    coreBlob: PROVIDER.files.core.blob,
    browserAdapterBlob: PROVIDER.files.browserAdapter.blob,
  },
);

const appsProviderRoot = path.join(appsRoot, APPS_REPAIR.package, "web/providers/structured-diagnostic");
for (const identity of Object.values(PROVIDER.files)) {
  const relative = identity.path.replace("packages/structured-diagnostic/", "");
  const carried = path.join(appsProviderRoot, relative);
  assert.equal(gitBlob(carried), identity.blob, `Apps carried provider drifted: ${relative}`);
  assert.deepEqual(fs.readFileSync(carried), fs.readFileSync(path.join(opsRoot, identity.path)), `Apps carried bytes differ: ${relative}`);
}

const baseline = readJson(baselinePath);
assert.equal(baseline.candidate.meaningSha256, CONTRACT.meaningSha256);
assert.deepEqual(baseline.baseline.correctedScopeT0.map(({ revision, tree }) => ({ revision, tree })), [T0.ops, T0.apps]);
assert.deepEqual(baseline.coverage, {
  applicable: 13,
  evaluated: 13,
  met: 8,
  unmet: 5,
  unknown: 0,
  conflict: 0,
  stale: 0,
});
assert.deepEqual(baseline.finding.unmet, [
  "cross_language_interoperability",
  "environment_transport",
  "supply_consumption_binding",
  "bounded_safe_failure",
  "causal_design_closure",
]);

const interchange = readJson(interchangePath);
assert.equal(interchange.schema, "diagnostic-interchange-proof/1");
assert.equal(interchange.status, "PASS");
assert.equal(interchange.authority, false);
assert.equal(interchange.implementation.pythonDelegatesToNode, false);
assert.equal(interchange.interchange.javascriptToPython, "byte-identical");
assert.equal(interchange.interchange.pythonToJavascript, "byte-identical");
assert.equal(interchange.semantics.feffOnly, "rejected");
assert.equal(interchange.semantics.nelOnly, "accepted");
assert.equal(interchange.semantics.fixedLimits, "limit-1/limit/limit+1");
assert.equal(interchange.browser.invalidPartialWrites, 0);
assert.equal(interchange.browser.transportRejectionPropagated, true);

const browser = readJson(browserPath);
assert.equal(browser.schema, "voice-ui.browser-diagnostic-proof/1");
assert.equal(browser.status, "PASS");
assert.equal(browser.authority, false);
assert.equal(browser.providerRevision, PROVIDER.revision);
assert.equal(browser.action, "inspect-judgment-provider");
assert.deepEqual(browser.actualFailureState, {
  state: "failed",
  primaryResult: "failed",
  transport: "accepted",
});
assert.deepEqual(browser.controls, [
  "wrong-source",
  "wrong-code",
  "invalid-diagnostic",
  "transport-preserved-primary",
]);

const decisions = Object.freeze({
  cross_language_interoperability: {
    finding: "JavaScript-only provider had no independent second implementation or two-way common corpus",
    decision: "add a standard-library Python implementation and execute the same finite corpus in both directions",
    evidence: {
      report: sha256File(interchangePath),
      javascriptToPython: interchange.interchange.javascriptToPython,
      pythonToJavascript: interchange.interchange.pythonToJavascript,
    },
  },
  environment_transport: {
    finding: "the fixed Apps T0 had no actual browser diagnostic path",
    decision: "keep the common core effect-free and add a browser-owned callback/in-memory port observed through the production MutationObserver path",
    evidence: {
      report: sha256File(browserPath),
      action: browser.action,
      actualFailureState: browser.actualFailureState,
      requests: browser.requests,
    },
  },
  supply_consumption_binding: {
    finding: "the fixed Apps T0 did not receive or execute the selected Ops provider package",
    decision: "carry exact selected provider bytes with fail-closed revision/tree/blob identity and execute them in voice-ui",
    evidence: {
      provider: PROVIDER,
      consumer: APPS_REPAIR,
      identitySha256: sha256File(identityPath),
    },
  },
  bounded_safe_failure: {
    finding: "strict validation and rejection existed only in JavaScript and browser rejection was unobserved",
    decision: "make both runtimes reject the same boundary corpus and retain invalid/no-partial-write/transport-failure controls without changing the caller-owned failure",
    evidence: {
      accepted: interchange.counts.accepted,
      rejected: interchange.counts.rejected,
      actualFailureState: browser.actualFailureState,
      controls: browser.controls,
    },
  },
  causal_design_closure: {
    finding: "a pre-repair 8/5 Finding existed without an accepted old/new implementation closure",
    decision: "bind each material Finding to the minimal implementation change and independently evaluate the repaired exact tree set",
    evidence: {
      oldFinding: sha256File(baselinePath),
      providerRevision: PROVIDER.revision,
      appsRevision: APPS_REPAIR.revision,
    },
  },
});

const obligations = Object.fromEntries(REQUIRED.map((name) => [name, {
  status: "met",
  evidence: decisions[name] ?? {
    baselineStatus: baseline.obligations[name]?.status ?? "met",
    retained: true,
  },
}]));
assert.deepEqual(Object.keys(obligations), [...REQUIRED]);
assert.equal(Object.values(obligations).every(({ status }) => status === "met"), true);

const result = {
  schema: "ops.logger-language-neutral.closure/1",
  authority: false,
  admitted: false,
  contract: CONTRACT,
  old: {
    treeSet: T0,
    findingSha256: sha256File(baselinePath),
    coverage: baseline.coverage,
    unmet: baseline.finding.unmet,
  },
  repaired: {
    provider: {
      ...PROVIDER,
      files: providerFiles,
    },
    consumer: APPS_REPAIR,
    interchangeSha256: sha256File(interchangePath),
    browserSha256: sha256File(browserPath),
  },
  decisions,
  obligations,
  coverage: {
    applicable: REQUIRED.length,
    evaluated: REQUIRED.length,
    met: REQUIRED.length,
    unmet: 0,
    unknown: 0,
    conflict: 0,
    stale: 0,
    residual: 0,
  },
  status: "CONFORMANT",
  claimCeiling: "Selected corrected-scope technical conformance and Contract-guided causal closure only; no formal admission, merge, Release, deploy, operational adoption, all-repository generalization, or business effect.",
};

process.stdout.write(`${JSON.stringify(result)}\n`);
