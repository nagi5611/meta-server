# time-machine

バックアップとロールバック用 addon。マウント HDD へ **hourly 状態** / **daily フル** を保存し、管理画面から復元できます。

## 有効化

1. 管理画面 `/admin.html` → **アドオン** で `time-machine` を有効化
2. **Node プロセスを再起動**（[docs/addons-restart-policy.md](../../docs/addons-restart-policy.md)）

## 環境変数

| 変数 | 説明 |
|------|------|
| `ADDON_TIME_MACHINE_MOUNTS` | `hdd-01:/mnt/hdd-01,hdd-02:/mnt/hdd-02` 形式 |
| `ADDON_TIME_MACHINE_ROLLBACK_PIN` | ロールバック時に必須の PIN（未設定時はロールバック不可） |
| `ADDON_TIME_MACHINE_SYSTEMD_SERVICE_NAME` | 既定 `metaverse-simple` |

## 本番サーバー要件

- `sqlite3` CLI（hourly の DB バックアップ）
- `rsync`（推奨。ロールバック復元にも使用）
- `META_SRC_DIRECTORY` 設定推奨
- マウント先への書き込み権限

## バックアップ先

```
{mount}/metaverse-simple/{hostname}/{hourly|daily}/{snapshotId}/
  manifest.json
  data/   … hourly
  db/     … *.db.bak（SQLite backup API）
  env/    … .env
  src/    … daily（META_SRC_DIRECTORY ミラー）
```

## ストレージ役割

管理画面 **タイムマシン** タブで各マウントに `hourly` / `daily` / `both` / `off` を割り当て。世代数・daily 実行時刻（既定 03:00）も変更可。

## 即時バックアップ

| scope | 内容 |
|-------|------|
| `state` | data + db + .env |
| `addons` | `addons/` |
| `server_src` | `META_SRC_DIRECTORY` |
| `full` | server_src + .env |

## ロールバック後の運用

1. 自動: `systemctl stop` → ファイル復元 → `systemctl start`
2. 起動時に S3 がローカルへ同期（`USE_S3_MODELS=1` 時）
3. **手動:** 管理画面の **アセット CDN を無効化**（CloudFront）。ロールバック直後はキャッシュが古い／新しい内容とずれる場合があります

## セキュリティ

バックアップに `.env`（秘密鍵・API キー）が含まれます。マウント HDD のアクセス制御を厳格にしてください。
