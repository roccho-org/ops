# 対象Jevを評価役の助言で改善する有限ループ

## 目的・役割・主張

対象JevはIssue本文のE（要求の存在）/O（観測の存在）を分類する。評価役Jevは対象の開発回答を点検し、既存Choice契約で修正仮説を選ぶ。修正担当local subがその実Choiceを採用/棄却して対象の質問設定を一度変更する。固定Goldとの通常コード照合が成果を評価する。評価役の合格は採用条件ではない。モデル重み更新、Apps接続、自動製品採用は行わない。

PR603は保存済み回答への評価役18判定の校正であり、対象改善の実証ではなかった。今回も旧43call・18call試行を再開しない。現Bestのbinary-eo-v3をbaselineとし、候補集合・本文投影・後段のclassifyは固定する。変更できるのは対象Jevの質問instructionsのみ。評価役自体の設定は同じ比較中に変更しない。

## 一周の有限契約

新しい架空の運用課題D4件・H12件とE/OのGold・根拠をfeedback-corpus.jsonに実行前固定する。旧9件の出力や言い換えを再採点する試行ではない。同じ意味課題familyの小標本であり、著者は修正担当と非独立。Hは今回のモデル実行・candidate選定には未使用だが、公開sourceで修正担当から読める。秘匿、学習未曝露、著者独立のholdoutとは呼ばない。外部採点は別のコード経路でありGold著者の独立性を意味しない。

Goldの適用範囲は当該機能への要求/現実の観測である。『実施を報告しない』『どちらも宣言しない』等の文書の読み方を限定するメタ説明を、それ自体で機能の進捗観測O=yesとは数えない。引用された語彙、架空の台詞も発話対象へ要求/観測として適用されているかで区別する。これは事前の意味契約であり、曖昧な場合は実行前にrootが反証できる。出力後にGoldを有利に変えない。

1. development: baseline E/O 2POST×4件=8、評価役診断1POST×4件=4、上限12。評価役はbodyと対象E/Oのみを見る。case ID/Gold/basis/過去正誤はmodel requestに渡さない。自由文rationaleは取得しない。
2. developmentの生Choice・source/run/artifactを保存。修正担当が各診断の採用/棄却とinstructions差分の対応をfeedback-candidate.jsonに記録する。candidateは事前に作らない。全no_change/有用な診断なしならNO_PROPOSALとしてこの周を閉じてよい。
3. candidate/sourceとCIを独立rootが確認後、confirmation: H12の新入力でbaseline/candidate E/Oを2POST×12件×2arm=48。caseごとにarm順を交替、candidate変更・Gold結果参照・best-of-k・retry/refillなし。上限はこの一周全体60POST、15秒/POST、各job16分。
4. 全回答完了後、鍵なしscoreで固定Goldに照合。全割当の完成率・正解/誤り/不明・repair/break・tokens/所要時間を保存。金額と人手原価はUNKNOWN（0ではない）。unknownのある実行はINCOMPLETEで採用不能。
5. 同じ報告model=jev-1.13.0、全件完了、candidate正解数増、baseline正解→candidate誤答0件かつ各caseの既存正解E/O軸の破壊0件なら有限改善の研究候補。それ以外は元Best保持。baselineが合成ラベルでは既に誤答でも、その中の正しい軸を壊して相殺する変更は受容しない。aliasはimmutable buildの証明ではない。有限例退行0を普遍的無退行・偽陽性0と呼ばない。

今回の2条件では対象設定変更の有限差だけを測る。評価役助言そのものの寄与はNOT_IDENTIFIED。次に必要なら同修正役・同予算の助言なし条件を設けるが、今回には追加しない。H結果を見て修正する場合はHを開発へ降格し、新しい集合・予算・source契約が必要。この一周で自動補充しない。

各armのE/O軸ごとにTP/TN/FP/FN/unknownを出し、分類合計だけで誤検出と見逃しの移動を隠さない。DではGold軸と実回答から期待診断を通常コードで算出し、実診断の一致・誤指摘・見逃し・誤軸・uncertain・unknownを報告する。対象2軸が完了して診断だけ失敗した場合、対象の観測済み正誤は保持し、phaseは未完了とする。confirmation前にはdevelopment実行sourceとのnative Git差分と実artifactから、corpus/Gold・baseline・評価役・実行器が不変で、追加が候補と証拠だけであることをrootが照合する。

```mermaid
flowchart TB
  C["📌 第1周：D4/H12・Gold・現Best・上限60を固定"] --> T["🤖 対象Jev：D4本文からE/O回答・実trace保存"]
  T --> E["🔎 評価役Jev：body＋対象回答からtyped修正仮説"]
  T --> V["📏 鍵なし固定Gold照合：対象E/O正誤"]
  E --> V
  V --> J["🧭 期待診断と実診断を突合\n一致・誤指摘・見逃し・誤軸・保留・不明"]
  J --> W["🛠️ 実診断ごとの採用/棄却と理由\n診断ID→変更差分を記録、評価役に拒否権なし"]
  W --> P{"📦 有用なcandidateを1つ生成できた？"}
  P -->|"なし"| N["🛑 NO_PROPOSAL：旧Best保持\n未実行Hは未消費、残予算を自動使用しない"]
  P -->|"あり"| F["❄️ candidate固定・独立review/CI\ncorpus/Gold・baseline・評価役は変更しない"]
  F --> H["🧪 H12新入力：両armを各2軸で実行\nGold結果を修正へ渡さない、最大48POST"]
  H --> M["📏 鍵なしGoldで両arm測定\n全割当完成率・軸FP/FN・repair/break・消費・不明"]
  M --> L["🧾 診断ID→採否→変更差分→H実成果を対応\n評価役の寄与因果はNOT_IDENTIFIED"]
  L --> G{"⚖️ 同model・全完了・正解数増\n各case/軸の既存正解破壊0？"}
  G -->|"満たす"| R["✅ 有限改善の研究候補\n製品へ自動採用しない"]
  G -->|"同点・退行"| B["↩️ 旧Best保持・candidate不採用\n失敗結果も保持"]
  G -->|"失敗・不明"| U["❓ 比較未完了・旧Best保持\n不明を誤答/成功へ読み替えない"]
  R --> X["📚 使用したHを未使用扱いから退役\n同Hで再修正・再選択しない"]
  B --> X
  U --> X
  X --> Z["🛑 第1周を証拠とともに停止"]
  N --> Z
  Z -. "別の次周：自動補充ではない" .-> Q["🆕 集合・予算・対象責務を事前固定\n同じ権限境界と独立reviewで次周判断"]
```

