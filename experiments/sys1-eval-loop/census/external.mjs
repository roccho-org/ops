import {assertGraphQLEnvelope} from './issue-pages.mjs';
import assert from 'node:assert/strict';

// A separately declared convenience cohort, never a replacement for the
// completed zero-case window or a representative sample of development work.
export const EXTERNAL_REPOSITORIES=Object.freeze(['cli/cli','NixOS/nixpkgs','microsoft/vscode']);
export const EXTERNAL_REPOSITORY_QUERY='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){__typename id nameWithOwner isPrivate hasIssuesEnabled}}';
const exact=(object,keys)=>assert.deepEqual(Object.keys(object).sort(),[...keys].sort());
export function replayExternalRepositoryScope(captures){
 assert.deepEqual(captures.map(c=>c.requestedFullName).sort(),[...EXTERNAL_REPOSITORIES].sort());
 const ids=new Set(),repositories=[];
 for(const fullName of EXTERNAL_REPOSITORIES){
  const c=captures.find(c=>c.requestedFullName===fullName);assert.equal(c.status,'SUCCESS');assert.equal(c.error,null);assertGraphQLEnvelope(c.reply);exact(c.reply.data,['repository']);
  const r=c.reply.data.repository;assert.ok(r);exact(r,['__typename','id','nameWithOwner','isPrivate','hasIssuesEnabled']);assert.equal(r.__typename,'Repository');assert.ok(typeof r.id==='string'&&r.id&&!ids.has(r.id));ids.add(r.id);assert.equal(r.nameWithOwner,fullName);assert.equal(r.isPrivate,false);assert.equal(r.hasIssuesEnabled,true);
  repositories.push({nodeId:r.id,fullName:r.nameWithOwner});
 }
 return {schema:'ops.sys1.census-external-repository-scope.v1',status:'PUBLIC_SCOPE_AWAITING_NATIVE_RETAIN',repositories,newIssueBodyRequests:0,newModelRequests:0,scope:'three prospectively named convenience repositories; no substitution, random sampling or population-representativeness claim'};
}
