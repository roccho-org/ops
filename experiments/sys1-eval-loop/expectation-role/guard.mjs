import assert from 'node:assert/strict';
const known=v=>v==='yes'||v==='no';
// This diagnostic uses the same fixed historical O for both contemporary E
// arms. It cannot substitute for the later all-contemporary three-call H.
export function expectationRoleDevelopmentGuard(rows,predictions,{qualified,modelStable}){
 assert.equal(rows.length,predictions.length);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.deepEqual(predictions.map(r=>r.id),rows.map(r=>r.id));assert.equal(typeof modelStable,'boolean');assert.ok(Number.isInteger(qualified)&&qualified>=0&&qualified<=2*rows.length);
 let baselineCorrect=0,candidateCorrect=0,firstAnchorCorrect=0;const repaired=[],regressed=[],unionERegressed=[],unknownProtectedE=[],unknownCandidate=[],unresolvedGold=[],E={baselineCorrect:0,candidateKnownCorrect:0,firstAnchorCorrect:0,repaired:[],regressed:[]},derived=[];
 for(const [i,row]of rows.entries()){
  assert.ok(known(row.gold.E));assert.ok(known(row.gold.O)||row.gold.O===null);assert.ok(known(row.first.E)&&known(row.first.O));assert.ok(Array.isArray(row.snapshots)&&row.snapshots.length);for(const s of row.snapshots)assert.ok(known(s.E));
  const {bestE,currentE}=predictions[i];for(const v of [bestE,currentE])assert.ok(known(v)||v===null);const value=currentE,protectedE=row.snapshots.some(s=>s.E===row.gold.E);derived.push({id:row.id,E:value});
  const firstECorrect=row.first.E===row.gold.E;E.firstAnchorCorrect+=Number(firstECorrect);if(known(bestE))E.baselineCorrect+=Number(bestE===row.gold.E);
  if(value===null){unknownCandidate.push(row.id);if(protectedE)unknownProtectedE.push(row.id);}else{const before=bestE===row.gold.E,after=value===row.gold.E;E.candidateKnownCorrect+=Number(after);if(known(bestE)&&!before&&after)E.repaired.push(row.id);if(known(bestE)&&before&&!after)E.regressed.push(row.id);if(protectedE&&!after)unionERegressed.push(row.id);}
  if(row.gold.O===null){unresolvedGold.push(row.id);continue;}
  firstAnchorCorrect+=Number(firstECorrect&&row.first.O===row.gold.O);
  if(known(bestE))baselineCorrect+=Number(bestE===row.gold.E&&row.first.O===row.gold.O);
  if(value===null)continue;
  const before=bestE===row.gold.E&&row.first.O===row.gold.O,after=value===row.gold.E&&row.first.O===row.gold.O;candidateCorrect+=Number(after);if(known(bestE)&&!before&&after)repaired.push(row.id);if(known(bestE)&&before&&!after)regressed.push(row.id);
 }
 const qualificationComplete=qualified===2*rows.length&&!unknownCandidate.length&&predictions.every(p=>known(p.bestE)),positiveKnownJointGain=repaired.length>regressed.length,noKnownUnionERegression=!unionERegressed.length,noKnownFreshERegression=!E.regressed.length;
 return {assigned:rows.length,physicalAssigned:2*rows.length,resolvedJoint:rows.length-unresolvedGold.length,unresolvedGold,baselineCorrect,candidateCorrect,firstAnchorCorrect,repaired,regressed,E,derived,unionERegressed,unknownProtectedE,unknownCandidate,positiveKnownJointGain,noKnownUnionERegression,noKnownFreshERegression,qualificationComplete,modelStable,eligible:qualificationComplete&&modelStable&&positiveKnownJointGain&&noKnownUnionERegression&&noKnownFreshERegression,scope:'fresh qualified BestE versus single role-instruction candidate E, both with fixed first historical O; mechanical first anchor diagnostic only; protect both all retained physical E snapshot correctness and contemporary BestE correctness independently'};
}

// Identical paired-E mathematics, a separately named treatment/guard scope.
export function expectationBoundaryDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus single criteria-boundary E, both with fixed first historical O; mechanical first diagnostic; historical607 and fresh E correctness are protected independently'};}

export function expectationExampleDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus single scope-and-examples E, both with fixed first historical O; mechanical first diagnostic; all5753 historical E receipts protect607 and fresh E correctness independently'};}

export function expectationFocusDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus single E with the O-directed comparison block removed, both with fixed first historical O; mechanical first diagnostic; all7005 historical E receipts protect610 and fresh E correctness independently'};}

export function expectationDeclarationDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus single English declaration E, both with fixed first historical O; mechanical first diagnostic; all8257 historical E receipts protect611 and fresh E correctness independently'};}

export function expectationRole4DevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus E projected from a qualified four-class role response, both with fixed first historical O; candidate O diagnostic only; mechanical first diagnostic; all9509 historical binary E receipts protect617 and fresh E correctness independently'};}

export function expectationRole2DevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:'fresh qualified BestE versus native binary E with E/O role definitions, both with fixed first historical O; no observed candidate O or latent four-class inference; mechanical first diagnostic; all10756 qualified E evidence protect617 and fresh E correctness independently; prior invalid5 remain unknown'};}

export function expectationDecompositionDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE versus E derived from both qualified native declaration/request answers by fixed OR, with the same fixed historical O; no branch Gold, candidate O or independence claim; mechanical first diagnostic; all12008 E evidence protect617 and fresh E correctness independently"};}

export function expectationPartitionDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE versus E derived from both qualified native specification and normative-request predicates by fixed OR with the same fixed historical O; no branch Gold or independence claim; mechanical first diagnostic; all13260 E evidence protect618 and fresh E correctness independently"};}

export function expectationLinesDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE versus strict-AND-qualified OR of the unchanged native2 predicates using only a lossless LF-line-array candidate body state, same fixed historical O; no branch Gold or independence claim; mechanical first diagnostic; all14512 E evidence protect618 and fresh E correctness independently"};}

export function expectationContrastDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE versus native binary E from fixed D3 Core plus three synthetic role contrasts, same fixed historical O; no branch Gold or language/example/path causal isolation; mechanical first diagnostic; all15764 E evidence protect618 and fresh E correctness independently; prior invalid5 remain unknown"};}

export function expectationVerificationDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE shared once versus derived verifiedE from that exact baseline label and a strict native label-correctness checker, same fixed historical O; no self-scoring Gold or hidden-uncertainty guarantee; mechanical first diagnostic; all17016 E evidence protect618 and fresh E correctness independently; checker native correctness is not a native E label"};}

export function expectationMajorityDevelopmentGuard(rows,predictions,qualification){return{...expectationRoleDevelopmentGuard(rows,predictions,qualification),scope:"fresh qualified BestE shared once versus fixed majority of that native Best E, qualified native P and E from qualified absence N; PN same-response agreement double weighted, not independent jury or contradiction proof; common D5 definition/language/polarity/state/ensemble package; all18268 E evidence protect618 and fresh E correctness independently; mechanical first diagnostic; same historical O"};}
