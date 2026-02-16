# Cloudflare TURN セットアップガイド

## 概要

このガイドでは、Cloudflare Realtime TURNをプロジェクトに統合する方法を説明します。

## 前提条件

- Cloudflareアカウント
- Cloudflare TURN/STUN APIへのアクセス権限

## セットアップ手順

### 1. Cloudflare APIトークンとキーIDを取得

Cloudflareダッシュボードから以下を取得：
- API Token (Bearer token)
- Key ID

### 2. 動作確認（オプション）

cURLでテスト：

```bash
curl \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 86400}' \
  https://rtc.live.cloudflare.com/v1/turn/keys/YOUR_KEY_ID/credentials/generate-ice-servers
```

成功すると、次のようなレスポンスが返されます：

```json
{
  "iceServers": [
    {
      "urls": [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.cloudflare.com:53"
      ]
    },
    {
      "urls": [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp"
      ],
      "username": "...",
      "credential": "..."
    }
  ]
}
```

### 3. 環境変数の設定

プロジェクトルートに `.env` ファイルを作成：

```bash
# Server Configuration
PORT=3000

# Cloudflare Realtime TURN Configuration
CLOUDFLARE_TURN_API_TOKEN=your-api-token-here
CLOUDFLARE_TURN_KEY_ID=your-key-id-here
```

**例**（実際の値に置き換えてください）：

```bash
PORT=3000

CLOUDFLARE_TURN_API_TOKEN=ca63b83a9f6160f51050a5a9d4cf269a02a3edbbc343ecaa9695a01eccd66abb
CLOUDFLARE_TURN_KEY_ID=3d1fd849b8c4c7a7554cb948c45128bc
```

### 4. サーバー起動

```bash
npm run dev
```

サーバーログで以下のメッセージを確認：

```
[VC] Cloudflare ICE servers fetched successfully
[VC] Using Cloudflare ICE servers
mediasoup VC enabled with X workers
```

## 動作の仕組み

### 自動更新

- サーバーは起動時にCloudflare APIからICEサーバー設定を取得
- 設定は24時間有効（TTL: 86400秒）
- サーバーは23時間後に自動的に再取得（1時間の余裕）
- キャッシュされた設定を使用するため、各クライアント接続でAPI呼び出しは発生しない

### フォールバック

API取得に失敗した場合：
- Google STUN (`stun:stun.l.google.com:19302`) を使用
- 基本的なNAT越えは可能だが、厳しいファイアウォール環境では接続できない場合がある

## トラブルシューティング

### API取得エラー

エラーログ: `Failed to fetch Cloudflare ICE servers`

**原因と対処**:
1. **APIトークンが間違っている**
   - `.env` ファイルの `CLOUDFLARE_TURN_API_TOKEN` を確認
   
2. **キーIDが間違っている**
   - `.env` ファイルの `CLOUDFLARE_TURN_KEY_ID` を確認

3. **ネットワークエラー**
   - サーバーがインターネットに接続できるか確認
   - プロキシ設定が必要な場合は設定

4. **レート制限**
   - Cloudflare APIのレート制限に達していないか確認
   - 通常、起動時と23時間ごとの呼び出しなので問題ないはず

### TURN接続の確認

ブラウザの開発者ツールで確認：

1. コンソールを開く
2. `[VC] ICE servers configured:` ログを探す
3. TURN URLが含まれているか確認

例：
```
[VC] ICE servers configured: [
  "stun:stun.cloudflare.com:3478",
  "turn:turn.cloudflare.com:3478?transport=udp",
  ...
]
```

### 接続テスト

WebRTC接続状態を確認：

1. ブラウザコンソールで `[VC] Send transport state:` または `[VC] Recv transport state:` を確認
2. 状態が `connected` になれば成功
3. 状態が `failed` の場合：
   - ファイアウォールでUDP 10000-10100が許可されているか確認
   - TURNが正しく設定されているか確認

## セキュリティ

### 認証情報の管理

- `.env` ファイルは `.gitignore` に含めること
- 本番環境では環境変数を直接設定（Heroku, AWS等）
- APIトークンは定期的にローテーション推奨

### TTL設定

- デフォルト: 86400秒（24時間）
- 短くすると: より頻繁な更新が必要、セキュリティ向上
- 長くすると: API呼び出し削減、セキュリティ低下

現在の設定（23時間でリフレッシュ）は、安全性と効率のバランスが取れています。

## コスト

Cloudflare TURN/STUN の料金：
- STUN: 無料
- TURN: データ転送量に応じて課金
  - 最初の 1TB: 無料
  - 以降: $0.05/GB

音声のみの場合、帯域使用量は比較的少ない（ユーザーあたり約50-100 kbps）ため、多くの場合は無料枠内で収まります。
