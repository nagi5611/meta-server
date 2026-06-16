# nfc-spawn アドオン

ジオラマ等の NFC タグからメタバースへ入場、またはスマホ専用 3D インスタンスを表示するアドオンです。

## 2 タイプ

| タイプ | URL | 説明 |
|--------|-----|------|
| **テレポート** | `https://<host>/?spawn=<TOKEN>` | フルメタバースの指定ワールド・座標へ入場 |
| **インスタンス** | `https://<host>/instance/?token=<TOKEN>` | A-Frame 閲覧専用（マルチプレイなし）。ベイク済み 3D のみ |

## 有効化

1. 管理画面「アドオン」で `nfc-spawn` を有効化
2. **Node プロセスを再起動**

## 管理画面（NFCタグ）

- 3D プレビューで位置を配置
- **インスタンス型**: ロード半径（球）を調整 → プレビュー確認 → **「インスタンスを生成 / 再ベイク」**（手動）
- ベイク完了後のみインスタンス URL が有効

## HTTP API

### 公開

```http
GET /api/addons/nfc-spawn/spawn/:token      # テレポート型のみ
GET /api/addons/nfc-spawn/instance/:token   # インスタンス型（ベイク済みのみ）
GET /api/addons/nfc-spawn/instance-assets/:spawnId/*
```

### 管理（Basic 認証）

| メソッド | パス |
|----------|------|
| GET/POST | `/admin/addons/nfc-spawn/spawns` |
| PUT/DELETE | `/admin/addons/nfc-spawn/spawns/:id` |
| POST | `/admin/addons/nfc-spawn/spawns/:id/regenerate-token` |
| POST | `/admin/addons/nfc-spawn/spawns/bake-preview` | 保存前でも座標・半径でプレビュー |
| POST | `/admin/addons/nfc-spawn/spawns/bake` | 保存＋ベイクを一括（`id` 任意） |
| GET | `/admin/addons/nfc-spawn/spawns/:id/bake-preview` | 既存行向け（レガシー） |
| POST | `/admin/addons/nfc-spawn/spawns/:id/bake` | 既存行向け（レガシー） |

## 設定（任意）

`addons/nfc-spawn/config.json`:

```json
{
  "publicBaseUrl": "",
  "maxBakeEntries": 1000,
  "instanceAssetsRateLimitMax": 10000,
  "maxBakeBytes": 104857600,
  "defaultModelRadius": 5
}
```

## ストレージ

- DB: `plugin-databases/nfc-spawn.db`
- インスタンス資産: `data/nfc-instances/{spawnId}/`（manifest.json + models/ + prefabs/）

## テスト

```bash
npm run test:nfc-spawn
```

## 手動テストチェックリスト

- [ ] テレポート型: `/?spawn=TOKEN` で入場・テレポート
- [ ] インスタンス型: 3Dで位置・半径を決めて **保存せず** プレビュー → 「インスタンスを生成 / 再ベイク」で一括保存
- [ ] インスタンス型: `/instance/?token=TOKEN` で A-Frame 表示
- [ ] インスタンス未ベイク時は API 404
- [ ] テレポートトークンで instance API は 404
- [ ] 半径変更・プレビュー除外・再ベイク
- [ ] タグ削除で `nfc-instances/{id}` も削除

## セキュリティ

- トークンは 128bit ランダム（base64url）
- トークン URL を知っている人は利用可能（NFC 物理認証は別途）
