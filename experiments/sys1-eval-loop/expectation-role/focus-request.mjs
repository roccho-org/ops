import assert from'node:assert/strict';import {exampleRequest}from'./example-request.mjs';
export const O_COMPARISON_BLOCK="Oでは実測の引用・確認状況一覧・本文内HTMLコメントの作業メモも数えますが、架空の試験入力・条件付きの例は数えません。許容を表す「〜でもよい」や仮定・可能性だけを述べる文は、現状の報告ではありません。例えば「点検は後日でもよい」は許容条件ですが、「点検はまだしていない」は現在の状態の報告です。O=yesにするには、本文が現実にそうだと主張している箇所が必要です。";
export function focusInstructions(s){assert.equal(s.split(O_COMPARISON_BLOCK).length,2);return s.replace(O_COMPARISON_BLOCK,'');}
export function focusRequest(body,best,key){const r=exampleRequest(body,best,key);return key==='scopedE'?{...r,instructions:focusInstructions(r.instructions)}:r;}
export function focusTemplatesFromOriginal(base){const proof=structuredClone(base);proof.scopedE.questions.live.instructions=focusInstructions(proof.scopedE.questions.live.instructions);return proof;}
