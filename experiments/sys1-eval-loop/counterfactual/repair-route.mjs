import assert from 'node:assert/strict';
import {parseCandidate} from './comparison.mjs';

export const REPAIR_MODEL=Object.freeze({providerID:'opencode',id:'deepseek-v4.1-flash'});
export function generatePayloads(projection){
  assert.equal(projection.targetComplete,true);assert.ok(projection.repair);
  const {feedback,noFeedback}=projection.repair;assert.deepEqual(feedback.common,noFeedback.common);
  assert.equal(feedback.advice.available,true);assert.equal(noFeedback.advice.available,false);assert.deepEqual(noFeedback.advice.rows,[]);
  return Object.fromEntries([['feedback',feedback],['no-feedback',noFeedback]].map(([arm,input])=>[arm,{model:{...REPAIR_MODEL},prompt:JSON.stringify(input)}]));
}
export function receiveCandidate(response,best){
  assert.equal(typeof response?.data?.text,'string');const rawText=response.data.text;
  try{return {status:'valid',candidate:parseCandidate(rawText,best),rawText};}
  catch{return {status:'invalid',candidate:null,rawText,reason:'strict JSON/sole instructions/Best prefix/6000 UTF-8 byte contract failed; no repair or redraw'};}
}
