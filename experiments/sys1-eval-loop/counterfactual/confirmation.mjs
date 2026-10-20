import assert from 'node:assert/strict';
import {pairedComparison} from './comparison.mjs';
const ROLES=['best','feedback','no-feedback'];

// Fixed before H is read. Identity is exact instructions, with no trimming or semantic guess.
export function configurationPlan(instructions){
  assert.equal(typeof instructions.best,'string');assert.ok(instructions.best.trim());
  const configurations=[],aliases={},invalidRoles=[];
  for(const role of ROLES){const text=instructions[role];
    if(text===null){assert.notEqual(role,'best');aliases[role]=null;invalidRoles.push(role);continue;}
    assert.equal(typeof text,'string');assert.ok(text.trim());
    const same=configurations.find(c=>c.instructions===text);
    if(same)aliases[role]=same.id;else{aliases[role]=role;configurations.push({id:role,instructions:text});}
  }
  const K=configurations.length;
  const execute=aliases.feedback!==null&&K>1;
  return {configurations,aliases,invalidRoles,uniqueConfigCount:K,
    execute,
    disposition:aliases.feedback===null?'INVALID_FEEDBACK_UNKNOWN':K===1?'NO_TREATMENT_H_NOT_OPENED':aliases['no-feedback']===null?'PARTIAL_CONFIRMATION_CONTROL_INVALID':'ONE_CONFIRMATION',
    plannedPosts:execute?32*(2*K+1):0,
    judge:execute?'body-only one per case; not repair feedback':'NOT_MEASURED'};
}
export function projectAliases(ids,physicalRows,plan){
  assert.equal(new Set(ids).size,ids.length);assert.equal(new Set(physicalRows.map(r=>JSON.stringify([r.id,r.configuration]))).size,physicalRows.length);
  for(const r of physicalRows){assert.ok(ids.includes(r.id));assert.ok(plan.configurations.some(c=>c.id===r.configuration));}
  return ids.flatMap(id=>ROLES.map(arm=>{const configuration=plan.aliases[arm],actual=configuration===null?null:physicalRows.find(r=>r.id===id&&r.configuration===configuration);
    return {...(actual??{status:'unknown'}),id,arm,observationOrigin:configuration===null?{kind:'invalid-candidate',receipt:null}:{kind:arm===configuration?'native':'alias',receipt:{caseId:id,configurationId:configuration}}};
  }));
}
export function confirmationComparison(gold,physicalRows,plan,expectedModel){
  const result=pairedComparison(gold,projectAliases(gold.map(c=>c.id),physicalRows,plan),expectedModel);
  for(const [metric,control]of [['A','best'],['B','no-feedback']]){
    if(plan.aliases.feedback!==null&&plan.aliases.feedback===plan.aliases[control]){
      result[metric].rawOutcome=result[metric].outcome;
      result[metric].outcome='IDENTICAL_CONFIGURATION_NO_TREATMENT';
    }
  }
  result.comparisonsShareObservations=plan.aliases.best!==null&&plan.aliases.best===plan.aliases['no-feedback'];
  result.physicalTargetRows=physicalRows.length;
  result.usageScope='aggregate native unique traces only; never sum projected aliases';
  return result;
}
