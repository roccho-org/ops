import assert from 'node:assert/strict';
import {validateWindow} from '../real-cases/frame.mjs';
import {observationPhysicalRequest,observationTemplates} from './request.mjs';
import {wireTemplate} from '../regression/scoped-request.mjs';

// Pure materialization only. Root owns standard gh API capture and native raw
// retention; neither the repository scope nor issue bodies are fetched here.
export function validatePublicCaptureScope(scope,captures,visibility,startedAt,endedAt){
 const ids=scope.repositories.map(r=>r.nodeId).sort();assert.ok(visibility?.before&&visibility?.after);
 for(const check of [visibility.before,visibility.after]){assert.deepEqual(check.repositories.map(r=>r.id).sort(),ids);assert.equal(new Set(check.repositories.map(r=>r.id)).size,ids.length);assert.ok(Date.parse(check.startedAt)>=Date.parse(startedAt)&&Date.parse(check.completedAt)<=Date.parse(endedAt));assert.ok(Date.parse(check.startedAt)<=Date.parse(check.completedAt));for(const r of check.repositories){assert.equal(r.isPrivate,false);assert.ok(typeof r.nameWithOwner==='string'&&/^[^/]+\/[^/]+$/.test(r.nameWithOwner));}}
 for(const cap of captures){validateWindow(cap.startedAt,cap.retrievedAt);assert.ok(Date.parse(cap.startedAt)>=Date.parse(visibility.before.completedAt));assert.ok(Date.parse(cap.retrievedAt)<=Date.parse(visibility.after.startedAt));}
 const before=new Map(visibility.before.repositories.map(r=>[r.id,r]));for(const r of visibility.after.repositories)assert.deepEqual(r,before.get(r.id),'repository public identity/name changed during non-atomic capture');
 return scope.repositories.map(r=>({...r,scopeFullName:r.fullName,fullName:before.get(r.nodeId).nameWithOwner}));
}
export async function materializeObservationFrame({scope,captures,visibility,knownIssueIds,priorBodies,best,cutoff,startedAt,endedAt}){
 assert.ok(!process.env.JEV_API_KEY);const acquisition=validateWindow(startedAt,endedAt),until=Date.parse(cutoff);assert.ok(Number.isFinite(until));
 const repositories=validatePublicCaptureScope(scope,captures,visibility,startedAt,endedAt);assert.ok(repositories.length>0);assert.equal(new Set(repositories.map(r=>r.nodeId)).size,repositories.length);assert.deepEqual(captures.map(c=>c.repositoryId).sort(),repositories.map(r=>r.nodeId).sort());
 const known=new Set(knownIssueIds),bodies=new Set(priorBodies),seen=new Set(),cases=[],excluded=[],coverage={rawItems:0,pullRequests:0,afterCutoff:0,knownIssue:0,priorExactBody:0,emptyBody:0,oversize:0,eligible:0};
 for(const cap of captures){const repo=repositories.find(r=>r.nodeId===cap.repositoryId);assert.equal(repo.private,false);assert.equal(repo.hasIssues,true);assert.equal(cap.complete,true);assert.equal(cap.exitStatus,0);assert.ok(Array.isArray(cap.pages)&&cap.pages.length>0);assert.ok(cap.pages.every(p=>Array.isArray(p)&&p.length<=100));assert.ok(cap.pages.slice(0,-1).every(p=>p.length===100));const retrieved=Date.parse(cap.retrievedAt);assert.ok(retrieved>=Date.parse(startedAt)&&retrieved<=Date.parse(endedAt));let previous=-Infinity;
  for(const item of cap.pages.flat()){
   coverage.rawItems++;assert.ok(typeof item.node_id==='string'&&item.node_id);assert.ok(!seen.has(item.node_id));seen.add(item.node_id);assert.ok(Number.isSafeInteger(item.number)&&item.number>0);assert.equal(item.repository_url,'https://api.github.com/repos/'+repo.fullName);const created=Date.parse(item.created_at),updated=Date.parse(item.updated_at);assert.ok(Number.isFinite(created)&&Number.isFinite(updated)&&created>=previous);previous=created;
   const base={repositoryId:repo.nodeId,repository:repo.fullName,scopeRepository:repo.scopeFullName,issueNodeId:item.node_id,number:item.number,url:item.html_url,createdAt:item.created_at,updatedAt:item.updated_at,retrievedAt:cap.retrievedAt};assert.ok(typeof base.url==='string'&&base.url.startsWith('https://github.com/'+repo.fullName+'/'));
   const reject=reason=>{coverage[reason]++;excluded.push({...base,reason});};
   if(item.pull_request){reject('pullRequests');continue;}if(created>=until){reject('afterCutoff');continue;}if(known.has(item.node_id)){reject('knownIssue');continue;}assert.ok(item.body===null||typeof item.body==='string');if(!item.body?.trim()){reject('emptyBody');continue;}if(bodies.has(item.body)){reject('priorExactBody');continue;}if(Buffer.byteLength(item.body)>=24000){reject('oversize');continue;}
   const sizes=[];for(const key of ['bestO','scopedO','sharedE'])sizes.push(Buffer.byteLength(JSON.stringify(await wireTemplate(observationPhysicalRequest(item.body,best,key)))));if(sizes.some(n=>n>=24000)){reject('oversize');continue;}
   cases.push({...base,id:repo.nodeId+'/'+item.node_id,body:item.body,serializedRequestBytes:sizes});coverage.eligible++;
  }
 }
 const counts=new Map();for(const c of cases)counts.set(c.body,(counts.get(c.body)??0)+1);
 return {schema:'ops.sys1.real-case-frame.v1',status:cases.length?'OBSERVED_FRAME_AWAITING_NATIVE_RETAIN':'NO_ELIGIBLE_FRAME',roundIndex:2,cutoff,acquisition,repositories,visibility,templateProof:await observationTemplates(best),coverage,excluded,cases,descriptiveDuplicates:{exactBodyGroups:[...counts.values()].filter(n=>n>1).length,extraIssueCopies:[...counts.values()].reduce((s,n)=>s+n-1,0),exclusion:false},scope:'prospectively fixed public repository metadata; whole captured issue bodies; one issue one weight; public at the pre/post observations only, no atomic private-transition or future-model guarantee'};
}
