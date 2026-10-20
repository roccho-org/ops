import fs from 'node:fs';import assert from 'node:assert/strict';
import {digest} from '../run.mjs';import {targetRequest} from '../feedback-improvement.mjs';import {wireTemplate} from '../regression/scoped-request.mjs';
import {verifyObservationMeasurement} from '../observation/measurement.mjs';import {preparedMeasurement} from '../observation/runtime.mjs';import {verifyQualificationEvents} from '../observation/qualification.mjs';
import {reserveRequest,reserveTemplateProof} from './request.mjs';import {developmentGuard} from './guard.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url),'utf8'));
export function retainedDevelopment(){
 const history=[1,2].map(repId=>{const prefix=`results/observation-pass${repId}-20261020/`;return {input:read(prefix+'input.json'),report:read(prefix+'predictions.json'),events:fs.readFileSync(new URL('../'+prefix+'events.jsonl',import.meta.url),'utf8').trim().split('\n').map(s=>JSON.parse(s)),provider:read(prefix+'provider.json')};});
 return {corpus:read('observation/corpus.json'),history};
}
function providerIdentity(h,i){
 const p=h.provider;assert.equal(p.repository,'roccho-org/ops');assert.equal(p.workflowPath,'.github/workflows/sys1-observation-improvement.yml');assert.equal(p.runId,[39426848156,39427992227][i]);assert.equal(p.runAttempt,1);assert.equal(p.branch,'codex/jev-observation-improvement-20261020');assert.equal(p.actor,'roccho-dev');assert.equal(p.event,'push');assert.equal(p.conclusion,'success');assert.equal(p.runUrl,`https://github.com/roccho-org/ops/actions/runs/${p.runId}`);assert.equal(h.input.repId,i+1);assert.deepEqual(h.input.execution,{source:p.source,activation:p.head,runUrl:p.runUrl});
}
export function historicalRows(data){
 const {corpus,history}=data;assert.equal(corpus.cases.length,300);assert.equal(history.length,2);history.forEach(providerIdentity);const first=history[0];assert.equal(first.input.rows.length,300);assert.equal(first.report.rows.length,300);
 return corpus.cases.map((c,i)=>{assert.deepEqual(first.input.rows[i],{id:c.id,body:c.body});assert.equal(first.report.rows[i].id,c.id);const aliases={};for(const [axis,key]of [['E','sharedE'],['O','bestO']]){const item=first.report.rows[i].observations.find(t=>t.key===key);assert.ok(item);assert.equal(item.answer.model,'jev-1.13.0');assert.ok(['yes','no'].includes(item.answer.choice));assert.deepEqual(item.request,targetRequest(c.body,first.input.best,axis));aliases[axis]={choice:item.answer.choice,key,repId:1,caseId:c.id,...first.input.execution};}return {id:c.id,body:c.body,aliases};});
}
export async function verifyHistoricalDevelopment(data){
 const rows=historicalRows(data),measured=[];
 for(const [i,h]of data.history.entries()){assert.deepEqual(h.input,await preparedMeasurement(i+1,h.input.execution));const m=await verifyObservationMeasurement(h.input,h.report,h.events);assert.equal(m.modelStable,true);assert.equal(m.effectCounts.qualified,900);measured.push(m);}
 return {rows,h1:measured[0].rows.map(r=>({id:r.id,...r.best})),h2:measured[1].rows.map(r=>({id:r.id,...r.best}))};
}
export async function prepareDevelopment(data,execution,version=1){
 const {rows}=await verifyHistoricalDevelopment(data),best=data.history[0].input.best;
 for(const r of rows)assert.ok(Buffer.byteLength(JSON.stringify(await wireTemplate(reserveRequest(r.body,best,'scopedO',version))))<24000);
 return {schema:'ops.sys1.reserve-development.v1',...(version===2?{candidateVersion:2}:{}),rows,best,templateProof:await reserveTemplateProof(best,version),expectedModel:'jev-1.13.0',maxPosts:300,execution};
}
function planned(input){assert.equal(input.schema,'ops.sys1.reserve-development.v1');assert.ok(input.candidateVersion===undefined||input.candidateVersion===2);assert.equal(input.expectedModel,'jev-1.13.0');assert.equal(input.maxPosts,300);assert.equal(input.rows.length,300);assert.equal(new Set(input.rows.map(r=>r.id)).size,300);return input.rows.map(r=>r.id+'/scopedO');}
export function assertDevelopmentEffectInput(input,data,execution,version=1){
 planned(input);assert.equal(input.candidateVersion??1,version);assert.deepEqual(input.rows,historicalRows(data));assert.deepEqual(input.best,data.history[0].input.best);assert.deepEqual(input.execution,execution);
 // No keyless wire capture or Gold scoring under the credential. The reviewed
 // source constructs the one fixed candidate; prepare/project check its proof.
}
export async function evaluateDevelopment(input,ask,observe=()=>{}){
 planned(input);const rows=[];let modelDrift=false;
 for(const c of input.rows){const row={id:c.id,observation:null};if(!modelDrift){const id=c.id+'/scopedO',request=reserveRequest(c.body,input.best,'scopedO',input.candidateVersion??1);observe({kind:'attempt',id});const start=performance.now();try{const answer=await ask(request);if(answer.model!==input.expectedModel){const error=Error('model changed');error.modelChanged=true;throw error;}assert.ok(['yes','no'].includes(answer.choice));row.observation={request,answer,elapsedMs:performance.now()-start};observe({kind:'answer',id,item:row.observation});}catch(error){observe({kind:'qualification-unknown',id});if(error?.modelChanged===true)modelDrift=true;}}rows.push(row);observe({kind:'row',row});}
 return {schema:'ops.sys1.reserve-development-predictions.v1',inputDigest:digest(input),modelDrift,rows};
}
export async function verifyDevelopment(input,report,events,data){
 const expected=planned(input);assert.deepEqual(input,await prepareDevelopment(data,input.execution,input.candidateVersion??1));assert.equal(report.schema,'ops.sys1.reserve-development-predictions.v1');assert.equal(report.inputDigest,digest(input));assert.equal(typeof report.modelDrift,'boolean');
 const ids=k=>events.filter(e=>e.kind===k).map(e=>e.id),attempts=ids('attempt'),posts=ids('post'),answers=ids('answer'),failures=ids('qualification-unknown');assert.deepEqual(attempts,expected.slice(0,attempts.length));assert.ok(attempts.length<=300);assert.equal(new Set(attempts).size,attempts.length);assert.equal(new Set(posts).size,posts.length);assert.deepEqual(posts,attempts.filter(id=>posts.includes(id)));assert.equal(report.actualPosts,posts.length);assert.ok(answers.every(id=>posts.includes(id)));assert.deepEqual([...answers,...failures].sort(),[...attempts].sort());assert.equal(new Set([...answers,...failures]).size,attempts.length);verifyQualificationEvents(report,events,attempts,posts,answers,failures);
 assert.deepEqual(report.rows.map(r=>r.id),input.rows.map(r=>r.id));assert.deepEqual(events.filter(e=>e.kind==='row').map(e=>e.row),report.rows);const candidate=[];
 for(const [i,row]of report.rows.entries()){const c=input.rows[i],o=row.observation;if(o){assert.deepEqual(o.request,reserveRequest(c.body,input.best,'scopedO',input.candidateVersion??1));assert.equal(o.answer.model,input.expectedModel);assert.ok(['yes','no'].includes(o.answer.choice));assert.deepEqual(events.find(e=>e.kind==='answer'&&e.id===c.id+'/scopedO')?.item,o);}else assert.ok(!answers.includes(c.id+'/scopedO'));candidate.push({id:c.id,E:c.aliases.E.choice,O:o?.answer.choice??null});}
 assert.equal(answers.length,report.rows.filter(r=>r.observation).length);const {h1,h2}=await verifyHistoricalDevelopment(data),guard=developmentGuard(data.corpus.cases,h1,h2,candidate,{qualified:answers.length,modelStable:!report.modelDrift});
 return {candidate,guard,effectCounts:{assigned:300,attempts:attempts.length,actualPosts:posts.length,qualified:answers.length,unknown:300-answers.length,unattempted:300-attempts.length},outcome:!guard.noUnionAxisRegression?'DEVELOPMENT_GUARD_FAIL':!guard.qualificationComplete||!guard.modelStable?'UNKNOWN':guard.eligible?'DEVELOPMENT_GUARD_PASS':'DEVELOPMENT_GUARD_FAIL'};
}
