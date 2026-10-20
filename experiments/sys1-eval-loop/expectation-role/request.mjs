import assert from 'node:assert/strict';import {expectationRequest} from '../expectation/request.mjs';
const OLD='本問はEだけ：本文が実現すべき状態を一つでも宣言しているか。完成状態の表・責務・式も宣言である。Goal等の見出しだけでYesにしない。本文にそのような期待がなければNo。実施済みと書いてあるだけなら期待ではない。';
export const ROLE_PROCEDURE='本問はEだけ。まず本文中で実現すべき状態・責務・機能や入出力対応として主張する宣言を探す。再現手順や観測の記録の中でも、機能・入力と実現すべき出力の対応を宣言する表現は、その表現の役割に従って数える。再現手順という形式だけで除外しない。真正の提出条件・依頼引用・本文で指された問題の解消や回復を求める問いも含む。単なる実施操作と観測結果・症状・回避経路の記録だけから仕様や望ましい状態を補わない。主題・見出し・疑問形だけで決めず、宣言が一つでもあればyes、本文全体になければno。';
export function roleRequest(body,best,key){const r=expectationRequest(body,best,key);if(key!=='scopedE')return r;assert.ok(r.instructions.endsWith(OLD));return {...r,instructions:r.instructions.slice(0,-OLD.length)+ROLE_PROCEDURE};}
