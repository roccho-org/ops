import assert from 'node:assert/strict';
import {targetRequest} from '../feedback-improvement.mjs';
import {wireTemplate} from '../regression/scoped-request.mjs';

export const OBSERVATION_SCOPE='Oは本文中の現実報告の存在を判定する。対象について実際に行ったこと、起きたこと、現在の実装・確認・達成・未達・未確認・失敗・権限・調査中の状態を一つでも報告していればyes。成功、数値、完了、外部の証拠リンクは必要条件ではなく、本文の報告の外部真偽を検証する問題ではない。設計・役割・要求の文書でも、そのような現実報告が混在すればyes。引用・表・HTMLコメントでも、本文が現実の報告として提示していれば含む。一方、命令や将来の期待・設計定義・望ましい完成状態・条件や仮定・架空の作文例を提示しているだけならno。出典・参照リンク・名称や語句が存在するだけでは現実報告にならない。引用や条件文という形式だけで一律に除外せず、対象の現実報告として提示されているかで区別する。';

export function observationRequest(body,best,axis){
 const original=targetRequest(body,best,axis);
 return axis==='E'?original:{...original,criteria:Object.fromEntries(Object.entries(original.criteria).map(([label,criterion])=>[label,criterion+OBSERVATION_SCOPE]))};
}
export function observationPhysicalRequest(body,best,key){
 assert.ok(['bestO','scopedO','sharedE'].includes(key));
 return key==='scopedO'?observationRequest(body,best,'O'):targetRequest(body,best,key==='sharedE'?'E':'O');
}
export async function observationTemplates(best){
 const body='fixed body for request identity only',templates={};
 for(const [name,axis,scoped]of [['bestE','E',false],['scopedE','E',true],['bestO','O',false],['scopedO','O',true]])templates[name]=await wireTemplate((scoped?observationRequest:targetRequest)(body,best,axis));
 assert.deepEqual(templates.bestE,templates.scopedE);assert.notDeepEqual(templates.bestO,templates.scopedO);
 return {templates,identityRule:'complete serialized standard client request; only candidate O yes/no criteria append the same scope clarification; original E/instructions/axis/model/protocol unchanged',physical:{development:['scopedO'],measurement:['bestO','scopedO','sharedE']},alias:{developmentE:'closed PR613 pass1 Best E historical receipt; nonconcurrent',measurementE:'one contemporary sharedE receipt per case within each repetition only'}};
}
