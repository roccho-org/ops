import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadInput,digest,score,requestFor} from './run.mjs';
import {sessionContract,plannedModelCalls,question,projectBody,classify} from './split.mjs';
import {next} from './next.mjs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const json=p=>JSON.parse(read(p));
const gold=read('./suites/closure-real/expected.jsonl').trim().split('\n').map(JSON.parse);
const reports=['baseline','candidate'].map(which=>json('./results/closure-20261019/split-'+which+'.json'));
test('both actual nine-case reports fully re-score, including each wire question and reply mapping',()=>{
  for(const [index,name] of ['baseline','binary-eo-v3'].entries()) {
    const report=reports[index],i=loadInput(fileURLToPath(new URL('./candidates/'+name+'.json',import.meta.url)),fileURLToPath(new URL('./suites/closure-real/',import.meta.url)));
    const inherited=i.contractDigest;i.contract=sessionContract(i.contract,27);i.contractDigest=digest(i.contract);
    const recalculated=score(i,gold,{...report,schema:'ops.sys1.predictions.v1'});
    Object.assign(recalculated,{inheritedContractDigest:inherited,treatment:index?'body-only-independent-E/O-choice':'single-choice',
      accounting:{expectedMaxCalls:plannedModelCalls(i,name),sessionMaxCalls:27,cost:null}});
    assert.deepEqual(recalculated,report);
    let wireCalls=0;
    for(const row of report.rows) {
      const c=i.cases.find(c=>c.id===row.id),request=requestFor(c,i.candidate,i.contract);
      assert.equal(row.modelTrace.length,index?2:1);
      for(const [n,trace] of row.modelTrace.entries()) {
        assert.equal(trace.model,'jev-1.13.0');wireCalls++;
        assert.deepEqual(trace.request,index?question(projectBody(request),n?'O':'E'):request);
      }
      assert.equal(row.prediction,index?classify(...row.modelTrace.map(t=>t.answer)):row.modelTrace[0].answer);
    }
    assert.equal(wireCalls,report.actualCalls);
    assert.equal(report.cost,null);assert.equal(report.goldAuthorIndependent,false);
    assert.equal(report.qualityAdoptionAuthorized,false);
  }
});
test('same-contract improvement stops at target with no regression, distinct real/synthetic evidence',()=>{
  const d=next(...reports),stored=json('./results/closure-20261019/decision.json');
  assert.deepEqual(d,stored.decision);
  assert.equal(d.action,'STOP_TARGET');assert.deepEqual(d.comparison.regressed,[]);
  assert.equal(d.comparison.beforeCorrect,5);assert.equal(d.comparison.afterCorrect,9);
  assert.deepEqual(d.comparison.resolved,['u83k','b62r','a46v','w71p']);
  const real=r=>r.rows.find(x=>x.id==='ops-482-body-20261009');
  assert.equal(real(reports[0]).correct,true);assert.equal(real(reports[1]).correct,true);
  assert.equal(reports[0].rows.filter(r=>r.id!=='ops-482-body-20261009'&&r.correct).length,4);
  assert.equal(reports[1].rows.filter(r=>r.id!=='ops-482-body-20261009'&&r.correct).length,8);
  assert.equal(stored.cumulativeCalls,43);
  assert.equal(d.independentQuality,'NOT_PROVEN');assert.equal(d.autonomousSys2Resume,'NOT_PROVEN');
});
