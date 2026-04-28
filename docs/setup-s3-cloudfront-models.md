# S3 + CloudFront で 3D モデルを配送する（セットアップ）

本番（`NODE_ENV=production`）で `USE_S3_MODELS=1` のとき、サーバーはモデルをローカル `models/` に保存したうえで同一キーへ S3 にアップロードし、参照用の URL は CloudFront ドメインを使います。クライアントは短命の **署名付き HTTPS URL** で CDN を取得し、失敗時は **同一オリジン**の `/models/`（Socket 認証 Cookie または管理者 Basic）へフォールバックします。

## 必要な環境変数（アプリ）

| 変数 | 説明 |
|------|------|
| `USE_S3_MODELS` | `1` / `true` 等で本番 S3 連携を有効 |
| `NODE_ENV` | `production`（開発では S3 無効） |
| `AWS_REGION` | 例: `ap-northeast-1` |
| `META_MODELS_S3_BUCKET` | プライベート S3 バケット名 |
| `META_MODELS_S3_PREFIX` | （任意）オブジェクトキーの接頭辞。既定 `models` |
| `META_CDN_PUBLIC_BASE` または `CLOUDFRONT_BASE_URL` | `https://distribution-id.cloudfront.net/optional-prefix`（末尾スラッシュ不要） |
| `CLOUDFRONT_KEY_PAIR_ID` | CloudFront キーペアの ID |
| `CLOUDFRONT_PRIVATE_KEY` | PEM 本文（改行は `\n` でも可）。または `CLOUDFRONT_PRIVATE_KEY_PATH` でファイルパス |
| `CLOUDFRONT_SIGN_EXPIRES_SECONDS` | （任意）署名 URL 有効時間。既定 900 |

EC2/ECS などでは `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` または IAM ロールで `s3:PutObject` / `s3:GetObject` / `s3:ListBucket` / `s3:DeleteObject` が必要です。

## AWS 側チェックリスト（要約）

1. **S3 バケット** — パブリックアクセスをすべてブロックする。
2. **CloudFront** — オリジンは上記バケット。オリジンアクセスは **Origin Access Control (OAC)** 推奨。
3. **バケットポリシー** — Put/Get は運用 IAM のみ許可。**CloudFront からの読み取りのみ**許可したポリシー（OAC 用）。
4. **CloudFront キーペア** — AWS コンソールでキーペアを作成し、秘密鍵（PEM）を安全にサーバーへ配置（環境変数・Secrets Manager）。
5. **CORS（CloudFront 応答）** — メタバースのオリジン（例 `https://game.example.com`）に対して `GET`/`HEAD` を許可。必要なら `Range`。
6. **検証手順の例**

```bash
# オブジェクトがある前提で、署名なし GET が 403 であること
curl -sI 'https://<distribution>/models/test.glb' | head -n 5

# アプリ経由で発行した署名付き URL なら 200 （サーバー側で確認）
```

## ワールドデータのパス書き換え

既存 `worlds.json` の `models/...` 相対パスを CDN 絶対 URL に置き換える場合:

```bash
node scripts/migrate-world-models-to-cdn.mjs ./data/worlds.json https://dxxxxxxxx.cloudfront.net/prod
```

実行前にスクリプトが `.bak.<timestamp>` バックアップを作成します。

## トラブルシュート

| 現象 | 確認 |
|------|------|
| 署名 API 503 | `isS3ModelsConfigComplete()` に必要な環境変数が揃っているか |
| CDN GET CORS | CloudFront が `Access-Control-Allow-Origin` を返しているか、アプリ Origin と一致させるか |
| `/models/` 403 | メタバースにログイン済み Cookie か、`Authorization: Basic` 管理画面ログイン状態か |

## 参考（公式）

- [CloudFront — Range GETs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RangeGETs.html)
- [S3 と CloudFront での静的コンテンツ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
