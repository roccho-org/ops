// Manual OPS676 trial operator. No Gold, scorer, credential acquisition or retry.
// R's frozen public manifest: {schema:'ops.raw-relations.live-bundle.v1',trialId,
// items:[16 ordered {id:'u01-original'|'u01-reverse'|...,plan:relativePath}],
// files:{every plan/Raw relative path:SHA256}}. Manifest SHA binds its bytes;
// manifest does not include itself in files. Unit ids carry no expected label.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import os from 'node:os';

const ORIGINAL_TRIAL = 'ops676-raw-relations-live-20261025-v1';
export const TRIAL = 'ops676-raw-relations-corrective-development-v2';
export const CONFIRMATION_TRIAL = 'ops676-raw-relations-corrective-confirmation-v2';
export const PRODUCT = 'bc1f991618a2f17ba0e4dc51f7811af5dddf72ac';
const DEVELOPMENT_SHA = '9288a688b4eadcc003f1a4f7b0dabe38977826c6fac05a03774a792f43193f02';
const CONFIRMATION_SHA = '91c24283190300becdb2d6fee700628caad93b38e27a797b1f0ee63dbcf820b2';

// Both inputs and the product/controller are frozen before stage1 dispatch.
// Stage2 receipt fields record external P/R acceptance; they do not prove it.
// P reconciles actual source/artifact/scoring and dispatch history before GO.
function stageIdentity(stage) {
  if (stage === 'development') return { stage, trialId: TRIAL };
  if (stage === 'confirmation') return { stage, trialId: CONFIRMATION_TRIAL };
  fail('INVALID_STAGE');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error(code); };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const closed = (x, keys) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const relative = p => typeof p === 'string' && /^[a-zA-Z0-9_./-]+$/.test(p)
  && !path.isAbsolute(p) && !p.split('/').some(s => !s || s === '.' || s === '..');

function members(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(e => {
    const p = prefix ? prefix + '/' + e.name : e.name;
    if (e.isSymbolicLink() || (!e.isFile() && !e.isDirectory())) fail('BUNDLE_MEMBER_TYPE');
    return e.isDirectory() ? members(dir, p) : [p];
  }).sort();
}

