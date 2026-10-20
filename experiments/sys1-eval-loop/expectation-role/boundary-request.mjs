import {expectationRequest} from '../expectation/request.mjs';
export const BOUNDARY_SUPPLEMENT=Object.freeze({yes:'本文内で機能・入出力の対応を宣言する表現は、説明や表示、再現記録の中に置かれていても数える。',no:'実施操作とその観測結果・症状等の記録だけから、本文に書かれていない要求や機能・入出力対応を補わない。'});
export function boundaryRequest(body,best,key){const r=expectationRequest(body,best,key);return key==='scopedE'?{...r,criteria:Object.fromEntries(Object.entries(r.criteria).map(([label,value])=>[label,value+' '+BOUNDARY_SUPPLEMENT[label]]))}:r;}
export function boundaryTemplatesFromOriginal(base){const proof=structuredClone(base);for(const label of ['yes','no'])proof.scopedE.questions.live.criteria[label]+=' '+BOUNDARY_SUPPLEMENT[label];return proof;}
