### R v32 · head `3372357`／固定13義務・五profile・fail-closed全体閉包の独立判定

**対象をexact版へ固定する。**

- Ops head: `3372357c67803d0b8c0875eea70bcc642391fa5a`
- Ops tree: `19f38cc4ea3eef3cb7a99bfb1823455aa53dce11`
- parent: `26e7945f37b47d829e22e12dbe66df955b50fbda`
- direct差分: `packages/shiftleft-admission/tests/logger-language-neutral-closure.mjs`のみ
- evaluator blob: `423faffd0c006d555574aee08712cfa9744f6ed5`
- fixed meaning: `sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c`
- Applicable Required: `13`
- selected provider: Ops `fe968fc6b8919fed48151a57f421667bce0aac87` / tree `b306bf999aba32a678ac48b5a56e4b4a0a3c0cf8`
- selected consumer: Apps `17c0108a5c2549ffaf7cef791a569f2e1926659f` / tree `3d603665d54c83dd770873870c66863959904b42`
- actual run: [39368809399](https://github.com/roccho-org/ops/actions/runs/39368809399)
- producer job: `118451717649` success
- independent readback job: `118452152513` success
- artifact: `12240652155` / 98,368 bytes / `sha256:5ac5df9deb5bf6c9a36de31e6d534b23673f0d5016ae7d576b2cd716741000a7`
- Apps exact-head whole nix-check: [39365786783](https://github.com/roccho-dev/apps/actions/runs/39365786783) success

```text
fixed T0 8 MET / 5 UNMET preservation       = PASS
fixed 13 obligations current evaluation      = 13 / 13 MET
unknown / conflict / stale / residual        = 0 / 0 / 0 / 0
five-profile denominator                     = FIXED / COMPLETE
missing or unreadable evidence -> MET         = IMPOSSIBLE IN CURRENT EVALUATOR
missing or failed check -> whole Green        = IMPOSSIBLE IN CURRENT EVALUATOR
actual JS <-> Python interchange              = PASS
actual browser failure -> typed consumption   = PASS
exact Ops provider -> exact Apps consumer     = PASS
Apps exact-head relevant whole CI             = PASS
artifact integrity / executable replay        = PASS / BYTE-IDENTICAL
R v31 structural block                        = RESOLVED
finite corrected-scope technical closure      = TRUE
formal admission / merge / Release / deploy   = NONE
W existing GO                                 = CONTINUES
new prior approval / method mandate           = NONE
```

## 1. R v31の構造反証はsource上で解消した

[R v31](https://github.com/roccho-org/ops/pull/602#issuecomment-6283074344)が阻止した理由は、旧evaluatorが旧8義務を現在証拠で再評価せず、`baselineStatus/retained`から一律METを組み立て、欠落しても13/13を作れた点だった。

現evaluatorはその構造を削除し、固定13義務をそれぞれ独立した`assess`へ分けている。

```text
purpose_scope_coverage
shared_meaning
cross_language_interoperability
pure_application_boundary
environment_transport
host_context_ownership
supply_consumption_binding
actual_data_use
traceable_evidence
bounded_safe_failure
compatibility
causal_design_closure
small_extensible_design
```

各義務は、現在のsource identity、実report、実run、反例、外部CI参照のうち、その義務に必要なものへ直接結び付く。旧baselineのMET値は現在METを生成する入力として使われず、旧8件にも現在証拠がある。したがって、**過去判定の保持を現在適合へ読み替える構造は消滅した。**

## 2. 欠落・不明時のnon-Greenは成立する

現sourceでは、選定fileについて次を個別に照合する。

- exact repository / revision / tree
- exact path / native Git blob
- current bytesと選定blobの一致
- fileの存在・読取可能性
- 実reportのstatusと必要値
- 実行commandのexit status

fileが存在しない場合は`unmet`、読取不能・取得不能は`unknown`となる。reportがPASSでなければ、そのreportに依存する後段証拠は有効化されない。`assess`は全checkが成立した場合だけMETとなり、最終statusは13件すべてがMETの場合だけ`CONFORMANT`となる。

よって、次の旧偽陽性経路はない。

```text
証拠欠落       -> retainedだからMET
identity不一致 -> 説明情報だけ保持してMET
一部義務未評価 -> denominator 13のまま13 MET
unknown存在    -> CONFORMANT
profile消失    -> 暗黙N/A
```

欠落を意図的に注入する別run自体は今回のpositive runでは行っていないが、判定分岐は直接かつ決定的であり、無条件METやfallback METは残っていない。既存の完成条件に対するfail-closed性として受容できる。

## 3. 五profileは消失せず、実装対象と設計対象も混同していない

現evaluatorは五profileを名前・target・owner・primary-result port・diagnostic port・evidence expectationまで完全一致で固定する。

| profile | target | 今回の意味 |
|---|---|---|
| CLI / batch | `implemented_observed` | 実CLI経路・既存routeを実行確認 |
| library | `implemented_observed` | pure coreとtyped value境界を確認 |
| browser | `implemented_observed` | exact Apps Hostでactual実行確認 |
| service | `supported_design_only` | Host owner/portsを明示、実装済みとは主張しない |
| worker | `supported_design_only` | Host owner/portsを明示、実装済みとは主張しない |

service / workerをactual implementationとして数えてはいない。一方、暗黙N/Aにもせず、固定Contractが要求する設計支援境界として評価している。この区別は固定meaningと一致する。

## 4. current evidenceによる13義務の成立

### 言語・共通意味・安全境界

JavaScriptとPythonは独立実装で、PythonはNodeへ委譲しない。同一corpusについて両方向byte-identical、accepted `16` / rejected `16`、FEFF拒否、NEL受理、limit-1 / limit / limit+1、invalid partial write `0`、transport rejection伝播をactual実行している。

pure coreは環境作用を持たず、Node / browser / Python adapterへ作用を分ける。code-only diagnosticを有効とする互換境界も保持する。

### 実供給・実消費

Appsは選定Ops providerのrevision・tree・contract/core/browser-adapter blobをidentityとして固定し、三つの実bytesを一致させている。actual browserはApps `17c0108...`からdist/runtimeをbuildし、実failure stateから次を通した。

```text
failed state
-> browser Host-owned transport
-> canonical diagnostic/1
-> callback / memory receiver
-> stable code + bounded phase
-> typed action inspect-judgment-provider
-> caller-owned primaryResult remains failed
```

wrong-source、wrong-code、invalid diagnostic、transport rejection時のprimary保存も同じ有限経路でPASSしている。message文章をmachine keyとして消費していない。

### compatibility・既存経路

provider e2e、既存CLI route `9/9`、browser routeがGreenである。さらにRが外部参照を独立確認した結果、Apps exact consumer `17c0108...`のnix-check `39365786783`は成功している。R v31時点のApps `c023c2a...`にあったCrashpad/SIGTRAPと関連CI non-Greenは、このexact tree setには残らない。

なおevaluator内の`conclusion: success`という記述だけを証拠にはしていない。RがGitHub上のexact commit workflow runを別読し、同じrevisionで成功を確認した。

## 5. 原本・artifact・再演

producerは固定T0、current provider、Apps consumer、evaluator、Finding、interchange、browser report、metadataをartifactへ格納し、全bodyを`SHA256SUMS`で固定した。

別jobはartifact `12240652155`をdownloadし、ZIP digest `5ac5df...`を一致させた後、

- 全file checksum
- interchange再実行
- Apps browser再build・再実行
- 13義務closure再評価
- original / replay byte一致

を完了した。再演結果も `13 MET / 0 UNMET / 0 UNKNOWN / 0 CONFLICT / 0 stale / residual 0 / CONFORMANT`、`authority=false`、`admitted=false`である。

Ops exact headのlogger runに加え、同headのnix-checkを含む全workflowも成功している。

## 6. 適用範囲と残る境界

今回成立するのは、固定candidate meaning、固定T0、選定Ops provider、選定Apps consumer、固定五profile targetからなる**有限corrected-scopeの技術適合とContract-guided causal closure**である。

次は主張しない。

- service / workerのactual runtime実装
- storage / collectorの採用
- 全repository・全logger・全環境への一般化
- formal admissionまたはnormative live Required
- merge、Release、deploy、運用採用
- 顧客価値・事業効果

これらを13義務の技術残件へ混ぜない。authorityとadmittedがfalseであることも原出力と一致する。

## 最終判定

**head `3372357...`について、R v31の既存反証は解消した。** 固定13義務は現在証拠から個別に評価され、五profileは完全な分母として保持され、欠落・不明・不一致・失敗はGreenへ補完されない。actual実行、exact Apps whole CI、artifact readbackまで同じtree setで成立した。

したがって、**有限corrected-scopeの技術完成を `13/13 CONFORMANT・residual 0`として独立受容する。** `causal_design_closure`も、固定T0の5 material Findingsから設計判断、修正、current義務別評価、実行、再演まで閉じた。

Wは既存Goのまま継続する。本判定は新しい先行approval、方法指定、merge・正式採択・Release・deploy許可を追加しない。
