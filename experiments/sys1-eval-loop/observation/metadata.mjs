import assert from 'node:assert/strict';import {validateWindow} from '../real-cases/frame.mjs';
const fields=r=>({id:r.id,nodeId:r.node_id,fullName:r.full_name,owner:r.owner.login,private:r.private,visibility:r.visibility,hasIssues:r.has_issues,archived:r.archived,fork:r.fork,htmlUrl:r.html_url,createdAt:r.created_at,updatedAt:r.updated_at,openIssuesCount:r.open_issues_count});
export function replayMetadataScope(plan,captures,rawByOwner){
 assert.equal(plan.schema,'ops.sys1.observation-real-case-prospective.v1');const owners=plan.cohort.owners;assert.equal(new Set(owners).size,2);assert.deepEqual(captures.map(c=>c.owner).sort(),[...owners].sort());assert.deepEqual(Object.keys(rawByOwner).sort(),[...owners].sort());
 const nodes=new Map(),numeric=new Map();let providerEntries=0,duplicateEntries=0;
 for(const c of captures){assert.equal(c.status,'SUCCESS');assert.equal(c.error,null);assert.equal(c.endpoint,`users/${c.owner}/repos?type=owner&sort=full_name&per_page=100`);const pages=rawByOwner[c.owner];assert.ok(Array.isArray(pages)&&pages.length>0&&pages.every(p=>Array.isArray(p)&&p.length<=100));assert.equal(c.pages,pages.length);assert.deepEqual(c.pageLengths,pages.map(p=>p.length));
  assert.ok(pages.slice(0,-1).every(p=>p.length===100),'short intermediate metadata page');
  for(const raw of pages.flat()){providerEntries++;const r=fields(raw);assert.ok(Number.isSafeInteger(r.id)&&r.id>0);assert.ok(typeof r.nodeId==='string'&&r.nodeId);assert.equal(r.owner,c.owner);assert.ok(r.fullName.startsWith(c.owner+'/'));assert.equal(r.private,false);assert.equal(r.visibility,'public');for(const k of ['hasIssues','archived','fork'])assert.equal(typeof r[k],'boolean');assert.ok(Number.isSafeInteger(r.openIssuesCount)&&r.openIssuesCount>=0);assert.ok(Number.isFinite(Date.parse(r.createdAt))&&Number.isFinite(Date.parse(r.updatedAt)));assert.equal(r.htmlUrl,'https://github.com/'+r.fullName);
   if(nodes.has(r.nodeId)){assert.deepEqual(nodes.get(r.nodeId),r);duplicateEntries++;continue;}assert.ok(!numeric.has(r.id));numeric.set(r.id,r.nodeId);nodes.set(r.nodeId,r);
  }
 }
 const repositories=[],excluded=[];for(const r of [...nodes.values()].sort((a,b)=>a.nodeId.localeCompare(b.nodeId,'en'))){const reason=plan.cohort.excludedAlreadyEvaluatedRepositoryIds.includes(r.nodeId)?'already-evaluated-repository':!r.hasIssues?'issues-disabled':null;if(reason)excluded.push({...r,reason});else repositories.push(r);}
 return {totalProviderEntries:providerEntries,uniqueRepositories:nodes.size,duplicateEntries,repositories,excluded};
}
export function verifyRetainedMetadata(plan,attempt,completion,record,rawByOwner){
 assert.equal(attempt.planNativeCommit,record.planNativeCommit);assert.deepEqual(attempt.owners,plan.cohort.owners);assert.equal(completion.status,'SUCCESS');assert.deepEqual(completion.captures,record.captures);validateWindow(attempt.startedAt,completion.endedAt,plan.cohort.metadataWindowMs);assert.equal(record.startedAt,attempt.startedAt);validateWindow(attempt.startedAt,record.endedAt,plan.cohort.metadataWindowMs);assert.ok(Date.parse(record.endedAt)<=Date.parse(completion.endedAt));for(const c of record.captures)assert.ok(Date.parse(c.completedAt)>=Date.parse(attempt.startedAt)&&Date.parse(c.completedAt)<=Date.parse(record.endedAt));
 for(const object of [attempt,record])for(const key of ['newBodies','newCandidates','newModelPosts'])assert.equal(object[key],0);const replay=replayMetadataScope(plan,record.captures,rawByOwner);for(const k of Object.keys(replay))assert.deepEqual(record[k],replay[k]);return replay;
}
