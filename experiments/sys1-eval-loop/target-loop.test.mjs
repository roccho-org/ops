import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeInput,casesFor,evaluate,score,compareDevelopment,failureDetails,responseFlags,admit,BRANCH,REQUEST} from './target-loop/loop.mjs';
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
  assert.equal(c.strata.publicIssue.assigned,8);assert.equal(c.strata.synthetic.assigned,40);
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
test('retained initial failure replays byte-preserved observations without a new call',()=>{
  const input=read('../results/target-discovery-20261020/input.json'),report=read('../results/target-discovery-20261020/predictions.json'),m=read('../results/target-discovery-20261020/measurement.json');
  assert.deepEqual(score(input,report,read),m);assert.equal(report.actualPosts,18);assert.equal(m.arms.baseline.wrong,1);
});
test('completion sends only 142 previously unissued requests, preserves one failed diagnosis as unknown',async()=>{
  const req={...request,phase:'completion'},f={...makeInput(req,{},read),read};assert.equal(f.input.maxPosts,142);assert.equal(f.input.prior.rows.length,6);
  const seen=[],ask=oracle(f.input);let calls=0;
  const report=await evaluate(f.input,q=>{calls++;seen.push(JSON.parse(q.text).body);return ask(q);});report.actualPosts=calls;
  const m=score(f.input,report,read);assert.equal(calls,142);assert.equal(m.actualPosts,142);assert.equal(m.priorActualPosts,18);
  assert.equal(m.status,'INCOMPLETE');assert.equal(m.targetStatus,'OBSERVATION_COMPLETE');assert.equal(m.assignmentStatus,'OBSERVATION_COMPLETE');
  assert.equal(m.arms.baseline.completed,48);assert.equal(m.arms.baseline.correct,47);assert.equal(m.arms.baseline.accuracy.value,47/48);
  assert.equal(m.diagnostic.unknown,1);assert.equal(m.injectedControls.matched,16);assert.equal(m.rows[5].evaluator,undefined);
  const cases=casesFor('development',read);assert.equal(seen.filter(body=>body===cases[5].body).length,1,'only its injected control, never retry failed actual diagnosis or target');
  assert.deepEqual(report.rows.slice(0,6),f.input.prior.rows);assert.equal(report.rows.at(-1).id,cases.at(-1).id);
});
test('safe failure diagnostics expose only allowlisted numeric/status fields',()=>{
  const f=failureDetails({name:'JevError',code:'provider_error',message:'secret',headers:{authorization:'secret'}},'provider',429);
  assert.deepEqual(f,{name:'JevError',code:'provider_error',stage:'provider',httpStatus:429});assert.ok(!JSON.stringify(f).includes('secret'));
  assert.deepEqual(failureDetails({name:'secret',code:'secret'},'secret','secret'),{stage:'local',code:'unknown',name:'unknown',httpStatus:null});
});
test('retained completion replays actual full-target evidence and every diagnosis decision',()=>{
  const input=read('../results/target-completion-20261020/input.json'),report=read('../results/target-completion-20261020/predictions.json'),m=read('../results/target-completion-20261020/measurement.json');
  assert.deepEqual(score(input,report,read),m);assert.equal(m.arms.baseline.correct,39);assert.equal(m.targetStatus,'OBSERVATION_COMPLETE');
  const c=read('candidate-1.json'),d=read('candidate-1-decisions.json'),b=read('../candidates/binary-eo-v3.json');
  assert.ok(c.instructions.startsWith(b.instructions));assert.ok(Buffer.byteLength(c.instructions)<6000);assert.equal(d.rows.length,48);assert.equal(d.usefulEvaluatorRepairs,0);
  assert.deepEqual(Object.fromEntries(['accept_no_change','reject_false_alarm','reject_missed_error','retain_unknown'].map(k=>[k,d.rows.filter(r=>r.decision===k).length])),{accept_no_change:36,reject_false_alarm:2,reject_missed_error:9,retain_unknown:1});
  for(const r of d.rows){const actual=m.rows.find(a=>a.id===r.caseId);assert.equal(r.actualDiagnosis,actual.evaluator?.answer.choice??null);assert.equal(r.expectedDiagnosis,actual.expectedDiagnosis);}
});
test('partial validation is immutable; only its unissued18 cases produce54 new requests',async()=>{
  const old=read('../results/target-validation-20261020/input.json'),prior=read('../results/target-validation-20261020/predictions.json'),m=read('../results/target-validation-20261020/measurement.json');
  assert.deepEqual(score(old,prior,read),m);assert.equal(prior.actualPosts,90);assert.equal(m.arms['candidate-1'].completed,30);
  const req={...request,phase:'validation-completion',configuration:'candidate-1'},i=makeInput(req,{},read).input;assert.equal(i.maxPosts,54);assert.equal(i.prior.rows.length,30);
  const seen=[],events=[],ask=oracle(i);let n=0;const r=await evaluate(i,q=>{n++;seen.push(JSON.parse(q.text).body);return ask(q);},e=>events.push(e));r.actualPosts=n;
  const s=score(i,r,read);assert.equal(n,54);assert.equal(s.assignmentStatus,'OBSERVATION_COMPLETE');assert.equal(s.targetStatus,'OBSERVATION_COMPLETE');assert.equal(s.status,'INCOMPLETE');
  assert.equal(s.priorActualPosts,90);assert.equal(s.arms['candidate-1'].completed,48);assert.equal(s.arms['candidate-1'].correct,47);assert.equal(s.diagnostic.unknown,1);
  const cases=casesFor('development',read);assert.ok(!seen.includes(cases[29].body));assert.equal(events.filter(e=>e.kind==='row'&&e.row.arm==='baseline').length,0,'tail events retain actual candidate arm');
  const b=read('../results/target-completion-20261020/measurement.json'),c=compareDevelopment([b],s);assert.equal(c.delta,8);assert.equal(c.axisRegressed.length,0);
});
test('granular response flags diagnose invariant failures without model text, headers or secret fields',()=>{
  const data={model:'jev-1.13.0',answers:{live:{choice:'a',probabilities:{a:.48,b:.49},confidence:.2}},secret:'hidden'};
  const f=responseFlags(data,'jev-1.13.0');assert.equal(f.modelMatches,true);assert.equal(f.answerKeyMatches,true);assert.equal(f.probabilitySum,.97);assert.equal(f.sumMatches,false);assert.equal(f.selectedIsMax,false);assert.ok(!JSON.stringify(f).includes('hidden'));
  assert.equal(responseFlags({model:'other',answers:{}},'jev-1.13.0').modelMatches,false);
});
test('actual candidate1 gain cannot hide its regression; candidate2 starts from unchanged Best and observed failures',()=>{
  const input=read('../results/target-validation-completion-20261020/input.json'),r=read('../results/target-validation-completion-20261020/predictions.json'),m=read('../results/target-validation-completion-20261020/measurement.json');
  assert.deepEqual(score(input,r,read),m);assert.equal(m.actualPosts,54);assert.equal(m.arms['candidate-1'].correct,45);
  const b=read('../results/target-completion-20261020/measurement.json'),c=compareDevelopment([b],m);assert.deepEqual(c,read('../results/target-validation-completion-20261020/comparison.json'));
  assert.equal(c.delta,6);assert.equal(c.outcome,'REGRESSION_KEEP_BASELINE');assert.deepEqual(c.axisRegressed,[{id:'public-ops-524',axis:'O'}]);
  assert.equal(c.strata.synthetic.candidateCorrect,39);assert.equal(c.strata.publicIssue.candidateCorrect,6);
  const next=read('candidate-2.json'),d=read('candidate-2-decisions.json');assert.ok(next.instructions.startsWith(read('../candidates/binary-eo-v3.json').instructions));assert.ok(Buffer.byteLength(next.instructions)<6000);
  assert.notEqual(next.instructions,read('candidate-1.json').instructions);assert.equal(d.rows.length,48);assert.equal(d.rows.filter(r=>r.decision==='reject_missed_error').length,3);assert.equal(d.rows.filter(r=>r.decision==='retain_unknown').length,1);
});
test('candidate2 strict sum failure remains rejected; target-only completion makes84 target POSTs and zero judge POSTs',async()=>{
  const old=read('../results/target-candidate2-validation-20261020/input.json'),r=read('../results/target-candidate2-validation-20261020/predictions.json'),m=read('../results/target-candidate2-validation-20261020/measurement.json');
  assert.deepEqual(score(old,r,read),m);assert.equal(r.actualPosts,18);assert.equal(m.arms['candidate-2'].completed,6);
  const req={...request,phase:'target-completion',configuration:'candidate-2'},i=makeInput(req,{},read).input;assert.equal(i.maxPosts,84);assert.equal(i.targetOnly,true);
  const seen=[],ask=oracle(i),events=[];let n=0;const report=await evaluate(i,q=>{assert.ok(!Object.hasOwn(q.criteria,'no_change'));n++;seen.push(JSON.parse(q.text).body);return ask(q);},e=>events.push(e));report.actualPosts=n;
  const s=score(i,report,read);assert.equal(n,84);assert.equal(s.assignmentStatus,'OBSERVATION_COMPLETE');assert.equal(s.targetStatus,'OBSERVATION_COMPLETE');assert.equal(s.status,'INCOMPLETE');
  assert.equal(s.arms['candidate-2'].completed,48);assert.equal(s.diagnostic.unknown,43);assert.equal(s.diagnosticCoverage.originalFullCoverage,'ABANDONED');assert.equal(s.diagnosticCoverage.notRequested,42);
  assert.equal(events.filter(e=>e.kind==='diagnosis').length,0);assert.ok(!seen.includes(i.rows[5].body));assert.deepEqual(report.rows.slice(0,6),i.prior.rows);
  const comparison=compareDevelopment([read('../results/target-completion-20261020/measurement.json')],s);assert.equal(comparison.outcome,'DEVELOPMENT_CANDIDATE');assert.equal(comparison.assigned,48);
});
test('actual whole-D candidate2 result freezes selection before any root confirmation knowledge',()=>{
  const i=read('../results/target-only-20261020/input.json'),r=read('../results/target-only-20261020/predictions.json'),m=read('../results/target-only-20261020/measurement.json');assert.deepEqual(score(i,r,read),m);
  const c=compareDevelopment([read('../results/target-completion-20261020/measurement.json')],m);assert.deepEqual(c,read('../results/target-only-20261020/comparison.json'));
  assert.equal(c.delta,8);assert.deepEqual(c.regressed,[]);assert.deepEqual(c.axisRegressed,[]);assert.equal(c.strata.synthetic.candidateCorrect,40);assert.equal(c.strata.publicIssue.candidateCorrect,7);
  const s=read('selection.json');assert.equal(s.candidate,'candidate-2');assert.equal(s.qualityAdoptionAuthorized,false);assert.equal(s.evaluatorDrivenRepair,'NOT_PROVEN');
});

