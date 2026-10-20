import test from 'node:test';import assert from 'node:assert/strict';import {priorInputs,materializeFrame,validateWindow} from './real-cases/frame.mjs';
const repositories=[{id:'R1',nameWithOwner:'roccho-org/ops',isPrivate:false},{id:'R2',nameWithOwner:'roccho-dev/apps',isPrivate:false}],startedAt='2026-10-20T10:00:00Z',endedAt='2026-10-20T10:05:00Z';
const item=(n,body,extra={})=>({node_id:'I'+n,number:n,body,html_url:'https://github.com/roccho-org/ops/issues/'+n,repository_url:'https://api.github.com/repos/roccho-org/ops',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-19T00:00:00Z',...extra});
const input=items=>({repositories,prior:{bodies:['already used body']},knownIssueIds:['I1'],captures:[{repositoryId:'R1',complete:true,exitStatus:0,retrievedAt:endedAt,pages:[items]},{repositoryId:'R2',complete:true,exitStatus:0,retrievedAt:endedAt,pages:[[]]}],best:'Best',cutoff:'2026-10-20T00:00:00Z',startedAt,endedAt});
test('prior metadata identities and exact request bodies are collected without pretending metadata is full-body history',()=>{
 const p=priorInputs([{path:'snapshot.json',json:{inventory:[{url:'https://github.com/roccho-dev/ops/issues/573'}],cases:[{body:'old body',source:{url:'https://github.com/roccho-dev/apps/issues/94'}}]}},{path:'retained.json',json:{text:JSON.stringify({body:'actual old provider input'})}}]);assert.equal(p.references.length,3);assert.ok(p.references.some(r=>r.number===482));assert.deepEqual(p.bodies,['actual old provider input','old body']);assert.match(p.rule,/metadata100/);
});
test('complete public traversal keeps whole body, structural exclusions and raw coverage with no semantic nearclone rule',async()=>{
 const p=await materializeFrame(input([item(1,'new-looking but known identity'),item(2,'already used body'),item(3,' '),item(4,'x'.repeat(24000)),item(5,'whole retained body'),item(6,'whole retained body'),item(7,'PR body',{pull_request:{url:'pull'}}),item(8,'after cutoff',{created_at:'2026-10-21T00:00:00Z'})]));
 assert.equal(p.status,'OBSERVED_FRAME_AWAITING_NATIVE_RETAIN');assert.equal(p.coverage.rawItems,8);assert.equal(p.cases.length,2);assert.ok(p.cases.every(c=>c.body==='whole retained body'&&c.serializedRequestBytes.length===3));assert.deepEqual(p.descriptiveDuplicates,{exactBodyGroups:1,extraIssueCopies:1,exclusion:false});assert.equal(p.coverage.knownIssue,1);assert.equal(p.coverage.priorExactBody,1);assert.equal(p.coverage.pullRequests,1);
});
test('partial pagination, identity duplicates, wrong repository, nonpublic or out-of-window captures are invalid',async()=>{
 for(const change of [x=>x.captures[0].complete=false,x=>x.captures[0].pages[0].push(item(2,'duplicate')),x=>x.captures[0].pages[0][0].repository_url='https://api.github.com/repos/wrong/repo',x=>x.repositories[0].isPrivate=true,x=>x.captures[0].retrievedAt='2026-10-21T00:00:00Z']){const x=structuredClone(input([item(2,'new body')]));change(x);await assert.rejects(()=>materializeFrame(x));}
 assert.throws(()=>validateWindow(startedAt,'2026-10-20T11:00:01Z'));assert.doesNotThrow(()=>validateWindow(startedAt,'2026-10-20T11:00:00Z'));
});
test('zero eligible issues is an explicit non-sampled empty frame rather than an approximation success',async()=>{
 const p=await materializeFrame(input([item(1,'known')]));assert.equal(p.status,'NO_ELIGIBLE_FRAME');assert.equal(p.cases.length,0);
});
