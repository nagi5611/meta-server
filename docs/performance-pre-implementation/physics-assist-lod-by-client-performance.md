# 実装前段階プラン — 物理演算補助の LOD（クライアント性能連動）

[索引に戻る](README.md)

## 目的

- 既存の **段階A 物理補助**（`player-update` 時の足元 Y の `minFeetY` / `maxFeetY` クランプと `physics-y-correction`）をベースに、**クライアントごとの性能指標**に応じてサーバ側の検証強度を変える（LOD）。
- **性能が低い（または不安定な）クライアント**では、フレーム落ち・タイムステップ肥大により **床抜け・壁抜け（トンネリング）** が起きやすい前提で、サーバが **より厳密なチェック**を行う。
- **高性能クライアント**では現状に近い **軽量パス**を維持し、サーバ CPU と帯域の無駄を抑える。

## 現状（コードベース事実）

- サーバ: `server.js` の `clampPlayerFeetYForWorld` が `physicsAssist.enabled` 時のみ Y をクランプ。接続直後等は `PHYSICS_ASSIST_GRACE_MS` でスキップ。管理者はスキップ。
- クライアント: `public/js/physics-manager.js` で BVH コライダ・カプセル・トンネル対策（`_tunnelStart` 等）を実装。サーバは **この幾何を保持していない**（[`server-physics-assist.md`](server-physics-assist.md) の「地形データ」課題と同じ）。

## 「LOD」の意味（本プランでの定義）

| レイヤ | 内容 |
|--------|------|
| **LOD-0（軽量）** | 現状相当: 受信した足元 Y のみ `min/max` クランプ（更新は `player-update` の頻度に依存）。 |
| **LOD-1（中）** | 直前サーバ確定位置との **移動量・速度の許容チェック**、**セグメント補間**による「大きな飛び」の検出（完全な壁幾何なしでも一部の異常を拾える）。 |
| **LOD-2（重）** | サーバが **簡略コライダ**（AABB グリッド、OBB、凸分解、高さ場など）を保持し、**水平方向の貫通**や **段差トンネリング** を検証。地形表現の整備が前提（[`server-physics-assist.md`](server-physics-assist.md) 段階B に近い）。 |

本ドキュメントでは **LOD-0 ↔ LOD-1 をクライアント性能で切り替える**ことを第1目標とし、LOD-2 は **データ仕様が決まってから**接続する。

## クライアント性能指数（リアルタイム計測）

「指数」は **単一指標に押し込めず**、次の **複合スコア**（0〜100 等）または **离散ティア**（`high` / `medium` / `low`）を推奨する。各要素は **フィーチャ検出**のうえ合成する。

### 1. フレーム時間（メインスレッド）

- **手段**: `requestAnimationFrame` ループで前フレームからの `deltaMs` を EMA（指数移動平均）する。Three.js のレンダループは `public/js/main-app.js` 等で `performance.now()` 利用あり → 同系統で集計可能。
- **根拠**: 60fps では 1 フレーム約 16.7ms（[MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing) でも言及）。`deltaMs` が大きいほど物理ステップが粗くなりトンネリングリスクが増える **（ゲーム物理の一般論; 本リポジトリ固有の計測結果ではない）**。

### 2. Long Animation Frames（LoAF）／Long Tasks

- **手段**: `PerformanceObserver` で `entryType === 'long-animation-frame'` を購読可能な場合は LoAF を集計（`duration` / `blockingDuration` 等）。未対応ブラウザでは `longtask` が使える場合のみフォールバック。
- **根拠**: LoAF は「50ms を超えたアニメーションフレーム」として定義され、メインスレッド上のスクリプト寄与も `scripts` で参照できる（[MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing)）。仕様リポジトリ: [w3c/long-animation-frames](https://github.com/w3c/long-animation-frames)。
- **注意**: LoAF は **ブラウザによって未対応**の可能性があるため、必ず `PerformanceObserver.supportedEntryTypes` で判定すること（同 MDN 記載）。

### 3. 静的な能力のヒント（任意・補助）

- `navigator.hardwareConcurrency`（論理コア数の目安、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency)）。GPU や実効 FPS とは直結しないため **単独ではティア決定に使わない**方が安全。

### 4. サーバとの往復遅延（任意）

- 既存の `pingMs` 等があれば、極端な RTT と組み合わせて「補間検証を強める」トリガにできる。**遅延単体は性能低下と区別**すること。

### 5. 報告プロトコル（Socket.IO）

