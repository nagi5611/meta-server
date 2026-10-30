# mmh-health-check

家メタバース（`*.mmh-virtual.jp`）向け HTTPS ヘルスチェック Worker。

## 監視

- `https://meta.mmh-virtual.jp/`
- `https://metair.mmh-virtual.jp/`
- `https://metadogo.mmh-virtual.jp/`
- `https://metapre.mmh-virtual.jp/`

5 分 cron。TLS エラーまたは HTTP 200 以外で失敗。失敗通知は **障害ごとに初回は即時**、継続失敗中は **最大 1 時間に 1 回**（KV `HEALTH_STATE`）。復旧後の次の失敗は再び初回扱い。

## デプロイ

```bash
cd workers/mmh-health-check
npm install
npx wrangler login
npx wrangler secret put WEBHOOK_URL
npx wrangler deploy
```

手動確認: デプロイ後の `https://<worker>.<subdomain>.workers.dev/run`

## 環境変数

| 名前 | 種別 | 説明 |
|------|------|------|
| `WEBHOOK_URL` | **Secret**（推奨） | 失敗通知先 HTTPS エンドポイント |

Webhook JSON 例:

```json
{
  "url": "https://metadogo.mmh-virtual.jp/",
  "status": null,
  "error": "...",
  "timestamp": "2026-10-31T00:00:00.000Z",
  "source": "mmh-health-check",
  "alert": "health_check_failed"
}
```
