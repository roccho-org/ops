import test from 'node:test';import assert from 'node:assert/strict';
import {prepareScopedDevelopment,evaluateScopedDevelopment,scopedDevelopmentProjection,verifyScopedEffects} from './regression/scoped-development.mjs';import {targetRequest} from './feedback-improvement.mjs';
import {retainedDevelopmentFailure} from './regression/runtime.mjs';
const origin={runId:1,runAttempt:1,head:'historical'},d={best:'Best',rows:Array.from({length:32},(_,i)=>({id:'c'+i,family:'fixture',body:'body '+i}))};
const cached=d.rows.map((c,i)=>({id:c.id,status:'qualified',model:'jev-1.13.0',E:i===0?'yes':'no',O:i===1?'yes':'no'}));
const old={rows:d.rows.map((c,i)=>({id:c.id,configurations:[{id:'best',target:[{role:'O',request:targetRequest(c.body,d.best,'O'),answer:{choice:cached[i].O,model:'jev-1.13.0'}}]}]}))};
const gold=d.rows.map(c=>({...c,gold:{E:'no',O:'no'}})),input=()=>prepareScopedDevelopment(d,old,cached,{fixture:true},origin),answer=()=>({choice:'no',model:'jev-1.13.0'});
test('new treatment retains and verifies the actual first128 negative rather than retrying or relabeling it',()=>{const prior=retainedDevelopmentFailure();assert.equal(prior.provider.runId,39387282415);assert.equal(prior.provider.runAttempt,1);assert.equal(prior.provider.conclusion,'success');assert.equal(prior.input.maxPosts,128);});
test('new D measures E32 and explicitly inherits exact-wire historical O without inventing an O improvement',async()=>{
 const i=await input();assert.equal(i.maxPosts,32);assert.equal(i.historicalOAliases.length,32);assert.ok(!JSON.stringify(i).includes('gold'));
 let n=0;const r=await evaluateScopedDevelopment(i,()=>{n++;return answer();});const p=await scopedDevelopmentProjection(i,r,gold,cached,origin);
 assert.equal(n,32);assert.equal(p.comparison.correct,31);assert.equal(p.comparison.eligible,true);assert.deepEqual(p.comparison.pair.resolved,['c0']);assert.deepEqual(p.comparison.pair.axisResolved,[{id:'c0',axis:'E'}]);assert.deepEqual(p.comparison.pair.axisRegressed,[]);
 for(const row of p.rows.filter(r=>r.arm==='scoped'))assert.equal(row.O,cached.find(b=>b.id===row.id).O);
});
test('historical alias requires exact actual O request and expected model, and cannot silently swap origins',async()=>{
 const bad=structuredClone(old);bad.rows[0].configurations[0].target[0].request.instructions+='changed';await assert.rejects(()=>prepareScopedDevelopment(d,bad,cached,{},origin));
 const i=await input(),r=await evaluateScopedDevelopment(i,answer);await assert.rejects(()=>scopedDevelopmentProjection(i,r,gold,cached,{...origin,runId:2}));
 const wrong=structuredClone(i);wrong.historicalOAliases[0].value='yes';await assert.rejects(()=>scopedDevelopmentProjection(wrong,{...r,inputDigest:'wrong'},gold,cached,origin));
});
test('unknown E preserves the entire assigned denominator and model drift cannot allow advancement',async()=>{
 const i=await input();let n=0;const r=await evaluateScopedDevelopment(i,()=>{if(++n===32)throw Error('unknown');return answer();});let p=await scopedDevelopmentProjection(i,r,gold,cached,origin);assert.equal(p.comparison.qualified,31);assert.equal(p.comparison.assigned,32);assert.equal(p.comparison.disposition,'UNKNOWN');
 const full=await evaluateScopedDevelopment(i,answer);p=await scopedDevelopmentProjection(i,{...full,modelDrift:true},gold,cached,origin);assert.equal(p.modelStable,false);assert.equal(p.comparison.eligible,false);
});
test('new axis-only accounting reconciles posts and exact answer/unknown partition without alias duplication',async()=>{
 const i=await input(),events=[];let id=null,n=0;const observe=e=>{if(e.kind==='attempt')id=e.id;events.push(e);};
 const r=await evaluateScopedDevelopment(i,()=>{observe({kind:'post',id});if(++n===1)throw Error('unknown');return answer();},observe);r.actualPosts=32;
 assert.deepEqual(verifyScopedEffects(i,r,events),{assignedPosts:32,attempted:32,actualPosts:32,qualified:31,unknown:1,unattempted:0,historicalOAliases:32});
 assert.throws(()=>verifyScopedEffects(i,{...r,actualPosts:31},events));const bad=structuredClone(events);bad.find(e=>e.kind==='qualification-unknown').id='unassigned';assert.throws(()=>verifyScopedEffects(i,r,bad));
});
