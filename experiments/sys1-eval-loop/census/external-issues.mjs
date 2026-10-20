import fs from 'node:fs';import assert from 'node:assert/strict';
import {replayExternalRepositoryScope} from './external.mjs';
import {ISSUE_METADATA_QUERY} from './metadata.mjs';
import {replayIssuePages} from './issue-pages.mjs';
export const EXTERNAL_ISSUE_QUERY=ISSUE_METADATA_QUERY;
const read=name=>JSON.parse(fs.readFileSync(new URL('./external-scope/'+name,import.meta.url),'utf8'));
export function fixedExternalRepositoryScope(){
 const replay=replayExternalRepositoryScope(read('captures.json')),stored=read('scope.json');
 for(const key of Object.keys(replay))assert.deepEqual(stored[key],replay[key]);
 return replay.repositories;
}
export function replayExternalIssueMetadata(captures,plan){
 assert.equal(plan.schema,'ops.sys1.paired-census-external-prospective.v1');assert.equal(plan.contractIndex,2);assert.equal(plan.issueMetadataMode,'ALL_HISTORY_CURSOR');assert.equal(plan.limits.acquisitionWindowMs,3600000);assert.equal(plan.limits.maximumPrefix,300);
 assert.deepEqual(plan.createdWindow,{startInclusive:'2026-10-19T00:00:00Z',endExclusive:'2026-10-20T00:00:00Z',reason:'one completed UTC day, fixed before external repository or Issue metadata; no size- or outcome-based adjustment'});
 const scope=fixedExternalRepositoryScope();assert.deepEqual(plan.repositoryNames,scope.map(r=>r.fullName));
 for(const cap of captures){const repo=scope.find(r=>r.nodeId===cap.repositoryId);assert.ok(repo);for(const p of cap.pages)assert.equal(p.data.node.nameWithOwner,repo.fullName,'fixed external scope name changed');}
 const replay=replayIssuePages(captures,scope,{start:Date.parse(plan.createdWindow.startInclusive),end:Date.parse(plan.createdWindow.endExclusive),lowerInclusive:true,upperInclusive:false});
 return {...replay,schema:'ops.sys1.paired-census-external-metadata-prefix.v1',contractIndex:2,repositoryScope:scope,createdWindow:{startInclusive:plan.createdWindow.startInclusive,endExclusive:plan.createdWindow.endExclusive},mode:'ALL_HISTORY_CURSOR',scope:'pooled prefix of three fixed convenience repositories; whole filtered metadata history terminated, not a random or representative sample; body eligibility never backfills'};
}
