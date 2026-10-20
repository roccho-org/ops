import assert from 'node:assert/strict';
import {targetRequest} from '../feedback-improvement.mjs';import {wireTemplate} from '../regression/scoped-request.mjs';
export const EXPECTATION_SUPPLEMENT=Object.freeze({
 yes:'本文中で実現すべき状態・責務・入出力対応・要件・受入条件として提示される宣言を一つでも数える。報告/提出の条件付き指示、引用された実際の依頼、定型チェック項目も、その文脈で要求や仕様として提示されていれば含む。主たる不具合と同じ対象であること、実施/採用済みであることは必要ない。',
 no:'本文全体にそのような宣言がなく、実施した操作/観測の記録、又は要求として使わない語句・作文・架空例の展示しかない場合だけ該当する。説明文や引用/テンプレの形式・命令形/時制だけで除外/採用せず、実現すべき状態/責務/入出力対応等の宣言として提示するかを判定する。'
});
export function expectationRequest(body,best,key){assert.ok(['bestE','scopedE','sharedO'].includes(key));const original=targetRequest(body,best,key==='sharedO'?'O':'E');return key==='scopedE'?{...original,criteria:Object.fromEntries(Object.entries(original.criteria).map(([label,value])=>[label,value+EXPECTATION_SUPPLEMENT[label]]))}:original;}
export async function expectationTemplates(best){const proof={};for(const key of ['bestE','scopedE','sharedO'])proof[key]=await wireTemplate(expectationRequest('fixed body for request identity only',best,key));assert.notDeepEqual(proof.bestE,proof.scopedE);return proof;}
// Secret-safe input comparison only. Base templates are read from the retained
// first actual census input; keyless preparation verifies the standard client
// produces these complete payloads. Actual requests still use the client.
export function expectationTemplatesFromOriginal(base){const proof={bestE:structuredClone(base.bestE),scopedE:structuredClone(base.bestE),sharedO:structuredClone(base.sharedO)};for(const label of ['yes','no'])proof.scopedE.questions.live.criteria[label]+=EXPECTATION_SUPPLEMENT[label];return proof;}
