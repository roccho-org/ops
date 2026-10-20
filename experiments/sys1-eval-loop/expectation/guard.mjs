import assert from 'node:assert/strict';
const known=v=>v==='yes'||v==='no';
// Historical O is used only for this development diagnostic. Fresh H must
// measure both E arms and one contemporary shared O within each repetition.
export function expectationDevelopmentGuard(rows,candidate,{qualified,modelStable}){
 assert.equal(rows.length,candidate.length);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.deepEqual(candidate.map(r=>r.id),rows.map(r=>r.id));assert.equal(typeof modelStable,'boolean');assert.ok(Number.isInteger(qualified)&&qualified>=0&&qualified<=rows.length);
 let baselineCorrect=0,candidateCorrect=0;const repaired=[],regressed=[],unionERegressed=[],unknownProtectedE=[],unknownCandidate=[],unresolvedGold=[],E={baselineCorrect:0,candidateKnownCorrect:0,repaired:[],regressed:[]};
 for(const [i,row]of rows.entries()){
  assert.ok(known(row.gold.E));assert.ok(known(row.gold.O)||row.gold.O===null);assert.equal(row.snapshots.length,2);for(const s of row.snapshots){assert.ok(known(s.E));assert.ok(known(s.O));}const value=candidate[i].E;assert.ok(known(value)||value===null);
  const firstECorrect=row.snapshots[0].E===row.gold.E;E.baselineCorrect+=Number(firstECorrect);if(known(value)){const after=value===row.gold.E;E.candidateKnownCorrect+=Number(after);if(!firstECorrect&&after)E.repaired.push(row.id);if(firstECorrect&&!after)E.regressed.push(row.id);}const protectedE=row.snapshots.some(s=>s.E===row.gold.E);if(!known(value)){unknownCandidate.push(row.id);if(protectedE)unknownProtectedE.push(row.id);}else if(protectedE&&value!==row.gold.E)unionERegressed.push(row.id);
  if(row.gold.O===null){unresolvedGold.push(row.id);continue;}const first=row.snapshots[0],before=first.E===row.gold.E&&first.O===row.gold.O;baselineCorrect+=Number(before);if(!known(value))continue;const after=value===row.gold.E&&first.O===row.gold.O;candidateCorrect+=Number(after);if(!before&&after)repaired.push(row.id);if(before&&!after)regressed.push(row.id);
 }
 const qualificationComplete=qualified===rows.length&&!unknownCandidate.length,positiveKnownJointGain=repaired.length>regressed.length,noKnownUnionERegression=unionERegressed.length===0;
 return {assigned:rows.length,resolvedJoint:rows.length-unresolvedGold.length,unresolvedGold,baselineCorrect,candidateCorrect,repaired,regressed,E,unionERegressed,unknownProtectedE,unknownCandidate,positiveKnownJointGain,noKnownUnionERegression,qualificationComplete,modelStable,eligible:qualificationComplete&&modelStable&&positiveKnownJointGain&&noKnownUnionERegression,scope:'first-snapshot complete E/O gain with fixed historical O; E-only counts are diagnostic, not the acceptance endpoint; protect known-correct E union across both actual snapshots; development only, not a fresh contemporary comparison'};
}
