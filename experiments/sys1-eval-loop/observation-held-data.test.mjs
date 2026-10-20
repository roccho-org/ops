import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {retainedMeasurement,preparedMeasurement} from './observation/runtime.mjs';import {validateObservationDataset,assertObservationEffectInput} from './observation/data.mjs';
import {observationPhysicalRequest} from './observation/request.mjs';import {wireTemplate} from './regression/scoped-request.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL('./observation/'+name+'.json',import.meta.url),'utf8'));
test('selected real dataset retains both original raters, every adjudication and all seven unresolved cases',()=>{
 const data=retainedMeasurement(),{corpus,sampling}=data;assert.deepEqual(validateObservationDataset(corpus,sampling),{n:300,frameSize:323});assert.equal(sampling.reserveIds.length,23);
 const root=read('gold-root-initial'),counter=read('gold-counter-initial'),adjudication=read('gold-adjudication'),third=read('gold-third-counter');assert.equal(root.annotations.length,300);assert.equal(counter.annotations.length,300);assert.deepEqual(root.annotations.map(c=>c.id),corpus.cases.map(c=>c.id));assert.deepEqual(counter.annotations.map(c=>c.id),corpus.cases.map(c=>c.id));assert.equal(adjudication.state,'FROZEN_BEFORE_ANY_HELD_MODEL_OUTPUTS');assert.equal(adjudication.initialAgreementCases,290);assert.equal(adjudication.initialDisagreementCases,10);assert.equal(adjudication.resolvedCases,3);assert.equal(adjudication.unresolvedCases,7);
 assert.deepEqual(third.cases.map(c=>c.id).sort(),adjudication.disagreements.map(c=>c.id).sort());let disagreementCount=0;
 for(const [i,c]of corpus.cases.entries())for(const axis of ['E','O']){const a=root.annotations[i][axis],b=counter.annotations[i][axis];if(a===b)assert.equal(c.gold[axis],a);else{disagreementCount++;const d=adjudication.disagreements.find(d=>d.id===c.id&&d.axis===axis);assert.ok(d);assert.equal(d.rootInitial,a);assert.equal(d.counterInitial,b);assert.equal(c.gold[axis],d.final);}}
 assert.equal(disagreementCount,10);assert.equal(corpus.cases.filter(c=>c.gold.O===null).length,7);assert.equal(corpus.cases.filter(c=>c.gold.E==='yes').length,295);assert.equal(corpus.cases.filter(c=>c.gold.O==='yes').length,140);assert.equal(corpus.cases.filter(c=>c.gold.O==='no').length,153);assert.deepEqual(corpus.cases.map(c=>c.sourceId),sampling.selectedIds);
});
test('all 1800 prospective real-case request wires are body-only and retain the frozen configuration',async()=>{
 const data=retainedMeasurement();let count=0,maxBytes=0;
 for(const repId of [1,2]){const execution={source:'fixture-only-no-model-effect',repId},input=await preparedMeasurement(repId,execution);assert.equal(input.maxPosts,900);assert.deepEqual(input.rows,data.corpus.cases.map(({id,body})=>({id,body})));
  process.env.JEV_API_KEY='synthetic-sentinel-not-a-credential';try{assertObservationEffectInput(input,data,repId,execution);}finally{delete process.env.JEV_API_KEY;}
  for(const r of input.rows)for(const key of ['bestO','scopedO','sharedE']){const wire=await wireTemplate(observationPhysicalRequest(r.body,input.best,key));assert.deepEqual(JSON.parse(wire.state),{body:r.body});const bytes=Buffer.byteLength(JSON.stringify(wire));assert.ok(bytes<24000);maxBytes=Math.max(maxBytes,bytes);count++;}
 }
 assert.equal(count,1800);assert.ok(maxBytes>0&&maxBytes<24000);
});
