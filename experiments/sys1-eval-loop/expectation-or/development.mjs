import fs from 'node:fs';import assert from 'node:assert/strict';
import {retainedExpectationDevelopment} from '../expectation/development.mjs';
import {retainedExpectationCensus} from '../expectation/held-runtime.mjs';
import {verifyExpectationCensusRecord,reconfirmExpectationCensus} from '../expectation/held-measurement.mjs';
import {verifyExpectationDevelopment} from '../expectation/measurement.mjs';
import {digest} from '../run.mjs';
import {expectationRequest,expectationTemplates} from '../expectation/request.mjs';
import {wireTemplate} from '../regression/scoped-request.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url),'utf8'));
const events=p=>fs.readFileSync(new URL('../'+p+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const provenance=(p,key,repId)=>({runId:p.runId,source:p.source,activation:p.head,artifactId:p.artifactId,runUrl:p.runUrl,key,...(repId?{repId}:{})});
export const OR_HISTORY_SCOPE='626 retired cases; all1997 physical E receipts protect601 known correct IDs; fresh paired E is the primary development comparison, fixed historical O remains nonconcurrent; no retired-H rescue';
export function orEffectSource(){const corpora=['observation/corpus.json','census/corpus.json','expectation/corpus.json'].map(read),original=read('results/expectation-development1-20261021/input.json'),rows=corpora.flatMap(c=>c.cases.map(({id,body})=>({id,body})));assert.equal(rows.length,626);assert.equal(new Set(rows.map(r=>r.id)).size,626);return {rows,best:original.best,templateProof:original.templateProof};}
export async function retainedOrDevelopment(){
 assert.ok(!process.env.JEV_API_KEY);const old=await retainedExpectationDevelopment(),d='results/expectation-development1-20261021/',input=read(d+'input.json'),attempt=read(d+'attempt.json'),report=read(d+'predictions.json'),projection=read(d+'projection.json'),provider=read(d+'provider.json');
 assert.deepEqual(attempt,{inputDigest:digest(input),maxPosts:507});assert.deepEqual(input.execution,{source:provider.source,activation:provider.head,runUrl:provider.runUrl});assert.deepEqual(projection,await verifyExpectationDevelopment(input,report,events(d),old));assert.equal(projection.guard.eligible,true);assert.equal(projection.effectCounts.qualified,507);
 const rows=old.rows.map((r,i)=>({...r,first:{E:r.snapshots[0].E,O:r.snapshots[0].O},snapshots:[...r.snapshots,{E:projection.candidate[i].E,provenance:provenance(provider,'scopedE')}]})),current=retainedExpectationCensus(),held=[],physicalHistories=[...old.physicalHistories,{...provenance(provider,'scopedE'),cases:507}];
 for(const repId of [1,2]){
  const p=`results/expectation-census-pass${repId}-20261021/`,saved=read(p+'projection.json'),{reconfirmation,...main}=saved,record={input:read(p+'input.json'),attempt:read(p+'attempt.json'),report:read(p+'predictions.json'),projection:main,provider:read(p+'provider.json'),events:events(p)};
  const actual=await verifyExpectationCensusRecord(record,current.corpus.cases,current.selection);assert.equal(actual.measurement.effectCounts.qualified,357);assert.equal(actual.measurement.modelStable,true);held.push({actual,provider:record.provider});if(reconfirmation)assert.deepEqual(reconfirmation,reconfirmExpectationCensus(held.map(h=>h.actual)));
  for(const key of ['bestE','scopedE'])physicalHistories.push({...provenance(record.provider,key,repId),cases:119});
 }
 for(const [i,c]of current.corpus.cases.entries()){
  const snapshots=held.flatMap((h,rep)=>['bestE','scopedE'].map(key=>({E:h.actual.measurement.rows[i][key==='bestE'?'best':'scoped'].E,provenance:provenance(h.provider,key,rep+1)}))),first=held[0].actual.measurement.rows[i].best;
  rows.push({id:c.id,body:c.body,sourceId:c.sourceId,source:c.source,gold:c.gold,first:{E:first.E,O:first.O},snapshots});
 }
 assert.equal(rows.length,626);assert.equal(new Set(rows.map(r=>r.id)).size,626);assert.equal(physicalHistories.reduce((n,h)=>n+h.cases,0),1997);const protectedIds=rows.filter(r=>r.snapshots.some(s=>s.E===r.gold.E)).map(r=>r.id);assert.equal(protectedIds.length,601);
 const selection=read('expectation/selection.json');assert.equal(selection.configuration.best,old.best);assert.deepEqual(selection.configuration.templateProof,input.templateProof);
 return {rows,best:old.best,templateProof:input.templateProof,physicalHistories,protectedIds,scope:OR_HISTORY_SCOPE};
}
export async function prepareOrDevelopment(data,execution){
 assert.ok(!process.env.JEV_API_KEY);assert.equal(data.rows.length,626);assert.equal(data.protectedIds.length,601);const templateProof=await expectationTemplates(data.best);assert.deepEqual(templateProof,data.templateProof);
 for(const row of data.rows)for(const key of ['bestE','scopedE']){const payload=await wireTemplate(expectationRequest(row.body,data.best,key));assert.deepEqual(JSON.parse(payload.state),{body:row.body});assert.ok(Buffer.byteLength(JSON.stringify(payload))<24000);payload.state=templateProof[key].state;assert.deepEqual(payload,templateProof[key]);}
 return {schema:'ops.sys1.expectation-or-development.v1',rows:data.rows.map(({id,body})=>({id,body})),best:data.best,templateProof,expectedModel:'jev-1.13.0',maxPosts:1252,execution,historyScope:data.scope,combination:'qualified OR(bestE,scopedE); both components required, no short circuit'};
}
export function assertOrDevelopmentInput(input,source,execution){assert.deepEqual(Object.keys(input).sort(),['schema','rows','best','templateProof','expectedModel','maxPosts','execution','historyScope','combination'].sort());assert.equal(input.schema,'ops.sys1.expectation-or-development.v1');assert.deepEqual(input.rows,source.rows);assert.equal(input.rows.length,626);assert.equal(input.best,source.best);assert.deepEqual(input.templateProof,source.templateProof);assert.equal(input.expectedModel,'jev-1.13.0');assert.equal(input.maxPosts,1252);assert.deepEqual(input.execution,execution);assert.equal(input.historyScope,OR_HISTORY_SCOPE);assert.equal(input.combination,'qualified OR(bestE,scopedE); both components required, no short circuit');}
