import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeInput,casesFor,evaluate,score,compareDevelopment,admit,BRANCH,REQUEST} from './target-loop/loop.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('./target-loop/'+p,import.meta.url),'utf8'));
const request={phase:'development',dataset:'development',configuration:'baseline',sourceSha:'a'.repeat(40)};
const answer=choice=>({choice,model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:1}});
function fixture(phase='development') {
  const custom=p=>p==='candidate-1.json'?{id:'candidate-1',instructions:read('../candidates/binary-eo-v3.json').instructions+'\nTest double.',feedback:[{caseId:'quote-1',origin:'evaluator',decision:'test only'}]}:p==='confirmation.json'?{cases:casesFor('development',read)}:read(p);
  const req=phase==='development'?request:{...request,phase,dataset:phase==='confirmation'?'confirmation':'development',configuration:'candidate-1'};
  return {...makeInput(req,{},custom),read:custom};
}
function oracle(i,{wrongFirst=false,judge='correct',breakCandidate=false}={}){
  const cases=casesFor(i.request.dataset,fixture().read);let calls=0;
  return async q=>{calls++;const text=JSON.parse(q.text),c=cases.find(c=>c.body===text.body);
    if(Object.hasOwn(q.criteria,'no_change')){
      if(judge==='no_change')return answer('no_change');
      const {E,O}=text.proposed,g=c.gold;return answer(E!==g.E?(O!==g.O?'both_scope':'requirement_scope'):O!==g.O?'evidence_scope':'no_change');
    }
    const axis=q.instructions.includes('本問はEだけ')?'E':'O';let value=c.gold[axis];
    if(wrongFirst&&c.id===cases[0].id&&axis==='E')value=value==='yes'?'no':'yes';
    if(breakCandidate&&q.instructions.includes('Test double.')&&axis==='E'&&c.id===cases[0].id)value=value==='yes'?'no':'yes';
    return answer(value);
  };
}
async function run(f,options){let n=0;const ask=oracle(f.input,options),r=await evaluate(f.input,q=>{n++;return ask(q);});r.actualPosts=n;return {r,s:score(f.input,r,f.read)};}
test('D48 keeps full public inventory, new mechanisms, and Gold outside every model request',async()=>{
  const f=fixture(),bodies=casesFor('development',read);assert.equal(bodies.length,48);assert.equal(read('public-snapshot.json').inventory.length,100);assert.equal(f.input.maxPosts,160);
  assert.equal(new Set(bodies.slice(0,40).map(c=>c.family)).size,10);
  const {r,s}=await run(f);assert.equal(r.actualPosts,160);assert.equal(s.arms.baseline.correct,48);assert.equal(s.injectedControls.assigned,16);assert.equal(s.injectedControls.matched,16);assert.equal(s.diagnostic.matched,48);assert.equal(s.status,'OBSERVATION_COMPLETE');
  for(const row of r.rows)for(const t of row.trace){assert.deepEqual(JSON.parse(t.request.text),{body:bodies.find(c=>c.id===row.id).body});}
  assert.equal(s.evaluatorContribution,'NOT_IDENTIFIED');assert.equal(s.providerCost,null);
});
test('actual target error and evaluator miss stay distinct; injected errors never inflate target failures',async()=>{
  const {s}=await run(fixture(),{wrongFirst:true,judge:'no_change'});assert.equal(s.arms.baseline.wrong,1);assert.equal(s.diagnostic.missed,1);assert.equal(s.injectedControls.wrong,16);
  assert.equal(s.arms.baseline.axes.E.falseNegative,1);assert.equal(s.arms.baseline.axes.O.falseNegative,0);
});
test('completed target answers survive evaluator transport failure, whole phase remains incomplete',async()=>{
  const f=fixture();let n=0;const ask=oracle(f.input),r=await evaluate(f.input,q=>{if(++n===3)throw Error('timeout');return ask(q);});r.actualPosts=n;
  const s=score(f.input,r,f.read);assert.equal(n,3);assert.equal(s.status,'INCOMPLETE');assert.equal(s.arms.baseline.completed,1);assert.equal(s.arms.baseline.correct,1);assert.equal(s.arms.baseline.unknown,47);assert.equal(s.diagnostic.unknown,48);assert.equal(s.arms.baseline.accuracy.value,null);
});
test('changed provider model stops rather than confounding comparison',async()=>{
  const f=fixture();let n=0;const r=await evaluate(f.input,()=>{n++;return {...answer('yes'),model:'other'};});r.actualPosts=n;assert.equal(n,1);assert.equal(score(f.input,r,f.read).status,'INCOMPLETE');
});
test('validation uses candidate and full D; one confirmation compares 192 target requests without evaluator',async()=>{
  const v=fixture('validation'),vr=await run(v);assert.equal(vr.r.actualPosts,144);assert.equal(vr.s.arms['candidate-1'].assigned,48);
  const h=fixture('confirmation'),hr=await run(h,{breakCandidate:true});assert.equal(hr.r.actualPosts,192);assert.equal(hr.s.outcome,'REGRESSION_KEEP_BASELINE');assert.equal(hr.s.axisRegressed.length,1);assert.equal(hr.s.regressed.length,1);assert.equal(hr.s.diagnostic.matched,0);
});
test('development comparison exposes broken correct axes across the entire assigned set',async()=>{
  const b=await run(fixture()),v=await run(fixture('validation'),{breakCandidate:true});
  const c=compareDevelopment([b.s],v.s);assert.equal(c.assigned,48);assert.equal(c.outcome,'REGRESSION_KEEP_BASELINE');assert.equal(c.axisRegressed.length,1);
  const missing=structuredClone(v.s);missing.rows.pop();assert.throws(()=>compareDevelopment([b.s],missing));
});
test('native admission reserves all roles, rejects refill, reruns and cumulative overflow',()=>{
  const env={GITHUB_REPOSITORY:'roccho-org/ops',GITHUB_ACTOR:'roccho-dev',GITHUB_REF:'refs/heads/'+BRANCH,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'1'};
  const row={id:1,head_sha:env.GITHUB_SHA,run_attempt:1,actor:{login:'roccho-dev'},event:'push',head_branch:BRANCH,status:'in_progress'};
  const h={total_count:1,workflow_runs:[row]},source={head:env.GITHUB_SHA,parent:request.sourceSha,changed:[REQUEST]},plans={[env.GITHUB_SHA]:{key:'x',maxPosts:160}};
  assert.equal(admit(request,env,h,source,plans),160);
  assert.throws(()=>admit(request,{...env,GITHUB_RUN_ATTEMPT:'2'},h,source,plans));
  const old={...row,id:2,head_sha:'c'.repeat(40),status:'completed'},both={total_count:2,workflow_runs:[row,old]};
  assert.throws(()=>admit(request,env,both,source,{...plans,[old.head_sha]:{key:'x',maxPosts:160}}));
  assert.throws(()=>admit(request,env,both,source,{...plans,[old.head_sha]:{key:'other',maxPosts:900}}));
  assert.throws(()=>admit(request,env,h,{...source,changed:[REQUEST,'other']},plans));
});
