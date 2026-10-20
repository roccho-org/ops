import fs from 'node:fs';import assert from 'node:assert/strict';
export const ISSUE_METADATA_QUERY='query($id:ID!,$endCursor:String){node(id:$id){__typename ... on Repository{id nameWithOwner isPrivate issues(first:100,after:$endCursor,states:[OPEN,CLOSED],orderBy:{field:CREATED_AT,direction:ASC}){nodes{__typename id number createdAt updatedAt} pageInfo{hasNextPage endCursor}}}}}';
export function fixedRepositoryScope(){const s=JSON.parse(fs.readFileSync(new URL('../observation/metadata/repositories.json',import.meta.url),'utf8'));assert.equal(s.schema,'ops.sys1.observation-public-repo-scope.v1');assert.equal(s.repositories.length,117);assert.equal(new Set(s.repositories.map(r=>r.nodeId)).size,117);return s.repositories;}
import {replayIssuePages} from './issue-pages.mjs';
export function replayIssueMetadata(captures,plan){
 const scope=fixedRepositoryScope();assert.equal(plan.schema,'ops.sys1.paired-census-prospective.v1');assert.equal(plan.metadata.candidatePrefixMaximum,300);assert.equal(plan.metadata.prefixBeforeBody,true);assert.equal(plan.metadata.replacementAfterBodyExclusion,false);
 return replayIssuePages(captures,scope,{start:Date.parse(plan.metadata.createdAfterExclusive),end:Date.parse(plan.metadata.createdBeforeInclusive),lowerInclusive:false,upperInclusive:true});
}
