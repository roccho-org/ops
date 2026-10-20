import assert from 'node:assert/strict';
const binary=['yes','no'],known=v=>binary.includes(v),range=(rows,key)=>[Math.min(...rows.map(r=>r[key])),Math.max(...rows.map(r=>r[key]))];
export function feasibleCase(row){
 assert.ok(typeof row.id==='string'&&row.id);for(const object of [row.gold,row.best,row.candidate])for(const axis of ['E','O'])assert.ok(known(object?.[axis])||object?.[axis]===null);
 const knownRegressionAxes=['E','O'].filter(a=>known(row.gold[a])&&known(row.best[a])&&known(row.candidate[a])&&row.best[a]===row.gold[a]&&row.candidate[a]!==row.gold[a]);
 if([row.best,row.candidate].some(p=>!known(p.E)||!known(p.O)))return {id:row.id,technicalUnknown:true,knownRegressionAxes,completions:null,bounds:null};
 const completions=[];for(const E of binary)for(const O of binary){const gold={E,O};if(['E','O'].some(a=>known(row.gold[a])&&gold[a]!==row.gold[a]))continue;const before=['E','O'].every(a=>row.best[a]===gold[a]),after=['E','O'].every(a=>row.candidate[a]===gold[a]);completions.push({gold,b:Number(!before&&after),c:Number(before&&!after),delta:Number(after)-Number(before),R:Number(['E','O'].some(a=>row.best[a]===gold[a]&&row.candidate[a]!==gold[a]))});}
 const bounds=Object.fromEntries(['b','c','delta','R'].map(key=>[key,range(completions,key)]));return {id:row.id,technicalUnknown:false,knownRegressionAxes,completions,bounds};
}
export function scorePairedCensus(rows,{physical,modelStable,repId}){
 assert.ok(Array.isArray(rows)&&rows.length<=300);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.ok(repId===1||repId===2);assert.equal(typeof modelStable,'boolean');assert.equal(physical.assigned,4*rows.length);assert.ok(Number.isInteger(physical.qualified)&&physical.qualified>=0&&physical.qualified<=physical.assigned);
 const cases=rows.map(feasibleCase),knownRegressionCases=cases.filter(c=>c.knownRegressionAxes.length).map(c=>c.id),qualificationComplete=physical.qualified===physical.assigned&&!cases.some(c=>c.technicalUnknown),technicalUnknown=!qualificationComplete||!modelStable;
 const sum=(key,i)=>cases.reduce((n,c)=>n+c.bounds[key][i],0),bounds=rows.length&&!technicalUnknown?{differenceLowerNumerator:sum('delta',0),differenceUpperNumerator:sum('delta',1),regressionLowerNumerator:sum('R',0),regressionUpperNumerator:sum('R',1),denominator:rows.length}:null;
 const accepted=Boolean(bounds&&bounds.differenceLowerNumerator>0&&bounds.regressionUpperNumerator===0),disposition=!rows.length?'NO_CASES':knownRegressionCases.length?'OBSERVED_REGRESSION':!modelStable?'UNKNOWN_INVALID_MEASUREMENT':!qualificationComplete?'UNKNOWN_INCOMPLETE_MEASUREMENT':accepted?'POSITIVE_FIXED_CENSUS_GAIN':'NOT_ESTABLISHED';
 return {schema:'ops.sys1.paired-feasible-census.v1',roundIndex:4,repId,assigned:rows.length,caseIds:rows.map(r=>r.id),physical:{...physical},qualificationComplete,modelStable,technicalUnknown,knownRegressionCases,cases,bounds,accepted,disposition,inference:'deterministic census envelope over shared Gold completions within each case and independently allowed completion sets across cases; no sampling CI, p-value, model independence or future-performance guarantee'};
}
