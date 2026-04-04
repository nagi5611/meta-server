# 実装前段階プラン — 指向性ライト（太陽光）高精度版 / 低精度版

[索引に戻る](README.md)

## 目的

- 低スペック向けにシャドウ負荷を下げ、オプションで品質を維持する。

## スコープ

- `DirectionalLight` + `shadow` の mapSize / type / bias 系、必要なら CSM（three.js addons）。**実装済み**: シャドウは設定メニューの **描画品質ティア**（高/中/低）と WebXR 時の低ティア強制で制御。詳細は [`lightweight-optimization-list.md`](../lightweight-optimization-list.md) 1.1。本書では CSM や bias 調整など **将来の追加分**の方針を書いてよい。

## 調査・決定タスク（実装前）

1. **プリセット定義表**: 「高」「低」それぞれの mapSize、ShadowMap の type、フォグ・pixelRatio との組み合わせを 1 枚の表にする。
2. **自動切替条件**: FPS 閾値、フレーム時間、ユーザー手動の優先順位。
3. **VR/WebXR**: ヘッドセット時は常に低品質にするか等のポリシー。

## 実装計画フェーズに渡す成果物

- 確定したプリセット表と、`scene-manager.js`（または lighting 集中モジュール）への差し込みポイント一覧。
