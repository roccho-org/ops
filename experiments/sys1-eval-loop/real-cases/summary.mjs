import assert from 'node:assert/strict';
const AXES=['E','O'],valid=x=>x==='yes'||x==='no';
export function summarizeObserved(rows,{modelStable=null}={}){
 assert.ok(Array.isArray(rows)&&rows.length>0);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.ok(rows.every(r=>typeof r.id==='string'&&r.id));assert.ok(modelStable===null||typeof modelStable==='boolean');
 const s={assigned:rows.length,resolved:0,unknown:0,b:0,c:0,bothCorrect:0,bothIncorrect:0,regressionCases:0,partialKnownRegressionCases:0,baselineCorrect:0,candidateCorrect:0,axes:{E:{resolved:0,unknown:0,regressions:0},O:{resolved:0,unknown:0,regressions:0}},modelStable};
 for(const r of rows){for(const key of ['gold','best','scoped']){assert.ok(r[key]&&typeof r[key]==='object');assert.deepEqual(Object.keys(r[key]).sort(),AXES);for(const a of AXES)assert.ok(r[key][a]===null||valid(r[key][a]));}
  const knownAxis=a=>[r.gold[a],r.best[a],r.scoped[a]].every(valid),broken=a=>knownAxis(a)&&r.best[a]===r.gold[a]&&r.scoped[a]!==r.gold[a];
  for(const a of AXES){if(knownAxis(a)){s.axes[a].resolved++;if(broken(a))s.axes[a].regressions++;}else s.axes[a].unknown++;}
  if(!AXES.every(knownAxis)){s.unknown++;if(AXES.some(broken))s.partialKnownRegressionCases++;continue;}
  s.resolved++;const B=AXES.every(a=>r.best[a]===r.gold[a]),C=AXES.every(a=>r.scoped[a]===r.gold[a]);if(B)s.baselineCorrect++;if(C)s.candidateCorrect++;if(!B&&C)s.b++;else if(B&&!C)s.c++;else if(B)s.bothCorrect++;else s.bothIncorrect++;if(AXES.some(broken))s.regressionCases++;
 }
 assert.equal(s.resolved+s.unknown,s.assigned);assert.equal(s.b+s.c+s.bothCorrect+s.bothIncorrect,s.resolved);
 s.observedRegressionCases=s.regressionCases+s.partialKnownRegressionCases;
 s.sampleWorstCase={differenceLower:(s.b-s.c-s.unknown)/s.assigned,differenceUpper:(s.b-s.c+s.unknown)/s.assigned,regressionUpper:(s.regressionCases+s.unknown)/s.assigned};
 s.hypergeometricSuccessRanges={B:[s.b,s.b+s.unknown],C:[s.c,s.c+s.unknown],R:[s.regressionCases,s.regressionCases+s.unknown]};
 s.approximation='NOT_COMPUTED';s.claim='assigned-case arithmetic only; no confidence, population claim or effect acceptance from this function';return s;
}
