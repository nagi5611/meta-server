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

EC2/ECS などでは `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` または IAM ロールで `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` が必要です。**起動時同期**は通常 **マニフェスト＋`GetObject`（マニフェスト1本）** で済みます。リモートにマニフェストがない初回など **レガシー同期**に落ちると、各ファイルの `HeadObject` のあと **孤児オブジェクト削除**用に **`s3:ListBucket`** を使います。`ListBucket` が IAM で拒否される場合も **起動は続行**し、孤児削除だけスキップしたうえでマニフェストを書きます（本体同期は MD5/Head で完了している前提）。

マニフェストは **`models/_meta/s3-sync-manifest.json`**（`META_MODELS_S3_PREFIX` がある場合は `prefix/_meta/s3-sync-manifest.json`）に置きます。`_meta/` 配下はモデル同期の走査対象外です。初回または S3 上のマニフェストが欠ける／壊れている場合のみ、従来どおり MD5 と Head で全件突き合わせたあと List で孤児を削り、マニフェストを書きます。差分同期は **パス＋ローカル mtime（ms）** の一致で判定します（同一 ms に内容だけ変えた場合は取りこぼすので、そのときは該当ファイルの `touch` か一度レガシー同期に戻す運用を想定）。

## AWS 側チェックリスト（要約）

1. **S3 バケット** — パブリックアクセスをすべてブロックする。
2. **CloudFront** — オリジンは上記バケット。オリジンアクセスは **Origin Access Control (OAC)** 推奨。
3. **バケットポリシー** — 下記「[バケットポリシー（CloudFront OAC）](#バケットポリシーcloudfront-oac)」を参照。**CloudFront から の `s3:GetObject` のみ**を書くことが多く、アプリの IAM（Put 等）は基本は **IAM ポリシー側だけ** で足ります（二重許可になるが同じバケットに書く場合は複数 Statement をマージ）。
4. **CloudFront キーペア** — AWS コンソールでキーペアを作成し、秘密鍵（PEM）を安全にサーバーへ配置（環境変数・Secrets Manager）。
5. **CORS（CloudFront のレスポンスヘッダー）** — モデルを読み込むメタバース側のオリジン（例: `https://game.example.com`）に対して、`GET` および `HEAD` メソッドの許可を設定します。Range リクエスト（部分取得）を使う場合は `Range` ヘッダーの許可も必要です。

<details>
<summary>CloudFront の動的レスポンスヘッダー例（カスタムヘッダー Behavior で追加）</summary>

```
Access-Control-Allow-Origin: https://game.example.com
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Range
```
（必要に応じて `OPTIONS` も追加、`Access-Control-Allow-Credentials` も用途により有効化）
</details>

なお、CloudFront の Distribution 設定に「レスポンスヘッダー（Response headers policy）」としてプリセット又はカスタムの CORS ポリシーを割り当てておく必要があります。S3 バケットポリシー（CORS ルール）は CloudFront オリジン直アクセス時しか効かず、通常は CloudFront 側の設定だけで十分です。

6. **検証手順の例** — 下記:

```bash
# オブジェクトがある前提で、署名なし GET が 403 であること
curl -sI 'https://<distribution>/models/test.glb' | head -n 5

# アプリ経由で発行した署名付き URL なら 200 （サーバー側で確認）
```

## バケットポリシー（CloudFront OAC）

バケットが**非公開**でも、CloudFront ディストリビューション経由でオブジェクトを配信するには、**バケットポリシー**で **`cloudfront.amazonaws.com` に `s3:GetObject` を許可**します。OAC をディストリビューションに関連付けたあと、コンソールから **推奨ポリシーをコピー**する方法が公式に案内されています（手動で書く場合は下記の形）。

### 役割の切り分け

| 種類 | どこに書くか | 何のためか |
|------|----------------|------------|
| メタバースサーバー（アップロード・同期） | **IAM ユーザー／ロールに付ける IAM ポリシー** | `PutObject` / `GetObject`（HEAD 含む）/ `DeleteObject` |
| 閲覧者向け CDN | **S3 バケットポリシー**の Statement | CloudFront（OAC）だけがオブジェクトを読めるようにする |

※ サーバー用の権限をバケットポリシーにも重ねて書く必要は**必須ではありません**（IAM 側で足りる）。既存 Statement とマージする場合は JSON を一つにまとめます。

### アップロード用 IAM に ListBucket（任意・孤児削除）

最小権限の Put/Get/Delete のみの IAM だと、**レガシー同期**時の `ListObjectsV2` が `AccessDenied` になります。その場合でもアプリは **警告を出して続行**し、**マニフェストは書き込みます**。S3 上にマニフェストに載らない古いキーを掃除したいときだけ、バケット ARN に対する `ListBucket` を次のように **プレフィックス条件付き**で足してください（`YOUR_BUCKET_NAME`・`META_MODELS_S3_PREFIX` に合わせる。既定プレフィックスなら `models/*`）。

```json
{
  "Sid": "ListBucketForModelSyncOrphanCleanup",
  "Effect": "Allow",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME",
  "Condition": {
    "StringLike": {
      "s3:prefix": ["models/*"]
    }
  }
}
```

### 例（OAC 用・CloudFront からの GET のみ）

`YOUR_ACCOUNT_ID`・`YOUR_BUCKET_NAME`・`YOUR_DISTRIBUTION_ID` を置き換えます。`AWS:SourceArn` は **その CloudFront ディストリビューションにだけ**効くよう固定します。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

- ディストリビューションを複数から同じバケットを読む場合は `Condition` を `ArnLike` + 配列にする、または Statement を分ける、などが必要です。
- 設定手順の詳細は AWS 公式ドキュメントを参照: [CloudFront の読み取り専用権限をオリジンの S3 バケットポリシーに付与する（OAC）](https://docs.aws.amazon.com/ja_jp/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)。

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
| `AccessDenied` の `s3:ListBucket` | 孤児削除だけ失敗。起動・マニフェスト書き込みは継続。孤児を掃除するなら「ListBucket（任意・孤児削除）」の IAM 例を追加 |

## 参考（公式）

- [S3 オリジンへのアクセスを OAC で制限する](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront — Range GETs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RangeGETs.html)
- [S3 と CloudFront での静的コンテンツ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
