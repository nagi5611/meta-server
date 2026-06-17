# webxr-vr アドオン

Meta Quest 等向け **WebXR VR（`immersive-vr`）** 機能を提供します。コアから L3 分離されたオプション拡張です。

## 機能

- VR 入室ボタン（`local-floor` / `dom-overlay`）
- スムーズ移動・スナップターン・テレポート・ジャンプ
- 没入中のグラフィック品質自動低下（FPS 優先）
- DOM Overlay 上のロコモーションモード切替 UI

## 有効化

1. 管理画面 `/admin.html` → アドオン → `webxr-vr` を有効
2. **Node プロセスを再起動**（`docs/addons-restart-policy.md`）

アップグレード時は `ensureWebxrVrOnUpgrade` により、既存環境では自動で有効行が追加されます。

## クライアント

- 登録: `public/js/addons/registry-game.js`
- 有効確認: `GET /api/addons/enabled` の `webxr-vr` フラグ
- 取得失敗・無効時は **XR を初期化しない**（コアのログイン・2D 入場は継続）

## コアとの境界

| コア | アドオン |
|------|----------|
| `lib/client-addon-registry.js` | `client/game.js` で registry 登録 |
| `character-controller` の movementDelegate | `movement-delegate.js` |
| `scene-manager` の graphics override | `init.js` で session 監視 |
| `app.isImmersivePresenting()` | `registerImmersiveStateProvider` |

## 実機テスト

HTTPS 必須。詳細は [docs/WEBXR_QUEST.md](../../docs/WEBXR_QUEST.md)。

## 障害時

アドオン init が失敗してもコアは動作します。VR だけ使えない状態は無停止定義の範囲内です。
