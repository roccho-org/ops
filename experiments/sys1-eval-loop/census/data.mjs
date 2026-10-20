import assert from 'node:assert/strict';
import {frozenReserveAndConfiguration} from '../reserve/and-measurement.mjs';
const label=v=>['yes','no',null].includes(v);
const profiles=Object.freeze({census:Object.freeze({frame:'ops.sys1.census-body-frame.v1',round:4,width:4,keys:['bestO','c2O','c4O','sharedE']}),expectation:Object.freeze({frame:'ops.sys1.expectation-body-frame.v1',round:5,width:3,keys:['bestE','scopedE','sharedO']})});
// Native custody/authenticity and independent full capture replay are admission
// responsibilities. This checks exact values, never a caller's accepted flag.
function validateDataset(data,p){
 const {frame,corpus,view,rootInitial,counterInitial,adjudication,selection}=data,M=frame.cases.length;
 assert.equal(frame.schema,p.frame);assert.equal(frame.status,'OBSERVED_FRAME_AWAITING_NATIVE_RETAIN');if(p===profiles.census){assert.equal(frame.contractIndex,2);assert.deepEqual(frame.configuration,frozenReserveAndConfiguration(selection));}else{assert.equal(selection.schema,'ops.sys1.expectation-selection.v1');assert.equal(selection.noFurtherCandidateChanges,true);assert.equal(selection.adopted,false);assert.deepEqual(selection.physical.measurement,p.keys);assert.deepEqual(frame.configuration,{...selection.configuration,expectedModel:selection.expectedModel});}assert.equal(frame.roundIndex,p.round);assert.equal(frame.newModelRequests,0);assert.ok(M>=1&&M<=300);assert.equal(frame.coverage.eligible,M);assert.equal(new Set(frame.cases.map(c=>c.id)).size,M);
 assert.equal(corpus.schema,'ops.sys1.real-case-corpus.v1');assert.equal(corpus.roundIndex,p.round);assert.equal(corpus.frameSize,M);assert.equal(corpus.cases.length,M);assert.deepEqual(corpus.cases.map(c=>c.id),frame.cases.map(c=>c.id));
 const ids=corpus.cases.map(c=>c.id);for(const [i,c]of corpus.cases.entries()){const {id,body,...source}=frame.cases[i];assert.equal(c.id,id);assert.equal(c.body,body);assert.equal(c.sourceId,source.repositoryId+'/'+source.issueNodeId);assert.deepEqual(c.source,source);assert.ok(typeof body==='string'&&body.trim());for(const axis of ['E','O'])assert.ok(label(c.gold?.[axis]));}
 assert.equal(view.schema,'ops.sys1.real-case-gold-view.v1');assert.deepEqual(view.cases,corpus.cases.map(({id,body})=>({id,body})));
 for(const key of ['frameNativeCommit','viewNativeCommit','rootInitialNativeCommit','counterInitialNativeCommit'])assert.ok(typeof corpus.origin?.[key]==='string'&&corpus.origin[key]);
 for(const r of [rootInitial,counterInitial]){assert.equal(r.schema,'ops.sys1.real-case-rater.v1');assert.equal(r.viewNativeCommit,corpus.origin.viewNativeCommit);assert.deepEqual(r.annotations.map(a=>a.id),ids);for(const a of r.annotations)for(const axis of ['E','O'])assert.ok(label(a[axis]));}
 assert.equal(adjudication.schema,'ops.sys1.real-case-gold-adjudication.v1');assert.equal(adjudication.modelPosts,0);for(const key of ['viewNativeCommit','rootInitialNativeCommit','counterInitialNativeCommit'])assert.equal(adjudication[key],corpus.origin[key]);assert.deepEqual(adjudication.annotations,corpus.cases.map(({id,gold})=>({id,...gold})));
 const agreement=rootInitial.annotations.filter((a,i)=>a.E===counterInitial.annotations[i].E&&a.O===counterInitial.annotations[i].O).length;assert.equal(adjudication.initialAgreementCases,agreement);assert.equal(adjudication.initialDisagreementCases,M-agreement);assert.equal(adjudication.unresolvedCases,corpus.cases.filter(c=>c.gold.E===null||c.gold.O===null).length);
 return {caseDenominator:M,perPassPosts:p.width*M,totalPosts:2*p.width*M,physicalTemplates:[...p.keys],scope:'census of all eligible members of the pre-body metadata prefix, without backfill, sampling CI or future-performance guarantee'};
}
export function validateCensusDataset(data){return validateDataset(data,profiles.census);}
export function validateExpectationCensusDataset(data){return validateDataset(data,profiles.expectation);}
