### R v22 · actual canonical merge／保持原本・source・meaningの独立再読

**対象をactual作用へ固定する。**

- ADRS PR: #655（closed / merged）
- actual merge commit: `6e4abcd22dbee397105625b6041ce1a0d4720182`
- merge tree: `cf28509d770022d2be6e4d172b0ce8b9486cced1`
- first parent / prior `proposals`: `0dd39ca41718fafe40e58c6927a2ebb0ea297eee`
- second parent / accepted source head: `a75e73fdb22a853bb312f057124ee17c75483f49`
- current `proposals` ref: `6e4abcd22dbee397105625b6041ce1a0d4720182`
- actual P admission raw: `raw.adrs.logger_language_neutral_contract_admission.261020.02`
- admission blob at merge: `9371fed680451f58976a00fda0a71e4fbb54f68f`
- fixed meaning: `sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c`

```text
actual merge / proposals ref effect          = CLOSED
accepted tree == reviewed source tree         = CLOSED
actual P admission source bytes               = CLOSED / UNCHANGED
corrected common-design source retained       = CLOSED
original CLI candidate retained               = CLOSED
User continuation authorization retained      = CLOSED
meaning / 13 obligations / five profiles      = UNCHANGED
canonical ADRS source acceptance              = ESTABLISHED
technical logger-design closure               = RETAINED / R v32
necessary retained K                          = NOT YET ESTABLISHED
Governance Cold -> Required binding            = NOT YET ESTABLISHED
final check-package consumer / readback        = NOT YET ESTABLISHED
whole Contract establishment                  = INCOMPLETE
W continuation                                = EXISTING GO
new prior approval                            = NONE
Ops/Apps merge / Release / deploy authority   = NONE
```

## 1. 実merge作用は原本で成立する

Git原本ではactual merge `6e4abcd...`が二親を持つ。

```text
parent 1 = 0dd39ca...  prior proposals
parent 2 = a75e73f...  R v21で受容したactual P source head
result tree = cf28509d...
```

PR metadataも`merged: true`、`merge_commit_sha: 6e4abcd...`を返し、`proposals` branchは現在このmerge commitを直接指す。merge tree `cf28509d...`は受容前head `a75e73f...`のtreeと同一である。

したがって、PR本文やmerge表示だけではなく、**review済みsource treeが既存canonical ADRS branch `proposals`へ実際に作用した**ことを確認した。merge commitはGitHubによるvalid verificationを持ち、別treeへのすり替え・merge後のsource欠落は観測されない。

## 2. 保持原本はmerge treeで分離されたまま存在する

actual mergeから次の4原本を直接再読した。

| 役割 | raw / path | merge時blob | 判定 |
|---|---|---:|---|
| 旧CLI有限candidate | `logger-assembly-failure-diagnostic-contract-261019.jsonl` | `1afdf31a...` | 非採択・限定scopeのまま保持 |
| common logger修正source | `logger-language-neutral-design-contract-261019.jsonl` | `f6baea67...` | 13義務・五profileの固定meaning原本 |
| User継続許可 | `logger-contract-establishment-authorization-261020.jsonl` | `d50c6f2c...` | 条件付きestablishmentと権限境界を保持 |
| actual P admission `.02` | `logger-language-neutral-contract-admission-261020.jsonl` | `9371fed6...` | 同じmeaningをPが選択した採択source |

旧CLI candidateは`meaning_admitted:false`、`current_selected:false`等を保ち、common logger契約へ後付け昇格していない。修正sourceは旧CLI caseを保持しつつUser全体目的の完成契約として置き換えるrelationを保つ。authorizationは同じP/R/Wと条件付き作用を維持する。admission `.02`は旧`.01`のexact revision/blobを`revises`で参照する。

よってcanonical mergeは履歴を一行へ潰しておらず、**candidate、scope訂正、継続許可、actual採択を異なる権限・時点の原本として保持**している。

## 3. source / meaningはR v21から不変

merge後のadmission blobは、R v21が評価した`9371fed680451f58976a00fda0a71e4fbb54f68f`と一致する。次も変わっていない。

- obligation id `ops.logger-language-neutral-design.v1`
- common language-neutral `diagnostic/1`境界
- Applicable 13義務
- CLI/batch・library・browser=`implemented_observed`
- service・worker=`supported_design_only`
- fixed T0、Ops provider、Apps consumer、technical observation
- `13/13 CONFORMANT`とresidual / UNKNOWN / CONFLICT / stale `0`の技術証拠
- 旧9義務caseとの非再帰的境界
- 運用・全言語runtime・Release等を含めないclaim ceiling

meaning identity contract自身がrevision、blob、timestamp、review URLをprovenanceとして意味digestから除外する。今回の作用はsource bytesを変更した再採択ではなく、**R v21で受容した同じP-owned meaningをcanonical branchへ受け入れた作用**である。

R v32で成立した有限技術完成も、このmergeにより弱まらず、逆にmergeだけで範囲拡張もしない。

## 4. canonical acceptanceの現在判定

admission source内の次の値は、source作成時点の状態を記録する。

```text
canonical_acceptance_pending = true
normative_live_required_established = false
operational_adoption = false
```

その後に発生したactual mergeは履歴sourceを書き換えず、別のGit作用として評価すべきである。今回、同sourceがnormal PR routeから`proposals`へ入り、actual refとtreeを再読できたため、**canonical ADRS source acceptanceは現在ESTABLISHED**と判定する。

これは、`normative_live_required_established`や`operational_adoption`をtrueへ読み替える判定ではない。またmerge messageの「Establish」を、Governance final consumerまで完成した主張として受け取らない。成立したのは**ADRS canonical source受入**までである。

## 5. なお未完了の作用

actual merge treeはP meaning、修正source、authorization、候補原本を保持するが、それだけでは次を証明しない。

1. artifact URL消失後も、旧/新Finding、matrix、causality、source context、独立判定を必要十分に再読できる**retained K**
2. accepted meaningから既存Governance Coldへ入り、対象logger Requiredへ投影されたactual identity
3. そのRequiredを既存final `check-package` consumerが実際に読み、対象packageへ適用した結果
4. canonical source、生成物、final consumer結果を別作用から照合する独立readback

admission source自身も「artifact URLだけではKを満たさない」「minimum existing Governance bindingとfinal consumer readback後に限りestablishmentを主張する」と境界を置く。この境界はactual merge後もmaterialである。

したがって、

```text
P meaning admission
+ canonical ADRS source acceptance
!= normative Required established
!= final consumer applied
!= whole Contract establishment
```

である。

## 最終判定

**actual merge `6e4abcd...`をcanonical ADRS source受入としてPASSする。** `proposals` ref、二親、result tree、actual admission blob、修正meaning source、旧candidate、authorizationを原本から照合し、R v21の同じmeaning・scope・権限境界がそのまま作用したことを確認した。

一方、必要K、既存Governance Cold→Required binding、final `check-package` consumerとその独立readbackは未観測のため、whole Contract establishmentは未完了である。

P/Wは既存Goの範囲でこの残件へ継続してよい。本判定は新しい先行approval、権限拡張、無条件のOps/Apps merge、Release、deploy、運用採用を追加しない。最終確立判定は、必要K・actual Governance binding・final consumerの実体が揃い、同じRが再読した後に限る。
