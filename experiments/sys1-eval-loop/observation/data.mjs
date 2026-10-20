import assert from 'node:assert/strict';import {replayPermutation} from '../real-cases/sample.mjs';import {inferFiniteFrame,reconfirmFixedFrame} from '../real-cases/inference.mjs';
import {prepareObservationMeasurement} from './measurement.mjs';

export function validateObservationDataset(corpus,sampling){
 assert.equal(corpus.schema,'ops.sys1.real-case-corpus.v1');assert.equal(corpus.roundIndex,2);assert.ok(Number.isSafeInteger(corpus.frameSize)&&corpus.frameSize>0);const n=Math.min(300,corpus.frameSize);assert.equal(corpus.cases.length,n);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,n);
 for(const c of corpus.cases){assert.ok(typeof c.id==='string'&&c.id&&!c.id.includes('/'));assert.ok(typeof c.sourceId==='string'&&c.sourceId);assert.ok(typeof c.body==='string'&&c.body.trim());for(const axis of ['E','O'])assert.ok(['yes','no',null].includes(c.gold?.[axis]));}
 assert.equal(sampling.schema,'ops.sys1.real-case-sampling.v1');assert.equal(sampling.status,'SAMPLE_DRAWN_AWAITING_NATIVE_RETAIN');assert.equal(sampling.redraw,false);assert.equal(sampling.modelPosts,0);assert.equal(sampling.frameSize,corpus.frameSize);assert.equal(sampling.sampleSize,n);assert.equal(sampling.permutation.length,corpus.frameSize);assert.equal(new Set(sampling.permutation).size,corpus.frameSize);assert.equal(sampling.mode,n===corpus.frameSize?'census':'SRSWOR');assert.deepEqual(replayPermutation(sampling.permutation,sampling.draws),sampling.permutation);assert.deepEqual(sampling.selectedIds,sampling.permutation.slice(0,n));assert.deepEqual(sampling.reserveIds,sampling.permutation.slice(n));assert.deepEqual(corpus.cases.map(c=>c.sourceId),sampling.selectedIds);
 return {n,frameSize:corpus.frameSize};
}
export async function prepareObservationDataset({corpus,sampling,selection},repId,execution){
 const {frameSize}=validateObservationDataset(corpus,sampling),input=await prepareObservationMeasurement(corpus.cases,selection,repId,execution);return {...input,roundIndex:2,frameSize};
}
export function assertObservationEffectInput(input,{corpus,sampling,selection},repId,execution){
 const {n,frameSize}=validateObservationDataset(corpus,sampling);assert.equal(input.schema,'ops.sys1.observation-measurement.v1');assert.equal(input.repId,repId);assert.ok(repId===1||repId===2);assert.equal(input.roundIndex,2);assert.equal(input.frameSize,frameSize);assert.equal(input.expectedModel,'jev-1.13.0');assert.equal(input.maxPosts,3*n);assert.deepEqual(input.rows,corpus.cases.map(({id,body})=>({id,body})));assert.deepEqual(input.best,selection.configuration.best);assert.deepEqual(input.templateProof,selection.configuration.templateProof);assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.adopted,false);assert.deepEqual(input.execution,execution);
}
export function scoreObservationMeasurement(measured,corpus){
 assert.equal(corpus.roundIndex,2);assert.equal(measured.rows.length,corpus.cases.length);assert.equal(measured.effectCounts.assigned,3*corpus.cases.length);
 const rows=measured.rows.map((r,i)=>{assert.equal(r.id,corpus.cases[i].id);return {...r,gold:{E:corpus.cases[i].gold.E,O:corpus.cases[i].gold.O}};}),base=inferFiniteFrame(rows,{frameSize:corpus.frameSize,roundIndex:2,repId:measured.repId,modelStable:measured.modelStable,samplingValid:true});
 const qualificationComplete=measured.effectCounts.qualified===measured.effectCounts.assigned,knownFailureObserved=base.observed?.observedRegressionCases>0;
 // The numeric robust bounds can remain informative; the protocol's native
 // qualification gate must also be reflected in its acceptance disposition.
 const disposition=knownFailureObserved?'OBSERVED_REGRESSION':!qualificationComplete?'UNKNOWN_INCOMPLETE_MEASUREMENT':base.disposition;
 return {...base,disposition,qualificationComplete,knownFailureObserved,technicalUnknown:!qualificationComplete||!measured.modelStable};
}
export function reconfirmObservationMeasurements(passes){
 const base=reconfirmFixedFrame(passes),knownFailurePasses=passes.filter(p=>p.knownFailureObserved||!p.disposition.startsWith('UNKNOWN')&&p.disposition!=='POSITIVE_FIXED_FRAME_APPROXIMATION').map(p=>p.repId),unknownPasses=passes.filter(p=>p.technicalUnknown||p.disposition.startsWith('UNKNOWN')).map(p=>p.repId);
 return {...base,knownFailurePasses,unknownPasses,disposition:knownFailurePasses.length?'NOT_RECONFIRMED':unknownPasses.length?'UNKNOWN_RECONFIRMATION':base.disposition};
}
