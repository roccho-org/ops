import test from 'node:test';
import assert from 'node:assert/strict';
import {next} from './next.mjs';

const report = (correct, id, hits) => ({
  schema:'ops.sys1.scored.v1',mode:'live',status:'EVALUATED',errors:0,actualCalls:2,total:2,
  contractDigest:'fixed',casesDigest:'fixed',goldDigest:'fixed',modelAlias:'fixed',models:['fixed'],
  correct,candidateDigest:id,targetReached:correct===2,
  rows:hits.map((hit,i)=>({id:String(i),expected:'ok',correct:hit}))
});
test('a successful baseline stops without inventing a change',()=>{
  assert.equal(next(report(2,'old',[true,true])).action,'STOP_TARGET');
});
test('one failed complete baseline permits exactly one proposal',()=>{
  assert.equal(next(report(1,'old',[true,false])).action,'PROPOSE_ONE_CANDIDATE');
});
test('paired improvement without regression keeps the better version',()=>{
  const r=next(report(1,'old',[true,false]),report(2,'new',[true,true]));
  assert.equal(r.best,'new');assert.equal(r.action,'STOP_TARGET');
  assert.equal(r.independentQuality,'NOT_PROVEN');assert.equal(r.autonomousSys2Resume,'NOT_PROVEN');
});
test('ties and regressions retain old Best and stop instead of refilling',()=>{
  for(const c of [report(1,'new',[false,true]),report(0,'new',[false,false])]) {
    const r=next(report(1,'old',[true,false]),c);
    assert.equal(r.best,'old');assert.equal(r.action,'STOP_BUDGET');
  }
});
test('provider errors, partial calls, mock and changed contracts cannot be promoted',()=>{
  const b=report(1,'old',[true,false]);
  for(const patch of [{errors:1},{actualCalls:1},{mode:'test-double'},{status:'STOP_EVALUATION_ERROR'}])
    assert.throws(()=>next({...b,...patch}));
  assert.throws(()=>next(b,{...report(2,'new',[true,true]),contractDigest:'changed'}));
});
