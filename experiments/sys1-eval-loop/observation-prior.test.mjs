import test from 'node:test';import assert from 'node:assert/strict';import {collectPriorInputs} from './observation/prior.mjs';
test('prior extraction is not restricted to the four old Ops/Apps aliases',()=>{
 const result=collectPriorInputs([{path:'a.json',json:{url:'https://github.com/another-owner/renamed.repo/issues/7#issuecomment-1',source:'https://github.com/roccho-dev/other/pull/12/files',body:'exact prior body'}},{path:'b.json',json:{text:'  {"body":"nested original","url":"https://github.com/roccho-org/other/issues/5"}',same:'https://github.com/another-owner/renamed.repo/issues/7'}}]);
 assert.equal(result.references.length,4);assert.deepEqual(result.references.find(r=>r.number===7).sources,['a.json','b.json']);assert.deepEqual(result.bodies,['exact prior body','nested original']);assert.ok(result.references.some(r=>r.repository==='roccho-dev/other'&&r.kind==='pull'));
});
test('exact bodies remain byte-sensitive and links do not invent body observations',()=>{
 const result=collectPriorInputs([{path:'x',json:{body:'x',nested:{body:'x\n'},refs:['https://github.com/a/b/issues/1','https://github.com/a/b/issues/1']}}]);assert.deepEqual(result.bodies,['x','x\n']);assert.equal(result.references.filter(r=>r.number===1).length,1);assert.ok(!result.bodies.includes('https://github.com/a/b/issues/1'));
});
test('typed issue identities remain globally excluded after transfer and body editing, without guessing arbitrary IDs',()=>{
 const result=collectPriorInputs([{path:'corpus.json',json:{schema:'ops.sys1.real-case-corpus.v1',cases:[{sourceId:'old-repo/known-issue',body:'old body'}]}},{path:'ids.json',json:[{source:{issueNodeId:'explicit-issue'}},{__typename:'Issue',id:'graphql-issue'},{node_id:'rest-issue',html_url:'https://github.com/a/b/issues/1'},{id:'not-typed'},{sourceId:'not-a-corpus/ignored'},{node_id:'pull-id',html_url:'https://github.com/a/b/pull/2',pull_request:{}}]}]);
 assert.deepEqual(result.knownIssueNodeIds,['explicit-issue','graphql-issue','known-issue','rest-issue']);assert.ok(!result.knownIssueNodeIds.includes('not-typed'));assert.ok(result.issueIdentityEvidence.every(r=>r.evidence.length>0));
});
