import {assertGraphQLEnvelope} from './issue-pages.mjs';
import assert from 'node:assert/strict';
export const PRIOR_REPOSITORY_QUERY='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){__typename id nameWithOwner isPrivate}}';
export const PRIOR_ISSUE_QUERY='query($id:ID!,$number:Int!){node(id:$id){__typename ... on Repository{id nameWithOwner isPrivate issueOrPullRequest(number:$number){__typename ... on Issue{id repository{id nameWithOwner isPrivate}} ... on PullRequest{id repository{id nameWithOwner isPrivate}}}}}}';
const exact=(o,keys)=>assert.deepEqual(Object.keys(o).sort(),[...keys].sort());
// Inputs and outside/private resolution traces stay with root/R. Only already
// known global IDs stay private; only public in-scope typed resolutions and
// aggregate coverage belong in the public projection.
export function resolvePriorReferences({prior,scope,repositoryCaptures,issueCaptures,knownScopeAliases=[]}){
 const names=[...new Set(prior.references.map(r=>r.repository))].sort(),byId=new Map(scope.map(r=>[r.nodeId,r])),aliases=new Map(scope.map(r=>[r.fullName.toLowerCase(),r.nodeId]));
 for(const alias of knownScopeAliases){assert.ok(typeof alias.name==='string'&&alias.name&&byId.has(alias.repositoryId));const key=alias.name.toLowerCase();if(aliases.has(key))assert.equal(aliases.get(key),alias.repositoryId,'conflicting native scope alias');else aliases.set(key,alias.repositoryId);}
 assert.equal(byId.size,scope.length);assert.deepEqual(repositoryCaptures.map(c=>c.requestedFullName).sort(),names);
 const publicRepos=new Map();for(const c of repositoryCaptures){
  const r=c.status==='SUCCESS'&&c.error===null?c.reply?.data?.repository:null;
  if(!r){assert.ok(!aliases.has(c.requestedFullName.toLowerCase()),'known scope alias unresolved');continue;}
  assertGraphQLEnvelope(c.reply);exact(c.reply.data,['repository']);exact(r,['__typename','id','nameWithOwner','isPrivate']);assert.equal(r.__typename,'Repository');assert.ok(typeof r.id==='string'&&r.id);assert.ok(typeof r.nameWithOwner==='string'&&r.nameWithOwner);assert.equal(typeof r.isPrivate,'boolean');
  if(aliases.has(c.requestedFullName.toLowerCase()))assert.equal(r.id,aliases.get(c.requestedFullName.toLowerCase()),'known scope alias resolved to conflicting repository identity');
  if(!byId.has(r.id))continue;assert.equal(r.isPrivate,false);assert.equal(r.nameWithOwner,byId.get(r.id).fullName);publicRepos.set(c.requestedFullName,r);
 }
 const refs=prior.references.filter(r=>publicRepos.has(r.repository));assert.deepEqual(issueCaptures.map(c=>c.referenceUrl).sort(),refs.map(r=>r.url).sort());
 const ids=new Set(prior.knownIssueNodeIds);for(const id of ids)assert.ok(typeof id==='string'&&id);
 const resolvedReferences=[];for(const ref of refs){const cap=issueCaptures.find(c=>c.referenceUrl===ref.url),repo=publicRepos.get(ref.repository);assert.equal(cap.status,'SUCCESS');assert.equal(cap.error,null);assertGraphQLEnvelope(cap.reply);exact(cap.reply.data,['node']);const r=cap.reply.data.node;assert.ok(r);exact(r,['__typename','id','nameWithOwner','isPrivate','issueOrPullRequest']);assert.equal(r.__typename,'Repository');assert.equal(r.id,repo.id);assert.equal(r.nameWithOwner,repo.nameWithOwner);assert.equal(r.isPrivate,false);const item=r.issueOrPullRequest;assert.ok(item);exact(item,['__typename','id','repository']);assert.ok(['Issue','PullRequest'].includes(item.__typename));assert.ok(typeof item.id==='string'&&item.id);assert.ok(item.repository);exact(item.repository,['id','nameWithOwner','isPrivate']);assert.deepEqual(item.repository,{id:r.id,nameWithOwner:r.nameWithOwner,isPrivate:false},'resolved item moved or redirected outside its public scope repository');if(item.__typename==='Issue')ids.add(item.id);resolvedReferences.push({url:ref.url,repositoryId:r.id,repository:r.nameWithOwner,type:item.__typename,id:item.id});}
 const inScopeIssueIds=[...new Set(resolvedReferences.filter(r=>r.type==='Issue').map(r=>r.id))].sort();
 return {schema:'ops.sys1.census-private-prior-resolution.v1',knownIssueNodeIds:[...ids].sort(),publicManifest:{schema:'ops.sys1.census-public-prior-manifest.v1',knownInScopeIssueNodeIds:inScopeIssueIds,resolvedReferences,coverage:{priorGlobalIssueIds:new Set(prior.knownIssueNodeIds).size,referenceRepositoryNames:names.length,resolvedInScopeReferences:refs.length},rule:'public in-scope typed references and aggregate coverage only; references do not imply body observation; PRs do not become Issue IDs; global known IDs and outside/private/unknown traces remain private'}};
}
