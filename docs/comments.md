なぜやったか（目的）
汎用メタバース基盤としてリポジトリを複製し、用途ごとにサーバーを立てたい。
そのとき コアをいじらず、ChatGPT 連携・物理・通信・管理 UI などを 後から足せるようにしたい。
TypeScript 志向は「addon 側の開発・管理のしやすさ」向け（今回のコアは主に既存の JS のまま、契約とローダー中心）。
単一マシン・単一 Node プロセスで運用し、いきなり Redis クラスタは前提にしない。
どんな前提・制約で始めたか（あなたが決めたこと）
項目	決めた内容
信頼
社内・信頼済みソースのみ（サンドボックス必須にしない）
置き場所
リポジトリ内ディレクトリ（addons/<id>/）
運用
管理画面で有効化。反映は プロセス全体の再起動（ランタイムでアンロードしない）
互換
meta-server の package.json の version と semver 照合
失敗時
1 本でも初期化失敗しても その addon だけスキップしてサーバーは起動
Socket
既存の デフォルト名前空間にイベントを足す想定
mediasoup
初期は addon API に出さない
設定
環境変数 + addons/<id>/config.json
DB
addon ごとに 専用 SQLite とマイグレーション
クライアント
初版から 管理画面とゲームの両方にバンドルで載せる
スケール
複数インスタンスは当面スコープ外（単一プロセス前提で設計を単純化）
どんな構成にしたか（アーキテクチャ）
マニフェスト
各 addon は plugin.json（id, version, main, engines.meta-server 等）。

ローダーと semver
起動時に addons/ を走査 → 互換チェック → 有効なものだけ 動的 import() → register(ctx)。

フック
コアは express:setup（ルート等）と socket:setup（io 上のハンドラ）を emit。addon は hooks.on(...) で登録。終了時は shutdown（httpServer の close など）。

有効フラグの永続化
db/addons_registry.db の addon_enabled。管理 API で更新。再起動までコードは変わらない。

addon 専用 DB
PLUGIN_DATABASES_DIR 配下に pluginId.db、起動時に migrations/*.sql を適用。

設定
config.json と ADDON_<ID>_... 形式の環境変数をマージ（後者で上書き）。

クライアント
Vite 本番ビルドに含めるため、アグリゲータ（public/js/addons/registry-game.js と admin 用の動的 import）に 新 addon のクライアントを 1 行 import で列挙する形。

サンプル
addons/sample-echo（HTTP /api/addons/sample-echo/hello、Socket ping/pong、マイグレーション例）。初回はレジストリが空なら sample-echo を自動有効するシードあり。

管理 UI
/admin.html に「アドオン」パネル、GET /admin/addons と POST /admin/addons/enabled（Basic 認証配下）。

一言でいうと: 「コアは拡張点（フック）とマニフェストだけ約束し、中身は addon に閉じる。信頼済み・単一プロセス・再起動で反映」という構成です。