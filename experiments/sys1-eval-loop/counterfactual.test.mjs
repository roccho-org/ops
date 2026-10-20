import test from 'node:test';import assert from 'node:assert/strict';
import {repairInputs,parseCandidate,pairedComparison,judgeRequest,deriveDiagnosis} from './counterfactual/comparison.mjs';
const cases=Array.from({length:24},(_,n)=>({id:'d'+n,body:'body '+n,gold:{E:'yes',O:'no',basis:'private'}}));
const outputs=cases.map(c=>({id:c.id,status:'qualified',E:'yes',O:'no'}));
const advice=cases.map(c=>({id:c.id,status:'qualified',diagnosis:'no_change',rationale:'not a real typed field'}));
test('judge independently receives body only; code derives diagnosis after its immutable answer',()=>{
  const q=judgeRequest('complete body');assert.deepEqual(JSON.parse(q.text),{body:'complete body'});
  assert.deepEqual(Object.keys(q.criteria),['neither','requirements','observations','both']);assert.ok(!JSON.stringify(q).includes('proposed'));
  assert.deepEqual(deriveDiagnosis('neither',{E:'yes',O:'no'}),{status:'qualified',diagnosis:'requirement_scope'});
  assert.deepEqual(deriveDiagnosis('both',{E:'no',O:'no'}),{status:'qualified',diagnosis:'both_scope'});
  assert.deepEqual(deriveDiagnosis(null,{E:'yes',O:'no'}),{status:'unknown',diagnosis:null});
});
test('repair arms have identical common input; only typed advice differs, without Gold or rationale',()=>{
  const p=repairInputs(cases,outputs,advice,'Best');assert.deepEqual(p.feedback.common,p.noFeedback.common);
  assert.equal(p.feedback.advice.rows.length,24);assert.equal(p.noFeedback.advice.rows.length,0);
  const text=JSON.stringify(p);for(const value of ['gold','basis','private','rationale','not a real'])assert.ok(!text.includes(value));
});
test('unknown diagnosis remains unknown and does not prevent repair input construction',()=>{
  const a=structuredClone(advice);a[0]={id:cases[0].id,status:'unknown',diagnosis:null};
  assert.deepEqual(repairInputs(cases,outputs,a,'Best').feedback.advice.rows[0],{index:0,status:'unknown',diagnosis:null});
  a[0].diagnosis='uncertain';assert.throws(()=>repairInputs(cases,outputs,a,'Best'));
});
test('missing target or duplicate advice cannot silently shrink development',()=>{
  assert.throws(()=>repairInputs(cases,outputs.slice(1),advice,'Best'));
  assert.throws(()=>repairInputs(cases,outputs,[...advice.slice(1),advice[1]],'Best'));
});
test('candidate parser preserves Best and rejects a second candidate or non-JSON prose',()=>{
  assert.deepEqual(parseCandidate('{"instructions":"Best supplement"}','Best'),{instructions:'Best supplement'});
  assert.throws(()=>parseCandidate('{"instructions":"replacement"}','Best'));
  assert.throws(()=>parseCandidate('{"instructions":"Best","another":"Best"}','Best'));
});
const gold=[{id:'a',gold:{E:'yes',O:'no'}},{id:'b',gold:{E:'no',O:'no'}}];
const row=(id,arm,E,O)=>({id,arm,E,O,status:'qualified',model:'fixed'});
const good=()=>gold.flatMap(c=>['best','feedback','no-feedback'].map(a=>row(c.id,a,c.gold.E,c.gold.O)));
test('perfect ceiling is no observed gain rather than invented improvement',()=>{
  const s=pairedComparison(gold,good(),'fixed');assert.equal(s.A.outcome,'NO_GAIN_OBSERVED');assert.equal(s.B.outcome,'NO_GAIN_OBSERVED');
});
test('control transport unknown preserves independently measurable A',()=>{
  const rows=good().filter(r=>r.arm!=='no-feedback');rows.find(r=>r.id==='a'&&r.arm==='best').E='no';
  const s=pairedComparison(gold,rows,'fixed');assert.equal(s.A.outcome,'FINITE_GAIN');assert.equal(s.B.outcome,'UNKNOWN');assert.equal(s.arms['no-feedback'].unknown,2);
});
test('feedback extra difference cannot hide a formerly-correct control axis broken',()=>{
  const rows=good();rows.find(r=>r.id==='a'&&r.arm==='no-feedback').E='no';rows.find(r=>r.id==='b'&&r.arm==='feedback').O='yes';
  const s=pairedComparison(gold,rows,'fixed');assert.equal(s.B.outcome,'OBSERVED_REGRESSION');assert.deepEqual(s.B.axisRegressed,[{id:'b',axis:'O'}]);
});
test('changed model and duplicate identities do not count as qualified paired evidence',()=>{
  const rows=good();rows[0].model='other';assert.equal(pairedComparison(gold,rows,'fixed').A.outcome,'UNKNOWN');
  assert.throws(()=>pairedComparison(gold,[...rows,rows[0]],'fixed'));
});
