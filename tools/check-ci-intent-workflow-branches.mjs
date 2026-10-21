#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXACT = "${{ github.sha }}";
const JEV_ORG_WORKFLOW = ".github/workflows/jev-issue-comment.yml";
const SYS1_PROOF_WORKFLOW = ".github/workflows/sys1-improvement-proof.yml";
const SELF_GRADING_WORKFLOW = ".github/workflows/sys1-self-grading-proof.yml";
const FEEDBACK_WORKFLOW = ".github/workflows/sys1-feedback-improvement.yml";
const TARGET_LOOP_WORKFLOW = ".github/workflows/sys1-target-loop.yml";
const COUNTERFACTUAL_WORKFLOW = ".github/workflows/sys1-counterfactual.yml";
const REAL_CASE_WORKFLOW = ".github/workflows/sys1-real-case-evaluation.yml";
const OBSERVATION_WORKFLOW = ".github/workflows/sys1-observation-improvement.yml";
const RESERVE_WORKFLOW = ".github/workflows/sys1-observation-reserve.yml";
const CENSUS_WORKFLOW = ".github/workflows/sys1-observation-census.yml";
const EXPECTATION_WORKFLOW = ".github/workflows/sys1-expectation-census.yml";
const EXPECTATION_ROLE_WORKFLOW = ".github/workflows/sys1-expectation-role.yml";
const EXPECTATION_OR_WORKFLOW = ".github/workflows/sys1-expectation-or.yml";
const REGRESSION_WORKFLOW = ".github/workflows/sys1-regression-repair.yml";
const JEV_MULTI_GUARD = "github.event_name == 'issue_comment' && github.event.repository.owner.type == 'Organization' && (github.event.comment.body == '/jev-evaluate' || (github.event.issue.pull_request != null && github.repository == 'roccho-org/ops' && github.event.issue.number == 522 && startsWith(github.event.comment.body, fromJSON('\"/jev-evaluate\\n\"')))) && ((github.event.issue.pull_request == null && ((github.repository == 'roccho-org/ops' && github.event.issue.number == 483) || (github.repository == 'roccho-org/envs' && github.event.issue.number == 52))) || (github.event.issue.pull_request != null && github.repository == 'roccho-org/ops' && (github.event.issue.number == 511 || github.event.issue.number == 522)))";
const JEV_PLAN_RUN = [
  'set -euo pipefail',
  '"$JEV_NODE" "$JEV_SRC/issue-executor.mjs" plan "$JEV_RUN_DIR"',
  'if [ -f "$JEV_RUN_DIR/plan.json" ]; then',
  "  echo 'planned=true' >> \"$GITHUB_OUTPUT\"",
  'fi',
].join("\n");
const WORKER_EFFECT_WORKFLOW = ".github/workflows/voice-ui-target-runtime.yml";
const WORKER_EFFECT_DEPLOY_SHA = "bce3daab76c9a4565902205cc59bb443f6e68009";
const WORKER_EFFECT_ISOLATION_SHA = "480d32a0e9e0e00ac4675c544e59c2aff325a64c6ae2bc30916e98e4ac1817c7";
const hasSecret = value => /\bsecrets(?:\s*[.\[]|")/.test(JSON.stringify(value));
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const need = (ok, message) => { if (!ok) throw new Error(message); };

// These two existing products do not consume the shared CI registry. Keep
// workflow-edit verification on PRs, but publish only for product-input pushes.
const isolatedProducts = {
  ".github/workflows/artifact-runtime-release.yml": [
    "verification/artifact-runtime-publication/**", "verification/artifact-runtime-app/**",
  ],
  ".github/workflows/ops-task-runtime-release.yml": [
    "packages/ops-task-runtime/**", "packages/gosh/**", "packages/ops-portable-runtime-pack/**",
    "packages/chatgpt-capability/ingress/carrier-job.mjs", "verification/raw-artifact-carry/**",
  ],
};
export function assertIsolatedPublisherPaths(workflow, filename) {
  const products = isolatedProducts[filename];
  if (!products) return;
  const events = workflow.on;
  need(events && typeof events === "object" && !Array.isArray(events), `${filename}: explicit events required`);
  need(same(Object.keys(events), ["pull_request", "push", "workflow_dispatch"]), `${filename}: event set differs`);
  need(Object.hasOwn(events, "workflow_dispatch"), `${filename}: manual entry missing`);
  for (const [event, expected] of [["pull_request", [...products, filename]], ["push", products]]) {
    const filter = events[event];
    need(filter && Array.isArray(filter.paths) && !Object.hasOwn(filter, "paths-ignore"), `${filename}: ${event} explicit paths required`);
    need(filter.paths.length === expected.length && same(filter.paths, expected), `${filename}: ${event} product paths differ`);
  }
  need(same(events.push.branches ?? [], ["proposals"]), `${filename}: product push branch differs`);
  need(!Object.hasOwn(events.push,"branches-ignore"), `${filename}: push branch exclusion forbidden`);
}

// Deliberately bounded admission, not a general GitHub expression interpreter.
// Unknown expression forms fail closed instead of being guessed safe.
function guarded(job, events, allowed, boundary) {
  const guard = typeof job.if === "string" ? job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "") : "";
  if (boundary?.path === JEV_ORG_WORKFLOW && boundary.secretScope === "organization"
    && guard.replace(/\s+/g, " ") === JEV_MULTI_GUARD
    && same(events, ["issue_comment", "workflow_call"]) && same(allowed, events)) return true;
  if (/[|!()?:]/.test(guard)) return false;
  const parts = guard.split(/\s*&&\s*/);
  return allowed.some(event => {
    const eventOnly = events.length === 1 && events[0] === event;
    if (!eventOnly && !parts.includes(`github.event_name == '${event}'`)) return false;
    if (event === "issue_comment") {
      const callerGate = boundary?.secretScope === "organization"
        ? boundary.path === JEV_ORG_WORKFLOW && parts.includes("github.event.repository.owner.type == 'Organization'")
          && parts.includes("github.event.issue.pull_request == null")
        : parts.includes("github.event.comment.user.login == github.repository_owner");
      return callerGate
        && parts.some(p => /^github\.event\.comment\.body == '[^']+'$/.test(p))
        && parts.some(p => /^github\.event\.issue\.number == [0-9]+$/.test(p));
    }
    return true;
  });
}

export function assertVoiceUiWorkerEffectBridge(workflow) {
  const inputs = workflow?.on?.workflow_dispatch?.inputs;
  need(inputs && inputs.worker_effect?.type === "boolean" && inputs.worker_effect.default === false,
    "voice-ui worker effect input must default false");
  for (const name of ["source_sha","approved_request_b64","approved_request_sha256","projection_receipt_b64","isolation_verdict_b64"])
    need(inputs[name]?.type === "string", "voice-ui worker effect input missing: " + name);

  const job = workflow?.jobs?.["worker-effect"];
  need(job && !job.needs, "voice-ui worker effect must be one independent job");
  const guard = typeof job.if === "string" ? job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "") : "";
  need(guard === "github.event_name == 'workflow_dispatch' && inputs.worker_effect",
    "voice-ui worker effect guard differs");
  need((typeof job.environment === "string" ? job.environment : job.environment?.name) === "cloudflare-production",
    "voice-ui worker effect Environment differs");
  need(job.permissions?.contents === "read" && Object.keys(job.permissions).length === 1,
    "voice-ui worker effect permissions differ");

  const steps = job.steps ?? [];
  const secretIndexes = steps.map((step,index)=>hasSecret(step)?index:-1).filter(index=>index>=0);
  need(secretIndexes.length === 1, "voice-ui worker effect must have exactly one secret-bearing step");
  const effectIndex = secretIndexes[0], effect = steps[effectIndex];
  need(effect.name === "Run one approved Worker deploy/readback", "voice-ui worker effect step identity differs");
  need(typeof effect.run === "string" && effect.run.includes('voice-ui-target-runtime" --request approved.json'),
    "voice-ui worker effect does not invoke installed approved request");
  need(!/\b(?:curl|gh|git|nix|nix-store|npm|npx|pip)\b/.test(effect.run),
    "voice-ui worker effect step acquires/builds source after secret exposure");
  need(steps.slice(0,effectIndex).every(step=>!hasSecret(step)),
    "voice-ui worker effect exposes secret before source/request preflight");
  for (const step of steps.slice(effectIndex+1)) {
    need(!hasSecret(step), "voice-ui worker post-effect step receives secret");
    if (step.run) need(!/\b(?:curl|gh|git\s+(?:clone|fetch|checkout|switch)|nix\s+(?:build|shell|develop)|nix-build|npm\s+(?:install|ci)|npx|pip\s+install)\b/.test(step.run),
      "voice-ui worker post-effect step acquires/builds source");
  }

  const text = JSON.stringify(job);
  const runText = steps.map(step => step.run ?? "").join("\n");
  for (const required of [
    WORKER_EFFECT_DEPLOY_SHA,
    WORKER_EFFECT_ISOLATION_SHA,
    'test "$GITHUB_REPOSITORY" = "roccho-dev/ops"',
    'test "$GITHUB_REF" = refs/heads/proposals',
    'test "$SOURCE_SHA" = "$GITHUB_SHA"',
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    'test "$PUBLISH_INPUT" != true',
    'test "$CANONICAL_INPUT" != true',
    "effect capability is missing",
    "environmentPhysicalApproval",
    "NOT_PROVEN_BY_SOURCE",
  ]) need(runText.includes(required) || text.includes(JSON.stringify(required).slice(1,-1)), "voice-ui worker effect invariant missing: " + required);
  need(text.includes("actions/checkout@11d5960a326750d5838078e36cf38b85af677262"),
    "voice-ui worker effect checkout pin differs");
  need(text.includes('"ref":"${{ github.sha }}"'),
    "voice-ui worker effect checkout is not exact github.sha");
  need(workflow.jobs["build-test"] && workflow.jobs["voice-ui-cf-consumer-cleanstart"] && workflow.jobs.publish,
    "voice-ui existing build/canonical/publish modes missing");
}

