# 実装前段階プラン — 指向性ライト（太陽光）高精度版 / 低精度版

[索引に戻る](README.md)

## 目的

- 低スペック向けにシャドウ負荷を下げ、オプションで品質を維持する。

## スコープ

- `DirectionalLight` + `shadow` の mapSize / type / bias 系、必要なら CSM（three.js addons）。[`lightweight-optimization-list.md`](../lightweight-optimization-list.md) 1.1 と統合し **設定 UI・永続化・自動検出**の方針だけ本書で固定する。

## 調査・決定タスク（実装前）

1. **プリセット定義表**: 「高」「低」それぞれの mapSize、ShadowMap の type、フォグ・pixelRatio との組み合わせを 1 枚の表にする。
2. **自動切替条件**: FPS 閾値、フレーム時間、ユーザー手動の優先順位。
3. **VR/WebXR**: ヘッドセット時は常に低品質にするか等のポリシー。

## 実装計画フェーズに渡す成果物

- 確定したプリセット表と、`scene-manager.js`（または lighting 集中モジュール）への差し込みポイント一覧。
