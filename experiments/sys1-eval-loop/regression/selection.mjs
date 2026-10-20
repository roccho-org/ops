import assert from 'node:assert/strict';import {pairedComparison} from '../counterfactual/comparison.mjs';
export const ARM_ORDER=Object.freeze(['feedback','no-feedback']);
export function compareCandidate(gold,rows,arm,instructions,expectedModel,stage){
  assert.ok(ARM_ORDER.includes(arm));assert.ok(['development','screen','audit'].includes(stage));
  assert.ok(typeof instructions.best==='string'&&instructions.best.trim());
  const mapped=rows.filter(r=>r.arm==='best'||r.arm===arm).map(r=>({...r,arm:r.arm==='best'?'best':'feedback'}));
  const scored=pairedComparison(gold,mapped,expectedModel),pair=scored.A;
  let disposition=!pair.complete?'UNKNOWN':pair.axisRegressed.length?'OBSERVED_REGRESSION':stage==='development'?'DEVELOPMENT_GUARD_PASS':pair.delta>0?'FINITE_GAIN':'NO_GAIN_OBSERVED';
  if(typeof instructions[arm]!=='string'||!instructions[arm].trim()||Buffer.byteLength(instructions[arm],'utf8')>6000)disposition='INVALID_CANDIDATE_UNKNOWN';
  else if(instructions[arm]===instructions.best)disposition='IDENTICAL_CONFIGURATION_NO_TREATMENT';
  return {arm,stage,disposition,eligible:stage==='development'?disposition==='DEVELOPMENT_GUARD_PASS':disposition==='FINITE_GAIN',
    correct:scored.arms.feedback.correct,qualified:scored.arms.feedback.qualified,assigned:gold.length,pair};
}
export function selectScreenCandidate(screen,development,instructions){
  const candidates=ARM_ORDER.filter(arm=>screen[arm]?.eligible&&development[arm]?.eligible).map(arm=>{
    assert.ok(typeof instructions[arm]==='string');
    return {arm,screenCorrect:screen[arm].correct,developmentCorrect:development[arm].correct,instructionsBytes:Buffer.byteLength(instructions[arm],'utf8')};
  });
  candidates.sort((a,b)=>b.screenCorrect-a.screenCorrect||b.developmentCorrect-a.developmentCorrect||a.instructionsBytes-b.instructionsBytes||ARM_ORDER.indexOf(a.arm)-ARM_ORDER.indexOf(b.arm));
  return {status:candidates.length?'ONE_CANDIDATE_FROZEN':'NO_ACCEPTED_SCREEN_CANDIDATE',selected:candidates[0]?.arm??null,ranked:candidates,
    rule:'screen correct desc; development correct desc; UTF-8 bytes asc; fixed feedback/no-feedback arm order',
    interpretation:'operational selection only; no evaluator causal value, efficiency or population guarantee inferred'};
}
