# nginx（TLS 終端・リバースプロキシ）

クライアントは **443/80 で nginx に接続**し、nginx が **HTTP で Node（meta-server）** に転送する構成の手順と設定例です。  
**Caddy / Traefik 等を使う場合は別途設定が必要**です（本リポジトリでは nginx 用ファイルのみ用意しています）。

## 前提

- DNS の A レコードがサーバーの公衆 IP を向いている。
- 本アプリは **Socket.io（WebSocket / 長輪詢）** を使うため、プロキシで **Upgrade** を通す必要がある（設定例に含む）。
- Node 側は `USE_REVERSE_PROXY=1` とし、**TLS は Node で張らない**（詳細は下表）。

## Node（`.env`）と nginx の対応

| 項目 | nginx | Node（`.env`） |
|------|--------|----------------|
| 外向き HTTPS | `listen 443 ssl`、証明書は `/etc/letsencrypt/...` | `USE_REVERSE_PROXY=1`（`SSL_*` は未使用） |
| バックエンド | `proxy_pass http://127.0.0.1:PORT` | `HOST=127.0.0.1` 推奨（同一マシン時） |
| ドメインとポート | `server_name` と `proxy_pass` のポートを一致させる | `PROXY_DOMAIN_PORT_MAP` と `PROXY_SERVICE_DOMAIN` で同じ対応を明示 |

例（meta を 3000、metair を 3001）:

- **meta 用プロセス**  
  `USE_REVERSE_PROXY=1`  
  `PROXY_DOMAIN_PORT_MAP=meta.mmh-virtual.jp=3000,metair.mmh-virtual.jp=3001`  
  `PROXY_SERVICE_DOMAIN=meta.mmh-virtual.jp`  
  （`PORT` は省略可。マップから 3000 になる）

- **metair 用プロセス**  
  同じマップを書き、  
  `PROXY_SERVICE_DOMAIN=metair.mmh-virtual.jp`  
  （待受 3001）

- **nginx**  
  `meta.mmh-virtual.jp` → `127.0.0.1:3000`  
  `metair.mmh-virtual.jp` → `127.0.0.1:3001`  

`TRUST_PROXY=1` を付けると Express が `X-Forwarded-*` を信頼します（未設定でも `USE_REVERSE_PROXY` 時は既定で 1 ホップ信頼）。

## アップロードサイズ

`server.js` では譜面 BGM など **最大約 80MB**、3D モデルアップロードは **最大 200MB** のため、設定例では `client_max_body_size 200m` としています。

## インストール（Ubuntu 例）

```bash
sudo apt update
sudo apt install -y nginx
```

## 設定ファイルの配置

リポジトリ内の例をサーバーへコピーし、ドメイン・ポート・証明書パスを編集します。

```bash
cd /path/to/metaverse-simple   # クローン先

sudo cp nginx/snippets/metaverse-proxy-headers.conf.example /etc/nginx/snippets/metaverse-proxy-headers.conf
sudo cp nginx/sites-available/metaverse-proxy.conf.example /etc/nginx/sites-available/metaverse-proxy.conf
sudo nano /etc/nginx/sites-available/metaverse-proxy.conf
```

有効化と構文チェック:

```bash
sudo ln -sf /etc/nginx/sites-available/metaverse-proxy.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

デフォルトサイトが干渉する場合は `sites-enabled/default` を無効化します。

```bash
sudo rm /etc/nginx/sites-enabled/default   # または unlink
sudo nginx -t && sudo systemctl reload nginx
```

## Let’s Encrypt（certbot）

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### nginx プラグイン（推奨・初回）

設定の `server_name` と `listen 80` が合っている状態で:

```bash
sudo certbot --nginx -d meta.mmh-virtual.jp -d metair.mmh-virtual.jp
```

ドメインごとに別証明書にする場合は、`-d` を分けて複数回実行し、各 `server { ssl_certificate ... }` を certbot が出力したパスに合わせます。  
**1 枚の SAN 証明書**にまとめた場合は、両方の `server` ブロックで **同じ** `fullchain.pem` / `privkey.pem` を指します。

### 更新後の reload

```bash
sudo systemctl reload nginx
```

`certbot renew` のフックで `systemctl reload nginx` を呼ぶのが一般的です。

## ファイアウォール（ufw 例）

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

WebRTC（mediasoup）用の **UDP/TCP の VC ポート範囲**は別途開ける必要があります。プロジェクトの `VC_*` / `VIDEO_*` / `PDF_*` と [DEPLOY_PRODUCTION_HTTPS.md](../DEPLOY_PRODUCTION_HTTPS.md) を参照してください。

## ホスト監視ダッシュボード（任意）

別ホスト名（例: `http://nagi-s1.f5.si/`）から **systemd のユニット状態を表示し、停止中なら Web から起動**できる機能があります。

### 全体のイメージ（先にこれだけ読む）

- **ブラウザ** → **nginx**（例: `nagi-s1.f5.si`）→ **meta 用の Node**（例: ポート 3000）の **`/host-monitor/`** というページ。
- そのページが **「どのサービスが動いてるか」** を表示し、止まっていれば **起動ボタン**で `systemctl start` を試す。
- **metair 用の Node（3001）** にはこの画面は載っていない。**必ず meta 用 Node が動いているマシン・ポート**に nginx を向ける。

---

### ステップバイステップ（初めてのとき）

**ステップ 0: ユニット名を調べる**

ターミナルで次を実行し、**自分の PC で使っているサービス名**をメモする。

