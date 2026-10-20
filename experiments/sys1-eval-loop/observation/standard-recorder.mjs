import fs from 'node:fs';import assert from 'node:assert/strict';
import {responseFlags,failureDetails} from '../target-loop/loop.mjs';
import * as client from '../../../packages/jev/src/client.mjs';

// The existing standard Jev path only: no caller-supplied endpoint, transport,
// retry policy or executor. Round admission remains in each fixed entry.
export function standardRecorder(input,eventsFile){
 assert.ok(process.env.JEV_API_KEY?.trim());assert.equal(input.expectedModel,'jev-1.13.0');assert.ok(Number.isSafeInteger(input.maxPosts)&&input.maxPosts>0);
 let calls=0,activeId=null,httpStatus=null,stage='local';const observe=e=>{if(e.kind==='attempt')activeId=e.id;fs.appendFileSync(eventsFile,JSON.stringify({...e,...(input.repId?{repId:input.repId}:{})})+'\n',{mode:0o600});};
 const bound=client.bindJev({apiKey:process.env.JEV_API_KEY,fetch:async(u,i)=>{const r=await fetch(u,{...i,redirect:'error'});httpStatus=r.status;return r;}});
 const ask=async request=>{let usage=null;httpStatus=null;stage='local';try{
  const provider={available:bound.available,post:async body=>{assert.equal(body.model,'jev-latest');assert.equal(Object.keys(body.answers??{}).length,0);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);assert.ok(calls<input.maxPosts);calls++;observe({kind:'post',id:activeId});stage='provider';const data=await bound.post(body,{deadlineMs:15000});observe({kind:'response-flags',id:activeId,...responseFlags(data,input.expectedModel)});stage='response-model';if(data.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}stage='response-answers';assert.deepEqual(Object.keys(data.answers??{}),['live']);const a=data.answers.live,p=a.probabilities;stage='response-probabilities';assert.ok(Math.abs(Object.values(p).reduce((s,v)=>s+v,0)-1)<1e-5&&p[a.choice]>=Math.max(...Object.values(p))-1e-6);usage=Object.fromEntries(Object.entries(data.usage??{}).filter(([k,v])=>['input_tokens','output_tokens','total_tokens'].includes(k)&&Number.isFinite(v)&&v>=0));stage='typed-contract';return data;}};
  const answer=await client.askJevChoice({...request,provider});return {choice:answer.choice.choice,model:answer.model,usage};
 }catch(error){observe({kind:'failure',id:activeId,...failureDetails(error,stage,httpStatus)});throw error;}};
 return {ask,observe,get calls(){return calls;}};
}
