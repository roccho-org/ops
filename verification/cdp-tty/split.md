# Viewer独立完成 — tty-split-20261013-v1 / A

## 目的

既存Headless Chromeの同じTargetへattachするcdp-ttyを、Meltypeやbconの完成待ちにしない。
PTY・キー・Kitty画像は既存の接続契約であり、Xという新製品・Scopeは作らない。

## 実装と試験の所有

- 実装の正本: `packages/cdp-tty/`。別repoへ実装を複製しない。
- 独立試験の正本: `verification/cdp-tty/` と既存のcdp-tty proof。
- 入力: 明示した既存Chrome Target、実Viewer、標準端末入力。
- 出力: 実画面と実DOMの読戻し、同じTarget・Profileの保持、終了・復旧の証拠。
- bconの描画実証は結合側、言語変換・候補選択はMeltype側が所有する。

## 独立完成で残してはいけない不足

| 契約 | 合格に必要な実証 |
|---|---|
| 表示・幾何 | 実Chrome画像、DPR、resize、古いframe拒否。PTYのprotocol試験を実rendererの成功にしない |
| 入力 | click・wheel・必要なdrag/修飾キー・UTF-8/確定日本語・貼付けが、意図した同じTargetへ一度だけ作用 |
| 継続 | Viewer終了・切断・再接続とChromeの寿命を分離。既存Profile/Target不変、端末復旧、所有資源解放 |
| 失敗 | 入力段階・接続段階・描画段階を識別。不明な作用を再送しない |
| 証拠 | 同じsource/build/実行対象、正常系と反例、独立review。過去版の成功を自動継承しない |

Meltype不在でも上記を完了できる。Meltypeの変換性能・再変換・native UndoはこのScopeのmerge条件にしない。
一方、分割を理由にViewer自身の既存必須機能を削除しない。

## 引継ぎ

既存の失敗正本は [ops #433](https://github.com/roccho-org/ops/issues/433)、
既存実装の履歴は [PR #426](https://github.com/roccho-org/ops/pull/426)、
全体結合の移行元は [Meltype #2](https://github.com/roccho-dev/Meltype/pull/2) と
[resources #3](https://github.com/roccho-dev/resources/pull/3)。
結合だけで失敗した場合、再現入力・境界前後の実値・exact版を受け取り、この所有コードに原因がある場合だけ修正する。

本差分は分担と受入契約の固定であり、Viewerの未達修正・新しい実試験の完了ではない。
実装着手時は既存の担当・権限・head・進行中作用を照合し、同一ファイルの並行writerを作らない。
独立Rの本人や権限をこの文書から新設しない。旧試験の削除、他PRのclose、merge、本番配備は行わない。
