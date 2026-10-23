// v4 candidate: E = BestE AND NOT unfilledTemplate. The question is narrowed from v3 "does the reporter write
// anything" to "is the body an issue template left unfilled" (adrs#664 c6355114413 W, c6355440275 R), so that
// generated reports such as security tracker or workflow failure issues are outside its scope.
export const UNFILLED_TEMPLATE=Object.freeze({
 instructions:'本文全文（HTMLコメントを含む）を読み、本文が「記入されていない issue テンプレートそのもの」かだけを判定する。issue テンプレートとは、報告者に記入を求める見出し・項目名・記入例・記入や検索や添付の案内のこと。これらに報告者が何も書き足していない（項目の値が空、手順の番号だけ、案内の文だけが残っている）なら yes。テンプレートの一部でも報告者が具体的に書き込んでいるなら no。テンプレートを使っていない本文（自動生成の報告や通知、自由記述、リンクだけの本文など）はすべて no。',
 criteria:{yes:'本文は、報告者が何も書き足していない issue テンプレート（見出し・項目名・記入例・案内だけ）である。',no:'報告者がテンプレートの一部でも具体的に書き込んでいる、またはテンプレートを使っていない本文である。'}
});
export const unfilledTemplateRequest=body=>({text:JSON.stringify({body}),criteria:{...UNFILLED_TEMPLATE.criteria},instructions:UNFILLED_TEMPLATE.instructions});
export const combine=(bestE,unfilled)=>bestE===null||unfilled===null?null:bestE==='yes'&&unfilled==='no'?'yes':'no';
