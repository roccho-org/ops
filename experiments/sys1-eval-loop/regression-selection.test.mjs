import test from 'node:test';import assert from 'node:assert/strict';
import {compareCandidate,selectScreenCandidate} from './regression/selection.mjs';
const gold=[{id:'one',gold:{E:'no',O:'no'}},{id:'two',gold:{E:'yes',O:'yes'}}];
const instructions={best:'Best',feedback:'BestF','no-feedback':'BestLongerN'};
const row=(id,arm,E,O)=>({id,arm,E,O,status:'qualified',model:'fixed'});
const baseline=[row('one','best','no','no'),row('two','best','no','yes')];
const repaired=[...baseline,row('one','feedback','no','no'),row('two','feedback','yes','yes')];
test('development guard rejects a formerly-correct axis destroyed even when another case is repaired',()=>{
  const bad=[...baseline,row('one','feedback','yes','no'),row('two','feedback','yes','yes')];
  const r=compareCandidate(gold,bad,'feedback',instructions,'fixed','development');assert.equal(r.eligible,false);assert.equal(r.disposition,'OBSERVED_REGRESSION');
});
test('unknown assignments block advancement without changing the full case denominator',()=>{
  const r=compareCandidate(gold,repaired.slice(0,-1),'feedback',instructions,'fixed','development');assert.equal(r.disposition,'UNKNOWN');assert.equal(r.assigned,2);assert.equal(r.eligible,false);
});
test('development guard needs no invented unseen gain, while screen and audit require positive gain',()=>{
  const same=[...baseline,...baseline.map(r=>({...r,arm:'feedback'}))];
  assert.equal(compareCandidate(gold,same,'feedback',instructions,'fixed','development').eligible,true);
  assert.equal(compareCandidate(gold,same,'feedback',instructions,'fixed','screen').eligible,false);
  assert.equal(compareCandidate(gold,repaired,'feedback',instructions,'fixed','audit').disposition,'FINITE_GAIN');
});
test('identical Best is no-treatment even if a separate response happens to improve',()=>{
  const r=compareCandidate(gold,repaired,'feedback',{...instructions,feedback:'Best'},'fixed','audit');assert.equal(r.disposition,'IDENTICAL_CONFIGURATION_NO_TREATMENT');assert.equal(r.eligible,false);
});
test('missing, oversized or non-prefix configuration cannot advance even with complete apparently good answers',()=>{
  for(const candidate of [null,undefined,'not the Best prefix','Best'+'x'.repeat(6000)]){
    const r=compareCandidate(gold,repaired,'feedback',{...instructions,feedback:candidate},'fixed','development');
    assert.equal(r.disposition,'INVALID_CANDIDATE_UNKNOWN');assert.equal(r.eligible,false);
  }
});
test('screen ranking is fixed and cannot admit a candidate that failed its development guard',()=>{
  const score=(correct,eligible=true)=>({correct,eligible});
  let r=selectScreenCandidate({feedback:score(8),'no-feedback':score(9)},{feedback:score(5),'no-feedback':score(6,false)},instructions);assert.equal(r.selected,'feedback');
  r=selectScreenCandidate({feedback:score(8),'no-feedback':score(8)},{feedback:score(5),'no-feedback':score(5)},instructions);assert.equal(r.selected,'feedback');
  r=selectScreenCandidate({feedback:score(8),'no-feedback':score(8)},{feedback:score(5),'no-feedback':score(5)},{...instructions,feedback:'LongF','no-feedback':'N'});assert.equal(r.selected,'no-feedback');
  r=selectScreenCandidate({feedback:score(8),'no-feedback':score(8)},{feedback:score(5),'no-feedback':score(5)},{...instructions,feedback:'F','no-feedback':'N'});assert.equal(r.selected,'feedback');
});
