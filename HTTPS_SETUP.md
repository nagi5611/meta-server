# HTTPS で通信する設定

サーバーは環境変数で SSL 証明書を指定すると、HTTPS で待ち受けます。

## 1. 環境変数

`.env` に以下を設定する。

```env
# HTTPS 用（両方設定すると HTTPS で起動）
SSL_CERT_PATH=/path/to/fullchain.pem
SSL_KEY_PATH=/path/to/privkey.pem

# HTTPS の待ち受けポート（例: 443）
PORT=443

# 任意: HTTP でリダイレクト用のポート（例: 80）。0 または未設定なら起動しない
PORT_HTTP_REDIRECT=80
```

- **SSL_CERT_PATH**: 証明書ファイル（PEM）のパス
- **SSL_KEY_PATH**: 秘密鍵ファイル（PEM）のパス
- **PORT**: HTTPS のポート（443 を使う場合、管理者権限が必要なことがある）
- **PORT_HTTP_REDIRECT**: ここで指定したポートへの HTTP アクセスを、上記 PORT の HTTPS へ 302 リダイレクトする。0 または未設定のときはリダイレクト用サーバーは起動しない。

**証明書を certbot で取得した直後（WSL の /etc/letsencrypt/ にある場合）**

Node サーバーを **Windows** から動かす場合は、Windows からそのパスを読めないので、証明書をプロジェクト内にコピーする。

```bash
# WSL で実行（プロジェクト直下の certs にコピー）
sudo cp /etc/letsencrypt/live/meta.mmh-virtual.jp/fullchain.pem /etc/letsencrypt/live/meta.mmh-virtual.jp/privkey.pem /mnt/d/myprojects/meta/server/metaverse-simple/certs/
```

その後、`.env` に以下を追加（または既存を書き換え）。

```env
SSL_CERT_PATH=certs/fullchain.pem
SSL_KEY_PATH=certs/privkey.pem
PORT=443
```

サーバーを起動すると HTTPS で待ち受ける。有効期限（例: 2026-05-17）までに、同じ DNS チャレンジ手順で certbot を再実行して証明書を更新し、再度 `certs/` にコピーする。

## 2. 証明書の取得

### Let's Encrypt（無料・推奨）

**certbot** で取得する例（Linux / WSL）。

```bash
# 例: Ubuntu
sudo apt install certbot
sudo certbot certonly --standalone -d your-domain.com
```

証明書は通常次の場所に保存される。

- 証明書: `/etc/letsencrypt/live/your-domain.com/fullchain.pem`
- 秘密鍵: `/etc/letsencrypt/live/your-domain.com/privkey.pem`

Node から読めるようにパスをそのまま指定するか、権限を調整する。

```env
SSL_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem
PORT=443
PORT_HTTP_REDIRECT=80
```

