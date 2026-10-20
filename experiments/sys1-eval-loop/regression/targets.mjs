import assert from 'node:assert/strict';
import {ARM_ORDER,compareCandidate} from './selection.mjs';
import {targetRequest} from '../feedback-improvement.mjs';
import {digest} from '../run.mjs';
export function developmentPlan(development,results){
  assert.equal(development.rows.length,32);const configurations=[],aliases={},instructions={best:development.best};
  for(const arm of ARM_ORDER){
    const text=results[arm]?.status==='valid'?results[arm].candidate.instructions:null;instructions[arm]=text;
    if(text===null){aliases[arm]=null;continue;}
    assert.ok(typeof text==='string'&&text.trim()&&Buffer.byteLength(text)<=6000);
    const same=configurations.find(c=>c.instructions===text);
    if(text===development.best)aliases[arm]='best';
    else if(same)aliases[arm]=same.id;
    else{aliases[arm]=arm;configurations.push({id:arm,instructions:text});}
  }
  return {instructions,configurations,aliases,maxPosts:32*2*configurations.length,cachedBest:'closed PR606 H32; historical observation, not a new contemporaneous control'};
}
export async function evaluateTargets(input,ask,observe=()=>{}){
  assert.equal(input.rows.length,32);assert.equal(input.maxPosts,32*2*input.plan.configurations.length);assert.equal(input.maxPosts,input.plan.maxPosts);assert.ok(input.maxPosts<=128);let stopped=false;
  const rows=[];
  for(const [index,c]of input.rows.entries()){
    const cs=input.plan.configurations,offset=cs.length?index%cs.length:0,order=[...cs.slice(offset),...cs.slice(0,offset)],row={id:c.id,order:order.map(x=>x.id),configurations:[]};
    for(const config of order){const target=[];
      for(const axis of ['E','O']){
        if(stopped)continue;const id=c.id+'/'+config.id+'/'+axis,request=targetRequest(c.body,config.instructions,axis);observe({kind:'attempt',id});
        const start=performance.now();
        try{const answer=await ask(request);assert.equal(answer.model,input.expectedModel);assert.ok(['yes','no'].includes(answer.choice));
          const item={axis,request,answer,elapsedMs:performance.now()-start};target.push(item);observe({kind:'answer',id,item});
        }catch(e){observe({kind:'qualification-unknown',id});if(e?.modelChanged===true)stopped=true;}
      }
      row.configurations.push({id:config.id,target});
    }
    rows.push(row);observe({kind:'row',row});
  }
  return {inputDigest:digest(input),modelDrift:stopped,rows};
}
export function verifyEffects(input,report,events){
  assert.equal(input.maxPosts,input.plan.maxPosts);assert.equal(input.maxPosts,32*2*input.plan.configurations.length);
  const ids=kind=>events.filter(e=>e.kind===kind).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');
  const expected=input.rows.flatMap((c,index)=>{const cs=input.plan.configurations,offset=cs.length?index%cs.length:0;return [...cs.slice(offset),...cs.slice(0,offset)].flatMap(config=>['E','O'].map(axis=>c.id+'/'+config.id+'/'+axis));});
  assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.equal(new Set(attempts).size,attempts.length);assert.ok(attempts.length<=input.maxPosts);
  assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);assert.ok(Number.isInteger(report.actualPosts));
  assert.ok(answers.every(id=>posts.includes(id)));assert.equal(new Set([...answers,...failures]).size,attempts.length);assert.equal(answers.length+failures.length,attempts.length);assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());
  assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);
  assert.equal(answers.length,report.rows.reduce((sum,r)=>sum+r.configurations.reduce((n,c)=>n+c.target.length,0),0));
  return {assignedPosts:input.maxPosts,attempted:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:input.maxPosts-answers.length,unattempted:input.maxPosts-attempts.length};
}
export function developmentProjection(input,report,gold,cachedBest){
  assert.equal(report.inputDigest,digest(input));assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(c=>c.id));assert.deepEqual(gold.map(c=>c.id),input.rows.map(c=>c.id));
  const physical=[];
  for(const [i,r]of report.rows.entries()){
    const c=input.rows[i];assert.equal(gold[i].body,c.body);const configs=input.plan.configurations,offset=configs.length?i%configs.length:0;
    assert.deepEqual(r.order,[...configs.slice(offset),...configs.slice(0,offset)].map(x=>x.id));assert.deepEqual(r.configurations.map(x=>x.id),r.order);
    for(const config of r.configurations){const instructions=configs.find(x=>x.id===config.id).instructions;
      assert.ok(config.target.length<=2);assert.equal(new Set(config.target.map(t=>t.axis)).size,config.target.length);
      for(const t of config.target){assert.ok(['E','O'].includes(t.axis));assert.deepEqual(t.request,targetRequest(c.body,instructions,t.axis));assert.equal(t.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(t.answer.choice));}
      physical.push({id:r.id,configuration:config.id,status:config.target.length===2?'qualified':'unknown',model:input.expectedModel,...Object.fromEntries(config.target.map(t=>[t.axis,t.answer.choice]))});
    }
  }
  assert.equal(cachedBest.length,32);assert.deepEqual(cachedBest.map(r=>r.id),input.rows.map(c=>c.id));
  for(const r of cachedBest){assert.equal(r.status,'qualified');assert.equal(r.model,input.expectedModel);assert.ok(['yes','no'].includes(r.E)&&['yes','no'].includes(r.O));}
  const rows=cachedBest.map(r=>({...r,arm:'best',observationOrigin:'cached PR606 H32'}));
  for(const id of input.rows.map(c=>c.id))for(const arm of ARM_ORDER){
    const alias=input.plan.aliases[arm],actual=alias==='best'?cachedBest.find(r=>r.id===id):physical.find(r=>r.id===id&&r.configuration===alias);
    rows.push({...actual,id,arm,observationOrigin:alias===null?'invalid candidate':alias==='best'?'cached Best alias':alias===arm?'native':'native configuration alias'});
  }
  const comparisons=Object.fromEntries(ARM_ORDER.map(arm=>[arm,compareCandidate(gold,rows,arm,input.plan.instructions,input.expectedModel,'development')]));
  if(report.modelDrift!==false)for(const r of Object.values(comparisons)){r.rawDisposition=r.disposition;r.disposition='UNKNOWN';r.eligible=false;}
  return {physical,rows,comparisons,modelStable:report.modelDrift===false,usageScope:'new unique native traces only; cached Best and aliases are not new calls'};
}