export async function inspectBundle({ product, bundle, bundleSha, stage = 'development' }) {
  const selected = stageIdentity(stage);
  const core = await import(pathToFileURL(path.join(product, 'packages/jev-review/raw-relations.mjs')));
  const { validateJevBudget } = await import(pathToFileURL(path.join(product, 'packages/jev-review/core.mjs')));
  const manifestFile = path.join(bundle, 'manifest.json');
  if (!fs.lstatSync(manifestFile).isFile() || fs.statSync(manifestFile).size > 65536) fail('BUNDLE_MANIFEST_FILE');
  const bytes = fs.readFileSync(manifestFile);
  if (sha(bytes) !== bundleSha) fail('BUNDLE_DIGEST');
  const manifest = core.strictJson(bytes.toString('utf8'));
  if (!closed(manifest, ['schema', 'trialId', 'items', 'files']) || manifest.schema !== 'ops.raw-relations.live-bundle.v1'
    || manifest.trialId !== (selected.stage === 'development' ? ORIGINAL_TRIAL : 'ops676-raw-relations-corrective-fresh-v1')
    || !Array.isArray(manifest.items) || manifest.items.length !== 16
    || !manifest.files || Array.isArray(manifest.files)) fail('BUNDLE_MANIFEST');
  const ids = Array.from({ length: 8 }, (_, i) => ['original', 'reverse'].map(order => `${stage === 'development' ? 'u' : 'f'}${String(i + 1).padStart(2, '0')}-${order}`)).flat();
  if (manifest.items.some((item, i) => !closed(item, ['id', 'plan']) || item.id !== ids[i])
    || new Set(manifest.items.map(item => item.plan)).size !== 16) fail('BUNDLE_ITEMS');
  const files = Object.keys(manifest.files).sort();
  if (files.length > 64 || files.some(p => !relative(p) || !/\.(json|jsonl)$/.test(p) || p === 'manifest.json')
    || JSON.stringify(members(bundle)) !== JSON.stringify(['manifest.json', ...files].sort())) fail('BUNDLE_FILE_SET');
  let total = 0;
  for (const p of files) {
    total += fs.statSync(path.join(bundle, p)).size;
    if (total > 4194304) fail('BUNDLE_BYTE_LIMIT');
    const bytes = fs.readFileSync(path.join(bundle, p));
    if (!/^[0-9a-f]{64}$/.test(manifest.files[p]) || sha(bytes) !== manifest.files[p]) fail('BUNDLE_FILE_HASH');
  }
  const used = new Set(manifest.items.map(item => item.plan));
  const plans = manifest.items.map(item => {
    const p = item.plan;
    if (!relative(p) || !files.includes(p)) fail('BUNDLE_PLAN');
    const file = path.join(bundle, p), plan = core.strictJson(fs.readFileSync(file, 'utf8'));
    if (plan.candidates?.length !== 1 || plan.obligations?.length !== 1 || plan.checks?.length !== 1
      || plan.filter !== undefined) fail('ONE_CANDIDATE_REQUIRED');
    for (const source of plan.sources ?? []) {
      if (!relative(source.path)) fail('SOURCE_NOT_BUNDLE_RELATIVE');
      const sourceFile = path.resolve(path.dirname(file), source.path);
      const rel = path.relative(bundle, sourceFile).split(path.sep).join('/');
      if (!relative(rel) || !files.includes(rel)) fail('SOURCE_OUTSIDE_BUNDLE');
      used.add(rel);
    }
    const resolved = core.resolvePlan(plan, path.dirname(file));
    const request = core.relationRequest(resolved, plan.candidates[0]);
    validateJevBudget(request.state, request.questions);
    return { id: item.id, path: p, binding: resolved.binding, kind: plan.checks[0].kind,
      questionMethod: core.QUESTION_METHOD, request,
      records: plan.candidates[0].participants.map(p => ({ role: p.role,
        raw: resolved.rows.find(row => row.sourceRef.source === p.source && row.sourceRef.revision === p.revision
          && row.sourceRef.occurrence === p.occurrence).raw })),
      participants: plan.candidates[0].participants, planFile: file };
  });
  if (used.size !== files.length) fail('UNUSED_BUNDLE_MEMBER');
  for (const kind of ['duplicate', 'inconsistent', 'shared_concept_different_angle', 'term_alias'])
    if (plans.filter(p => p.kind === kind).length !== 4) fail('FOUR_KINDS_REQUIRED');
  for (let i = 0; i < 16; i += 2) {
    const [a, b] = plans.slice(i, i + 2);
    if (a.kind !== b.kind || JSON.stringify(a.records) !== JSON.stringify([...b.records].reverse())) fail('PARTICIPANT_ORDER_PAIR');
    const pair = [a, b].map(p => core.strictJson(fs.readFileSync(p.planFile, 'utf8')));
    for (const field of ['sources', 'checks', 'context', 'candidateRule', 'scope', 'asOf'])
      if (JSON.stringify(pair[0][field]) !== JSON.stringify(pair[1][field])) fail('PAIR_CONTEXT_CHANGED');
  }
  // Gold and independence remain external R responsibilities; counts/order are
  // not inferred labels and this runner never scores semantic correctness.
  return { manifest, plans };
}

function execute(root, args, live) {
  const result = spawnSync(path.join(root, 'bin/jev-review'), ['raw-relations', ...args], {
    env: { LANG: 'C.UTF-8', ...(live ? { JEV_API_KEY: process.env.JEV_API_KEY } : {}) },
    encoding: 'utf8', timeout: 20000, maxBuffer: 8388608, shell: false,
  });
  // Never serialize raw child errors/streams into logs on failure.
  if (result.error || result.signal || result.status !== 0) fail('CHILD_FAILED_OR_UNKNOWN');
  return result.stdout;
}

