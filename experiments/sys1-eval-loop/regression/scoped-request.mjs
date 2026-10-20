import assert from 'node:assert/strict';
import {askJevChoice} from '../../../packages/jev/src/client.mjs';
import {targetRequest} from '../feedback-improvement.mjs';
export const SCOPE_CLARIFICATION='ここでいう宣言は、本文が対象についての実現すべき状態・必要な責務・入出力の対応・要件・仕様・目標・受入/完成条件として提示する内容を指す。語彙・文型・作文等の見本として展示される文に要求形の語句があるだけでは、対象の要求宣言としない。引用・条件付き・表形式でも、対象についての要求・仕様として提示されるなら含む。採用済み・実施済みであることは必要条件ではない。';
export function scopedRequest(body,best,axis){
 const original=targetRequest(body,best,axis);return axis==='O'?original:{...original,criteria:Object.fromEntries(Object.entries(original.criteria).map(([label,criterion])=>[label,criterion+SCOPE_CLARIFICATION]))};
}
// Capture the actual standard client's serialized body, without a credential or network.
// A shared fixed body is only an identity placeholder; actual effect calls use each real body.
export async function wireTemplate(request){
 assert.ok(!process.env.JEV_API_KEY);let captured=null,n=0;
 try{await askJevChoice({...request,provider:{available:true,post:async body=>{n++;captured=JSON.parse(JSON.stringify(body));throw Error('keyless wire capture');}}});}catch{}
 assert.equal(n,1);assert.ok(captured);return captured;
}
export async function scopedTemplates(best){
 const body='fixed body for request identity only',templates={};
 for(const [name,axis,scoped]of [['bestE','E',false],['scopedE','E',true],['bestO','O',false],['scopedO','O',true]])templates[name]=await wireTemplate((scoped?scopedRequest:targetRequest)(body,best,axis));
 assert.deepEqual(templates.bestO,templates.scopedO);assert.notDeepEqual(templates.bestE,templates.scopedE);
 return {templates,identityRule:'complete standard wire body: state/model/live choice/criteria/instructions; fixed body shared; transport and credential binding unchanged; no IDs or version labels',
   physical:{development:['scopedE'],screen:['bestE','scopedE','sharedO'],audit:['bestE','scopedE','sharedO']},
   alias:{developmentO:'historical closed PR606 Best O receipt',screenO:'one contemporary sharedO receipt per case',auditO:'one contemporary sharedO receipt per case'},
   maxPosts:{retainedFailedDevelopment:128,development:32,screen:144,audit:192,total:496}};
}
