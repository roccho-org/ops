import assert from 'node:assert/strict';

// No API or scope-dependent filtering here. This is a private capture input:
// downstream resolves repositories first and publishes only public scope IDs.
export function collectPriorInputs(blobs){
 const refs=new Map(),bodies=new Set(),issues=new Map();
 function issue(id,source,type){assert.ok(typeof id==='string'&&id);if(!issues.has(id))issues.set(id,[]);const evidence=issues.get(id);if(!evidence.some(x=>x.source===source&&x.type===type))evidence.push({source,type});}
 function urls(text,source){for(const m of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/g)){
  const repository=m[1]+'/'+m[2],kind=m[3],number=Number(m[4]);assert.ok(Number.isSafeInteger(number)&&number>0);const url=`https://github.com/${repository}/${kind}/${number}`;
  if(!refs.has(url))refs.set(url,{repository,kind,number,url,sources:[]});const r=refs.get(url);if(!r.sources.includes(source))r.sources.push(source);
 }}
 function visit(value,source,schema){
  if(typeof value==='string'){urls(value,source);if(/^[\s]*[\[{]/.test(value)){try{const nested=JSON.parse(value);if(nested&&typeof nested==='object')visit(nested,source,nested.schema);}catch{}}return;}
  if(!value||typeof value!=='object')return;
  const currentSchema=value.schema??schema;
  if(typeof value.issueNodeId==='string')issue(value.issueNodeId,source,'explicit issueNodeId');
  if(value.__typename==='Issue')issue(value.id,source,'provider typed Issue');
  if(typeof value.node_id==='string'&&typeof value.html_url==='string'&&/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+(?:$|[?#])/.test(value.html_url)&&!Object.hasOwn(value,'pull_request'))issue(value.node_id,source,'REST issue node_id with issue URL');
  if(currentSchema==='ops.sys1.real-case-corpus.v1'&&typeof value.sourceId==='string'){const parts=value.sourceId.split('/');assert.equal(parts.length,2);assert.ok(parts.every(Boolean));issue(parts[1],source,'real-case corpus compound sourceId');}
  for(const [key,child]of Object.entries(value)){if(key==='body'&&typeof child==='string')bodies.add(child);visit(child,source,currentSchema);}
 }
 for(const blob of blobs){assert.ok(typeof blob.path==='string'&&blob.path);visit(blob.json,blob.path);}
 urls('https://github.com/roccho-org/ops/issues/482','explicit known-used source');
 return {references:[...refs.values()].sort((a,b)=>a.url.localeCompare(b.url,'en')),bodies:[...bodies].sort(),knownIssueNodeIds:[...issues.keys()].sort(),issueIdentityEvidence:[...issues].sort(([a],[b])=>a.localeCompare(b,'en')).map(([issueNodeId,evidence])=>({issueNodeId,evidence})),rule:'all retained native JSON GitHub issue/pull references and explicitly typed issue identities regardless of current repository; conservative identity exclusion, not evidence of every referenced body having been read; exact body values retained independently; no semantic exclusion or arbitrary ID guessing'};
}
