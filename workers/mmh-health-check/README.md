# mmh-health-check

家メタバース（`*.mmh-virtual.jp`）向け HTTPS ヘルスチェック Worker。

## 監視

- `https://meta.mmh-virtual.jp/`
- `https://metair.mmh-virtual.jp/`
- `https://metadogo.mmh-virtual.jp/`
- `https://metapre.mmh-virtual.jp/`

5 分 cron。TLS エラーまたは HTTP 200 以外で **1 回目が失敗したとき、15 秒間隔であと 2 回リトライ**（合計 3 回）。3 回とも失敗したときだけ障害扱い（一瞬の不通による誤検知を抑える）。失敗通知は **障害ごとに初回は即時**、継続失敗中は **最大 1 時間に 1 回**（KV `HEALTH_STATE`）。復旧後の次の失敗は再び初回扱い。

JSON レポートの各 URL に `attempts`（成功・失敗までに使った試行回数）が付く。

**526 /「オリジン SSL 無効」:** Cloudflare プロキシ経由時の表示。直結 nginx 構成では **nginx 停止**（証明書パス欠落で `nginx -t` 失敗など）も TLS 不通として検知される。再発防止は [docs/ops-certbot-nginx.md](../../docs/ops-certbot-nginx.md) を参照。

## デプロイ

```bash
cd workers/mmh-health-check
npm install
# Cloud Agent / CI: CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を設定
# 初回のみ: npx wrangler login または npx wrangler secret put WEBHOOK_URL
npx wrangler deploy
```

本番 URL 例: `https://mmh-health-check.harumacci94.workers.dev/run`（`wrangler.toml` に本番 KV / cron を記載）

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
