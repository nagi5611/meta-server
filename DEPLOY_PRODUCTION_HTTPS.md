# 本番公開（mmh-virtual.jp / HTTPS）手順メモ

このドキュメントは、`metaverse-simple` を **外部（グローバル）から `https://mmh-virtual.jp` でアクセス**できるようにするための、最低限の手順と注意点です。

## 重要（先に確認が必要）

- **このリポジトリの音声通話は mediasoup を使うため、サーバー側で UDP/TCP ポート（例: 10000-10100）を外部から到達可能にする必要があります。**
- **Xserver の契約プラン（共有レンタル / VPS / 専用）によって、Node.js 常駐や任意ポート開放ができるかが変わります。**
  - この点は、このリポジトリだけでは判断できません（= ここでは断定しません）。

## 1) DNS（ドメインをサーバーへ向ける）

- `mmh-virtual.jp` の **Aレコード**を、実際にサーバーが動く **グローバルIP**へ向けます。
- 既に Web サイトを Xserver のサーバー領域で公開している場合は、その構成に合わせてください（DNS の向き先が変わると他サービスに影響します）。

## 2) HTTPS（SSL）を有効化する

### 2-1) Xserver の「無料独自SSL」を使う場合

- Xserver のマニュアルに従って SSL を有効化します。
- 出典: Xserver マニュアル（独自SSL） `https://www.xserver.ne.jp/manual/man_server_ssl.php`

### 2-2) それ以外（VPS等）で Let’s Encrypt / Nginx / Caddy を使う場合

- ここは環境依存なので、このリポジトリでは手順を固定しません。
- ただし **Socket.io（WebSocket）を使うため、リバースプロキシ構成では WebSocket の Upgrade を通す設定が必須**です。

## 3) Node.js アプリ（server.js）の公開方法

このプロジェクトのクライアントは本番時、Socket.io の接続先として `window.location.origin` を使用します（= `https://mmh-virtual.jp` で配信するなら同一オリジンに揃う設計）。

そのため、一般的には次のどちらかになります。

- **方式A（推奨されることが多い）**: 443 は Nginx/Apache/Caddy 等で TLS 終端し、Node.js（`PORT=3000` など）へリバースプロキシする
- **方式B**: Node.js 自体が TLS を持って 443 で待ち受ける

※ このリポジトリの `server.js` は現状 **HTTP サーバー起動**です（方式A向き）。

## 4) mediasoup の本番必須設定（announcedIp）

本番では、mediasoup がクライアントに返す ICE candidate に **外部から到達可能なアドレス**を載せる必要があります。

このリポジトリでは、以下の環境変数で指定できるようにしてあります。

```bash
# 例: ドメイン、またはグローバルIP
MEDIASOUP_ANNOUNCED_IP=mmh-virtual.jp

# 本番では localhost 候補は不要（OFF 推奨）
MEDIASOUP_ENABLE_LOCALHOST=0

# 例: Node.js の待受ポート（リバプロで 443→3000 の場合）
PORT=3000
NODE_ENV=production
```

出典（mediasoup の announced address / listen info の概念）:
- `https://mediasoup.org/documentation/v3/mediasoup/api/`

## 5) TURN（Cloudflare TURN）を本番で使う場合

`.env` または本番環境変数で以下を設定します（未設定でも STUN のみで動作はします）。

```bash
CLOUDFLARE_TURN_API_TOKEN=your_token
CLOUDFLARE_TURN_KEY_ID=your_key_id
```

出典（Cloudflare TURN）:
- `https://developers.cloudflare.com/realtime/turn/`

## 6) 必要なポート（要: ファイアウォール/セキュリティグループ設定）

- **TCP 443**: HTTPS（Web / Socket.io を含む）
- **TCP 80**: HTTP → HTTPS リダイレクト用（運用方針による）
- **UDP/TCP 10000-10100**: mediasoup（`rtcMinPort`/`rtcMaxPort` に合わせる）

※ ここはホスティング/ネットワークに依存します。到達性は必ず外部から確認してください。

## 7) 動作確認チェックリスト（最低限）

- ブラウザで `https://mmh-virtual.jp` が証明書エラー無しで開く
- 2台（例: PC と スマホLTE）でアクセスし、同じルームで通話できる
- サーバーログに以下が出る
  - `mediasoup VC enabled ...`
  - `Cloudflare ICE servers fetched successfully`（TURN を設定した場合）
- クライアントコンソールで以下が connected になる
  - `[VC SEND] 🔌 Transport connection state: connected`
  - `[VC RECV] 🔌 Transport connection state: connected`