function append(file, value) {
  const fd = fs.openSync(file, 'r+'); // absence is UNKNOWN, never create/refill
  try { fs.writeSync(fd, JSON.stringify(value) + '\n', fs.fstatSync(fd).size); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function boundedEvidence(out) {
  const size = members(out).reduce((n, p) => n + fs.statSync(path.join(out, p)).size, 0);
  if (size > 67108864) fail('EVIDENCE_BYTE_LIMIT');
}

function identity() {
  const { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
    GITHUB_RUN_ATTEMPT: attempt, GITHUB_RUN_ID: runId, GITHUB_SHA: workflow,
    GITHUB_WORKFLOW_SHA: workflowSource, EXPECTED_WORKFLOW_SHA: expected,
    RAW_RELATIONS_STAGE: stage, TRIAL_ID: trialId, BUNDLE_SHA: bundleSha,
    STAGE1_ROOT_GO: rootGo, STAGE1_RUN_ID: stage1RunId,
    STAGE1_ARTIFACT_SHA256: stage1ArtifactSha256, STAGE1_REPORT_SHA256: stage1ReportSha256 } = process.env;
  const selected = stageIdentity(stage);
  if (repo !== 'roccho-org/ops' || event !== 'workflow_dispatch' || ref !== 'refs/heads/codex/raw-annotations-676-20261024'
    || attempt !== '1' || !/^\d+$/.test(runId ?? '') || !/^[a-f0-9]{40}$/.test(expected ?? '')
    || workflow !== expected || workflowSource !== expected || trialId !== selected.trialId
    || bundleSha !== (stage === 'development' ? DEVELOPMENT_SHA : CONFIRMATION_SHA)) fail('TRIAL_IDENTITY');
  if (stage === 'confirmation' ? rootGo !== 'true' || !/^[1-9]\d*$/.test(stage1RunId ?? '') || stage1RunId === runId
    || !/^[a-f0-9]{64}$/.test(stage1ArtifactSha256 ?? '') || !/^[a-f0-9]{64}$/.test(stage1ReportSha256 ?? '')
    : rootGo !== 'false' || stage1RunId !== '' || stage1ArtifactSha256 !== '' || stage1ReportSha256 !== '') fail('STAGE1_EXTERNAL_ACCEPTANCE_REQUIRED');
  return { ...selected, runId, workflow, product: PRODUCT, stage1RootGo: rootGo === 'true',
    stage1RunId, stage1ArtifactSha256, stage1ReportSha256,
    acceptanceVerification: 'EXTERNAL_P_R_NOT_MACHINE_PROOF' };
}

export async function prepare(options, exec = execute, owner = identity()) {
  if (owner.stage !== (options.stage ?? 'development') || owner.trialId !== stageIdentity(owner.stage).trialId) fail('STAGE_BINDING');
  const inspected = await inspectBundle(options);
  fs.mkdirSync(options.out, { mode: 0o700 }); // fresh only; never resume/refill
  const baseline = [];
  for (let i = 0; i < inspected.plans.length; i++) {
    const p = inspected.plans[i], file = path.join(options.out, `baseline-${i}.json`);
    exec(options.root, ['evaluate', p.planFile, file], false);
    const d = read(file);
    if (d.binding !== p.binding || d.accounting.provider !== 'baseline' || d.accounting.calls !== 0) fail('BASELINE_BINDING');
    const exported = exec(options.root, ['project', p.planFile, file], false);
    fs.writeFileSync(path.join(options.out, `baseline-${i}.jsonl`), exported, { flag: 'wx', mode: 0o600 });
    baseline.push(sha(fs.readFileSync(file)));
    boundedEvidence(options.out);
  }
  const prepared = { schema: 'ops.raw-relations.trial-prepared.v2', ...owner, root: options.root,
    bundleSha: options.bundleSha,
    plans: inspected.plans.map(({ planFile: _file, ...p }) => p), bindings: inspected.plans.map(p => p.binding), baseline };
  fs.copyFileSync(path.join(options.bundle, 'manifest.json'), path.join(options.out, 'bundle-manifest.json'), fs.constants.COPYFILE_EXCL);
  write(path.join(options.out, 'prepared.json'), prepared);
  write(path.join(options.out, 'reservations.jsonl'), { ...owner, event: 'PREPARED', bundleSha: options.bundleSha,
    preparedSha256: sha(fs.readFileSync(path.join(options.out, 'prepared.json'))) });
  boundedEvidence(options.out);
  return prepared;
}

export async function trial(options, exec = execute, owner = identity(), clock = () => performance.now()) {
  if (owner.stage !== (options.stage ?? 'development') || owner.trialId !== stageIdentity(owner.stage).trialId) fail('STAGE_BINDING');
  const journal = path.join(options.out, 'reservations.jsonl');
  if (!fs.existsSync(journal)) fail('MISSING_JOURNAL_UNKNOWN_NO_REFILL');
  const entries = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  if (entries.length !== 1 || entries[0].event !== 'PREPARED'
    || Object.keys(owner).some(k => entries[0][k] !== owner[k])) fail('PRIOR_ATTEMPTS_UNKNOWN_NO_REFILL');
  const prepared = read(path.join(options.out, 'prepared.json'));
  const inspected = await inspectBundle(options);
  if (entries[0].preparedSha256 !== sha(fs.readFileSync(path.join(options.out, 'prepared.json')))
    || prepared.schema !== 'ops.raw-relations.trial-prepared.v2' || prepared.root !== options.root || prepared.bundleSha !== options.bundleSha
    || Object.keys(owner).some(k => prepared[k] !== owner[k])
    || JSON.stringify(prepared.bindings) !== JSON.stringify(inspected.plans.map(p => p.binding))
    || prepared.baseline.some((h, i) => sha(fs.readFileSync(path.join(options.out, `baseline-${i}.json`))) !== h)) fail('PREPARED_BINDING');
  if (!process.env.JEV_API_KEY?.trim()) fail('OWNER_KEY_MISSING');
  let calls = 0, confirmedPostCalls = 0, actualCallsKnown = true, waitMs = 0, tokens = 0, usageKnown = true, stop = null;
  for (let i = 0; i < inspected.plans.length; i++) {
    if (waitMs + 20000 > 600000 || tokens >= 100000) { stop = 'TRIAL_TIME_OR_TOKEN_STOP'; break; }
    const p = inspected.plans[i], file = path.join(options.out, `jev-${i}.json`);
    // Durable reservation precedes EVERY possible POST. Unknown attempt is spent.
    append(journal, { ...owner, event: 'RESERVED', sequence: i, plan: p.path, binding: p.binding });
    calls++;
    const started = clock();
    try {
      exec(options.root, ['evaluate', p.planFile, file, '--provider', 'jev'], true);
    } catch {
      waitMs += clock() - started; usageKnown = false; actualCallsKnown = false; stop = 'CHILD_FAILED_OR_UNKNOWN';
      append(journal, { event: 'UNKNOWN', sequence: i }); break;
    }
    waitMs += clock() - started;
    try {
    const d = read(file);
    // Preserve raw D before interpretation; project uses the installed product.
    const exported = exec(options.root, ['project', p.planFile, file], false);
    fs.writeFileSync(path.join(options.out, `jev-${i}.jsonl`), exported, { flag: 'wx', mode: 0o600 });
    if (!Number.isFinite(waitMs) || waitMs < 0 || d.binding !== p.binding || d.accounting.provider !== 'jev'
      || d.accounting.calls !== 1 || d.outcomes.length !== 1) fail('ATTEMPT_EVIDENCE_UNKNOWN');
    const o = d.outcomes[0], reported = d.accounting.reportedTokens;
    if (o.execution === 'COMPLETED' && o.evidenceValidity === 'VALID') confirmedPostCalls++;
    else { actualCallsKnown = false; usageKnown = false; }
    append(journal, { event: 'OBSERVED', sequence: i, assessment: o.assessment,
      execution: o.execution, reportedTokens: reported, dSha256: sha(fs.readFileSync(file)) });
    if (reported === null || !Number.isSafeInteger(reported) || reported < 0) usageKnown = false;
    else tokens += reported;
    boundedEvidence(options.out);
    if (!usageKnown
      || o.execution !== 'COMPLETED' || o.evidenceValidity !== 'VALID' || o.assessment === 'UNKNOWN') {
      stop = 'MISSING_USAGE_FAILED_OR_UNKNOWN'; break;
    }
    } catch {
      usageKnown = false; actualCallsKnown = false; stop = 'ATTEMPT_EVIDENCE_UNKNOWN';
      append(journal, { event: 'UNKNOWN', sequence: i }); break;
    }
  }
  const result = { schema: 'ops.raw-relations.trial-run.v2', ...owner, plannedObservations: 16, reservedAttempts: calls,
    actualPostCalls: actualCallsKnown ? confirmedPostCalls : null, confirmedPostCalls,
    actualCallsStatus: actualCallsKnown ? 'CONFIRMED' : 'UNKNOWN', waitMs,
    reportedTokens: usageKnown ? tokens : null, knownSubtotal: tokens,
    usageStatus: usageKnown ? 'REPORTED' : 'UNKNOWN', stop, completed: !stop && calls === 16, dollars: 'UNKNOWN',
    preparationReviewEffort: 'UNKNOWN', semanticQuality: 'NOT_SCORED_R_EXTERNAL',
    tokenPolicy: 'OBSERVED_STOP_NOT_HARD_CAP' };
  write(path.join(options.out, 'run.json'), result);
  return result;
}

async function selftest(product) {
  const core = await import(pathToFileURL(path.join(product, 'packages/jev-review/raw-relations.mjs')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops676-trial-public-'));
  const bundle = path.join(tmp, 'bundle'); fs.mkdirSync(bundle);
  const sample = read(path.join(product, 'packages/jev-review/tests/fixtures/raw-relations/plan.json'));
  fs.copyFileSync(path.join(product, 'packages/jev-review/tests/fixtures/raw-relations/raw.jsonl'), path.join(bundle, 'raw.jsonl'));
  const plans = [];
  for (let i = 0; i < 16; i++) {
    const p = structuredClone(sample), k = sample.candidates[[0, 1, 2, 3][Math.floor(i / 4)]];
    p.candidates = [structuredClone(k)];
    if (i % 2) p.candidates[0].participants.reverse();
    p.obligations = structuredClone(p.candidates); p.checks = [sample.checks.find(c => c.id === k.check)];
    const name = `plan-${i}.json`; write(path.join(bundle, name), p); plans.push(name);
  }
  const files = Object.fromEntries(members(bundle).map(p => [p, sha(fs.readFileSync(path.join(bundle, p)))]));
  const items = plans.map((plan, i) => ({ id: `u${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${i % 2 ? 'reverse' : 'original'}`, plan }));
  write(path.join(bundle, 'manifest.json'), { schema: 'ops.raw-relations.live-bundle.v1', trialId: ORIGINAL_TRIAL, items, files });
  const bundleSha = sha(fs.readFileSync(path.join(bundle, 'manifest.json')));
  const owner = { stage: 'development', trialId: TRIAL, runId: 'PUBLIC_TEST', workflow: 'PUBLIC_TEST', product: PRODUCT };
  const opts = { product, bundle, bundleSha, root: '/public-test-only', out: path.join(tmp, 'ok') };
  const fixedEnv = { GITHUB_REPOSITORY: 'roccho-org/ops', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/codex/raw-annotations-676-20261024', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), EXPECTED_WORKFLOW_SHA: 'a'.repeat(40),
    RAW_RELATIONS_STAGE: 'development', TRIAL_ID: TRIAL, BUNDLE_SHA: DEVELOPMENT_SHA,
    STAGE1_ROOT_GO: 'false', STAGE1_RUN_ID: '', STAGE1_ARTIFACT_SHA256: '', STAGE1_REPORT_SHA256: '' };
  const savedEnv = Object.fromEntries(Object.keys(fixedEnv).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, fixedEnv);
    assert.equal(identity().trialId, TRIAL);
    for (const [key, invalid] of [['GITHUB_REPOSITORY', 'other/ops'], ['GITHUB_EVENT_NAME', 'pull_request'],
      ['GITHUB_EVENT_NAME', 'push'], ['GITHUB_REF', 'refs/heads/proposals'], ['GITHUB_RUN_ATTEMPT', '2'],
      ['GITHUB_SHA', 'b'.repeat(40)], ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)], ['TRIAL_ID', ORIGINAL_TRIAL],
      ['BUNDLE_SHA', '0'.repeat(64)], ['RAW_RELATIONS_STAGE', 'confirmation']]) {
      process.env[key] = invalid;
      assert.throws(() => identity(), /TRIAL_IDENTITY/);
      process.env[key] = fixedEnv[key];
    }
    Object.assign(process.env, { RAW_RELATIONS_STAGE: 'confirmation', TRIAL_ID: CONFIRMATION_TRIAL,
      BUNDLE_SHA: CONFIRMATION_SHA, STAGE1_ROOT_GO: 'true', STAGE1_RUN_ID: '122',
      STAGE1_ARTIFACT_SHA256: 'b'.repeat(64), STAGE1_REPORT_SHA256: 'c'.repeat(64) });
    const confirmationIdentity = identity();
    assert.equal(confirmationIdentity.stage1RunId, '122');
    assert.equal(confirmationIdentity.acceptanceVerification, 'EXTERNAL_P_R_NOT_MACHINE_PROOF');
    for (const [key, invalid] of [['STAGE1_ROOT_GO', 'false'], ['STAGE1_RUN_ID', ''], ['STAGE1_RUN_ID', '123'],
      ['STAGE1_ARTIFACT_SHA256', ''], ['STAGE1_REPORT_SHA256', 'not-a-digest']]) {
      const saved = process.env[key]; process.env[key] = invalid;
      assert.throws(() => identity(), /STAGE1_EXTERNAL_ACCEPTANCE_REQUIRED/);
      process.env[key] = saved;
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const fake = (mode = 'ok') => (root, [operation, planFile, dFile, ...flags], live) => {
    const p = core.strictJson(fs.readFileSync(planFile, 'utf8'));
    const resolved = core.resolvePlan(p, path.dirname(planFile));
    if (operation === 'project') {
      if (live) fail('PROJECT_MUST_BE_KEYLESS');
      if (mode === 'project-failed' && path.basename(dFile).startsWith('jev-')) fail('PUBLIC_PROJECT_FAILURE');
      return 'PUBLIC_TEST_EXPORT\n';
    }
    // Caller path/reservation is tested without any provider or real subprocess.
    assert.equal(live, flags.includes('jev'));
    const d = { binding: resolved.binding, accounting: { provider: live ? 'jev' : 'baseline', calls: live ? 1 : 0,
      reportedTokens: mode === 'missing' ? null : mode === 'tokens' ? 100000 : 2 },
      outcomes: [{ execution: mode === 'failed' ? 'FAILED' : 'COMPLETED', evidenceValidity: mode === 'failed' ? 'INVALID' : 'VALID', assessment: mode === 'unknown' ? 'UNKNOWN' : 'NEGATIVE' }] };
    if (live && mode === 'throw') throw Error('PUBLIC_FAILURE');
    if (live && mode === 'malformed') fs.writeFileSync(dFile, '{', { flag: 'wx' });
    else write(dFile, d);
    return '';
  };
  // No key value printed or sourced; only an explicitly synthetic test slot.
  if (process.env.JEV_API_KEY !== undefined) fail('SELFTEST_MUST_BE_PRESECRET');
  await inspectBundle(opts);
  await assert.rejects(inspectBundle({ ...opts, stage: 'confirmation' }), /BUNDLE_MANIFEST/);
  await assert.rejects(prepare(opts, fake(), { ...owner, trialId: CONFIRMATION_TRIAL }), /STAGE_BINDING/);
  await assert.rejects(inspectBundle({ ...opts, bundleSha: '0'.repeat(64) }), /BUNDLE_DIGEST/);
  // A malformed final plan must refuse the entire run before even baseline 0.
  const last = path.join(bundle, plans[15]), savedPlan = fs.readFileSync(last);
  const manifestFile = path.join(bundle, 'manifest.json'), savedManifest = fs.readFileSync(manifestFile);
  fs.writeFileSync(last, '{"schema":1,"schema":2}');
  const badManifest = JSON.parse(savedManifest); badManifest.files[plans[15]] = sha(fs.readFileSync(last));
  fs.writeFileSync(manifestFile, JSON.stringify(badManifest));
  let preflightCalls = 0;
  await assert.rejects(prepare({ ...opts, bundleSha: sha(fs.readFileSync(manifestFile)), out: path.join(tmp, 'invalid-late') },
    () => { preflightCalls++; }, owner), /INVALID_OR_DUPLICATE_JSON/);
  assert.equal(preflightCalls, 0); assert.equal(fs.existsSync(path.join(tmp, 'invalid-late')), false);
  fs.writeFileSync(last, savedPlan); fs.writeFileSync(manifestFile, savedManifest);
  const confirmationBundle = path.join(tmp, 'confirmation-bundle'); fs.mkdirSync(confirmationBundle);
  for (const p of members(bundle)) fs.copyFileSync(path.join(bundle, p), path.join(confirmationBundle, p));
  const confirmationManifest = read(manifestFile);
  confirmationManifest.trialId = 'ops676-raw-relations-corrective-fresh-v1';
  confirmationManifest.items = confirmationManifest.items.map(item => ({ ...item, id: item.id.replace(/^u/, 'f') }));
  fs.writeFileSync(path.join(confirmationBundle, 'manifest.json'), JSON.stringify(confirmationManifest));
  const confirmationOptions = { ...opts, stage: 'confirmation', bundle: confirmationBundle,
    bundleSha: sha(fs.readFileSync(path.join(confirmationBundle, 'manifest.json'))), out: path.join(tmp, 'confirmation') };
  const confirmationOwner = { ...owner, stage: 'confirmation', trialId: CONFIRMATION_TRIAL,
    stage1RootGo: true, stage1RunId: '122', stage1ArtifactSha256: 'b'.repeat(64), stage1ReportSha256: 'c'.repeat(64) };
  await inspectBundle(confirmationOptions);
  await assert.rejects(trial(opts, fake(), owner), /MISSING_JOURNAL/);
  const noKey = { ...opts, out: path.join(tmp, 'no-key') };
  await prepare(noKey, fake(), owner);
  await assert.rejects(trial(noKey, () => fail('MUST_NOT_EXECUTE'), owner), /OWNER_KEY_MISSING/);
  const modified = { ...opts, out: path.join(tmp, 'modified-prepared') };
  await prepare(modified, fake(), owner);
  fs.appendFileSync(path.join(modified.out, 'prepared.json'), ' ');
  await assert.rejects(trial(modified, () => fail('MUST_NOT_EXECUTE'), owner), /PREPARED_BINDING/);
  process.env.JEV_API_KEY = 'PUBLIC_SYNTHETIC_TEST_ONLY';
  try {
    for (const mode of ['ok', 'missing', 'failed', 'unknown', 'tokens', 'throw', 'malformed', 'project-failed']) {
      const o = { ...opts, out: path.join(tmp, mode) };
      await prepare(o, fake(), owner);
      const r = await trial(o, fake(mode), owner);
      assert.equal(r.reservedAttempts, mode === 'ok' ? 16 : 1);
      assert.equal(r.completed, mode === 'ok');
      if (['missing', 'failed', 'throw', 'malformed', 'project-failed'].includes(mode)) assert.equal(r.reportedTokens, null);
      if (['failed', 'throw', 'malformed', 'project-failed'].includes(mode)) assert.equal(r.actualPostCalls, null);
      await assert.rejects(trial(o, fake(), owner), /PRIOR_ATTEMPTS/);
    }
    const timed = { ...opts, out: path.join(tmp, 'time') };
    await prepare(timed, fake(), owner);
    let tick = 0;
    const timedResult = await trial(timed, fake(), owner, () => tick++ ? 600001 : 0);
    assert.equal(timedResult.reservedAttempts, 1); assert.equal(timedResult.stop, 'TRIAL_TIME_OR_TOKEN_STOP');
    await prepare(confirmationOptions, fake(), confirmationOwner);
    await assert.rejects(trial(confirmationOptions, () => fail('MUST_NOT_EXECUTE'), { ...confirmationOwner, stage1ReportSha256: 'd'.repeat(64) }), /PRIOR_ATTEMPTS/);
    const confirmed = await trial(confirmationOptions, fake(), confirmationOwner);
    assert.equal(confirmed.completed, true); assert.equal(confirmed.reservedAttempts, 16);
    assert.equal(confirmed.stage1ReportSha256, confirmationOwner.stage1ReportSha256);
    await assert.rejects(trial(confirmationOptions, fake(), confirmationOwner), /PRIOR_ATTEMPTS/);
  } finally { delete process.env.JEV_API_KEY; }
  console.log(JSON.stringify({ selftest: 'PASS', realProviderCalls: 0, semanticQuality: 'NOT_PROVEN' }));
}

async function main() {
  const [mode, product, root, bundle, bundleSha, out, extra] = process.argv.slice(2);
  if (mode === 'selftest' && product && !root) return selftest(path.resolve(product));
  if (!['prepare', 'run'].includes(mode) || !product || !root || !bundle || !/^[a-f0-9]{64}$/.test(bundleSha ?? '') || !out || extra) fail('TRIAL_ARGS');
  const options = { product: path.resolve(product), root: path.resolve(root), bundle: path.resolve(bundle), bundleSha, out: path.resolve(out), stage: process.env.RAW_RELATIONS_STAGE };
  const result = mode === 'prepare' ? await prepare(options) : await trial(options);
  console.log(JSON.stringify(result));
  if (mode === 'run' && !result.completed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('RAW_RELATIONS_TRIAL_FAILED_OR_UNKNOWN'); process.exitCode = 1; });
