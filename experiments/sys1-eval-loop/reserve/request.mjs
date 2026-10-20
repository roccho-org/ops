import assert from 'node:assert/strict';import {OBSERVATION_SCOPE,observationPhysicalRequest,observationTemplates} from '../observation/request.mjs';

// Public retired D300 motivates this distinction. No reserve cases inform it.
export const RESERVE_O_SCOPE=OBSERVATION_SCOPE+'現実の状態報告と、今ここで定める規範を区別する。責務・権限の許可や禁止・採用branchやref・完了条件の定義それ自体は、実施や確認の報告ではない。実際の適用・操作・現在の進行・未達・未確認を別に報告していればyes。現実の権限状態の報告を、規範という形式だけで除外しない。';
export const RESERVE_O_SCOPE_V2='本文が現実の出来事や現在の状態を報告している箇所の有無でOを決める。規範・責務・権限・構成・採用先の定義や宣言、望ましい完成状態・受入条件を示しているだけならno。その内部の現在形や完了・採用・存在・通過などの語だけを、既に起きた事実の報告へ昇格しない。一方、本文内に実操作・実装・確認結果、現在の進行・未達・未確認・失敗・調査中などの現実報告が一つでもあればyes。成功・完了・数値・外部の証拠は不要で、本文外の真偽は検証しない。設計文書や見出し、引用・表・HTMLコメントという形式だけで報告を除外しない。';
export const RESERVE_O_SCOPE_V3=RESERVE_O_SCOPE_V2+'以下は文の働きの対照例であり、見出し名や時制だけで一律判定する規則ではない。受入要件（求める状態）：「修正が実装済みで検査が通っている」→no。作業報告：「修正を実装し検査の通過を確認した」→yes。進捗報告：「検査は未実施・未確認」→yes。';
export function candidateScope(version=1){assert.ok([1,2,3].includes(version));return [RESERVE_O_SCOPE,RESERVE_O_SCOPE_V2,RESERVE_O_SCOPE_V3][version-1];}
export const reserveRequest=(body,best,key,version=1)=>observationPhysicalRequest(body,best,key,candidateScope(version));
export async function reserveTemplateProof(best,version=1){
 const {templates}=await observationTemplates(best,candidateScope(version));
 return {templates,identityRule:'exact serialized standard client requests; only candidate O criteria differ from original Best',physical:{development:['scopedO'],measurement:['bestO','scopedO','sharedE']},alias:{development:'mechanical H1 original Best O/sharedE; H2 original Best only contributes the auxiliary known-correct-axis union guard; historical nonconcurrent receipts',measurement:'one contemporary sharedE receipt within each repetition; no cross-repetition reuse'}};
}
