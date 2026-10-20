import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {targetRequest} from './feedback-improvement.mjs';import {wireTemplate} from './regression/scoped-request.mjs';
import {observationRequest,observationPhysicalRequest,observationTemplates,OBSERVATION_SCOPE} from './observation/request.mjs';
const best=JSON.parse(fs.readFileSync(new URL('./results/real-case-pass1-20261020/input.json',import.meta.url),'utf8')).best;
test('O-only treatment preserves the original E and all non-criteria O fields',async()=>{
 const body='現在の実装は未確認。次は確認を行う。',old=targetRequest(body,best,'O'),fresh=observationRequest(body,best,'O');
 assert.deepEqual(observationRequest(body,best,'E'),targetRequest(body,best,'E'));
 assert.deepEqual({...fresh,criteria:old.criteria},old);assert.deepEqual(Object.keys(fresh.criteria),['yes','no']);
 for(const label of ['yes','no'])assert.equal(fresh.criteria[label],old.criteria[label]+OBSERVATION_SCOPE);
 const a=await wireTemplate(old),b=await wireTemplate(fresh);assert.notDeepEqual(a,b);
 // The transport state contains the body alone, without case IDs or Gold.
 assert.deepEqual(JSON.parse(b.state),{body});
});
test('full-wire proof aliases E only and retains a real O treatment',async()=>{
 const proof=await observationTemplates(best);assert.deepEqual(proof.templates.bestE,proof.templates.scopedE);assert.notDeepEqual(proof.templates.bestO,proof.templates.scopedO);
 for(const key of ['bestO','scopedO','sharedE'])assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(observationPhysicalRequest('fixture body',best,key))))<24000);
 assert.throws(()=>observationPhysicalRequest('fixture',best,'scopedE'));
});