Windows の場合は [Certbot for Windows](https://certbot.eff.org/) や、WSL 上で certbot を実行する方法がある。

### 自宅サーバーでドメインがない場合

- **ダイナミック DNS**（例: No-IP, Duck DNS）でドメインを取得し、そのドメインで Let's Encrypt を取得する。
- または **自己署名証明書** で HTTPS 化する（ブラウザで警告が出るが、通信は暗号化される）。作成例:

```bash
openssl req -x509 -newkey rsa:4096 -keyout privkey.pem -out fullchain.pem -days 365 -nodes -subj "/CN=localhost"
```

## 3. 起動

証明書を設定したうえでサーバーを起動する。

```bash
npm run start:prod
# または
node server.js
```

ログに `HTTPS is enabled` と出ていれば HTTPS で待ち受けている。

## 4. リバースプロキシを使う場合

本番では **nginx や Caddy** で SSL 終端し、Node は HTTP のまま動かす構成もよく使われる。

- クライアント → HTTPS (443) → nginx/Caddy → HTTP (3000) → この Node サーバー

その場合は **このサーバー側では SSL を設定しない**（PORT=3000 のまま）。SSL は nginx/Caddy の設定で行う。

## 5. ルーター・ファイアウォール

HTTPS で 443 を使う場合、ルーターのポート転送と Windows ファイアウォールで **TCP 443** を開放する。HTTP リダイレクト用に 80 も開放する場合は **TCP 80** も同様に設定する。

---

## 6. Xserver でサブドメイン（例: meta.mmh-virtual.jp）を自宅サーバーに向ける

**SRV レコードは使わない。** ブラウザの HTTP/HTTPS は SRV を参照せず、**A レコード（または AAAA/CNAME）** でホスト名から IP を引いて、**ポートは常に 443（HTTPS）または 80（HTTP）** で接続します。SRV で「3000 番に転送」のようなことはブラウザではできません。

### 手順

1. **Xserver の DNS 設定**  
   - ドメイン `mmh-virtual.jp` の DNS 管理で、**サブドメイン** `meta` を追加する。  
   - **A レコード**: ホスト `meta`（または `meta.mmh-virtual.jp`）→ 値 **あなたの自宅の公衆 IP**（例: 220.208.10.216）。  
   - これで `meta.mmh-virtual.jp` の名前解決が自宅 IP に向く。

2. **ポートの考え方**  
   - ブラウザは **443**（HTTPS）または **80**（HTTP）にしかつながらないため、**ポート番号なしで** `https://meta.mmh-virtual.jp` で開きたい場合は、**自宅サーバーを 443 で待ち受け**、ルーターで **TCP 443** をその PC に転送する。  
   - このサーバーなら `.env` で `PORT=443`、`SSL_CERT_PATH` / `SSL_KEY_PATH` を設定し、証明書は **meta.mmh-virtual.jp** 用のもの（Let's Encrypt など）を用意する。  
   - **3000 のまま使う**場合は、アクセス先は **`https://meta.mmh-virtual.jp:3000`** になる（ルーターで TCP 3000 を転送）。証明書の Common Name / SAN に `meta.mmh-virtual.jp` を含める。

3. **証明書（meta.mmh-virtual.jp 用）**  
   - Let's Encrypt なら、**meta.mmh-virtual.jp** の A レコードが自宅 IP を向いた状態で、自宅 PC で certbot を実行する。  
   - 例（80 番を一時的にこの PC で使う場合）:  
     `sudo certbot certonly --standalone -d meta.mmh-virtual.jp`  
   - 取得した `fullchain.pem` / `privkey.pem` を `SSL_CERT_PATH` / `SSL_KEY_PATH` に指定する。

**まとめ**: SRV ではなく **A レコードで meta.mmh-virtual.jp → 自宅の公衆 IP**。ポートは **443 で待ち受けてルーターで 443 を転送**すれば、`https://meta.mmh-virtual.jp` でアクセスできる。

### certbot --standalone で「Timeout during connect」「likely firewall problem」になる理由

Let's Encrypt は **あなたのサーバーのポート 80** に外からアクセスし、`http://meta.mmh-virtual.jp/.well-known/acme-challenge/...` を取得してドメインの確認をします。ここでタイムアウトするのは、**インターネットからあなたの PC の 80 番に届いていない**ためです。

**確認すること:**

1. **ルーターで TCP 80 を転送しているか**  
   - 3000 だけ転送している場合は、**80 番も**同じ PC（例: 192.168.0.20）に転送する。certbot 実行中だけでもよい。

2. **Windows ファイアウォールで 80 番を許可しているか**  
   - 受信の規則で TCP 80 を許可する。

3. **WSL2 で certbot を動かしている場合**  
   - certbot は **WSL 内の 80** で待ち受けるため、外から来たパケットは「Windows の 80」に届いても **WSL の 80 には自動では届かない**。  
   - **対処 A**: **DNS チャレンジ**を使い、80 番を開けずに証明書を取る（下記）。  
   - **対処 B**: Windows 側で「ポート 80 を WSL の 80 に転送」する（`netsh interface portproxy` 等）か、certbot を **Windows 版**で実行する。

**80 番を開けずに証明書を取る（DNS チャレンジ）**

Let's Encrypt の「HTTP-01」の代わりに「DNS-01」を使うと、ポート 80 は不要です。Xserver の DNS で TXT レコードを一時的に追加します。

```bash
sudo certbot certonly --manual --preferred-challenges dns -d meta.mmh-virtual.jp
```

実行すると、**TXT レコード**の名前と値が表示されます。Xserver の DNS 管理でその TXT を追加し、伝播を待ってから（数分）certbot の指示に従い Enter を押します。取得後、表示される `fullchain.pem` と `privkey.pem` のパスを `.env` の `SSL_CERT_PATH` / `SSL_KEY_PATH` に指定します。

**「NXDOMAIN」「check that a DNS record exists」と出る場合**

Let's Encrypt が `_acme-challenge.meta.mmh-virtual.jp` の TXT を引けていません。次を確認してください。

1. **Xserver での追加内容**  
   - ドメイン `mmh-virtual.jp` の DNS 設定を開く。  
   - **新規レコード追加**で、種類 **TXT** を選ぶ。  
   - **ホスト名**: `_acme-challenge.meta`（`meta.mmh-virtual.jp` のサブドメイン用なので、ホストは `_acme-challenge.meta`。画面によっては「サブドメイン」欄に `_acme-challenge.meta` や `_acme-challenge` のみなどと書く場合あり。最終的に **FQDN が _acme-challenge.meta.mmh-virtual.jp になる**ようにする。）  
   - **値（TXT の内容）**: certbot が表示した文字列をそのまま貼る（例: `OuFazWKpWfXidz_GjXDD6xDHyyxm88Y5UCeULQH2rZE`）。  
   - 保存する。

2. **伝播を待ってから Enter**  
   追加してから **2〜10 分**待ち、下記で確認してから certbot で Enter を押す。

3. **追加できているか確認する**  
   - https://toolbox.googleapps.com/apps/dig/#TXT/_acme-challenge.meta.mmh-virtual.jp  
   - 「;ANSWER」の下に、追加した TXT の値が表示されていれば OK。何も出ないか NXDOMAIN のままなら、ホスト名が違うかまだ伝播していない。

4. **Xserver で「サブドメイン」だけ別管理になっている場合**  
   `meta` をサブドメインとして追加済みなら、その `meta` 用の DNS 設定で「TXT レコードのホスト名」を `_acme-challenge` にし、値に certbot の文字列を入れる（結果的に _acme-challenge.meta.mmh-virtual.jp になればよい）。

### 192.168.0.20:80 に入れない（同じ LAN からも）

- **certbot を止めているとき**  
  80 番で何も動いていないので、`http://192.168.0.20:80` につながらないのは当然です。

- **certbot を WSL2 で動かしているとき**  
  certbot は **WSL 内の 80** で待ち受けています。`192.168.0.20` は **Windows 側**の IP なので、192.168.0.20:80 は「Windows の 80」を指し、WSL の 80 には届きません。そのため同じ LAN のスマホや別 PC から 192.168.0.20:80 には入れません。

**おすすめ**: 80 番を開けずに済む **DNS チャレンジ**（上記 `--manual --preferred-challenges dns`）で証明書を取得するのが確実です。ルーターや WSL のポート転送をいじる必要はありません。