test('root confirmation has frozen independent authorship, complete balanced Gold and no exact development bodies',()=>{
  const h=read('confirmation.json'),d=casesFor('development',read);
  assert.equal(h.schema,'ops.sys1.root-confirmation.v1');assert.equal(h.cases.length,48);
  assert.equal(new Set(h.cases.map(c=>c.id)).size,48);assert.equal(new Set(h.cases.map(c=>c.family)).size,12);
  const pairs={};for(const c of h.cases){assert.ok(c.gold.basis.trim());pairs[c.gold.E+'/'+c.gold.O]=(pairs[c.gold.E+'/'+c.gold.O]??0)+1;assert.ok(!d.some(x=>x.body===c.body));}
  assert.deepEqual(pairs,{'yes/no':12,'no/yes':12,'yes/yes':12,'no/no':12});
  const i=makeInput({...request,phase:'confirmation',dataset:'confirmation',configuration:'candidate-2'},{},read).input;
  assert.equal(i.maxPosts,192);assert.equal(i.controls.length,0);assert.equal(i.rows.length,48);
  assert.ok(i.rows.every(c=>!Object.hasOwn(c,'gold')&&!Object.hasOwn(c,'basis')));
});

test('frozen confirmation replays its finite gain without hiding residual errors or authorizing adoption',()=>{
  const i=read('../results/target-confirmation-20261020/input.json'),r=read('../results/target-confirmation-20261020/predictions.json'),m=read('../results/target-confirmation-20261020/measurement.json');
  assert.deepEqual(score(i,r,read),m);assert.equal(m.actualPosts,192);assert.equal(m.status,'OBSERVATION_COMPLETE');
  assert.equal(m.arms.baseline.correct,45);assert.equal(m.arms['candidate-2'].correct,46);assert.equal(m.delta,1);
  assert.deepEqual(m.resolved,['hc16']);assert.deepEqual(m.regressed,[]);assert.deepEqual(m.axisRegressed,[]);
  assert.equal(m.outcome,'FINITE_IMPROVEMENT_CANDIDATE');assert.equal(m.qualityAdoptionAuthorized,false);
  assert.equal(m.arms['candidate-2'].wrong,2);assert.equal(m.usageRows,192);assert.equal(m.providerCost,null);
  assert.equal(m.injectedControls.assigned,0);assert.equal(m.diagnostic.actualErrors.assigned,0);
});
