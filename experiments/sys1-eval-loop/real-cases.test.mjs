import test from 'node:test';import assert from 'node:assert/strict';import {summarizeObserved} from './real-cases/summary.mjs';
const row=(id,best,scoped,gold={E:'no',O:'no'})=>({id,gold,best,scoped});
test('paired complete-case discordance uses issue cases and keeps axis changes distinct',()=>{
 const p=summarizeObserved([row('gain',{E:'yes',O:'no'},{E:'no',O:'no'}),row('loss',{E:'no',O:'no'},{E:'yes',O:'no'}),row('tradeoff',{E:'yes',O:'no'},{E:'no',O:'yes'}),row('same',{E:'no',O:'no'},{E:'no',O:'no'})]);
 assert.equal(p.b,1);assert.equal(p.c,1);assert.equal(p.regressionCases,2);assert.equal(p.axes.O.regressions,1);assert.equal(p.bothIncorrect,1);assert.equal(p.assigned,4);assert.equal(p.approximation,'NOT_COMPUTED');
});
test('unresolved Gold or outputs remain in all-n worst-case bounds rather than inflate a known subset',()=>{
 const p=summarizeObserved([row('gain',{E:'yes',O:'no'},{E:'no',O:'no'}),row('gold-missing',{E:'no',O:'no'},{E:'no',O:'no'},{E:null,O:'no'}),row('output-missing',{E:'no',O:'no'},{E:null,O:'no'})]);
 assert.equal(p.assigned,3);assert.equal(p.resolved,1);assert.equal(p.unknown,2);assert.deepEqual(p.hypergeometricSuccessRanges,{B:[1,3],C:[0,2],R:[0,2]});assert.equal(p.sampleWorstCase.differenceLower,-1/3);assert.equal(p.sampleWorstCase.regressionUpper,2/3);
});
test('partial known regressions are observed but are not double counted in the worst-case R+u',()=>{
 const p=summarizeObserved([row('partial',{E:'no',O:'no'},{E:'yes',O:null})]);assert.equal(p.unknown,1);assert.equal(p.regressionCases,0);assert.equal(p.partialKnownRegressionCases,1);assert.equal(p.observedRegressionCases,1);assert.equal(p.sampleWorstCase.regressionUpper,1);
});
test('bad identifiers/labels do not silently become a missing case, while model drift remains visible',()=>{
 const a=row('x',{E:'no',O:'no'},{E:'no',O:'no'});assert.throws(()=>summarizeObserved([a,a]));assert.throws(()=>summarizeObserved([{...a,gold:{E:'maybe',O:'no'}}]));assert.throws(()=>summarizeObserved([{...a,best:{E:'no'}}]));const p=summarizeObserved([a],{modelStable:false});assert.equal(p.modelStable,false);assert.equal(p.approximation,'NOT_COMPUTED');
});