- クライアントから **低頻度のサマリ**を送る（例: 1〜2 秒ごとに `fpsEma`, `longFrameCount`, `tier`）。毎フレーム送らない。
- Socket.IO は既存の双方向イベント基盤として利用（[Socket.IO 公式ドキュメント v4](https://socket.io/docs/v4/)）。イベント名・ペイロードは実装フェーズで `server.js` / `network-manager.js` に合わせて定義する。

### チート／誤報への注意（事実と対策の分離）

- **事実**: クライアント送信の性能値は **改ざん可能**である。
- **対策案（設計レベル）**: サーバは **自前の観測**（`player-update` の間隔・ジッター、位置の数理的おかしさ）と **クライアント報告**を併用し、乖離が大きい場合は **報告を無視**するかティアを **サーバ推定で上書き**する。完全な信頼は置かない。

## サーバ側 LOD の振る舞い（案）

### ティア決定

- `socket.data.physicsAssistTier`（例: `0` | `1`）を保持。`client-perf` イベントで更新。直近 N 秒のスムージングでチラつき抑制。

### LOD-0（報告 `high` かつサーバも問題なし）

- 現行の `clampPlayerFeetYForWorld` のみ。

### LOD-1（報告 `low` またはサーバが更新異常を検知）

追加で検討する検証（幾何なしでも可能な範囲）:

1. **時間正規化速度**: `Δpos / Δt` がワールドで許容する最大移動速度を超えないか（ジャンプ・テレポート・grace との整合が必要）。
2. **セグメント通過チェック**: 前回サーバ確定位置から今回までの線分が、**ワールドバウンディング**（将来は簡略コライダ）と交差するか。完全な壁は **AABB ボックス外の「プレイ可能直方体」** 程度でも **一部の壁抜け**は検出しうる（斜め壁・凹形状は不可）。
3. **Y のみの強化**: 同一フレーム相当で複数回検証は **更新レートが 30Hz のため不可能**。代わりに **クライアント側で `player-update` を性能劣化時だけ短周期にする**か、サーバで **直近複数サンプルをキュー**してまとめて検証する（帯域増）。

### LOD-2（将来）

- [`server-physics-assist.md`](server-physics-assist.md) の **地形データ**がサーバに載った段階で、水平コライダとの **連続衝突検出（CCD）相当**や **BVH レイ**を検討。 [@dimforge/rapier](https://github.com/dimforge/rapier) 等のサーバ wasm は **工数大**（段階B）。

## 既存ドキュメントとの関係

- [server-physics-assist.md](server-physics-assist.md): 段階A/B・地形の必要性。本プランの LOD-2 はその **前提条件**に依存。
- [lod.md](lod.md): **表示用 LOD**（メッシュ）。本プランは **サーバ検証強度の LOD** で概念は似ているが別軸。将来、表示 LOD が低いクライアントと性能ティアを **相関させる**選択肢あり（実装時に検証）。

## 調査・決定タスク（実装前）

1. **ティア閾値**: `fpsEma` と LoAF 件数のしきい値（端末テストで調整）。
2. **速度上限**: ワールドごと / グローバルでの `maxHorizontalSpeed`, `maxVerticalDelta`（管理者・乗り物・テレポートとの例外）。
3. **帯域**: `client-perf` の送信周期と JSON サイズ上限。
4. **LOD-1 で「壁抜け」の定義**: AABB のみで足りるマップか。足りないマップは LOD-2 前提と割り切るか。
5. **VR / XR**: フレームレートと `player-update` の関係（別閾値が必要か）。

## リスク

- クライアント性能報告の **信頼性**（上記）。
- LOD-1 だけでは **凹型・斜壁**の壁抜けは **検出不能**な場合が多い（幾何が必要）。
- 検証強化に伴う **サーバ CPU 増**（プレイヤー数スケール時はプロファイラで要確認）。

## 実装計画フェーズに渡す成果物

- `client-perf`（仮称）イベントの **JSON スキーマ**とティア決定アルゴリズム（疑似コード可）。
- `socket.data` に載せる **サーバ側状態**一覧（現在の `physicsAssistGraceUntil` との優先順位）。
- LOD-1 用 **速度・バウンディング**の具体式と、既存 `physicsAssist` 設定との組み合わせ表。

---

## 実装済み（確定仕様の要約）

- **送信**: `report-ping` に `pingMs` に加え `fpsSample`（可視/XR 時のみ 10 秒ごと 1 秒窓のフレーム数）、`perfTier`（`low`≤15 / `medium`≤30 / `high`）、`loafCount`・`longtaskCount`（前回 ping からの差分）、任意 `perfSampleAt`。
- **サーバ**: `socket.data.effectivePerfTier`（管理者は常に `high`）。`[perf]` 行を `console.log`。Low のみ `player-update` で速度上限（`PHYSICS_LOW_MAX_HORIZ_SPEED`）、`playBounds`、`serverColliders`（AABB ソリッド）を適用。補正は `physics-position-correction` と既存 `physics-y-correction`。
- **ワールド**: `playBounds` / `serverColliders` は `POST /admin/worlds` で検証。未設定時は壁 AABB 検証をスキップ（速度・境界・Y クランプのみ）。
