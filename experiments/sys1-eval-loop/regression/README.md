# 適用scopeをrequest configurationで直す改善ループ

目的は、未使用の固定評価でBestより完全正答を増やし、Bestの既正答E/O軸を壊さない設定を確認すること。Bestと旧606の閉じた記録は変更せず、merge/採用/新認証は行わない。普遍的な偽陽性/偽陰性ゼロや人口精度の保証ではない。

## 実測した現在地

旧606 H32は既使用D32へ降格済み。固定入力で標準stateless generate N→F各一回を行い、N3300B/F3446B strict validを生request/response/receiptとともに固定した。再抽選0、観測metadata前後一致。provider内部試行/usage/hardmaxはunknownで、6000Bは候補受入上限だった。

D1は[source6556](https://github.com/roccho-org/ops/tree/6556fe0e95943656b249ffc45697bd69e857cb39)、[run39387282415](https://github.com/roccho-org/ops/actions/runs/39387282415)、artifact12248102054（40853B、SHA256 `203123ad0a2ed3a50bc2a58ab04e83c925c95b95a4a0a72f0db0e6d9352efba3`）で完了。作用は128POST/128qualified/unknown0、model stable。rawとcanonical全値再生を`results/regression-validation-20261020/`に保持する。source必要CIは437/437・fresh consumer・repo-health成功。

| D32 | 完全正答 | Best比修復 | Best既正答軸破壊 | 判定 |
|---|---:|---|---|---|
| 歴史Best | 29 | — | — | 維持 |
| F rewrite | 30 | 17E・21E | 01E | 棄却 |
| N rewrite | 30 | 17E・21E | 01E | 棄却 |

総正答が増えても01E退行を隠さない。両候補がDguardに不合格なのでS48/A64は未開封のまま。F/N生成・D1は閉じた負結果で、再送/書換/勝者の後付け選択をしない。D1のBestは606のcached歴史観測で、同時対照の新実測ではない。

D1の既知usageはF64call=input111870/output1984、N64call=input110846/output1984。`total_tokens`は全128callで未提供。金額・収益効果は未取得、標準generate2要求の内部試行/usageもunknown。既知小計と未取得を分け、0費用とはしない。

## 次の小さい処置

両rewriteはscope例外を既に書いていても01Eを壊した。単に同じ指示を強めて再生成せず、対象configurationの一因子を変える。候補は**元Bestの生instructions＋E criteriaの適用scope明確化**の一本。F/N失敗を救済したことにはしない。`scoped-request.mjs`は元yes/no両全文を保持して同じscope定義を追記し、文型/語彙展示内の要求形と、対象の要件/責務/仕様/目標としての宣言を分ける。引用・条件付き・表形式を一律除外せず、採用/実施済みを要求しない。O、axis固定文、標準protocol、元Best全requestは不変。

これは公開DからWが作るGold/Sys2由来のrequest-configuration処置であり、Jev助言の純因果効果やrewriteだけの効果と称さない。Gold/意味契約は変更しない。候補へcaseID/回答lookup/個別Goldを入れない。

identityはinstructionsや版名ではなく、既存標準clientのnetworkなしpost注入で取得した**実serialized E/O wire template**で判定する。model/state/live choice/criteria/instructionsを含み、共通の固定bodyはidentity用のplaceholderだけ。実作用には各caseの本来bodyを渡す。BestOと候補Oのwire完全一致を確認し、同一Oを二度推論して偶然の差を改善へ数えない。

- D2: 新候補E32だけ。Oはexact wireを確認した旧606 BestOの歴史receiptへ明示alias。全32分母/各軸の出自を保持する。
- S48: caseごとBestE・候補E・sharedOを事前循環で3実測、最大144POST。共有Oのunknownは両roleへ同じく伝播し、独立2証拠や2callに数えない。
- A64: screen通過後に候補一本を固定し、同じ3実測で一度だけ最終確認、最大192POST。

合計は保持済D1 128＋D2 32＋S144＋A192＝**496 Jev POST上限**、既実施の標準generate2要求は別単位。先の800/640/672の設計案を足し合わせたり、本人確認待ちの通算上限へ変えない。各phaseは有限の技術上限・3者事前受容・既存標準client/CI/secret profileで実行する。現sliceはD1記録、adapter/template、新D2 E32 entry、S/A固定3templateの純粋処理まで実装した。起動可能な新phaseは受容後のD2一回だけで、S/Aのデータ/provenance/native admissionは未実装・別受容とする。

sharedOによる呼出削減は実験測定の節約で、配備後の分類が安くなった証拠ではない。S/AのusageはBestE/scopedE/sharedOという物理template単位で一回だけ集計し、候補運用相当のE+Oとpaired実験全体を分ける。E criteria追記は入力tokensを増やし得る。品質gainと効率改善を同一視せず、金額未取得を0費用としない。

## 3者counterと知識境界

適用policyはADRS `0dd39ca41718fafe40e58c6927a2ebb0ea297eee`。同じroot＋W＋counterreviewが主張/反証/再提案を担う。Wは製品source/処置author、rootは別data worktreeで新S/Aを出力前固定し、root/RがGoldを事前反証済み。W/修正器へSはDguard後、Aはscreen通過/候補固定後にだけ開く。root/Rの候補意味レビューは公開task契約への適合だけで、封印S/Aから添削や最適化ヒントを返さない。同UIDのOS秘匿や独立第三者著作は主張しない。

```mermaid
flowchart TB
  U["👤 User: 未見で改善/観測退行0まで継続GO"] --> R["🔎 root: 集合/Gold固定・独立算術・counter"]
  U --> W["🛠️ W: configuration/source/実行/証拠・counter"]
  U --> C["🔎 counterreview: 一次資料・独立再生・counter"]
  R <-->|主張・反証・再提案| W
  W <-->|主張・反証・再提案| C
  C <-->|主張・反証・再提案| R
  R --> K["🔒 S48/A64を段階開封までW非開示"]
  W --> B["✅ 標準N/F各一回・生出力freeze"]
  B --> D["✅ D1 128実測・両01E退行を棄却"]
  D --> P["🧩 W: 元Best＋E criteriaだけの処置候補"]
  K --> P
```

## 完成状態までの閉包

```mermaid
flowchart TB
  A["✅ 606/旧FAIL/旧H32を既使用Dとして保存"] --> B["✅ 標準生成2要求・N/F freeze"]
  B --> D1["✅ D1 128qualified・F/Nとも01E退行"]
  D1 --> J1["❌ 両guard不合格・Best保持・S/A未開封"]
  J1 --> C["🧩 候補一本: 元Best＋scope E criteria"]
  C --> V["⏳ source/必要check/3者counter後、新D2 E32"]
  V --> G{"📏 全32qualified・既正答軸破壊0"}
  G -->|不成立| R["🔁 負結果保持・変更処置を先に契約し開発へ"]
  R --> C
  G -->|成立| S["🔒 S48開封・BestE/候補E/sharedO 144上限"]
  S --> SG{"📏 casegain正・既正答軸破壊0・全qualified"}
  SG -->|不成立| SD["🔁 S退役→開発・fresh Sを先固定"]
  SD --> R
  SG -->|成立| F["🔒 候補一本固定・以降変更なし"]
  F --> H["🔒 A64開封・同3templateで192上限、一回"]
  H --> Q{"📏 casegain正・既正答軸破壊0・全qualified"}
  Q -->|成立| P["📏 この固定未使用audit内の有限改善/観測退行0"]
  Q -->|不成立/unknown| N["🔁 全失敗保存・A退役・Best維持・fresh Aを先固定"]
  N --> R
  P --> Z["🗃️ 原raw・3者独立再計算・通常CI・PR記録を閉じる"]
```

qualified不足・輸送不明・model driftを不成立の実正答やuncertainへ変換しない。全assigned/attempt/post/qualified/unknown/unattemptedを原eventsと照合し、model driftは比較をUNKNOWNへする。成功/失敗queryの盲再送、同一Oの独立arm扱い、alias費用の二重計上をしない。後続sourceは前のrun/原raw/候補を不変に保ち、通常技術是正をUserへ再質問せず3者counterで進める。

改善の証明や近似は不可能ではない。固定未使用auditでの有限gain/観測退行0は確認可能。ただし人工cluster集合・Gold著者依存・選択履歴を持つ本系列へ人口p値/普遍保証を付けない。より強い統計近似には対象分布、無作為で独立したsampling単位、Goldと事前基準が必要。別設計の仮定を満たす独立300件で退行0なら片側95%上限約0.994%だが、本112件の保証ではない。counterreviewによる一次調査：[adaptive holdout](https://arxiv.org/abs/1506.02629)、[NIST exact binomial](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)。全失敗を残し、最後の成功だけへ統計保証を付けない。
