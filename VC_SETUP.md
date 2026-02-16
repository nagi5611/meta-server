# Voice Chat (VC) Setup Guide

## 概要

mediasoupを使用した音声のみのボイスチャット機能が実装されています。

## 主な機能

- **自動参加**: ルーム入室時に自動的にVCに参加
- **初期状態**: マイクOFF（ミュート）、スピーカーON
- **同時発話制限**: 同時にマイクONにできるのは最大10人まで（サーバー側でハード制限）
- **ルーム切替**: world切替（lobby↔school）でVCも自動的に切り替わる
- **軽量化**: マイクOFF時はsendTransportごと破棄、スピーカーOFF時はrecvTransportごと破棄

## 使用方法

### メニューバーのボタン

- **マイクボタン**: クリックでマイクON/OFF切替
  - ミュート状態（デフォルト）: マイクアイコンに斜線
  - アンミュート状態: 通常のマイクアイコン
  - 制限: 同時に10人までマイクON可能（11人目は拒否され、通知が表示される）

- **スピーカーボタン**: クリックでスピーカーON/OFF切替
  - スピーカーOFF時: 他の参加者の音声が聞こえなくなり、受信トラフィックも削減
  - スピーカーON時（デフォルト）: 他の参加者の音声が聞こえる

## サーバー設定

### 基本設定

サーバーは自動的に以下を設定します：

- **Worker数**: CPUコア数（最大4）
- **ポート範囲**: デフォルト 10000-10100 (UDP)。`.env` の `VC_RTC_MIN_PORT` / `VC_RTC_MAX_PORT` で変更可能
- **PDFビューワーVC**: 別ポート範囲 デフォルト 20000-20100 (UDP)。`.env` の `PDF_VC_RTC_MIN_PORT` / `PDF_VC_RTC_MAX_PORT` で変更可能（同じPDFを開いている人だけの通話用）
- **コーデック**: Opus (48kHz, 2ch)
- **最大帯域**: 150kbps (audio)

### 本番公開（HTTPS / 外部アクセス）で追加で必要な設定

本番で外部ネットワークから WebRTC を成立させるため、mediasoup の `announcedIp` を環境変数で指定できます：

```bash
# 例: 公開ドメイン、またはグローバルIP
MEDIASOUP_ANNOUNCED_IP=mmh-virtual.jp

# 本番では localhost 候補は不要（OFF 推奨）
MEDIASOUP_ENABLE_LOCALHOST=0

NODE_ENV=production
PORT=3000

# VC UDP port range (optional, default: 10000-10100)
# VC_RTC_MIN_PORT=10000
# VC_RTC_MAX_PORT=10100

# PDF Viewer VC UDP port range (optional, default: 20000-20100)
# PDF_VC_RTC_MIN_PORT=20000
# PDF_VC_RTC_MAX_PORT=20100
```

出典（mediasoup の announced address / listen info の概念）:
- `https://mediasoup.org/documentation/v3/mediasoup/api/`

本番公開手順の全体像は `DEPLOY_PRODUCTION_HTTPS.md` を参照してください。

### Cloudflare TURN設定（オプション）

NAT/ファイアウォール越えのために、Cloudflare Realtime TURNを使用できます。

#### 自動取得（推奨）

環境変数を設定してください：

```bash
CLOUDFLARE_TURN_API_TOKEN=your-api-token
CLOUDFLARE_TURN_KEY_ID=your-key-id
```

サーバーは起動時とその後24時間ごとに自動的にCloudflare APIからICEサーバー設定を取得します。

**取得方法**:

```bash
curl \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 86400}' \
  https://rtc.live.cloudflare.com/v1/turn/keys/YOUR_KEY_ID/credentials/generate-ice-servers
```

#### フォールバック

設定されていない場合は、Google STUNのみが使用されます（基本的なNAT越えには対応）。

## アーキテクチャ

### サーバー側 (server.js)

- **mediasoup Workers**: CPUコアごとのメディア処理プロセス
- **Router per Room**: ルームごとに独立したRouter
- **Peer管理**: socket.idごとにtransport/producer/consumerを管理
- **同時発話制限**: ルームごとに最大10人のアクティブProducerをハード制限
- **PDF Viewer VC**: 別ワーカー群（ポート範囲 20000-20100 等）。PDFルームID（`pdf:`+pdfPath）ごとにRouter。同じPDFを開いているソケットのみが参加

### クライアント側 (public/js/)

- **VoiceChatManager**: mediasoup-clientのラッパー
  - Transport生成/管理
  - Producer/Consumer管理
  - マイク/スピーカー制御
- **MenuManager連携**: UI操作をVCに反映
- **自動ルーム切替**: WorldManager連動

### シグナリング (Socket.io)

- `vc-join`: ルーム参加
- `vc-create-transport`: Transport作成
- `vc-connect-transport`: Transport接続
- `vc-set-mic`: マイクON/OFF（max10チェック）
- `vc-produce-audio`: Audio Producer作成
- `vc-set-speaker`: スピーカーON/OFF
- `vc-consume`: Consumerを作成
- `vc-consumer-resume`: Consumer再開
- `vc-leave`: VC退出

## トラブルシューティング

### 音声が聞こえない

1. スピーカーがONになっているか確認
2. ブラウザのコンソールでエラーがないか確認
3. 他の参加者がマイクONにしているか確認

### マイクがONにできない

1. 同時マイクON数が10人を超えていないか確認（通知が表示される）
2. ブラウザのマイク権限が許可されているか確認
3. 他のアプリケーションがマイクを使用していないか確認

### 接続が不安定

1. Cloudflare TURNが設定されているか確認
2. VC用UDPポート（ルームVC: 10000-10100、PDF VC: 20000-20100。それぞれ `VC_RTC_*` / `PDF_VC_RTC_*` で変更可）がファイアウォールで許可されているか確認
3. ネットワーク帯域が十分か確認（音声のみで最低150kbps推奨）

## パフォーマンス

### 帯域使用量（目安）

- **マイクON（送信）**: 約50-100 kbps
- **スピーカーON（受信）**: 約50-100 kbps × アクティブスピーカー数（最大10人）
- **最大**: 約1 Mbps（10人全員が同時発話の場合）

### スケーラビリティ

- **推奨**: ルームあたり100人まで（同時発話最大10人）
- **上限**: ルームあたり1000人（理論値、同時発話10人制限必須）

## 開発情報

### 依存関係

- `mediasoup`: ^3.x (サーバー側SFU)
- `mediasoup-client`: ^3.x (クライアント側WebRTC)
- `socket.io`: ^4.x (シグナリング)

### ファイル構成

```
server.js                           # mediasoup統合、VCシグナリング
public/js/voice-chat-manager.js           # ルームVC管理
public/js/pdf-viewer-voice-chat-manager.js # PDFビューワー専用VC管理
public/js/main.js                         # VC初期化、ルーム連動・PDF open/close で join/leave
public/js/menu-manager.js                 # マイク/スピーカーボタン連携
public/js/pdf-viewer-manager.js           # PDFビューワー内マイク/スピーカーボタン連携
```
