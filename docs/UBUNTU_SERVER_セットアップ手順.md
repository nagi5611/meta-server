# meta-server を Ubuntu Server 24 にクローンしてホストする手順

Ubuntu Server 24.04 LTS を 1 から入れた Linux PC に、本リポジトリをクローンしてサーバーを稼働させるまでの手引書です。

---

## 1. Ubuntu Server 24.04 のインストール

### 1.1 インストール媒体の準備

- **公式イメージ**: [Ubuntu Server 24.04 LTS](https://ubuntu.com/download/server) から ISO をダウンロードする。
- USB メモリに書き込む場合は [Rufus](https://rufus.ie/) や [balenaEtcher](https://etcher.balena.io/) を使用（Windows の場合）。

### 1.2 インストール時の選択

- 言語・キーボード: 任意
- **Install type**: 「Ubuntu Server」を選択
- **Storage**: デフォルト（Use an entire disk）でよい。LVM を使うかは任意。
- **Profile**: ユーザー名・パスワード・SSH の設定
  - **Import SSH identity**: 既存の公開鍵がある場合はここで読み込むと、パスワードログインなしにできる。
  - **Setup this disk as an encrypted LUKS container**: 必要に応じて有効化。
- **Featured Server Snaps**: 必須ではない。必要なら OpenSSH などは後から `apt install` でも可。

インストール完了後、メディアを抜いて再起動し、指定したユーザーでログインできることを確認する。

---

## 2. 初回ログイン後の基本設定

### 2.1 パッケージの更新

```bash
sudo apt update && sudo apt upgrade -y
```

### 2.2 ホスト名の設定（任意）

```bash
sudo hostnamectl set-hostname meta-server
```

### 2.3 固定 IP の設定（推奨）

DHCP のままだと IP が変わり、ルーターのポート転送先がずれる。必要なら `netplan` で固定 IP を設定する。

```bash
# 現在の Netplan 設定と「実際の NIC 名」を確認
ls /etc/netplan/
ip link show
```

**重要**: 固定 IP を設定するのは **実際に使っているインターフェース** だけ。  
例: `50-cloud-init.yaml` で `enp8s0` とあれば、固定化するのも **enp8s0**。別の名前（例: enp0s3）を書くと別 NIC 用になり、有線 LAN が enp8s0 のままだと 50 の DHCP が優先されたままになる。

編集（既存の cloud-init 用設定がある場合は、**数字の大きい方**のファイルで同じインターフェースを上書きする）:

```bash
sudo nano /etc/netplan/99-config.yaml
```

例（**enp8s0** は 50-cloud-init.yaml で使っている名前。実際のインターフェース名・ゲートウェイ・DNS は環境に合わせる）:

```yaml
network:
  version: 2
  ethernets:
    enp8s0:
      addresses:
        - 192.168.0.20/24
      routes:
        - to: default
          via: 192.168.0.1
      nameservers:
        addresses:
          - 8.8.8.8
          - 1.1.1.1
```

※ 50-cloud-init.yaml で `enp8s0: dhcp4: true` になっていても、99-config.yaml で同じ `enp8s0` を静的に書けば 99 が優先される。

適用:

```bash
# Netplan は設定ファイルのパーミッションが緩いと警告する。先に 600 にしておく。
sudo chmod 600 /etc/netplan/99-config.yaml
# または編集したファイル名に合わせる: sudo chmod 600 /etc/netplan/<ファイル名>.yaml

sudo netplan apply
```

**「Permissions are too open」と出た場合**: 上記の `chmod 600` を実行してから、再度 `sudo netplan apply` する。

### 2.4 ファイアウォール（ufw）の準備

後述の「ポート開放」のあとで有効化する。ここではインストールのみ。

```bash
sudo apt install -y ufw
```

---

## 3. Node.js とビルド環境のインストール

本プロジェクトは **better-sqlite3** と **mediasoup** でネイティブモジュールを使うため、ビルドツールが必要です。

### 3.1 ビルドに必要なパッケージ

```bash
sudo apt install -y build-essential python3-minimal git
```

### 3.2 Node.js のインストール

**mediasoup 3.19** は Node.js 22 以上を要求するため、Node.js 22 を推奨。

NodeSource で Node.js 22 を入れる:

```bash
# NodeSource 用の鍵とリポジトリ追加（Node.js 22.x）
sudo apt install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

sudo apt update
sudo apt install -y nodejs
```

確認:

```bash
node -v   # v22.x.x
npm -v
```

**既に Node.js 20 を入れている場合**: 上記で `node_22.x` を追加すると、`apt install nodejs` で 22 に上がる。`node -v` で 22.x であることを確認してから `npm ci` を実行する。

---

## 4. リポジトリのクローンとセットアップ

### 4.1 クローン

配置するディレクトリは任意。例: ホーム直下に `meta-server` としてクローン。

```bash
cd ~
git clone https://github.com/<あなたのユーザー名>/meta-server.git
cd meta-server
```

（GitHub の URL は実際のリポジトリ URL に置き換えてください。SSH の場合は `git@github.com:<ユーザー名>/meta-server.git` でも可。）

### 4.2 依存関係のインストールとビルド

```bash
npm ci
npm run build
```

`npm ci` で失敗する場合（ネットワークやビルドエラー）は、`npm install` を試す。

### 4.3 環境変数ファイル `.env` の作成

リポジトリには `.env` が含まれていません。手元で作成します。

```bash
cp .env.example .env
nano .env
```

`.env.example` がない場合は、次の内容をプロジェクト直下の `.env` に貼り付けて編集する。

```env
# 待ち受け
PORT=3000
HOST=0.0.0.0

# 本番で HTTPS を使う場合は 443 に変更（root または setcap が必要）
# PORT=443

# WebRTC（音声・ビデオ）で外部から接続する場合: このサーバーの公衆 IP またはドメイン
MEDIASOUP_ANNOUNCED_IP=

# Voice Chat 用 mediasoup UDP ポート範囲
VC_RTC_MIN_PORT=10000
VC_RTC_MAX_PORT=11000

# PDF ビューワー VC 用
PDF_VC_RTC_MIN_PORT=20000
PDF_VC_RTC_MAX_PORT=21000

# ビデオ VC 用
VIDEO_VC_RTC_MIN_PORT=30000
VIDEO_VC_RTC_MAX_PORT=31000
VIDEO_VC_MAX_PRODUCERS_PER_ROOM=10

# Cloudflare TURN（任意。未設定なら STUN のみ）
# CLOUDFLARE_TURN_API_TOKEN=
# CLOUDFLARE_TURN_KEY_ID=

# 管理画面の認証
ADMIN_USERNAME=admin
ADMIN_PASSWORD=

# 帯域制限（Mbps）
BANDWIDTH_LIMIT_MBPS=100

# HTTPS を使う場合（証明書を用意したあとで有効化）
# SSL_CERT_PATH=certs/fullchain.pem
# SSL_KEY_PATH=certs/privkey.pem
# PORT=443
# PORT_HTTP_REDIRECT=80
```

- `ADMIN_PASSWORD` は必ず強めのパスワードに変更する。
- 外部から WebRTC を使う場合は `MEDIASOUP_ANNOUNCED_IP` に **このサーバーの公衆 IP またはドメイン** を設定する。
- HTTPS で運用する場合は、次の「証明書の用意」のあとで `SSL_CERT_PATH` / `SSL_KEY_PATH` / `PORT=443` / `PORT_HTTP_REDIRECT=80` を有効化する。

---

## 5. 証明書の用意（HTTPS で運用する場合）

### 5.1 Let's Encrypt（推奨）

ドメインの A レコードがこの Ubuntu サーバーの公衆 IP を向いている前提です。

```bash
sudo apt install -y certbot
```

**注意**: `certbot certonly --standalone` を使う場合、**80 番ポートが空いている必要**があります。すでにアプリが 80 で動いている場合は停止するか、後述の「HTTP リダイレクト」を止める。

```bash
# 例: ドメインが meta.example.com の場合
sudo certbot certonly --standalone -d meta.example.com
```

証明書は次の場所に保存されます。

- 証明書: `/etc/letsencrypt/live/meta.example.com/fullchain.pem`
- 秘密鍵: `/etc/letsencrypt/live/meta.example.com/privkey.pem`

Node から読めるように、パスをそのまま `.env` に書くか、`certs/` にコピーする。

**方法 A: パスをそのまま .env に指定**

```env
SSL_CERT_PATH=/etc/letsencrypt/live/meta.example.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/meta.example.com/privkey.pem
PORT=443
PORT_HTTP_REDIRECT=80
```

Node を実行するユーザーに証明書の読取権限が必要です。

```bash
# 例: アプリユーザーが meta の場合
sudo chown -R meta:meta /etc/letsencrypt/archive
sudo chown -R meta:meta /etc/letsencrypt/live
```

**方法 B: プロジェクトの certs にコピー**

```bash
sudo cp /etc/letsencrypt/live/meta.example.com/fullchain.pem /etc/letsencrypt/live/meta.example.com/privkey.pem /home/<ユーザー名>/meta-server/certs/
sudo chown <ユーザー名>:<ユーザー名> /home/<ユーザー名>/meta-server/certs/*.pem
```

`.env` では:

```env
SSL_CERT_PATH=certs/fullchain.pem
SSL_KEY_PATH=certs/privkey.pem
PORT=443
PORT_HTTP_REDIRECT=80
```

**更新の自動化（cron）**

```bash
sudo crontab -e
```

### 方法 A の場合（Let’s Encrypt 証明書を `/etc/letsencrypt/live/` から直接参照）

毎日 3 時に証明書を自動更新し、サービスを再起動するだけでOKです（コピー・chown不要）。

例（crontabの設定）:

```
0 3 * * * certbot renew --quiet --deploy-hook "systemctl restart meta-server"
```

※ `systemctl restart meta-server` のみで、証明書ファイルのパーミッション設定やコピー作業は不要です（ただし、Nodeを実行するユーザーに `/etc/letsencrypt/live/` への読取権限があることを必ず確認してください）。

### 5.2 自己署名証明書（テスト用）

ドメインがなく、とりあえず HTTPS で試す場合:

```bash
cd ~/meta-server/certs
openssl req -x509 -newkey rsa:4096 -keyout privkey.pem -out fullchain.pem -days 365 -nodes -subj "/CN=localhost"
```

ブラウザでは「安全でない」と表示されますが、通信は暗号化されます。

---

## 6. 動作確認（手動起動）

```bash
cd ~/meta-server
npm run start:prod
```

- HTTP の場合: 同じマシンで `http://localhost:3000` を開く。
- HTTPS で 443 を使う場合: `https://localhost` または `https://<このサーバーのIP>`。

問題なければ Ctrl+C で止め、次で systemd サービス化する。

### 6.1 SSH でサーバー上の Node を終了させる方法

**systemd で動かしている場合**

```bash
sudo systemctl stop meta-server
```

状態確認: `sudo systemctl status meta-server`

**手動で起動したまま（別セッションやバックグラウンドで動いている場合）**

1. Node プロセスの PID を確認する:
   ```bash
   pgrep -af "node server.js"
   # または
   ps aux | grep "node server.js"
   ```
2. 表示された PID を指定して終了する:
   ```bash
   kill <PID>
   ```
   応答しない場合は強制終了:
   ```bash
   kill -9 <PID>
   ```

一括で終了する場合（`server.js` を実行している node だけ対象）:

```bash
pkill -f "node server.js"
```

---

## 7. systemd サービスで常時起動

### 7.1 サービスファイルの作成

```bash
sudo nano /etc/systemd/system/meta-server.service
```

次の内容を貼り付ける（`<ユーザー名>` と `meta-server` のパスは環境に合わせる）。

```ini
[Unit]
Description=meta-server (metaverse Node.js)
After=network.target

[Service]
Type=simple
User=<ユーザー名>
WorkingDirectory=/home/<ユーザー名>/meta-server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 7.2 有効化と起動

```bash
sudo systemctl daemon-reload
sudo systemctl enable meta-server
sudo systemctl start meta-server
sudo systemctl status meta-server
```

ログは `journalctl -u meta-server -f` で確認できる。

---

## 8. ファイアウォール（ufw）でポート開放

必要最小限だけ開放する。

| 用途           | ポート              | プロトコル |
|----------------|---------------------|------------|
| HTTP           | 3000（HTTPS を使わない場合） | TCP        |
| HTTPS          | 443                 | TCP        |
| HTTP→HTTPS 転送 | 80                  | TCP        |
| Voice Chat     | 10000–11000         | UDP        |
| PDF VC         | 20000–21000         | UDP        |
| Video VC       | 30000–31000         | UDP        |

例: HTTPS で 443/80 を使い、WebRTC も使う場合。

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 10000:11000/udp
sudo ufw allow 20000:21000/udp
sudo ufw allow 30000:31000/udp
sudo ufw enable
sudo ufw status
```

HTTP のみ（3000）の場合は:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
# WebRTC を使う場合のみ
sudo ufw allow 10000:11000/udp
sudo ufw allow 20000:21000/udp
sudo ufw allow 30000:31000/udp
sudo ufw enable
```

---

## 9. ルーターのポート転送（自宅サーバーの場合）

外部からアクセスするには、ルーターで上記のポートを **この Ubuntu サーバーのローカル IP** に転送する。

- 転送先: この PC の固定 IP（例: 192.168.1.100）
- 転送するポート: 80, 443（または 3000）, および UDP 10000–11000, 20000–21000, 30000–31000

ルーターの機種によって「ポート転送」「仮想サーバー」「NAT」などの項目で設定する。

---

## 10. トラブルシュート

### 10.1 サービスが起動しない

- `journalctl -u meta-server -n 50` でエラーを確認。
- `.env` のパス・権限（特に `SSL_*` のファイル）を確認。
- 443 を使う場合、root で動かすか `setcap 'cap_net_bind_service=+ep' $(which node)` で権限を付与する必要がある。サービスを root で動かすのは非推奨のため、setcap または 80/443 の代わりに 3000 で動かしてリバースプロキシで 443 に振る方法を推奨。

### 10.2 better-sqlite3 / mediasoup のビルドエラー

- `build-essential` と `python3-minimal` が入っているか確認。
- `node-gyp` のログを読む。Node.js は 22 以上（mediasoup 3.19 の要件）を推奨。

### 10.3 外部から WebRTC がつながらない

- `.env` の `MEDIASOUP_ANNOUNCED_IP` に **公衆 IP またはドメイン** が入っているか。
- ルーターで UDP ポート（10000–11000 など）が転送されているか。
- ufw で該当 UDP が開放されているか。

### 10.4 証明書の更新後も古い証明書が使われる

- certbot 更新後に `systemctl restart meta-server` を実行する（cron の deploy-hook に含めるとよい）。

---

## 11. まとめチェックリスト

- [ ] Ubuntu Server 24.04 インストール・更新
- [ ] 固定 IP（任意）・ホスト名（任意）
- [ ] build-essential, python3-minimal, git インストール
- [ ] Node.js 22（NodeSource）インストール
- [ ] リポジトリのクローン、`npm ci`、`npm run build`
- [ ] `.env` 作成（`ADMIN_PASSWORD` と必要に応じて `MEDIASOUP_ANNOUNCED_IP` を設定）
- [ ] HTTPS 用: 証明書の用意と `.env` の SSL_* / PORT 設定
- [ ] 手動で `npm run start:prod` の動作確認
- [ ] systemd サービス `meta-server.service` の作成・有効化
- [ ] ufw で必要なポートを開放
- [ ] 自宅の場合はルーターのポート転送を設定
- [ ] 外部端末（別ネットワーク）から HTTPS（または HTTP）でアクセス確認

以上で、Ubuntu Server 24 上で meta-server をホストできる状態になります。
