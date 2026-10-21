import {boundaryRequest}from'./boundary-request.mjs';
export const EXAMPLE_SUPPLEMENT="要求宣言は、製品変更だけでなく、実現すべき状態・責務、行為・回答の依頼や提出条件を含む。合成例は本文での役割を示し、語句・文体・時制だけの規則ではない。「報告時は使用環境を添えてください」は提出条件としてyes、「使用環境を添えて報告した」という実施記録だけはno。「入力AではBを返す仕様」は入出力宣言としてyes、「Aを入力したらBが返った」という観測記録だけはno。「元に戻す方法を教えてください」は回復依頼としてyes。疑問形だけでyesにしない。引用も本文で実際の要求・仕様・責務の宣言として使う場合は数え、要求として使わない語句・架空例の展示だけなら数えない。";
export function exampleRequest(body,best,key){const r=boundaryRequest(body,best,key);return key==='scopedE'?{...r,instructions:r.instructions+' '+EXAMPLE_SUPPLEMENT}:r;}
export function exampleTemplatesFromOriginal(base){const proof=structuredClone(base);proof.scopedE.questions.live.instructions+=' '+EXAMPLE_SUPPLEMENT;return proof;}