```mermaid
flowchart TB
  T["🎯 同じ本文・候補・classify"] --> A["🅰️ baseline：現Best質問"]
  T --> B["🅱️ candidate：診断から修正した質問"]
  A --> O["📦 実E/Oとmodel・消費・traceを保存"]
  B --> O
  O --> S["📏 固定Goldで全割当を照合"]
  S --> Q["📊 対象性能の有限差・軸FP/FN・不明・repair/break"]
  E["💬 開発段階の評価役typed診断"] --> J["📏 別の測定対象：診断の妥当性\n誤指摘/見逃し/誤軸/保留/不明"]
  J --> W["🛠️ 修正担当の採否と差分"]
  W -. "H実行前に固定" .-> B
  Q --> G["⚖️ 有限candidateの受容条件\n評価役との一致を要求しない"]
```

## 実行・証拠境界

local subがW、rootが独立R。同じmodel/effortの追加はUser明示指示、旧DSは中断したまま再発火しない。DSの設計3round・source反証・artifact読戻しと関連調査を継承したが、DSの経験的成功や既存GOを捏造しない。policy0dd39ca41718fafe40e58c6927a2ebb0ea297eee共通契約。専用bare/.worktrees、専用branch、新PR、merge/close/配置/鍵変更なし。

標準Actionsはmarkerだけのpushで各phase一度起動。最初のdevelopment history1件、confirmation history2件で先行成功を確認し、attempt1のみ。native Git親・差分でreview sourceとactivationを対応させ、手転記blob SHA gateは追加しない。これはtrusted ownerの誤操作防止であり悪性owner/runnerの暗号attestationではない。既存Org JEV_API_KEYを評価stepだけに渡し値を取得/コピー/表示しない。旧workflowと必要checkは変更しない。

各attempt・answer・diagnosis・rowを逐次artifact用eventsとnative logへ保存。部分終了は終端不明のactualCalls:null・INCOMPLETEを残す。runner喪失時のuploadは保証しない。失敗・作用不明で同じphaseを再送しない。実artifact保存後はkeylessで再計算可能にする。

## 第1周の実結果：NO_PROPOSAL・現Best保持

[source CI39350733705](https://github.com/roccho-org/ops/actions/runs/39350733705)は329/329・fail0、fresh consumerも成功。独立rootのsource/Gold反証と軸退行guard是正後、review source1734fe6eを親にmarkerだけのactivation5c86a823を一回push。[実development39352118583](https://github.com/roccho-org/ops/actions/runs/39352118583)はattempt1で成功し、native workflow履歴はtotal1。追加run/retry/refillなし。

|対象|実観測|
|---|---|
|対象Jev|4/4正答・完了4/4・不明0。E/O各軸TP2/TN2/FP0/FN0|
|評価役Jev|4/4がno_change。通常コードで算出した期待診断とも一致4/4|
|評価役の誤り検出感度|対象誤答の分母0で測定不能。no_change一致だけで診断全般を認定しない|
|修正担当の処理|各実no_changeを保持判断として採用。変更差分null、候補生成なし|
|実POST|対象8＋評価4＝12。terminal true、error/not_run0|
|usage・原価|入力11711/output500 tokens。金額・人手原価UNKNOWN|
|Hと残予算|H未実行・未消費。残48POSTを自動使用しない|
|対象改善・自己修正・Apps効果|未証明/未実行。評価役そのものの寄与因果も未識別|

このDは現Bestに対して天井だった。改善すべき実診断が無いのに候補を作って『評価を使った改善』と捏造せず、事前契約に従いNO_PROPOSAL_KEEP_BASELINEで停止した。対象改善の成功ではない。4例に誤答が無かったことを母集団精度100%や実案件全体の保証にしない。

PR603はaccept/rejectという正否採点、今回は修正箇所を選ぶtyped診断で、課題・rubric・標本が異なる。今回の一致4/4をPR603との評価役性能改善として比較しない。有効な修正仮説からのrepairも分母0で、評価→修正→対象性能向上の閉包はNOT_PROVENである。

artifact12233975172を実取得し、provider digest/sizeと実ZIP（13013bytes）の再計算一致、全5fileのbytes保持とcanonical prepare/score再計算一致を確認した。[生出力・測定・診断採否・native metadata](results/feedback-development-20261020)を保存、feedback-evidence.test.mjsで再推論なしに読戻す。H48/candidateは開始していない。別の次周は新しい事前契約と独立reviewを要し、この周の未使用枠を黙って再配分しない。
