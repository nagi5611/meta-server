# 大規模ワールド向けシステム — 実装前段階プラン（索引）

各システムは **別ファイル**に分けてある。詳細設計・実装に入る前に、そちらの「調査・決定タスク」を埋める。

## 共通の前提（コードベース）

- クライアント: Three.js（例: r160）、`GLTFLoader` + `DRACOLoader`、ワールド読み込みは `public/js/scene-manager.js` 等でモデル一覧を順次ロードする構成。
- サーバ: `server.js`（Socket 同期中心）。物理はクライアント主導に近い前提で進めているなら、サーバ物理はアーキテクチャ変更に相当する。

既存の軽量化タスク（シャドウ解像度・pixelRatio 等）は [`../lightweight-optimization-list.md`](../lightweight-optimization-list.md) を参照。指向光 2 段階はその延長線上の「設計方針の固定」として [`directional-light-quality.md`](directional-light-quality.md) で扱う。

## ドキュメント一覧

| # | システム | ファイル |
|---|----------|----------|
| 1 | ストレージキャッシュ | [storage-cache.md](storage-cache.md) |
| 2 | LOD | [lod.md](lod.md) |
| 3 | チャンクローディング | [chunk-loading.md](chunk-loading.md) |
| 4 | 指向光（高精度 / 低精度） | [directional-light-quality.md](directional-light-quality.md) |
| 5 | GLB テクスチャのアップロード時スケール変更 | [glb-texture-resize-upload.md](glb-texture-resize-upload.md) |
| 6 | サーバ側物理補助 | [server-physics-assist.md](server-physics-assist.md) |
| 7 | 物理補助 LOD（性能連動） | [physics-assist-lod-by-client-performance.md](physics-assist-lod-by-client-performance.md) |

## 推奨する検討順（実装前）

1. **指向光 2 段階** … 既存コードへの影響が局所的で、`lightweight-optimization-list.md` とまとめやすい。
2. **アップロード時テクスチャ縮小** … 帯域・VRAM への効果が明確。パイプライン依存の決定が中心。
3. **ストレージキャッシュ** … URL バージョニングとセットで設計する。
4. **LOD** … アセットワークフロー合意が取れてから。
5. **チャンク** … ワールドデータ分割の合意が取れてから。
6. **サーバ物理補助** … 地形データのサーバ側表現が決まってから。
7. **物理補助 LOD（性能連動）** … `player-update` 30Hz 前提とクライアント報告の信頼性を踏まえ、LOD-0/1 の閾値と速度上限を決めてから（LOD-2 は地形表現とセット）。

## 次のアクション（このフォルダのゴール）

- 各 `.md` の **「調査・決定タスク」にチェックオーナーを付け、議論の結果を追記**する。
- 上記が埋まったら、別紙で **実装計画**（マイルストーン・タスク分解・テスト観点）を起票する。
