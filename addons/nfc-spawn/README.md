# nfc-spawn アドオン

ジオラマ等の NFC タグからメタバースの特定ワールド・座標へ入場するためのアドオンです。

## 概要

- URL 形式: `https://<host>/?spawn=<TOKEN>`（座標は URL に含めない）
- トークン → サーバー DB 参照 → ワールド + スポーン座標を返す
- 管理画面（サイドバー「NFCタグ」）でタグごとのスポーン地点を CRUD

## 有効化

1. 管理画面「アドオン」で `nfc-spawn` を有効化
2. **Node プロセスを再起動**

## HTTP API

### 公開

```http
GET /api/addons/nfc-spawn/spawn/:token
```

### 管理（Basic 認証）

| メソッド | パス |
|----------|------|
| GET | `/admin/addons/nfc-spawn/spawns` |
| POST | `/admin/addons/nfc-spawn/spawns` |
| PUT | `/admin/addons/nfc-spawn/spawns/:id` |
| DELETE | `/admin/addons/nfc-spawn/spawns/:id` |
| POST | `/admin/addons/nfc-spawn/spawns/:id/regenerate-token` |

## 設定（任意）

`addons/nfc-spawn/config.json`:

```json
{
  "publicBaseUrl": "https://meta.example.com"
}
```

NFC に焼く URL のホストを固定したい場合に指定。未設定時はリクエストヘッダから推定。

環境変数: `ADDON_NFC_SPAWN_PUBLIC_BASE_URL`

## データベース

`plugin-databases/nfc-spawn.db`（テーブル `nfc_spawns`）

管理画面「データベース」→ `plugin/nfc-spawn` からも閲覧可能。

## セキュリティ

- トークンは 128bit ランダム（base64url）
- 座標の URL 直書きテレポートは不可
- トークン URL を知っている人は利用可能（NFC 物理認証は別途）
