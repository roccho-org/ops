// v3 candidate: E = BestE AND ownContent. The gate is one native binary question about whether the reporter wrote
// anything beyond issue-template scaffolding; it can only turn a Best yes into no (adrs#664 c6354577601: an unfilled
// template declares nothing). Bot-generated reports are not excluded, so bot requests such as an Action Required stay to Best.
export const OWN_CONTENT=Object.freeze({
 instructions:'本文全文（HTMLコメントを含む）を読み、記入者自身が書いた文があるかだけを判定する。次は記入者自身の文に数えない：issue テンプレートの見出し・項目名・記入例・記入や検索や添付の案内（HTMLコメントを含む）、値の無い項目、中身の無い番号付き手順、URL・画像・添付ファイルへのリンクだけの行。これら以外に、記入者が自分の状況・要求・期待・観測・手順を一文でも書いていれば yes。文の内容が期待か報告かは問わない。',
 criteria:{yes:'テンプレートの見出し・記入例・案内、空の項目、リンクや添付だけの行のほかに、記入者自身が書いた文が一文以上ある。',no:'本文はテンプレートの見出し・記入例・案内、空の項目、URL や画像や添付へのリンクだけで、記入者自身が書いた文が無い。'}
});
export const ownContentRequest=body=>({text:JSON.stringify({body}),criteria:{...OWN_CONTENT.criteria},instructions:OWN_CONTENT.instructions});
export const combine=(bestE,ownContent)=>bestE===null||ownContent===null?null:bestE==='yes'&&ownContent==='yes'?'yes':'no';
