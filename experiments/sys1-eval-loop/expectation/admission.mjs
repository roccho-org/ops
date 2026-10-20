import assert from 'node:assert/strict';
export const BRANCH='codex/jev-expectation-census-20261021',WORKFLOW='sys1-expectation-census.yml',REQUEST='experiments/sys1-eval-loop/expectation/request.json';
export function admitExpectationDevelopment(request,env,source,history){
 assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.equal(request.phase,'development');assert.match(request.sourceSha,/^[0-9a-f]{40}$/);
 assert.equal(env.GITHUB_REPOSITORY,'roccho-org/ops');assert.equal(env.GITHUB_EVENT_NAME,'push');assert.equal(env.GITHUB_ACTOR,'roccho-dev');assert.equal(env.GITHUB_REF,'refs/heads/'+BRANCH);assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.equal(source.head,env.GITHUB_SHA);assert.equal(source.parent,request.sourceSha);assert.deepEqual(source.changed,[REQUEST]);
 assert.equal(history.total_count,1);assert.equal(history.workflow_runs.length,1);const r=history.workflow_runs[0];assert.equal(String(r.id),env.GITHUB_RUN_ID);assert.equal(r.head_sha,source.head);assert.equal(r.run_attempt,1);assert.equal(r.event,'push');assert.equal(r.actor.login,'roccho-dev');assert.equal(r.head_branch,BRANCH);assert.equal(r.path,'.github/workflows/'+WORKFLOW);return r;
}
