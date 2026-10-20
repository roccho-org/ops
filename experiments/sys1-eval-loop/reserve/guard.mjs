import assert from 'node:assert/strict';
import {replayPermutation} from '../real-cases/sample.mjs';

const axes=['E','O'],known=v=>v==='yes'||v==='no';
function index(rows,ids){assert.deepEqual(rows.map(r=>r.id),ids);assert.equal(new Set(ids).size,ids.length);return rows;}
// Pure scoring only: the live entry must verify raw qualifications, requests and
// fixed native provider history before supplying these projections.
export function developmentGuard(cases,h1,h2,candidate,{qualified,modelStable}){
 assert.equal(cases.length,300);const ids=cases.map(c=>c.id);index(h1,ids);index(h2,ids);index(candidate,ids);assert.ok(Number.isSafeInteger(qualified)&&qualified>=0&&qualified<=300);assert.equal(typeof modelStable,'boolean');
 assert.ok(h1.every(r=>axes.every(a=>known(r[a])))&&h2.every(r=>axes.every(a=>known(r[a]))));assert.equal(qualified,candidate.filter(r=>known(r.O)).length);
 let baselineCorrect=0,candidateCorrect=0,unknownGold=0;const repaired=[],regressed=[],unionAxisRegressed=[],unknownProtectedAxes=[];
 for(const [i,c]of cases.entries()){
  for(const axis of axes){assert.ok(known(c.gold?.[axis])||c.gold?.[axis]===null);for(const r of [h1[i],h2[i],candidate[i]])assert.ok(known(r[axis])||r[axis]===null);}
  // E is a historical exact-wire alias, not a newly measured candidate axis.
  assert.equal(candidate[i].E,h1[i].E);
  const complete=axes.every(a=>known(c.gold[a])),before=complete&&axes.every(a=>h1[i][a]===c.gold[a]),after=complete&&axes.every(a=>candidate[i][a]===c.gold[a]);
  if(!complete)unknownGold++;if(before)baselineCorrect++;if(after)candidateCorrect++;if(!before&&after)repaired.push(c.id);if(before&&axes.some(a=>known(candidate[i][a])&&candidate[i][a]!==c.gold[a]))regressed.push(c.id);
  for(const a of axes)if(known(c.gold[a])&&(h1[i][a]===c.gold[a]||h2[i][a]===c.gold[a])){if(!known(candidate[i][a]))unknownProtectedAxes.push({id:c.id,axis:a});else if(candidate[i][a]!==c.gold[a])unionAxisRegressed.push({id:c.id,axis:a});}
 }
 const positiveKnownCompleteGain=candidateCorrect>baselineCorrect,noUnionAxisRegression=unionAxisRegressed.length===0,qualificationComplete=qualified===300;
 return {baselineCorrect,candidateCorrect,unknownGold,repaired,regressed,unionAxisRegressed,unknownProtectedAxes,positiveKnownCompleteGain,noUnionAxisRegression,qualificationComplete,modelStable,eligible:positiveKnownCompleteGain&&noUnionAxisRegression&&qualificationComplete&&modelStable,scope:'retired D300; primary mechanical H1 joint gain; H2 only auxiliary guard; historical E is not fresh confirmation'};
}

// Validate only public identifiers. This never loads the sealed reserve bodies.
export function reserveIdentifiers(sampling){
 assert.equal(sampling.schema,'ops.sys1.real-case-sampling.v1');assert.equal(sampling.frameSize,323);assert.equal(sampling.sampleSize,300);assert.equal(sampling.mode,'SRSWOR');assert.equal(sampling.redraw,false);assert.equal(sampling.modelPosts,0);
 assert.equal(sampling.permutation.length,323);assert.equal(new Set(sampling.permutation).size,323);assert.deepEqual(replayPermutation(sampling.permutation,sampling.draws),sampling.permutation);
 assert.deepEqual(sampling.selectedIds,sampling.permutation.slice(0,300));assert.deepEqual(sampling.reserveIds,sampling.permutation.slice(300));assert.equal(sampling.reserveIds.length,23);
 assert.equal(sampling.frameNativeCommit,'034a16b70a71127bbb09175229048875db649980');assert.equal(sampling.frameSourcePath,'experiments/sys1-eval-loop/observation-root-data/frame-1/frame-replayed.json');
 return {originFrameSize:323,frameSize:23,sampleSize:23,mode:'conditional sealed-complement census; not a new SRS',sourceIds:[...sampling.reserveIds],roundIndex:3,perPassPosts:69,totalPosts:138,tailAlpha:{numerator:1,denominator:1600},freshDraws:0};
}
