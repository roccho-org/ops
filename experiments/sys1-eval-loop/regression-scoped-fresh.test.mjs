import test from 'node:test';import assert from 'node:assert/strict';
import {prepareFreshScoped,evaluateFreshScoped,freshScopedProjection,verifyFreshEffects} from './regression/scoped-fresh.mjs';import {SCOPE_CLARIFICATION} from './regression/scoped-request.mjs';
const corpus=n=>({cases:Array.from({length:n},(_,i)=>({id:'fixture'+i,body:'body'+i,family:'synthetic',gold:{E:'no',O:'no',basis:'never sent'}}))});
const a=choice=>({choice,model:'jev-1.13.0'});
const ask=async q=>a(q.text===JSON.stringify({body:'body0'})&&!q.criteria.yes.includes(SCOPE_CLARIFICATION)&&q.instructions.includes('本問はEだけ')?'yes':'no');
test('fresh screen uses three fixed rotating templates and one actual shared O receipt per case',async()=>{
 const data=corpus(48),i=await prepareFreshScoped(data,'screen','Best',{});assert.equal(i.maxPosts,144);assert.ok(!JSON.stringify(i).includes('gold'));assert.ok(!JSON.stringify(i).includes('basis'));
 let n=0;const r=await evaluateFreshScoped(i,q=>{n++;return ask(q);});const p=await freshScopedProjection(i,r,data.cases);
 assert.equal(n,144);assert.deepEqual(r.rows.slice(0,3).map(r=>r.order),[['bestE','scopedE','sharedO'],['scopedE','sharedO','bestE'],['sharedO','bestE','scopedE']]);
 assert.equal(r.rows.flatMap(r=>r.observations).filter(t=>t.key==='sharedO').length,48);assert.equal(p.comparison.disposition,'FINITE_GAIN');assert.equal(p.comparison.baselineCorrect,47);assert.equal(p.comparison.candidateCorrect,48);assert.deepEqual(p.comparison.pair.axisRegressed,[]);
 for(const row of data.cases){const projected=p.rows.filter(r=>r.id===row.id);assert.equal(projected[0].O,projected[1].O);assert.deepEqual(projected[0].observationOrigin.O,projected[1].observationOrigin.O);}
});
test('one shared O failure propagates the same unknown to both roles without refill or fabricated gain',async()=>{
 const data=corpus(48),i=await prepareFreshScoped(data,'screen','Best',{});let id=null,n=0;
 const r=await evaluateFreshScoped(i,q=>{n++;if(id==='fixture0/sharedO')throw Error('unknown');return ask(q);},e=>{if(e.kind==='attempt')id=e.id;});const p=await freshScopedProjection(i,r,data.cases);
 assert.equal(n,144);assert.equal(p.comparison.disposition,'UNKNOWN');assert.ok(p.rows.filter(r=>r.id==='fixture0').every(r=>r.status==='unknown'&&r.O===undefined));
});
test('audit keeps64 assigned and192 requests, and model drift invalidates comparison even at terminal call',async()=>{
 const data=corpus(64),i=await prepareFreshScoped(data,'audit','Best',{});assert.equal(i.maxPosts,192);let n=0;const e=Error('model');e.modelChanged=true;
 const r=await evaluateFreshScoped(i,q=>{if(++n===192)throw e;return ask(q);});const p=await freshScopedProjection(i,r,data.cases);assert.equal(n,192);assert.equal(p.modelStable,false);assert.equal(p.comparison.disposition,'UNKNOWN');assert.equal(p.comparison.assigned,64);
});
test('projection and physical accounting reject changed shared queries, counts or IDs',async()=>{
 const data=corpus(48),i=await prepareFreshScoped(data,'screen','Best',{}),events=[];let id=null;const observe=e=>{if(e.kind==='attempt')id=e.id;events.push(e);};
 const r=await evaluateFreshScoped(i,q=>{observe({kind:'post',id});return ask(q);},observe);r.actualPosts=144;
 assert.equal(verifyFreshEffects(i,r,events).contemporarySharedOAssigned,48);assert.throws(()=>verifyFreshEffects(i,{...r,actualPosts:143},events));
 const changed=structuredClone(r);changed.rows[0].observations.find(t=>t.key==='sharedO').request.instructions+='changed';await assert.rejects(()=>freshScopedProjection(i,changed,data.cases));
});
