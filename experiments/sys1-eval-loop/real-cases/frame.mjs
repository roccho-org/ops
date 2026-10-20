import assert from 'node:assert/strict';
import {fixedRequest} from '../regression/scoped-fresh.mjs';import {wireTemplate,scopedTemplates} from '../regression/scoped-request.mjs';
const REPOS=new Set(['roccho-org/ops','roccho-dev/ops','roccho-dev/apps','roccho-org/apps']);
export function priorInputs(blobs){
 const refs=new Map(),bodies=new Set();
 function addURL(url,path){const re=/https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/(issues|pull)\/(\d+)/g;for(const m of url.matchAll(re)){const repo=m[1]+'/'+m[2];if(!REPOS.has(repo))continue;const key=repo+'/'+m[3]+'/'+m[4];if(!refs.has(key))refs.set(key,{repository:repo,kind:m[3],number:Number(m[4]),url:'https://github.com/'+key,sources:[]});const r=refs.get(key);if(!r.sources.includes(path))r.sources.push(path);}}
 function visit(x,path){if(typeof x==='string'){addURL(x,path);if(x.startsWith('{')){try{const j=JSON.parse(x);if(j&&typeof j==='object')visit(j,path);}catch{}}return;}if(!x||typeof x!=='object')return;for(const [k,v]of Object.entries(x)){if(k==='body'&&typeof v==='string')bodies.add(v);visit(v,path);}}
 for(const b of blobs){assert.equal(typeof b.path,'string');visit(b.json,b.path);}addURL('https://github.com/roccho-org/ops/issues/482','explicit known-used source');
 return {references:[...refs.values()].sort((a,b)=>a.url.localeCompare(b.url)),bodies:[...bodies].sort(),rule:'all retained prior experiment JSON references and exact body strings; old605 inventory metadata100 is conservative identity exclusion, not body100 observation'};
}
export function validateWindow(startedAt,endedAt,maxMs=3600000){const a=Date.parse(startedAt),b=Date.parse(endedAt);assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&b>=a&&b-a<=maxMs);return {startedAt,endedAt,maxMs};}
export async function materializeFrame({repositories,prior,knownIssueIds,captures,best,cutoff,startedAt,endedAt}){
 assert.ok(!process.env.JEV_API_KEY);validateWindow(startedAt,endedAt);assert.equal(repositories.length,2);assert.equal(new Set(repositories.map(r=>r.id)).size,2);assert.equal(captures.length,2);const until=Date.parse(cutoff);assert.ok(Number.isFinite(until));
 const known=new Set(knownIssueIds),priorBodies=new Set(prior.bodies),seen=new Set(),cases=[],excluded=[],coverage={rawItems:0,pullRequests:0,afterCutoff:0,knownIssue:0,priorExactBody:0,emptyBody:0,oversize:0,eligible:0};
 const templateProof=await scopedTemplates(best);
 for(const cap of captures){const repo=repositories.find(r=>r.id===cap.repositoryId);assert.ok(repo);assert.equal(repo.isPrivate,false);assert.ok(typeof repo.nameWithOwner==='string'&&repo.nameWithOwner);assert.equal(cap.complete,true);assert.equal(cap.exitStatus,0);assert.ok(Array.isArray(cap.pages)&&cap.pages.length>0);let previous=-Infinity;
  for(const page of cap.pages){assert.ok(Array.isArray(page)&&page.length<=100);for(const item of page){coverage.rawItems++;assert.ok(typeof item.node_id==='string'&&item.node_id);assert.ok(!seen.has(item.node_id));seen.add(item.node_id);assert.ok(Number.isSafeInteger(item.number)&&item.number>0);assert.equal(item.repository_url,'https://api.github.com/repos/'+repo.nameWithOwner);const created=Date.parse(item.created_at),updated=Date.parse(item.updated_at);assert.ok(Number.isFinite(created)&&Number.isFinite(updated)&&created>=previous);previous=created;
   const base={repositoryId:repo.id,repository:repo.nameWithOwner,issueNodeId:item.node_id,number:item.number,url:item.html_url,createdAt:item.created_at,updatedAt:item.updated_at,retrievedAt:cap.retrievedAt};assert.equal(typeof base.url,'string');assert.ok(Number.isFinite(Date.parse(base.retrievedAt))&&Date.parse(base.retrievedAt)>=Date.parse(startedAt)&&Date.parse(base.retrievedAt)<=Date.parse(endedAt));
   const reject=reason=>{excluded.push({...base,reason});coverage[reason]++;};if(item.pull_request){reject('pullRequests');continue;}if(created>=until){reject('afterCutoff');continue;}if(known.has(item.node_id)){reject('knownIssue');continue;}assert.ok(item.body===null||typeof item.body==='string');if(!item.body?.trim()){reject('emptyBody');continue;}if(priorBodies.has(item.body)){reject('priorExactBody');continue;}if(Buffer.byteLength(item.body)>=24000){reject('oversize');continue;}
   const sizes=[];for(const key of ['bestE','scopedE','sharedO'])sizes.push(Buffer.byteLength(JSON.stringify(await wireTemplate(fixedRequest(item.body,best,key)))));if(sizes.some(n=>n>=24000)){reject('oversize');continue;}
   cases.push({...base,id:repo.id+'/'+item.node_id,body:item.body,serializedRequestBytes:sizes});coverage.eligible++;
  }}
 }
 const bodyCounts=new Map();for(const c of cases)bodyCounts.set(c.body,(bodyCounts.get(c.body)??0)+1);
 return {descriptiveDuplicates:{exactBodyGroups:[...bodyCounts.values()].filter(n=>n>1).length,extraIssueCopies:[...bodyCounts.values()].reduce((s,n)=>s+n-1,0),exclusion:false},schema:'ops.sys1.real-case-frame.v1',status:cases.length?'OBSERVED_FRAME_AWAITING_NATIVE_RETAIN':'NO_ELIGIBLE_FRAME',cutoff,acquisition:validateWindow(startedAt,endedAt),repositories,templateProof,coverage,excluded,cases,scope:'captured eligible whole-body versions; non-atomic API traversal; not future GitHub, training-unseen or iid model outputs'};
}
