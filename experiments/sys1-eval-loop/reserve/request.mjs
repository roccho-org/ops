import {OBSERVATION_SCOPE,observationPhysicalRequest,observationTemplates} from '../observation/request.mjs';

// Public retired D300 motivates this distinction. No reserve cases inform it.
export const RESERVE_O_SCOPE=OBSERVATION_SCOPE+'現実の状態報告と、今ここで定める規範を区別する。責務・権限の許可や禁止・採用branchやref・完了条件の定義それ自体は、実施や確認の報告ではない。実際の適用・操作・現在の進行・未達・未確認を別に報告していればyes。現実の権限状態の報告を、規範という形式だけで除外しない。';
export const reserveRequest=(body,best,key)=>observationPhysicalRequest(body,best,key,RESERVE_O_SCOPE);
export async function reserveTemplateProof(best){
 const {templates}=await observationTemplates(best,RESERVE_O_SCOPE);
 return {templates,identityRule:'exact serialized standard client requests; only candidate O criteria differ from original Best',physical:{development:['scopedO'],measurement:['bestO','scopedO','sharedE']},alias:{development:'mechanical H1 original Best O/sharedE; H2 original Best only contributes the auxiliary known-correct-axis union guard; historical nonconcurrent receipts',measurement:'one contemporary sharedE receipt within each repetition; no cross-repetition reuse'}};
}