export function analyzeEffectWorkflow(workflow, boundary) {
  const issues = [];
  try {
    need(workflow && typeof workflow === "object", "workflow must be an object");
    need(!/envs-old|envctl\s+auth\s+exec|auth[-_]bundle|old private artifact/i.test(JSON.stringify(workflow)), "historical auth fallback forbidden");
    const events = typeof workflow.on === "string" ? [workflow.on]
      : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
    need(!events.includes("pull_request_target"), "pull_request_target forbidden");
    need(!hasSecret(workflow.env), "workflow-scoped secret forbidden");
    if (boundary.path === SYS1_PROOF_WORKFLOW) {
      assertSys1ProofWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === SELF_GRADING_WORKFLOW) {
      assertSelfGradingWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === FEEDBACK_WORKFLOW) {
      assertFeedbackWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === TARGET_LOOP_WORKFLOW) {
      assertTargetLoopWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === COUNTERFACTUAL_WORKFLOW) {
      assertCounterfactualWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === RESERVE_WORKFLOW) {
      assertReserveWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === CENSUS_WORKFLOW) {
      assertCensusWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === EXPECTATION_WORKFLOW) {
      assertExpectationWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === EXPECTATION_ROLE_WORKFLOW) {
      assertExpectationRoleWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === EXPECTATION_OR_WORKFLOW) {
      assertExpectationOrWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === OBSERVATION_WORKFLOW) {
      assertObservationWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === REAL_CASE_WORKFLOW) {
      assertRealCaseWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    if (boundary.path === REGRESSION_WORKFLOW) {
      assertRegressionWorkflow(workflow,boundary);
      return {issues,contributingJobs:['evaluate']};
    }
    const jobs = workflow.jobs ?? {};
    const effectNames = Object.keys(jobs).filter(name => hasSecret(jobs[name]));
    need(effectNames.length > 0, "declared effect workflow has no visible secret job");
    const allowed = boundary.allowedEvents;
    need(Array.isArray(allowed) && allowed.length > 0
      && allowed.every(event => ["workflow_dispatch", "issue_comment"].includes(event)
        || (event === "workflow_call" && boundary.path === JEV_ORG_WORKFLOW && boundary.secretScope === "organization")),
      "invalid effect event contract");
    const contributing = new Set(), visiting = new Set();
    function visit(name) {
      need(typeof name === "string" && jobs[name], `missing upstream job: ${name}`);
      need(!visiting.has(name), "job dependency cycle");
      if (contributing.has(name)) return;
      visiting.add(name);
      for (const parent of list(jobs[name].needs)) visit(parent);
      visiting.delete(name); contributing.add(name);
    }
    for (const name of effectNames) {
      const job = jobs[name];
      need(guarded(job, events, allowed, boundary), `${name}: automatic or unsupported event guard`);
      if (boundary.secretScope === "organization") {
        const reused = same(events, ["issue_comment", "workflow_call"]) && same(allowed, events);
        need((same(events, ["issue_comment"]) && same(allowed, ["issue_comment"])) || reused,
          `${name}: Org effect is bounded issue-comment/reusable only`);
        if (reused) {
          need(JSON.stringify(workflow.on.workflow_call) === JSON.stringify({secrets:{JEV_API_KEY:{required:true}}}),
            `${name}: reusable contract must pass only the provider slot`);
          const checkout = (job.steps ?? []).filter(step => step.uses?.startsWith("actions/checkout@"));
          need(checkout.length === 1 && checkout[0].with?.repository === "roccho-org/ops"
            && /^[0-9a-f]{40}$/.test(checkout[0].with?.ref ?? "") && checkout[0].with["persist-credentials"] === false,
            `${name}: reusable runtime source must be the fixed Ops commit`);
          const provision = (job.steps ?? []).find(step => step.name === "Resolve fixed jev-review runtime before any credential use");
          need(provision?.run?.includes(`runtime_source=${checkout[0].with.ref}`)
            && provision.run.includes('test "$(git rev-parse HEAD)" = "$runtime_source"')
            && provision.run.includes('echo "JEV_EXECUTION_SOURCE=$runtime_source" >> "$GITHUB_ENV"'),
            `${name}: runtime source must be checked before credential use`);
        }
        need(boundary.path === JEV_ORG_WORKFLOW && boundary.secretName === "JEV_API_KEY"
          && !Object.hasOwn(boundary, "environment") && !Object.hasOwn(job, "environment"), `${name}: Org Secret must not use an Environment`);
        const steps = job.steps ?? [], keyed = steps.filter(hasSecret), plans = steps.filter(step => step.id === "plan");
        need(keyed.length === 1 && plans.length === 1 && steps.indexOf(plans[0]) < steps.indexOf(keyed[0]), `${name}: Org admission must precede the only secret step`);
        need(!hasSecret(plans[0]) && !plans[0].uses && plans[0].shell === "bash"
          && JSON.stringify(plans[0].env) === JSON.stringify({GITHUB_TOKEN:"${{ github.token }}"})
          && plans[0].run?.trim() === JEV_PLAN_RUN, `${name}: Org admission must use the fixed keyless plan`);
        need(keyed[0].if === "steps.plan.outputs.planned == 'true'"
          && JSON.stringify(keyed[0].env) === JSON.stringify({JEV_API_KEY:"${{ secrets.JEV_API_KEY }}"}), `${name}: Org Secret requires an admitted plan`);
      } else {
        need(boundary.secretScope === undefined && typeof boundary.environment === "string" && boundary.environment.length > 0
          && (typeof job.environment === "string" ? job.environment : job.environment?.name) === boundary.environment,
          `${name}: static Environment differs`);
      }
      need(!hasSecret(job.env), `${name}: job-scoped secret forbidden`);
      need(!job.secrets, `${name}: inherited/reusable secrets forbidden`);
      visit(name);
    }
    for (const name of contributing) {
      const job = jobs[name];
      need(!job.uses && !job.strategy, `${name}: reusable jobs/matrix require explicit proof`);
      need(!job["continue-on-error"], `${name}: continue-on-error forbidden`);
      need(Array.isArray(job.steps) && job.steps.length > 0, `${name}: empty execution path`);
      for (const step of job.steps) {
        if (step.if === "github.event_name == 'pull_request'") {
          need(!hasSecret(step), `${name}: PR-only step cannot receive a secret`);
          continue; // all allowed effects above are manual or owner-command events
        }
        need(!step["continue-on-error"], `${name}: continued failure forbidden`);
        if (step.uses) {
          need(typeof step.uses === "string", `${name}: invalid action`);
          const action = step.uses.match(/^([A-Za-z0-9_.\/-]+)@([0-9a-f]{40})$/);
          need(action && !action[1].startsWith("./"), `${name}: all contributing Actions must use full SHA; local/reusable actions need expansion`);
          if (action[1] === "actions/checkout") {
            const fixedJev = boundary.path === JEV_ORG_WORKFLOW && boundary.secretScope === "organization"
              && same(events, ["issue_comment", "workflow_call"]) && step.with?.repository === "roccho-org/ops"
              && /^[0-9a-f]{40}$/.test(step.with?.ref ?? "") && step.with["persist-credentials"] === false;
            if (!fixedJev) {
              need((step.with?.ref ?? EXACT) === EXACT, `${name}: source must equal exact workflow revision, not a variable name or branch`);
              need(!step.with?.repository || step.with.repository === "${{ github.repository }}", `${name}: external checkout requires separate artifact admission`);
            }
          }
        }
        if (step.run) {
          need(typeof step.run === "string", `${name}: invalid run`);
          need(!/\b(?:npx|npm\s+(?:install|ci)|pip\s+install)\b/.test(step.run),
            `${name}: runtime package acquisition must move into an approved fixed closure`);
          need(!/\b(?:git\s+(?:clone|fetch|checkout|switch)|curl[^\n]*\|\s*(?:ba)?sh)\b/.test(step.run),
            `${name}: mutable source or downloaded executable inside effect path`);
        }
      }
    }
    return { issues, contributingJobs: [...contributing].sort() };
  } catch (error) { issues.push(error.message); return { issues, contributingJobs: [] }; }
}

// Separate, explicit admission for the User-requested finite development trial.
// The existing Issue-command/Environment rules above remain unchanged.
export function assertSys1ProofWorkflow(w,b) {
  need(b.secretScope==='organization' && b.secretName==='JEV_API_KEY'
    && same(b.allowedEvents??[],['push']) && b.maxCalls===43 && !b.environment,
    'Sys1 proof boundary differs');
  need(same(Object.keys(w.on??{}),['push'])
    && same(Object.keys(w.on.push??{}),['branches','paths'])
    && same(w.on.push.branches??[],['codex/jev-improvement-closure-20261019'])
    && same(w.on.push.paths??[],['experiments/sys1-eval-loop/live-request.json']),
    'Sys1 proof source entry differs');
  need(JSON.stringify(w.permissions)===JSON.stringify({actions:'read',contents:'read'}),
    'Sys1 proof permissions differ');
  need(w.concurrency?.group==='sys1-improvement-proof' && w.concurrency['cancel-in-progress']===false,
    'Sys1 proof must serialize without cancellation');
  need(same(Object.keys(w.jobs??{}),['evaluate']),'Sys1 proof job set differs');
  const j=w.jobs.evaluate;
  need(j.if==="github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1"
    && j['runs-on']==='ubuntu-24.04' && j['timeout-minutes']===5
    && !j.environment && !j.secrets && !j.strategy && !j.uses && !j['continue-on-error']
    && !j.permissions && !hasSecret(j.env),'Sys1 proof actor/attempt/job boundary differs');
  need(JSON.stringify(j.env)===JSON.stringify({TRIAL_SUITE:'role-boundaries',TRIAL_SOURCE_SHA:EXACT,TRIAL_SESSION_CALLS:'24'}),
    'Sys1 proof fixed suite/source/session differs');
  const steps=j.steps??[], keyed=steps.filter(hasSecret), request=steps.find(s=>s.id==='request');
  need(keyed.length===1 && request && steps.indexOf(request)<steps.indexOf(keyed[0])
    && !hasSecret(request) && !request.if && !request['continue-on-error'],
    'Sys1 proof must admit before the only secret step');
  const key=keyed[0];
  need(!key.if && !key['continue-on-error'] && !key.uses
    && JSON.stringify(key.env)===JSON.stringify({JEV_API_KEY:'${{ secrets.JEV_API_KEY }}',CANDIDATE:'${{ steps.request.outputs.candidate }}',PHASE:'${{ steps.request.outputs.phase }}'})
    && key.run?.trim()===[
      'case "$PHASE" in',
      '  baseline|candidate) entry=run.mjs ;;',
      '  split-baseline|split-candidate) entry=split.mjs; export TRIAL_SUITE=closure-real TRIAL_SESSION_CALLS=27 ;;',
      '  *) exit 1 ;;',
      'esac',
      'node "experiments/sys1-eval-loop/$entry" evaluate "$CANDIDATE" "$RUNNER_TEMP/sys1-result"'
    ].join('\n'),'Sys1 proof credential command differs');
  for(const text of ["const phases=['baseline','candidate','split-baseline','split-candidate'];",
    "assert.equal(history.total_count,phases.indexOf(r.phase)+1);",
    "assert.ok(prior.every(x=>x.status==='completed'&&x.conclusion==='success'));",
    "assert.equal(next(b).action,'PROPOSE_ONE_CANDIDATE');",
    "if(r.phase==='split-candidate') assert.equal(r.candidate,'binary-eo-v3');"])
    need(request.run?.includes(text),'Sys1 proof finite history/admission differs');
  need(JSON.stringify(request.env)===JSON.stringify({GH_TOKEN:'${{ github.token }}'}),
    'Sys1 proof keyless history identity differs');
  const checkout=steps.filter(s=>s.uses?.startsWith('actions/checkout@'));
  need(checkout.length===1 && checkout[0].with?.['persist-credentials']===false
    && (checkout[0].with?.ref??EXACT)===EXACT && !checkout[0].with?.repository,
    'Sys1 proof exact source checkout differs');
  for(const s of steps) {
    need(!s['continue-on-error'],'Sys1 proof cannot continue failures');
    if(s.uses) need(/^[\w/-]+@[0-9a-f]{40}$/.test(s.uses),'Sys1 proof Action must be immutable');
    if(s.run) need(!/\b(?:npx|npm\s+(?:install|ci)|pip\s+install|git\s+(?:clone|fetch|checkout|switch))\b/.test(s.run),
      'Sys1 proof cannot acquire mutable executable source');
  }
}

export function assertSelfGradingWorkflow(w,b) {
  need(b.secretScope==='organization'&&b.secretName==='JEV_API_KEY'&&b.maxCalls===18&&!b.environment
    &&same(b.allowedEvents??[],['push']),'self-grading finite boundary differs');
  need(same(Object.keys(w.on??{}),['push'])&&same(Object.keys(w.on.push??{}),['branches','paths'])
    &&same(w.on.push.branches??[],['codex/jev-self-grading-measurement-20261020'])
    &&same(w.on.push.paths??[],['experiments/sys1-eval-loop/self-grading-live.json']),'self-grading entry differs');
  need(JSON.stringify(w.permissions)===JSON.stringify({actions:'read',contents:'read'})
    &&w.concurrency?.group==='sys1-self-grading-proof'&&w.concurrency['cancel-in-progress']===false,'self-grading permissions/serialization differs');
  need(same(Object.keys(w.jobs??{}),['evaluate']),'self-grading job set differs');
  const j=w.jobs.evaluate,s=j.steps??[];
  need(j.if==="github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1"
    &&j['runs-on']==='ubuntu-24.04'&&j['timeout-minutes']===8
    &&!j.environment&&!j.env&&!j.secrets&&!j.strategy&&!j.uses&&!j.permissions&&!j['continue-on-error'],'self-grading actor/job differs');
  need(s.length===6&&s.filter(hasSecret).length===1,'self-grading steps differ');
  const cli='node experiments/sys1-eval-loop/self-grading.mjs ';
  need(s[0].uses==='actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
    &&JSON.stringify(s[0].with)===JSON.stringify({'persist-credentials':false,'fetch-depth':0}),'self-grading source differs');
  need(s[1].run==='node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'
    &&s[2].id==='prepare'&&s[2].run===cli+'prepare "$RUNNER_TEMP/self-grading"'
    &&JSON.stringify(s[2].env)===JSON.stringify({GH_TOKEN:'${{ github.token }}'}),'self-grading preflight differs');
  need(JSON.stringify(s[3].env)===JSON.stringify({JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'})
    &&s[3].run===cli+'evaluate "$RUNNER_TEMP/self-grading"','self-grading credential command differs');
  need(s[4].run===cli+'score "$RUNNER_TEMP/self-grading"'
    &&s[4].if==="always() && steps.prepare.outcome == 'success'"
    &&s[5].uses==='actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
    &&s[5].if==='always()','self-grading score/receipt differs');
  need(JSON.stringify(s[5].with)===JSON.stringify({name:'sys1-self-grading-${{ github.run_id }}',
    path:'${{ runner.temp }}/self-grading','if-no-files-found':'ignore','retention-days':30}),'self-grading artifact destination differs');
  for(const [n,step] of s.entries()) {
    need(!step['continue-on-error']&&!step['working-directory']&&!step.shell,'self-grading step override');
    if(n<4)need(!step.if,'self-grading mandatory admission skipped');
    if(n!==2&&n!==3)need(!step.env,'self-grading extra environment');
  }
}

export function assertFeedbackWorkflow(w,b) {
  need(b.secretScope==='organization'&&b.secretName==='JEV_API_KEY'&&b.maxCalls===60&&!b.environment
    &&same(b.allowedEvents??[],['push']),'feedback finite boundary differs');
  need(same(Object.keys(w.on??{}),['push'])&&same(Object.keys(w.on.push??{}),['branches','paths'])
    &&same(w.on.push.branches??[],['codex/jev-feedback-improvement-20261020'])
    &&same(w.on.push.paths??[],['experiments/sys1-eval-loop/feedback-development-live.json','experiments/sys1-eval-loop/feedback-confirmation-live.json']),'feedback entry differs');
  need(JSON.stringify(w.permissions)===JSON.stringify({actions:'read',contents:'read'})
    &&w.concurrency?.group==='sys1-feedback-improvement'&&w.concurrency['cancel-in-progress']===false,'feedback permissions/serialization differs');
  need(same(Object.keys(w.jobs??{}),['evaluate']),'feedback job set differs');
  const j=w.jobs.evaluate,s=j.steps??[];
  need(j.if==="github.repository == 'roccho-org/ops' && github.actor == 'roccho-dev' && github.run_attempt == 1"
    &&j['runs-on']==='ubuntu-24.04'&&j['timeout-minutes']===16
    &&!j.environment&&!j.env&&!j.secrets&&!j.strategy&&!j.uses&&!j.permissions&&!j['continue-on-error'],'feedback actor/job differs');
  need(s.length===6&&s.filter(hasSecret).length===1,'feedback steps differ');
  const cli='node experiments/sys1-eval-loop/feedback-improvement.mjs ';
  need(s[0].uses==='actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
    &&JSON.stringify(s[0].with)===JSON.stringify({'persist-credentials':false,'fetch-depth':0}),'feedback source differs');
  need(s[1].run==='node --test experiments/sys1-eval-loop/*test.mjs experiments/sys1-continuation/*test.mjs experiments/sys1-continuation/models/*test.mjs'
    &&s[2].id==='prepare'&&s[2].run===cli+'prepare "$RUNNER_TEMP/feedback-improvement"'
    &&JSON.stringify(s[2].env)===JSON.stringify({GH_TOKEN:'${{ github.token }}'}),'feedback preflight differs');
  need(JSON.stringify(s[3].env)===JSON.stringify({JEV_API_KEY:'${{ secrets.JEV_API_KEY }}'})
    &&s[3].run===cli+'evaluate "$RUNNER_TEMP/feedback-improvement"','feedback credential command differs');
  need(s[4].run===cli+'score "$RUNNER_TEMP/feedback-improvement"'
    &&s[4].if==="always() && steps.prepare.outcome == 'success'"
    &&s[5].uses==='actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
    &&s[5].if==='always()','feedback score/receipt differs');
  need(JSON.stringify(s[5].with)===JSON.stringify({name:'sys1-feedback-${{ github.run_id }}',
    path:'${{ runner.temp }}/feedback-improvement','if-no-files-found':'ignore','retention-days':30}),'feedback artifact destination differs');
  for(const [n,step] of s.entries()) {
    need(!step['continue-on-error']&&!step['working-directory']&&!step.shell,'feedback step override');
    if(n<4)need(!step.if,'feedback mandatory admission skipped');
    if(n!==2&&n!==3)need(!step.env,'feedback extra environment');
  }
}

// Reuse the exact six-step secret isolation profile; only this new finite
// series has a distinct entry, timeout and cap. Closed profiles remain exact.
export function assertTargetLoopWorkflow(w,b) {
  need(b.maxCalls===1000,'target loop total limit differs');
  need(same(w.on?.push?.branches??[],['codex/jev-target-loop-20261020'])
    &&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/target-loop/request.json']), 'target loop entry differs');
  need(w.concurrency?.group==='sys1-target-loop'&&w.jobs?.evaluate?.['timeout-minutes']===60,'target loop runtime differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode] of [[2,'prepare'],[3,'evaluate'],[4,'score']]) {
    need(s[n]?.run===`node experiments/sys1-eval-loop/target-loop/loop.mjs ${mode} "$RUNNER_TEMP/target-loop"`,'target loop command differs');
    s[n].run=`node experiments/sys1-eval-loop/self-grading.mjs ${mode} "$RUNNER_TEMP/self-grading"`;
  }
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-target-loop-${{ github.run_id }}',path:'${{ runner.temp }}/target-loop','if-no-files-found':'ignore','retention-days':30}),'target loop receipt differs');
  v.on.push.branches=['codex/jev-self-grading-measurement-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/self-grading-live.json'];
  v.concurrency.group='sys1-self-grading-proof';v.jobs.evaluate['timeout-minutes']=8;
  s[5].with={name:'sys1-self-grading-${{ github.run_id }}',path:'${{ runner.temp }}/self-grading','if-no-files-found':'ignore','retention-days':30};
  assertSelfGradingWorkflow(v,{...b,maxCalls:18});
}

export function assertCounterfactualWorkflow(w,b) {
  need(b.maxCalls===296,'counterfactual Jev plan differs');
  need(same(w.on?.push?.branches??[],['codex/jev-feedback-counterfactual-20261020'])
    &&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/counterfactual/request.json']),'counterfactual entry differs');
  need(w.concurrency?.group==='sys1-counterfactual'&&w.jobs?.evaluate?.['timeout-minutes']===70,'counterfactual runtime differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){
    need(s[n]?.run===`node experiments/sys1-eval-loop/counterfactual/runtime.mjs ${mode} "$RUNNER_TEMP/counterfactual"`,'counterfactual command differs');
    s[n].run=`node experiments/sys1-eval-loop/target-loop/loop.mjs ${mode==='project'?'score':mode} "$RUNNER_TEMP/target-loop"`;
  }
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-counterfactual-${{ github.run_id }}',path:'${{ runner.temp }}/counterfactual','if-no-files-found':'ignore','retention-days':30}),'counterfactual receipt differs');
  v.on.push.branches=['codex/jev-target-loop-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/target-loop/request.json'];
  v.concurrency.group='sys1-target-loop';v.jobs.evaluate['timeout-minutes']=60;
  s[5].with={name:'sys1-target-loop-${{ github.run_id }}',path:'${{ runner.temp }}/target-loop','if-no-files-found':'ignore','retention-days':30};
  assertTargetLoopWorkflow(v,{...b,maxCalls:1000});
}

export function assertRegressionWorkflow(w,b) {
  need(b.maxCalls===496,'regression finite series differs');
  need(same(w.on?.push?.branches??[],['codex/jev-regression-repair-20261020'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/regression/request.json']),'regression entry differs');
  need(w.concurrency?.group==='sys1-regression-repair'&&w.jobs?.evaluate?.['timeout-minutes']===90,'regression runtime differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){
    need(s[n]?.run===`node experiments/sys1-eval-loop/regression/runtime.mjs ${mode} "$RUNNER_TEMP/regression"`,'regression command differs');
    s[n].run=`node experiments/sys1-eval-loop/counterfactual/runtime.mjs ${mode} "$RUNNER_TEMP/counterfactual"`;
  }
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-regression-${{ github.run_id }}',path:'${{ runner.temp }}/regression','if-no-files-found':'ignore','retention-days':30}),'regression receipt differs');
  v.on.push.branches=['codex/jev-feedback-counterfactual-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/counterfactual/request.json'];v.concurrency.group='sys1-counterfactual';v.jobs.evaluate['timeout-minutes']=70;
  s[5].with={name:'sys1-counterfactual-${{ github.run_id }}',path:'${{ runner.temp }}/counterfactual','if-no-files-found':'ignore','retention-days':30};
  assertCounterfactualWorkflow(v,{...b,maxCalls:296});
}

export function assertRealCaseWorkflow(w,b) {
  need(b.maxCalls===708,'real-case prospective two-pass count differs');
  need(same(w.on?.push?.branches??[],['codex/jev-real-case-evaluation-20261020'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/real-cases/request.json']),'real-case entry differs');
  need(w.concurrency?.group==='sys1-real-case-evaluation'&&w.jobs?.evaluate?.['timeout-minutes']===110,'real-case per-pass deadline/retention differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){
    need(s[n]?.run==='node experiments/sys1-eval-loop/real-cases/runtime.mjs '+mode+' "$RUNNER_TEMP/real-cases"','real-case command differs');
    s[n].run='node experiments/sys1-eval-loop/regression/runtime.mjs '+mode+' "$RUNNER_TEMP/regression"';
  }
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-real-cases-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/real-cases','if-no-files-found':'ignore','retention-days':30}),'real-case receipt differs');
  v.on.push.branches=['codex/jev-regression-repair-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/regression/request.json'];v.concurrency.group='sys1-regression-repair';v.jobs.evaluate['timeout-minutes']=90;
  s[5].with={name:'sys1-regression-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/regression','if-no-files-found':'ignore','retention-days':30};
  assertRegressionWorkflow(v,{...b,maxCalls:496});
}

export function assertObservationWorkflow(w,b) {
  need(b.maxCalls===1918,'observation series bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-observation-improvement-20261020'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/observation/request.json']),'observation entry differs');
  need(w.concurrency?.group==='sys1-observation-improvement'&&w.jobs?.evaluate?.['timeout-minutes']===250,'observation per-pass deadline/retention differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){
    need(s[n]?.run==='node experiments/sys1-eval-loop/observation/runtime.mjs '+mode+' "$RUNNER_TEMP/observation"','observation command differs');
    s[n].run='node experiments/sys1-eval-loop/real-cases/runtime.mjs '+mode+' "$RUNNER_TEMP/real-cases"';
  }
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-observation-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/observation','if-no-files-found':'ignore','retention-days':30}),'observation receipt differs');
  v.on.push.branches=['codex/jev-real-case-evaluation-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/real-cases/request.json'];v.concurrency.group='sys1-real-case-evaluation';v.jobs.evaluate['timeout-minutes']=110;
  s[5].with={name:'sys1-real-cases-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/real-cases','if-no-files-found':'ignore','retention-days':30};
  assertRealCaseWorkflow(v,{...b,maxCalls:708});
}

export function assertCensusWorkflow(w,b){
  need(b.maxCalls===2400,'census two-pass bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-observation-census-20261021'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/census/request.json']),'census entry differs');
  need(w.concurrency?.group==='sys1-observation-census'&&w.jobs?.evaluate?.['timeout-minutes']===330,'census deadline/retention differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){need(s[n]?.run==='node experiments/sys1-eval-loop/census/runtime.mjs '+mode+' "$RUNNER_TEMP/census"','census command differs');s[n].run='node experiments/sys1-eval-loop/reserve/runtime.mjs '+mode+' "$RUNNER_TEMP/reserve"';}
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-census-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/census','if-no-files-found':'ignore','retention-days':30}),'census receipt differs');
  v.on.push.branches=['codex/jev-observation-reserve-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/reserve/request.json'];v.concurrency.group='sys1-observation-reserve';v.jobs.evaluate['timeout-minutes']=170;
  s[5].with={name:'sys1-reserve-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/reserve','if-no-files-found':'ignore','retention-days':30};assertReserveWorkflow(v,{...b,maxCalls:1984});
}
export function assertExpectationWorkflow(w,b){
  need(b.maxCalls===2307,'expectation fixed series bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-expectation-census-20261021'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/expectation/request.json']),'expectation entry differs');
  need(w.concurrency?.group==='sys1-expectation-census'&&w.jobs?.evaluate?.['timeout-minutes']===250,'expectation census deadline differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){need(s[n]?.run==='node experiments/sys1-eval-loop/expectation/runtime.mjs '+mode+' "$RUNNER_TEMP/expectation"','expectation command differs');s[n].run='node experiments/sys1-eval-loop/reserve/runtime.mjs '+mode+' "$RUNNER_TEMP/reserve"';}
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-expectation-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/expectation','if-no-files-found':'ignore','retention-days':30}),'expectation receipt differs');
  v.on.push.branches=['codex/jev-observation-reserve-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/reserve/request.json'];v.concurrency.group='sys1-observation-reserve';v.jobs.evaluate['timeout-minutes']=170;
  s[5].with={name:'sys1-reserve-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/reserve','if-no-files-found':'ignore','retention-days':30};assertReserveWorkflow(v,{...b,maxCalls:1984});
}
export function assertExpectationRoleWorkflow(w,b){
  need(b.maxCalls===24336,'role fixed series bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-expectation-role-20261021'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/expectation-role/request.json']),'role entry differs');
  need(w.concurrency?.group==='sys1-expectation-role'&&w.jobs?.evaluate?.['timeout-minutes']===350,'role development deadline differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){need(s[n]?.run==='node experiments/sys1-eval-loop/expectation-role/runtime.mjs '+mode+' "$RUNNER_TEMP/expectation-role"','role command differs');s[n].run='node experiments/sys1-eval-loop/expectation-or/runtime.mjs '+mode+' "$RUNNER_TEMP/expectation-or"';}
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-expectation-role-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/expectation-role','if-no-files-found':'ignore','retention-days':30}),'role receipt differs');
  v.on.push.branches=['codex/jev-expectation-or-20261021'];v.on.push.paths=['experiments/sys1-eval-loop/expectation-or/request.json'];v.concurrency.group='sys1-expectation-or';v.jobs.evaluate['timeout-minutes']=350;
  s[5].with={name:'sys1-expectation-or-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/expectation-or','if-no-files-found':'ignore','retention-days':30};assertExpectationOrWorkflow(v,{...b,maxCalls:3052});
}
export function assertExpectationOrWorkflow(w,b){
  need(b.maxCalls===3052,'OR fixed series bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-expectation-or-20261021'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/expectation-or/request.json']),'OR entry differs');
  need(w.concurrency?.group==='sys1-expectation-or'&&w.jobs?.evaluate?.['timeout-minutes']===350,'OR development deadline differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){need(s[n]?.run==='node experiments/sys1-eval-loop/expectation-or/runtime.mjs '+mode+' "$RUNNER_TEMP/expectation-or"','OR command differs');s[n].run='node experiments/sys1-eval-loop/expectation/runtime.mjs '+mode+' "$RUNNER_TEMP/expectation"';}
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-expectation-or-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/expectation-or','if-no-files-found':'ignore','retention-days':30}),'OR receipt differs');
  v.on.push.branches=['codex/jev-expectation-census-20261021'];v.on.push.paths=['experiments/sys1-eval-loop/expectation/request.json'];v.concurrency.group='sys1-expectation-census';v.jobs.evaluate['timeout-minutes']=250;
  s[5].with={name:'sys1-expectation-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/expectation','if-no-files-found':'ignore','retention-days':30};assertExpectationWorkflow(v,{...b,maxCalls:2307});
}
export function assertReserveWorkflow(w,b){
  need(b.maxCalls===1984,'reserve series bound differs');
  need(same(w.on?.push?.branches??[],['codex/jev-observation-reserve-20261020'])&&same(w.on?.push?.paths??[],['experiments/sys1-eval-loop/reserve/request.json']),'reserve entry differs');
  need(w.concurrency?.group==='sys1-observation-reserve'&&w.jobs?.evaluate?.['timeout-minutes']===170,'reserve deadline/retention differs');
  const v=structuredClone(w),s=v.jobs.evaluate.steps;
  for(const [n,mode]of [[2,'prepare'],[3,'evaluate'],[4,'project']]){need(s[n]?.run==='node experiments/sys1-eval-loop/reserve/runtime.mjs '+mode+' "$RUNNER_TEMP/reserve"','reserve command differs');s[n].run='node experiments/sys1-eval-loop/observation/runtime.mjs '+mode+' "$RUNNER_TEMP/observation"';}
  need(JSON.stringify(s[5]?.with)===JSON.stringify({name:'sys1-reserve-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/reserve','if-no-files-found':'ignore','retention-days':30}),'reserve receipt differs');
  v.on.push.branches=['codex/jev-observation-improvement-20261020'];v.on.push.paths=['experiments/sys1-eval-loop/observation/request.json'];v.concurrency.group='sys1-observation-improvement';v.jobs.evaluate['timeout-minutes']=250;
  s[5].with={name:'sys1-observation-'+String.fromCharCode(36)+'{{ github.run_id }}',path:String.fromCharCode(36)+'{{ runner.temp }}/observation','if-no-files-found':'ignore','retention-days':30};assertObservationWorkflow(v,{...b,maxCalls:1918});
}

export function selftest() {
  for (const [filename, products] of Object.entries(isolatedProducts)) {
    const isolated = {on:{pull_request:{paths:[...products, filename]},push:{branches:["proposals"],paths:[...products]},workflow_dispatch:null}};
    assertIsolatedPublisherPaths(isolated, filename);
    const mutations = [
      w=>{w.on.push.paths.push("ci.intent.v1.jsonl");},
      w=>{w.on.pull_request.paths.push("ci.intent.v1.jsonl");},
      w=>{w.on.push.paths.push(filename);},
      w=>{w.on.push.paths=["**"];},
      w=>{delete w.on.push.paths;},
      w=>{w.on.push["paths-ignore"]=["unrelated/**"];},
      w=>{w.on.push.paths.pop();},
      w=>{delete w.on.workflow_dispatch;},
      w=>{w.on.pull_request_target={};},
      w=>{w.on.push["branches-ignore"]=["proposals"];},
    ];
    for (const mutate of mutations) {const w=structuredClone(isolated);mutate(w);assert.throws(()=>assertIsolatedPublisherPaths(w,filename));}
    // Bounded literal/prefix representatives, not a general GitHub glob engine.
    const matches = file => products.some(pattern => pattern.endsWith("/**") ? file.startsWith(pattern.slice(0,-2)) : file === pattern);
    for (const pattern of products) assert.ok(matches(pattern.endsWith("/**") ? pattern.slice(0,-2)+"fixture.mjs" : pattern));
    for (const file of ["ci.intent.v1.jsonl",filename,"build/packages.jsonl","build/checks.jsonl","flake.nix","packages/jev/src/batch.mjs"]) assert.equal(matches(file),false);
  }
  const action = "actions/checkout@" + "1".repeat(40);
  const policy = {allowedEvents:["workflow_dispatch"],environment:"cloudflare-production"};
  const safe = {on:{pull_request:{},workflow_dispatch:{}},jobs:{
    materialize:{steps:[{uses:action,with:{ref:EXACT}},{run:"node checked-in-build.mjs"}]},
    effect:{needs:["materialize"],if:"github.event_name == 'workflow_dispatch'",environment:"cloudflare-production",
      steps:[{uses:action,with:{ref:EXACT}},{env:{TOKEN:"${{ secrets.TOKEN }}"},run:"node approved-effect.mjs"}]},
  }};
  assert.deepEqual(analyzeEffectWorkflow(safe,policy).issues,[]);
  const cases = [
    w=>{w.jobs.materialize.steps[0].uses="actions/checkout@v4";},
    w=>{w.jobs.materialize.steps[0].with.ref="proposals";},
    w=>{w.jobs.effect.steps[0].with.ref="${{ needs.materialize.outputs.source_sha }}";},
    w=>{w.jobs.effect.if="github.event_name == 'workflow_dispatch' || true";},
    w=>{w.jobs.effect.if="github.event_name == 'workflow_dispatch' && true ? true : true";},
    w=>{w.jobs.effect.env={TOKEN:"${{ secrets.TOKEN }}"};},
    w=>{w.jobs.effect.environment="${{ inputs.environment }}";},
    w=>{w.jobs.effect.needs=["missing"];},
    w=>{w.jobs.materialize.needs=["effect"];},
    w=>{w.jobs.materialize.steps.push({uses:"./.github/actions/install"});},
    w=>{w.jobs.materialize.steps.push({run:"npx --yes untrusted@1.0.0"});},
    w=>{w.jobs.effect.steps[0]["continue-on-error"]=true;},
    w=>{w.on={pull_request_target:{}};},
    w=>{w.jobs.effect.steps.at(-1).run="envctl auth exec node effect.mjs";},
  ];
  const commentWorkflow=structuredClone(safe);
  commentWorkflow.on={issue_comment:{}};commentWorkflow.jobs.effect.if="github.event_name == 'issue_comment'";
  assert.ok(analyzeEffectWorkflow(commentWorkflow,{...policy,allowedEvents:["issue_comment"]}).issues.length);
  for (const mutate of cases) {const w=structuredClone(safe);mutate(w);assert.ok(analyzeEffectWorkflow(w,policy).issues.length);}
  const orgPolicy = {path:JEV_ORG_WORKFLOW,allowedEvents:["issue_comment"],secretScope:"organization",secretName:"JEV_API_KEY"};
  const org = {on:{issue_comment:{types:["created"]}},jobs:{evaluate:{
    if:"github.event.issue.number == 483 && github.event.repository.owner.type == 'Organization' && github.event.comment.body == '/jev-evaluate' && github.event.issue.pull_request == null",
    steps:[
      {id:"plan",shell:"bash",env:{GITHUB_TOKEN:"${{ github.token }}"},run:JEV_PLAN_RUN},
      {if:"steps.plan.outputs.planned == 'true'",env:{JEV_API_KEY:"${{ secrets.JEV_API_KEY }}"},run:'node fixed-entry.mjs'},
    ],
  }}};
  assert.deepEqual(analyzeEffectWorkflow(org,orgPolicy).issues,[]);
  const orgCases = [
    w=>{w.jobs.evaluate.environment="jev-issue-comment";},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("Organization","User");},
    w=>{delete w.jobs.evaluate.steps[1].if;},
    w=>{w.jobs.evaluate.steps[1].if="true";},
    w=>{w.jobs.evaluate.steps[0].env.JEV_API_KEY="${{ secrets.JEV_API_KEY }}";},
    w=>{w.jobs.evaluate.steps[0].run="echo planned=true >> $GITHUB_OUTPUT";},
    w=>{w.jobs.evaluate.steps.reverse();},
    w=>{w.jobs.evaluate.steps[1].env.EXTRA="${{ secrets.EXTRA }}";},
    w=>{w.on={workflow_dispatch:{}};w.jobs.evaluate.if="github.event_name == 'workflow_dispatch'";},
  ];
  for (const mutate of orgCases) {const w=structuredClone(org);mutate(w);assert.ok(analyzeEffectWorkflow(w,orgPolicy).issues.length);}
  assert.ok(analyzeEffectWorkflow(org,{...orgPolicy,path:".github/workflows/other.yml"}).issues.length);
  assert.ok(analyzeEffectWorkflow(org,{...orgPolicy,secretName:"OTHER"}).issues.length);
  assert.ok(analyzeEffectWorkflow(org,{...orgPolicy,environment:"jev-issue-comment"}).issues.length);
  assert.ok(analyzeEffectWorkflow(org,{...orgPolicy,allowedEvents:["workflow_dispatch"]}).issues.length);
  const reusablePolicy = {...orgPolicy,allowedEvents:["issue_comment","workflow_call"]};
  const reusable = structuredClone(org);
  reusable.on.workflow_call = {secrets:{JEV_API_KEY:{required:true}}};
  reusable.jobs.evaluate.if = JEV_MULTI_GUARD;
  const runtime = "a".repeat(40);
  reusable.jobs.evaluate.steps.unshift(
    {uses:"actions/checkout@11d5960a326750d5838078e36cf38b85af677262",with:{repository:"roccho-org/ops",ref:runtime,"persist-credentials":false}},
    {name:"Resolve fixed jev-review runtime before any credential use",run:`runtime_source=${runtime}\ntest "$(git rev-parse HEAD)" = "$runtime_source"\necho "JEV_EXECUTION_SOURCE=$runtime_source" >> "$GITHUB_ENV"`});
  assert.deepEqual(analyzeEffectWorkflow(reusable,reusablePolicy).issues,[]);
  const reusableCases = [
    w=>{w.on.workflow_call.inputs={program:{type:"string"}};},
    w=>{w.on.workflow_call.secrets.EXTRA={required:true};},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("== 52","== 53");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("roccho-org/envs","other/envs");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("== 511","== 512");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replaceAll("== 522","== 520");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replaceAll("== 522","== 522 || github.event.issue.number == 523");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("github.event.issue.number == 522 && startsWith", "startsWith");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace('fromJSON(\'"/jev-evaluate\\n"\')', '\'/jev-evaluate\'');},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("startsWith(github.event.comment.body", "contains(github.event.comment.body");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("pull_request != null","pull_request == null");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("pull_request == null","pull_request != null");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("github.event.issue.pull_request != null && ","");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("Organization","User");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("/jev-evaluate","/other");},
    w=>{w.jobs.evaluate.if+=" || true";},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("== 511","== 511 || github.event.issue.number == 512");},
    w=>{w.jobs.evaluate.if=w.jobs.evaluate.if.replace("github.repository == 'roccho-org/ops' && (github.event.issue.number == 511", "(github.event.issue.number == 511");},
    w=>{w.jobs.evaluate.steps[0].with.ref="proposals";},
    w=>{w.jobs.evaluate.steps[0].with.repository="other/ops";},
    w=>{w.jobs.evaluate.steps[0].with["persist-credentials"]=true;},
    w=>{w.jobs.evaluate.steps[1].run="echo ready";},
  ];
  for (const mutate of reusableCases) {const w=structuredClone(reusable);mutate(w);assert.ok(analyzeEffectWorkflow(w,reusablePolicy).issues.length);}
  const parity=structuredClone(safe);
  parity.jobs.materialize.steps.push({if:"github.event_name == 'pull_request'",run:"git clone public-fixture"});
  assert.deepEqual(analyzeEffectWorkflow(parity,policy).issues,[]);
  parity.jobs.materialize.steps.at(-1).env={TOKEN:"${{ secrets.TOKEN }}"};
  assert.ok(analyzeEffectWorkflow(parity,policy).issues.length);
  const bridge = {on:{pull_request:{},workflow_dispatch:{inputs:{
    publish:{type:"boolean",default:false},canonical:{type:"boolean",default:false},
    worker_effect:{type:"boolean",default:false},source_sha:{type:"string"},
    approved_request_b64:{type:"string"},approved_request_sha256:{type:"string"},
    projection_receipt_b64:{type:"string"},isolation_verdict_b64:{type:"string"},
  }}},jobs:{
    "build-test":{steps:[{run:"echo build"}]},
    "voice-ui-cf-consumer-cleanstart":{steps:[{run:"echo canonical"}]},
    publish:{steps:[{run:"echo publish"}]},
    "worker-effect":{
      if:"github.event_name == 'workflow_dispatch' && inputs.worker_effect",
      environment:"cloudflare-production",permissions:{contents:"read"},
      env:{DEPLOY_SHA:WORKER_EFFECT_DEPLOY_SHA,ISOLATION_SHA256:WORKER_EFFECT_ISOLATION_SHA},
      steps:[
        {uses:"actions/checkout@11d5960a326750d5838078e36cf38b85af677262",with:{ref:EXACT}},
        {name:"source preflight",run:'test "$GITHUB_REPOSITORY" = "roccho-dev/ops"; test "$GITHUB_REF" = refs/heads/proposals; test "$SOURCE_SHA" = "$GITHUB_SHA"; test "$(git rev-parse HEAD)" = "$GITHUB_SHA"; test "$PUBLISH_INPUT" != true; test "$CANONICAL_INPUT" != true; echo effect capability is missing; echo environmentPhysicalApproval NOT_PROVEN_BY_SOURCE'},
        {name:"Run one approved Worker deploy/readback",env:{CLOUDFLARE_API_TOKEN:"${{ secrets.CLOUDFLARE_API_TOKEN }}"},run:'"$runtime/bin/voice-ui-target-runtime" --request approved.json'},
        {name:"receipt",run:"node validate-receipt.mjs"},
      ],
    },
  }};
  assertVoiceUiWorkerEffectBridge(bridge);
  const bridgeCases = [
    w=>{w.on.workflow_dispatch.inputs.worker_effect.default=true;},
    w=>{w.jobs["worker-effect"].if="github.event_name == 'pull_request'";},
    w=>{w.jobs["worker-effect"].environment="${{ inputs.environment }}";},
    w=>{w.jobs["worker-effect"].env.DEPLOY_SHA="a".repeat(40);},
    w=>{w.jobs["worker-effect"].steps[1].env={TOKEN:"${{ secrets.TOKEN }}"};},
    w=>{w.jobs["worker-effect"].steps[2].run+='; curl https://example.invalid/source';},
    w=>{w.jobs["worker-effect"].steps[1].run=w.jobs["worker-effect"].steps[1].run.replace('test "$SOURCE_SHA" = "$GITHUB_SHA"; ','');},
    w=>{w.jobs["worker-effect"].steps[3].run="git fetch origin proposals";},
  ];
  for (const mutate of bridgeCases) {const w=structuredClone(bridge);mutate(w);assert.throws(()=>assertVoiceUiWorkerEffectBridge(w));}
  return {positive:3,negative:cases.length+2+bridgeCases.length,publisherIsolation:{positive:2,negative:20},workerEffectBridge:{positive:1,negative:bridgeCases.length},jevOrgAdmission:{positive:1,negative:orgCases.length+4},jevReusableAdmission:{positive:1,negative:reusableCases.length}};
}

export function check(root) {
  const read = p => fs.readFileSync(path.join(root,p),"utf8");
  const jsonl = p => read(p).split(/\r?\n/).filter(s=>s.trim()).map(JSON.parse);
  const intents = jsonl("ci.intent.v1.jsonl").filter(x=>x.kind==="ci.intent.v1" && x.provider==="github-actions");
  const boundaries = jsonl("contracts/secret-effect-boundary.v1.jsonl");
  need(new Set(intents.map(x=>x.path)).size===intents.length,"duplicate CI intents");
  need(new Set(boundaries.map(x=>x.path)).size===boundaries.length,"duplicate effect contracts");
  const byPath=new Map(boundaries.map(x=>[x.path,x]));
  const names=fs.readdirSync(path.join(root,".github/workflows")).filter(n=>/\.ya?ml$/.test(n)).sort().map(n=>`.github/workflows/${n}`);
  const workflows=[],failures=[];
  for(const p of names) {
    const parsed=spawnSync("yq",["-o=json",".",path.join(root,p)],{encoding:"utf8"});
    need(parsed.status===0,`${p}: YAML parser failed; yq-go must be provided by the pinned check closure`);
    const w=JSON.parse(parsed.stdout),intent=intents.find(x=>x.path===p),boundary=byPath.get(p);
    assertIsolatedPublisherPaths(w,p);
    if(p===WORKER_EFFECT_WORKFLOW) {
      try { assertVoiceUiWorkerEffectBridge(w); }
      catch(error) { failures.push(p + ": " + error.message); }
    }
    need(intent,`${p}: no CI intent`);
    const events=typeof w.on==="string"?[w.on]:Array.isArray(w.on)?w.on:Object.keys(w.on??{});
    for(const event of intent.dispatch??[]) need(events.includes(event),`${p}: intent trigger ${event} absent`);
    if(events.includes("push") && intent.dispatch.includes("push")) need(same(intent.push_branches??[],w.on.push?.branches??["*"]),`${p}: push branches differ`);
    const secret=hasSecret(w);
    if(secret) {
      if(boundary?.classification!=="secret_bearing_effect") failures.push(`${p}: unclassified secret path`);
      else failures.push(...analyzeEffectWorkflow(w,boundary).issues.map(s=>`${p}: ${s}`));
    } else if(boundary?.classification==="secret_bearing_effect") failures.push(`${p}: effect declaration without secret job`);
    if(boundary?.classification==="obsolete") failures.push(`${p}: obsolete workflow active`);
    workflows.push({path:p,classification:secret?"secret_bearing_effect":"secret_free_verify"});
  }
  for(const x of boundaries) need(x.kind==="ops.secretEffectBoundary.v1" && ["obsolete","secret_bearing_effect"].includes(x.classification),"invalid effect contract");
  for(const i of intents) need(names.includes(i.path)||byPath.get(i.path)?.classification==="obsolete",`${i.path}: missing workflow`);
  for(const b of boundaries.filter(b=>b.classification==="secret_bearing_effect")) need(names.includes(b.path),`${b.path}: missing declared effect`);
  need(failures.length===0,failures.join("\n"));
  return {kind:"ops.secretEffectBoundary.check.v1",status:"PASS",active:workflows.length,
    secretBearingEffects:workflows.filter(w=>w.classification==="secret_bearing_effect").length,
    obsolete:boundaries.filter(b=>b.classification==="obsolete").length,unclassified:0,workflows};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const tests=selftest();console.log(JSON.stringify(process.argv[2]==="--selftest"?tests:check(path.resolve(process.argv[2]??"."))));}
  catch(error){console.error(`ci intent / effect path check failed\n${error.message}`);process.exitCode=1;}
}
