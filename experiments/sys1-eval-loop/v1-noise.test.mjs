import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {retainedD18Best,prepareNoise,assertNoiseInput,evaluateNoise,projectNoise,noiseStageInput} from './v1/noise.mjs';import {admitActivation} from './v1/runtime.mjs';
const execution={source:'s',activation:'a',runUrl:'u'},contract=JSON.parse(fs.readFileSync(new URL('./v1/contract.json',import.meta.url),'utf8'));

test('noise freezes the 626 retained D18 BestE requests exactly',()=>{const retained=retainedD18Best(),input=prepareNoise(execution);assert.equal(input.rows.length,626);assert.equal(input.maxPosts,contract.budget.plan.noise);assert.deepEqual(input.rows.map(r=>r.request),retained.map(r=>r.request));assert.ok(retained.every(r=>r.choice==='yes'||r.choice==='no'));assertNoiseInput(input,execution);console.log('noise requestDigest',input.requestDigest);});

test('noise projection pairs the rerun with retained D18 answers',async()=>{const input=prepareNoise(execution),retained=retainedD18Best();let i=0;const events=[];const report=await evaluateNoise(input,async request=>{const r=retained[i++];assert.deepEqual(request,r.request);return {choice:i===1?(r.choice==='yes'?'no':'yes'):r.choice,model:'jev-1.13.0',usage:{input_tokens:1}};},e=>events.push(e));const p=projectNoise(input,report);assert.deepEqual(p.noise,{n:626,f:1});assert.equal(p.complete,true);assert.equal(events.filter(e=>e.kind==='attempt').length,626);});

test('model drift stops the tail without inventing answers',async()=>{const input=prepareNoise(execution);let calls=0;const report=await evaluateNoise(input,async()=>{calls++;return {choice:'yes',model:'other'};},()=>{});assert.equal(calls,1);assert.equal(report.modelDrift,true);assert.ok(report.rows.every(r=>r.choice===null));assert.throws(()=>projectNoise(input,report));});

test('noise stage input maximum is derived from frozen wire and retained usage',async()=>{const max=await noiseStageInput();assert.ok(Number.isSafeInteger(max)&&max>0);console.log('noise stage inputMax',max,'inputTokenMax',contract.budget.inputTokenMax);});

test('activation admits only request.json on the reviewed source',()=>{const req={phase:'noise',sourceSha:'p',jevOpenLaunch:false,ledger:{http:0,input:0}},src={parent:'p',changed:['experiments/sys1-eval-loop/v1/request.json']};admitActivation(req,src);assert.throws(()=>admitActivation({...req,jevOpenLaunch:true},src));assert.throws(()=>admitActivation(req,{...src,changed:[...src.changed,'x']}));assert.throws(()=>admitActivation({...req,sourceSha:'q'},src));});
