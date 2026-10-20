import assert from 'node:assert/strict';
export const BRANCH='codex/jev-observation-census-20261021',WORKFLOW='sys1-observation-census.yml',REQUEST='experiments/sys1-eval-loop/census/request.json';
export function censusRepetition(request){assert.ok(['census1','census2'].includes(request.phase));return request.phase==='census1'?1:2;}
export function admitCensusAssignment(request,env,source,history){
 const repId=censusRepetition(request);assert.deepEqual(Object.keys(request).sort(),['phase','sourceSha']);assert.match(request.sourceSha,/^[0-9a-f]{40}$/);for(const [key,value]of Object.entries({GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_EVENT_NAME:'push',GITHUB_ACTOR:'roccho-dev',GITHUB_REF:'refs/heads/'+BRANCH,GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value);
 assert.equal(source.head,env.GITHUB_SHA);assert.equal(source.parent,request.sourceSha);assert.deepEqual(source.changed,[REQUEST]);assert.equal(history.total_count,repId);assert.equal(history.workflow_runs.length,repId);assert.equal(new Set(history.workflow_runs.map(r=>r.id)).size,repId);
 for(const r of history.workflow_runs){assert.equal(r.run_attempt,1);assert.equal(r.actor.login,'roccho-dev');assert.equal(r.event,'push');assert.equal(r.head_branch,BRANCH);assert.equal(r.path,'.github/workflows/'+WORKFLOW);}
 const current=history.workflow_runs.find(r=>String(r.id)===env.GITHUB_RUN_ID);assert.ok(current);assert.equal(current.head_sha,source.head);return current;
}
export function assertCensusNative(provider,history,source){
 const p=provider;assert.equal(p.repository,'roccho-org/ops');assert.equal(p.workflowPath,'.github/workflows/'+WORKFLOW);assert.equal(p.runAttempt,1);assert.equal(p.actor,'roccho-dev');assert.equal(p.event,'push');assert.equal(p.branch,BRANCH);assert.ok(['success','failure'].includes(p.conclusion));assert.equal(p.runUrl,`https://github.com/roccho-org/ops/actions/runs/${p.runId}`);
 const native=history.workflow_runs.find(r=>r.id===p.runId);assert.ok(native);for(const [key,value]of Object.entries({head_sha:p.head,status:'completed',conclusion:p.conclusion,run_attempt:1,event:'push',head_branch:BRANCH,path:p.workflowPath,html_url:p.runUrl}))assert.equal(native[key],value);assert.equal(native.actor.login,p.actor);
 assert.equal(source.head,p.head);assert.equal(source.parent,p.source);assert.deepEqual(source.changed,[REQUEST]);assert.deepEqual(source.request,{phase:'census1',sourceSha:p.source});
}
