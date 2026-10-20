import test from 'node:test';import assert from 'node:assert/strict';
import {configurationPlan,projectAliases,confirmationComparison} from './counterfactual/confirmation.mjs';
const configs=(best='Best',feedback='F',control='N')=>({'best':best,feedback,'no-feedback':control});
const gold=[{id:'one',gold:{E:'yes',O:'no'}},{id:'two',gold:{E:'no',O:'no'}}];
const rows=plan=>gold.flatMap(c=>plan.configurations.map(p=>({id:c.id,configuration:p.id,status:'qualified',E:c.gold.E,O:c.gold.O,model:'fixed'})));
test('unique configuration plan is fixed without H and caps physical requests',()=>{
  assert.equal(configurationPlan(configs()).plannedPosts,224);
  const p=configurationPlan(configs('Best','F','Best'));assert.equal(p.plannedPosts,160);assert.equal(p.aliases['no-feedback'],'best');
  const same=configurationPlan(configs('Best','Best','Best'));assert.equal(same.execute,false);assert.equal(same.plannedPosts,0);assert.equal(same.judge,'NOT_MEASURED');
});
test('identity is exact text, not guessed semantic equivalence or trimmed whitespace',()=>{
  assert.equal(configurationPlan(configs('Best','Best ','Best')).uniqueConfigCount,2);
});
test('invalid candidates are not aliased to Best and do not open H',()=>{
  const p=configurationPlan(configs('Best',null,'N'));assert.equal(p.aliases.feedback,null);assert.equal(p.execute,false);assert.equal(p.disposition,'INVALID_FEEDBACK_UNKNOWN');
});
test('invalid no-feedback control preserves a measurable A without inventing a B',()=>{
  const p=configurationPlan(configs('Best','F',null));assert.equal(p.execute,true);assert.equal(p.plannedPosts,160);assert.equal(p.aliases['no-feedback'],null);
  const physical=rows(p);physical.find(r=>r.id==='one'&&r.configuration==='best').E='no';
  const s=confirmationComparison(gold,physical,p,'fixed');assert.equal(s.A.outcome,'FINITE_GAIN');assert.equal(s.B.outcome,'UNKNOWN');
  const same=configurationPlan(configs('Best','Best',null));assert.equal(same.execute,false);assert.equal(same.plannedPosts,0);
});
test('aliases point to the same receipt and propagate its unknown without invented observations',()=>{
  const p=configurationPlan(configs('Best','F','Best')),physical=rows(p);physical[0].status='unknown';
  const r=projectAliases(gold.map(c=>c.id),physical,p),b=r.find(x=>x.id==='one'&&x.arm==='best'),n=r.find(x=>x.id==='one'&&x.arm==='no-feedback');
  assert.equal(b.status,'unknown');assert.equal(n.status,'unknown');assert.deepEqual(b.observationOrigin.receipt,n.observationOrigin.receipt);assert.equal(n.observationOrigin.kind,'alias');
});
test('both identity guards are symmetric, and shared A/B observations are not two independent tests',()=>{
  const p=configurationPlan(configs('Best','Best','N')),s=confirmationComparison(gold,rows(p),p,'fixed');assert.equal(s.A.outcome,'IDENTICAL_CONFIGURATION_NO_TREATMENT');
  const q=configurationPlan(configs('Best','F','F'));assert.equal(confirmationComparison(gold,rows(q),q,'fixed').B.outcome,'IDENTICAL_CONFIGURATION_NO_TREATMENT');
  const n=configurationPlan(configs('Best','F','Best')),a=confirmationComparison(gold,rows(n),n,'fixed');assert.equal(a.comparisonsShareObservations,true);assert.equal(a.physicalTargetRows,4);assert.equal(a.arms.best.assigned,2);
});