```bash
systemctl list-units --type=service --state=running | grep -E 'meta|nginx'
# または
systemctl status meta-server
```

例では `meta-server.service` と `nginx.service` と書く。metair を別サービスで動かしているなら `metair-server.service` のように **実際の名前**をメモする。

---

**ステップ 1: `.env` に 1 行足す（meta 用 Node のディレクトリで）**

`~/meta-server/.env` など、**いつも `npm run start:prod` する meta 側**のファイルを開く。

次の 1 行を追加する（カンマ区切りで、ステップ 0 でメモした名前を並べる）。

```env
HOST_MONITOR_UNITS=meta-server.service,nginx.service
```

- ここに書いた名前だけ、Web 画面に出て、起動ボタンも押せる。
- この行が **無い／空**のとき、**ホスト監視機能は無効**（URL も出ない）。

---

**ステップ 2: 「起動」ボタン用に sudo を許可する**

Web から起動するとき、Node は内部で **`sudo -n systemctl start ユニット名`** を実行する。  
`-n` は **パスワードを聞かない**ので、**あらかじめ sudoers でだけ許可**する。

1. サーバーで `sudo visudo` を実行する（エディタが開く）。
2. **ファイルの末尾**に、次のような **1 行**を追加する（`nagi` は **Node を実行している Linux ユーザー名**に置き換える）。

```text
nagi ALL=(ALL) NOPASSWD: /bin/systemctl start meta-server.service, /bin/systemctl start nginx.service
```

- **`HOST_MONITOR_UNITS` に書いた各ユニット**について、上の行にも **`/bin/systemctl start その名前`** を **カンマ区切り**で足す。
- 例: metair も足すなら  
  `..., /bin/systemctl start metair-server.service`  
  のように続ける。

保存して終了。ここを間違えると「起動」ボタンだけ失敗する（状態表示は動くことが多い）。

---

**ステップ 3: nginx に「nagi-s1 用」の設定を入れる**

目的: ブラウザで `http://nagi-s1.f5.si/` を開くと、**中身は meta 用 Node の `/host-monitor/`** につながるようにする。

1. リポジトリの [sites-available/nagi-s1-f5si.conf.example](sites-available/nagi-s1-f5si.conf.example) をサーバーにコピーする。例:

   ```bash
   sudo cp /home/nagi/meta-server/nginx/sites-available/nagi-s1-f5si.conf.example /etc/nginx/sites-available/nagi-s1-f5si.conf
   ```

2. `sudo nano /etc/nginx/sites-available/nagi-s1-f5si.conf` で **`proxy_pass http://127.0.0.1:3000;`** の **3000** を、**meta 用 Node が実際に listen しているポート**に合わせる（`.env` の `PORT` や `PROXY_SERVICE_DOMAIN` の結果と同じ）。

3. 有効化して nginx を再読み込みする。

   ```bash
   sudo ln -sf /etc/nginx/sites-available/nagi-s1-f5si.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. DNS で **`nagi-s1.f5.si` がこのサーバーの IP** を向いていることを確認する（さくらの DNS など）。

---

**ステップ 4: コードを反映して Node を再起動**

1. サーバー上で **git pull** など、ホスト監視機能が入ったコードに更新する。
2. 本番で `dist` を使っているなら、プロジェクト直下で **`npm run build`** を実行する。
3. meta 用の Node を再起動する（例）。

   ```bash
   sudo systemctl restart meta-server
   ```

---

**ステップ 5: 動作確認**

1. ブラウザで `http://nagi-s1.f5.si/` を開く → **`/host-monitor/` にリダイレクト**される。
2. **ADMIN のユーザー名・パスワード**（`.env` の `ADMIN_USERNAME` / `ADMIN_PASSWORD`）を聞かれたら入力する。
3. 一覧に **active / inactive** が出るか見る。止まっているユニットで **起動**を試す。

---

**注意**: このダッシュボードは **ADMIN Basic 認証**付きですが、**インターネットに晒すとリスクが高い**ので、`ADMIN_PASSWORD` を強くし、可能なら **VPN や IP 制限**を検討してください。

## ファイル一覧（リポジトリ）

| ファイル | 説明 |
|----------|------|
| [sites-available/metaverse-proxy.conf.example](sites-available/metaverse-proxy.conf.example) | `server_name` 別に `proxy_pass` する完全例 |
| [sites-available/metaverse-proxy.ex01.conf.example](sites-available/metaverse-proxy.ex01.conf.example) | hub=`http://nagi-s1.f5.si/`→3000、meta/metair は HTTPS→3001/3002（ex01） |
| [sites-available/nagi-s1-f5si.conf.example](sites-available/nagi-s1-f5si.conf.example) | ホスト監視用ホスト名（HTTP）の例 |
| [snippets/metaverse-proxy-headers.conf.example](snippets/metaverse-proxy-headers.conf.example) | WebSocket 向けヘッダ等（`location` 内で include） |

## 動作確認

- `curl -I https://meta.mmh-virtual.jp` で 200/302 等が返る。
- ブラウザでアプリを開き、**Socket.io が接続**すること。
- Node が起動していること（`npm run start:prod` や systemd）。**nginx だけでは Node は起動しません。**

## `proxy_read_timeout`

長い値（例: 86400 秒）は **WebSocket 相当の接続を切りにくくする**ための例です。ポリシーに応じて短くしてもよいです。長輪詢のみ使う場合はそれほど長く不要なこともあります。
