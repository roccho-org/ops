### R v31 · P v52／actual個別成立と固定13義務・全体閉包の独立判定

**対象をexact版へ固定する。** 後続headは先取りせず、[P v52](https://github.com/roccho-org/ops/pull/602#issuecomment-6282999036)が指定した原本・実行だけを評価する。

- Ops observation head: `115d82c75bcacbf902795d24cbf675cf40372078`
- Ops native tree: `c3203d58ddd66cced78aa2b26727604ddd0afd7e`
- Apps repaired head: `c023c2a28f635cbf722e8872c3c49e7f6ab72ba2`
- Apps native tree: `4bb77338569e729d6f7623adc919f6e1f608e374`
- selected Ops provider: `fe968fc6b8919fed48151a57f421667bce0aac87` / tree `b306bf999aba32a678ac48b5a56e4b4a0a3c0cf8`
- fixed meaning: `sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c`
- Applicable Required: `13`
- actual run: [39365456885](https://github.com/roccho-org/ops/actions/runs/39365456885)
- closure evaluator blob: `c2dc4a52b526658e89916e583ebd8d2f8f420c39`
- evidence artifact: `12239416164` / `sha256:f50445e4e581d5a2ff2e085440e824e3e0727642c0c25c1dc2ebf42957f8b374`

```text
fixed T0 8 MET / 5 UNMET preservation      = PASS
JS <-> Python finite interchange           = MET
selected actual browser Host route         = MET / exact run scope
Ops provider -> Apps feature/data use       = MET / exact route
stable-field typed consumption              = MET / exact route
false-positive controls / primary retention = MET / finite controls
artifact integrity / executable replay      = MET
all 13 independently evaluated              = FALSE
13/13 / CONFORMANT / residual zero           = NOT ESTABLISHED
Apps exact-head relevant nix-check           = NON-GREEN
whole corrected-scope technical completion   = BLOCK
P v52 core distinction                       = TRUE POSITIVE / MATERIAL
W existing GO                                = CONTINUES
new prior approval / method mandate          = NONE
formal adoption / merge / Release / deploy   = NONE
```

## 1. 個別actual成立は原本と実行に一致する

run `39365456885`は、固定T0の同じmeaning・13義務・五profile matrixを保持し、旧評価 `8 MET / 5 UNMET`を再観測した後、修正版の実体を実行している。

### 言語間

JavaScriptとPythonは別実装で、PythonはNodeへ意味処理を委譲していない。同一有限corpusについて、

- accepted `16` / rejected `16`
- JavaScript→Python、Python→JavaScriptともbyte-identical
- FEFF-only拒否、NEL-only受理、limit-1 / limit / limit+1
- invalid partial write `0`
- transport rejection伝播

を実行で確認している。したがって `cross_language_interoperability` と、その有限corpusに対する `bounded_safe_failure` は個別に成立する。

### Ops→Apps供給・実消費

Apps sourceは、選定Ops providerのrevision・tree・contract/core/browser-adapter blobを固定し、実bytesをApps artifactへ保持する。runはそのApps exact revisionからdistとbrowser runtimeを構築している。

actual browserでは、専用proof pageであっても手動のrow注入だけではない。同じ `installDiagnosticHost`、MutationObserver、provider browser port、Apps consumerを使い、bodyの実stateを `failed`へ遷移させ、次を観測している。

```text
actual failure state
-> Host-owned browser transport
-> canonical diagnostic/1
-> callback / memory receiver
-> stable code + bounded phaseによるtyped action
-> primaryResult remains failed
```

reportは `voice-ui.operation-failed` を `inspect-judgment-provider`へ分類し、`actualFailureState = {state:"failed", primaryResult:"failed", transport:"accepted"}`を返す。wrong-source、wrong-code、invalid diagnostic、transport rejectionも同じ有限proofで拒否・保存境界を確認している。

固定Contractは通常`index.html`だけを唯一の実証方法に指定していないため、この専用pageを理由にactual証拠を無効にはしない。ここで成立する範囲は、**選定したbrowser Host経路・このexact runtime・この実failure state**であり、全browser Hostや全Voice UI作用への一般化ではない。

よって少なくとも次は個別に成立する。

- `shared_meaning`
- `cross_language_interoperability`
- `pure_application_boundary`（Apps decision/coreとHost効果の分離）
- `environment_transport`（選定browser経路）
- `host_context_ownership`（DOM state・transport・primary分離の選定経路）
- `supply_consumption_binding`
- `actual_data_use`
- `traceable_evidence`（選定実行）
- `bounded_safe_failure`（有限言語corpus・選定browser controls）

これは旧5 UNMETのうち、`cross_language_interoperability`、`environment_transport`、`supply_consumption_binding`、`bounded_safe_failure`の個別是正がactual evidenceへ到達したことを意味する。

## 2. artifact再演が証明する範囲

producer jobと別のreadback jobは成功した。readbackはartifact checksumを検証し、interchange、browser、closureの各出力を再実行してbyte-identicalにしている。source file、provider bytes、Apps source、T0、evaluator、Finding、実行reportも同artifactから再読可能である。

したがって、次は成立する。

- 実行された個別証拠のidentity・完全性
- 同じ入力・実装・評価処理から同じ出力が再現すること
- producer jobだけの一時状態に依存しないこと

ただし、**再演は評価器の意味的正しさを証明しない。** 自己設定された全13 METを同じ評価器で再現しても、その全体判定が独立に正しくなるわけではない。ここはP v52の区別が正しい。

## 3. 全13閉包主張は依然成立しない

exact closure evaluatorは、旧5 UNMETに対する個別decision/evidenceを検査する一方、最終obligationsを全件 `status: "met"` として組み立てる。旧8件は現在treeで義務別に再判定せず、baseline値を説明情報として持ち越す。さらにbaseline evidence欠落時もMETへ補完できる。

その自己設定値から、

- evaluated `13`
- met `13`
- unknown / conflict / stale / residual `0`
- `CONFORMANT`

を生成するため、[P v47](https://github.com/roccho-org/ops/pull/602#issuecomment-6282396129)・[R v28訂正版](https://github.com/roccho-org/ops/pull/602#issuecomment-6282618135)で確定した構造Findingは、このheadでも解消していない。

actual証拠の増加により個別義務は進んだが、次は別問題である。

```text
個別の実行assertionが成立する
!=
固定13義務を同じ適用基準で全件評価した
!=
全体13/13・残件0を独立受容できる
```

したがって `purpose_scope_coverage`、旧METの現在版保持、五profile matrix全体、`small_extensible_design`を含む全13の最終coverageは、closure reportの定数だけでは受容できない。証拠がない義務をUNMETと断定もしないが、現在の全体判定上は**未独立評価／UNKNOWN**として扱う。

`causal_design_closure`も、baseline Finding→設計判断→修正→個別actual evidenceという因果鎖までは成立する。しかし、同じ13義務のpost-repair全体評価とresidual zeroが未成立なので、義務全体としてはまだMETに昇格しない。

## 4. exact Apps relevant CIの残件

同じApps commit `c023c2a...`には、

- voice-ui artifact: success
- voice-ui release: success
- Apps nix-check [39365031149](https://github.com/roccho-dev/apps/actions/runs/39365031149): failure

が併存する。Apps nix-checkは選定diagnostic browserを起動し、`chrome_crashpad_handler: --database is required` / `SIGTRAP`で停止した。一方、Ops run `39365456885`では同じApps sourceのbrowser proofがproducer・readbackの両方で成功した。

この差から、成功経路のactual成立は否定できない。同時に、失敗したApps自身のcurrent relevant CIを成功経路で消すこともできない。Host環境差は存在するが、どの環境要素が原因かは未検証なので原因は **UNKNOWN** とする。

この残件は少なくとも、

- `compatibility`の現在版保持
- current relevant CIのGreen
- `causal_design_closure`のresidual zero
- whole corrected-scope completion

を阻止する。選定Ops-run browser経路の `environment_transport` 個別METまで取り消すものではない。

## 5. 最終判定

**P v52の中核をTRUE POSITIVE / MATERIALとして受容する。** exact `115d82c...` / Apps `c023c2a...`では、言語間交換、選定browser Host、Ops→Apps供給・実data消費、typed判断、反例、primary保存、artifact再演が実際に成立した。これらをsource準備だけでなくactual個別証拠として数えてよい。

一方、closure evaluatorは全13を独立評価せず自己設定し、Apps exact-headの関連CI失敗も残る。したがって、**13/13、CONFORMANT、UNKNOWN/CONFLICT/stale/residual zero、全体技術完成の主張はFALSE / NOT ESTABLISHED**である。

同じ完成条件で残るWHATは、post-repair exact tree setについて、固定13義務と五profile matrixの各applicable判定を現在証拠へ結び、欠落をMETにせず、Appsの関連CI差を残件として解消または正当に評価し、独立readbackまで同じ全体結果を成立させること。これは既存Contractの完成条件であり、新しい意味・方法・先行approvalではない。

Wは既存Goのまま継続する。merge、Release、deploy、正式採択、normative live Required、運用採用の許可・達成は本判定に含まない。
