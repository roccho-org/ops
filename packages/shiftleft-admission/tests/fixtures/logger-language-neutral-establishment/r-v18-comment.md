### R v18 · P v27継続／固定matrix・baseline Finding・次系列の独立判定

**対象実体**

- 継続指示: [P v27 / issuecomment-6280148432](https://github.com/roccho-dev/adrs/pull/655#issuecomment-6280148432)
- corrected Contract source: [`logger-language-neutral-design-contract-261019.jsonl`](https://github.com/roccho-dev/adrs/blob/ad38c5f8d7eb310030d1bd184a7ce9e88a76869f/decisions/logger-language-neutral-design-contract-261019.jsonl)
- source head/tree/blob: `ad38c5f8d7eb310030d1bd184a7ce9e88a76869f` / `5ee2f9bc28439202a9758232d56e1817316e0e3d` / `f6baea67fa0ff76d507d554da38a9e4db2f168bb`
- meaning: `sha256:ab3c271e57ba33a7e663f99d417680f6044cc59c099e5223978e2e4ef6811e3c`
- fixed matrix: [W matrix / issuecomment-6266407621](https://github.com/roccho-dev/adrs/pull/655#issuecomment-6266407621)
- baseline report: [W baseline / issuecomment-6266487885](https://github.com/roccho-org/ops/pull/602#issuecomment-6266487885)
- P checkpoint: [P v26 / issuecomment-6266591123](https://github.com/roccho-org/ops/pull/602#issuecomment-6266591123)
- observer head/tree: `b8c9a0eb1436d1d1218621c41d39a9b5a60fc9d2` / `cfeee63db40e42260252872f273acaf5354a1975`
- baseline run: [39246951391](https://github.com/roccho-org/ops/actions/runs/39246951391)
- whole-head run: [39246951307](https://github.com/roccho-org/ops/actions/runs/39246951307)
- fixed T0:
  - Ops `d1ed2594aa6112f931ff3996c89d8fde8aed8690` / tree `27c40aee9b923129e0feefa8477da711155c8384`
  - Apps `c91bab56ec5e769d9788453a098a289115cdaa92` / tree `a32423848d2298b4c54cf43cd22119859f25c905`
- policy: [ADRS #449](https://github.com/roccho-dev/adrs/issues/449) / `0dd39ca41718fafe40e58c6927a2ebb0ea297eee`

```text
R corrected source / 13-obligation denominator = GO
R five-profile matrix                           = GO
R exact T0 / evaluator identity                 = GO
R baseline evidence readability                 = GO
R material product/design Findings              = 4 TRUE POSITIVE
R causal_design_closure                         = TRUE PROCESS-STATE UNMET
R observer repository compatibility             = BLOCK / DIRECT FIX ALLOWED
R product repair                                = HOLD UNTIL CORRECTED OBSERVER READBACK
R formal admission / canonical Contract         = NOT YET
R merge / Release / deploy authority             = NONE
```

## 1. source・matrix・評価境界

R v17で受容したcorrected sourceと固定T0は、今回読んだ実評価器でも変更されていない。評価器は次をexact identityで固定している。

- corrected meaningと13義務
- Ops/AppsのT0 revision・tree・選定file blob
- CLI/batch、library、browser、service、workerの五profile
- baseline state、target state、owner、primary/diagnostic port、必要証拠
- 旧CLI proofは旧meaningの既存事実であり、新Contractが導いた変更ではないという境界

matrixは小さく妥当である。

| profile | baseline → target | R判定 |
|---|---|---|
| CLI/batch | implemented_observed → implemented_observed | 既存caseを保持。新全体完成の代用不可 |
| library | implemented_observed → implemented_observed | pure value/port境界として妥当 |
| browser | supported_design_only → implemented_observed | 実非CLI・Apps消費の選定経路として妥当 |
| service | supported_design_only → supported_design_only | port/owner/限界の設計解決のみ。実装済みとは数えない |
| worker | supported_design_only → supported_design_only | 同上。別profileのPASSを借用しない |

全profile SDK実装を要求せず、かつ未実装profileを曖昧な「対応済み」で消さないため、User目的と小ささの両方を守る。具体言語にPython、実非CLIにApps/browserを選ぶことはW-owned HOWであり、現matrixでは目的coverageを満たす最小候補として受容する。

## 2. baseline evaluatorの独立評価

実評価器 `packages/shiftleft-admission/tests/logger-language-neutral-baseline.mjs` は、期待文字列だけで結果を作っていない。少なくとも以下を実読・実行している。

- Ops T0の`structured-diagnostic` contract、README、pure core、Node adapter、CLI、既存consumer/tests
- Apps T0のflakeとvoice-ui関連実体、および`diagnostic/1`/provider利用の不在
- `diagnostic/1`のcode-only正当値
- host-owned fieldの禁止境界
- existing JS executable behaviorと既存artifact routeの実data use
- Python実装・browser実経路・cross-repo feature useの不存在

run `39246951391`はproducer jobとartifact-only readback jobが成功し、次を同じobservationとして保持した。

```text
Applicable / evaluated = 13 / 13
MET                     = 8
UNMET                   = 5
UNKNOWN / CONFLICT      = 0 / 0
stale                   = 0
repairAllowed           = false
observationId           = sha256:e2203f6f4706ee3797b0345589c89ddec50affe1b8c77ea83b2b7e4938929998
```

source・T0・matrix・評価器・実行・readbackの結合は、baseline Findingを独立評価するために十分である。ただし、各UNMETの種類を同じ「実装欠陥」として扱うのは誤りなので、次のように分類する。

## 3. material Finding判定

### A. `cross_language_interoperability` — TRUE POSITIVE / MATERIAL

T0は実行可能な共通意味をNode/JavaScriptだけで供給している。第二言語が独立にvalid/invalid/limit semanticsを実行し、両方向で同じbytes/decisionを交換する証拠はない。

単にPythonからNodeを呼ぶ、同じJSON fixtureを読む、shapeを複写するだけでは閉じない。第二言語が同じcanonical contractを独立に解釈し、Node→第二言語、第二言語→Nodeの両方でvalid受理・invalid拒否・境界値の同じ判断を示す必要がある。

### B. `environment_transport` — TRUE POSITIVE / MATERIAL

READMEにはbrowser callback/in-memory sinkという設計profileがあるが、Apps T0の実browser producer→consumer pathは存在しない。design-onlyをimplemented_observedとして数えていないため正しいFindingである。

修正後は主UI結果とdiagnostic transportを分離し、consoleをauthorityや唯一のtransportにせず、actual callback/portを通ったdiagnosticが実consumerへ届く必要がある。

### C. `supply_consumption_binding` — TRUE POSITIVE / MATERIAL

T0には、Ops provider Packageの実装をApps consumer Packageがexact version/treeで取り込み、その機能を実行した経路がない。同じschema文字列やコピーしたvalidation logicは供給・機能消費ではない。

閉包には次の四者を区別した実証が必要である。

```text
canonical meaning contract
executable conforming provider implementation
provider機能を使うApps package
生成diagnostic dataを判断に使うreceiver
```

### D. `bounded_safe_failure` — TRUE POSITIVE / MATERIAL

strict encoding、duplicate/unknown/nesting/Unicode/size、host-owned field、invalid時のprimary-result保全はJavaScriptでは実行済みだが、言語境界を越えた同一判断は未証明である。第二言語で「概ね同じ」では不足し、共通caseに対して同じaccept/rejectとlimit semanticsが必要である。

### E. `causal_design_closure` — TRUE PROCESS-STATE UNMET / NON-PRODUCT

これは実装すべき第五機能ではない。現時点では、corrected Contractのpre-change FindingがRにmaterialと判定され、そのFindingから後続design decision・実装・同じContractのold/new閉包へ進んでいないためUNMETである。

この義務を閉じる方法は、専用frameworkや新しいlogger部品を追加することではない。上記A–DのFindingを入力としてWが設計判断を残し、その後のactual deltaと同じ13義務のnew evaluationを結ぶことで閉じる。

したがって、baselineの`8 MET / 5 UNMET`という分母・結果は受容するが、**Wの製品修正対象はA–Dの4 WHAT**であり、Eは系列全体の完了条件である。

## 4. 反証

次では完成扱いしない。

1. PythonがNode executableへ委譲し、独立言語実装を自称する。
2. valid happy pathだけ一致し、duplicate key、unknown field、Unicode、nested value、limitsのどれかが言語間でdriftする。
3. Appsが`contract.json`またはJSON shapeだけをコピーし、Ops provider機能を消費したと呼ぶ。
4. CI fixtureだけがproviderをimportし、実Apps packageの非CLI経路では使われない。
5. browserでconsoleへ出しただけで、callback/portとactual receiverを省く。
6. diagnostic受信を数えるだけで、stable codeと必要fieldを用いた実分類・次判断がない。
7. 正常結果、invalid diagnostic、wrong code/source、transport rejectionが誤分類される。
8. service/workerのdesign-onlyをimplemented_observedへ昇格する。
9. 旧CLI proofをcorrected Contractが導いた実装として後付けする。
10. `causal_design_closure`を理由に第二のContract engine、logger framework、collector、storageを作る。
11. profile/matrix/13義務を修正後の実装に合わせて縮小する。
12. author summaryやGreenだけで、actual bytes・tree set・実consumer readbackを置換する。

## 5. whole-head counterfinding

whole run `39246951307`の失敗は、13義務Findingとは別の直接的repo-convention Findingである。

```text
code    = undeclared-workflow
path    = .github/workflows/logger-language-neutral-baseline.yml
severity = blocking
```

既存guardは正しく新workflowの未宣言を拒否した。これを無関係な外乱として無視せず、guardを削除・弱化せず、観測経路を既存repo conventionへ適合させる必要がある。

一方、この失敗は固定T0の実状態やA–Dのmaterialityを反証しない。baseline専用runはexact source/T0/evaluatorで完了し、artifact-only readbackも一致しているため、Rのmaterial Finding判断は成立する。

ただし、因果系列を最も小さく保つため、**製品側repair前に観測headだけを既存conventionへ適合し、同じsource・T0・matrix・13義務・評価意味で再実行し、whole-head Greenと同じFindingをreadbackする**。この是正でFinding、分母、T0、matrixを変えてはならない。評価器変更が必要なら、旧新版・理由・意味同一性を保持する。

## 6. 系列判定と次境界

```text
C0 corrected source / 13 obligations           = CLOSED
C1 exact T0 + finite support matrix             = CLOSED
C2 actual baseline observation                  = CLOSED
C3 R material true-positive judgment            = CLOSED (A–D)
C4 Finding-guided design / implementation       = NOT STARTED
C5 two-language + non-CLI actual interoperability = NOT STARTED
C6 Ops -> Apps actual package supply/use        = NOT STARTED
C7 actual data use + counterexamples + compatibility = NOT STARTED
C8 same matrix old UNMET / new MET independent readback = NOT STARTED
C9 unresolved / UNKNOWN / CONFLICT / stale = 0 = NOT STARTED
formal P admission / canonical Contract         = NOT STARTED
```

**継続判定**：

- Wは、既存guardを維持したままobserverのrepo-convention不適合を最小是正し、同じbaseline Findingを再観測してよい。
- そのcorrected observerのexact head・whole CI・同一Findingをreadbackした後、P v27の既存許可内でA–Dを入力とする最小design/implementation repairへ進める。
- design decisionは、A–Dそれぞれに対して何を変えるかを示し、Eを新機能へ変換しない。
- 最終評価は固定meaning、同じ13義務、同じprofile matrix、固定old T0とexact new Ops/Apps tree setで行う。全13 MET、residual/UNKNOWN/CONFLICT/stale 0、whole relevant CI Green、独立artifact/readbackが必要である。
- 技術完成後、Pが別作用としてactual admission decisionをexact source/resultへ結び、canonical source・派生Required・実供給消費をRが再読するまで「Contract確立」とは呼ばない。
- merge、Release、deploy、auth/settings、新外部基盤、万能collector、全言語SDK、事業効果は依然として未許可・非要件。
