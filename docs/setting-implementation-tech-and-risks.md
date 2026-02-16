# setting.html 実装：使用技術と失敗リスク一覧

本ドキュメントは、ワールド設定管理サイト（setting.html）の実装にあたり、使用する技術の参照ドキュメントと、実装で失敗しうる可能性のある点を理由・解決策とともにリストアップしたものです。

---

## 1. 使用技術と参照ドキュメント

### 1.1 フロントエンド（setting.html 画面）

| 技術 | 用途 | 参照ドキュメント |
|------|------|------------------|
| **Three.js** | 3D シーン・カメラ・モデル表示 | [Three.js Docs](https://threejs.org/docs/) |
| **OrbitControls** | カメラ操作（ドラッグで回転、SHIFT+ドラッグでパン、ホイールでズーム） | [OrbitControls](https://threejs.org/docs/#api/en/controls/OrbitControls) — デフォルトで `enablePan: true`、パンは「左ドラッグ + Ctrl/Meta/Shift」で有効 |
| **TransformControls** | オブジェクトの移動・回転・スケール（Gizmo） | [TransformControls](https://threejs.org/docs/#api/en/controls/TransformControls) |
| **Raycaster** | マウスクリックでオブジェクト選択 | [Raycaster](https://threejs.org/docs/#api/en/core/Raycaster)、[Picking (manual)](https://threejs.org/manual/en/picking.html) |
| **GLTFLoader** | .glb モデルの読み込み | [GLTFLoader](https://threejs.org/docs/#api/en/loaders/GLTFLoader) |

※ OrbitControls のパンは「左ドラッグ + Shift」でデフォルト対応。キーボードパンが必要なら `controls.listenToKeyEvents(window)` を呼ぶ。

### 1.2 バックエンド（Node.js / Express）

| 技術 | 用途 | 参照ドキュメント |
|------|------|------------------|
| **Express** | ルーティング・静的ファイル・API | [Express](https://expressjs.com/) |
| **multer** | モデルアップロード（multipart/form-data） | [Multer (Express)](https://expressjs.com/en/resources/middleware/multer.html)、[multer npm](https://www.npmjs.com/package/multer) |
| **fs** | worlds.json の読み書き | [Node.js fs](https://nodejs.org/api/fs.html) |
| **write-file-atomic** または **write-json-file**（任意） | JSON のアトミック書き込み（書き込み途中クラッシュ対策） | [write-file-atomic](https://www.npmjs.com/package/write-file-atomic)、[write-json-file](https://www.npmjs.com/package/write-json-file) |

### 1.3 認証

| 技術 | 用途 | 参照 |
|------|------|------|
| **Basic 認証** | setting.html の保護 | 既存 `server.js` の `basicAuth` ミドルウェア（ADMIN_USERNAME / ADMIN_PASSWORD）を setting 用ルートにも適用 |

---

## 2. 失敗しうる可能性のある点（理由・解決策）

### 2.1 TransformControls と OrbitControls のイベント競合

- **現象**: TransformControls の Gizmo をドラッグしているときに、OrbitControls も反応してカメラが動いてしまう。
- **理由**: 両方とも同じ pointer/mouse イベントを購読しており、同時に有効だと競合する。
- **解決策**:
  - TransformControls の `mouseDown` で OrbitControls を `controls.enabled = false` にし、`mouseUp` で `controls.enabled = true` に戻す。
  - 参考: [threejs disable orbit camera while using transform control](https://stackoverflow.com/questions/20058579/threejs-disable-orbit-camera-while-using-transform-control)

---

### 2.2 Raycaster で「モデル全体」を選択したいが子メッシュが当たる

- **現象**: GLB は Group の子に Mesh が複数あるため、`intersectObjects(scene.children)` だと「子の Mesh」がヒットし、どの「モデルインスタンス」を選んだか分かりにくい。
- **理由**: `intersectObjects` は再帰的に子も対象にでき、戻り値の `object` はヒットした Mesh になる。編集対象は「シーンに追加したモデルルート（Group）」にしたい。
- **解決策**:
  - 各モデルルート（Group）に `userData.editId` など一意の ID を付与し、ヒットした `object` から `object.parent` または `object.uuid` を辿って「編集対象のルート Object3D」を決める。
  - または、編集可能オブジェクトだけ別の Group にまとめ、その Group の子を `intersectObjects` に渡し、ヒットしたオブジェクトからルートまで `while (obj.parent && obj.parent !== editGroup) obj = obj.parent` で遡り、ルートを「選択オブジェクト」とする。

---

### 2.3 マウス座標が canvas のオフセットとずれる

- **現象**: クリック位置と Raycaster のヒット位置がずれる（特に canvas が画面の一部にしかないレイアウト）。
- **理由**: NDC 計算に `window.innerWidth/Height` を使うと、canvas がオフセット・リサイズされている場合にずれる。
- **解決策**: `event.clientX - canvas.getBoundingClientRect().left` と `canvas.getBoundingClientRect().width`（同様に height）を使って、canvas 基準の -1〜1 の NDC を計算する。  
  [Three.js manual - Picking](https://threejs.org/manual/en/picking.html) でも canvas の bounding rect を使う方法が推奨されている。

---

### 2.4 ワールド設定の読み込み元の変更による本番の挙動

- **現象**: 本番（index.html）でワールド設定を JSON に移行した結果、初回表示が遅い・失敗する。
- **理由**: 現在は `world-manager.js` の定数 `WORLDS` を同期的に参照している。JSON を `GET /api/worlds` で取得するようにすると、非同期になり、`loadWorld('lobby')` の前にワールド一覧が空の可能性がある。
- **解決策**:
  - 起動フローを「先に GET /api/worlds で取得 → 取得成功後に WorldManager に渡して loadWorld」に変更する。
  - またはサーバー起動時に `data/worlds.json` を読み、`GET /api/worlds` はメモリ上のオブジェクトを返すようにし、クライアントは従来どおり「ワールド一覧が存在する」前提で初期化する（初回表示はサーバー次第で安定）。

---

### 2.5 worlds.json の書き込みでファイルが壊れる

- **現象**: 保存中にサーバーが落ちるなどで、worlds.json が空や途中切れになる。
- **理由**: `fs.writeFileSync` は「上書き」のため、書き込み途中でプロセスが死ぬとファイルが破損する。
- **解決策**:
  - 一時ファイルに書き、成功したら `fs.renameSync` で本ファイルに置き換える（同一ファイルシステム上ならアトミックに近い挙動）。
  - または `write-file-atomic` / `write-json-file` を使い、アトミック書き込みに任せる。

---

### 2.6 モデルアップロードで同名上書き時の確認

- **現象**: 同名ファイルで上書きする際、ユーザーが「上書きしてよいか」を確認できず誤って上書きする。
- **理由**: 仕様で「上書きしてもよいか質問する」とあるが、API だけだとフロントで確認ダイアログを出さないと実現しない。
- **解決策**:
  - アップロード前にフロントで「同名ファイルが既に存在する場合は確認ダイアログを表示し、OK の場合のみ送信」とする。
  - サーバーは「同名が既にある場合」に 409 などで「上書きするには confirm パラメータを付けて再送信」のようにし、二段階にしてもよい（フロントで一度 409 を受け取り、確認後に `?confirm=1` で再送）。

---

### 2.7 ポイントライトの 3D 上ドラッグ

- **現象**: PointLight は Scene の子だが、Mesh ではないので Raycaster でヒットしない。そのままでは「3D 上で位置をドラッグ」できない。
- **理由**: Raycaster はデフォルトで Mesh/Line/Points などを対象にする。Light は描画オブジェクトではない。
- **解決策**:
  - ポイントライトごとに「見えないが当たり判定用の Mesh」（例: 小さい Sphere）を同じ位置に置き、その Mesh に `userData.lightRef = light` を付けておく。Raycaster でその Mesh をヒットさせ、`userData.lightRef` の position を TransformControls で動かす（または Mesh の position を動かし、毎フレーム `light.position.copy(mesh.position)` で同期）。
  - Three.js の [PointLightHelper](https://threejs.org/docs/#api/en/helpers/PointLightHelper) は表示用なので、編集用には上記のような「ダミー Mesh + userData」が扱いやすい。

---

### 2.8 DirectionalLight / AmbientLight の「位置」編集

- **現象**: Ambient は位置を持たない。Directional は「方向」が重要で、position は「どこから照らすか」の基準点。Spot は position と target を持つ。
- **理由**: 仕様で「ライトも追加・編集」とあるが、種類によって編集するプロパティが違う。
- **解決策**:
  - Ambient: 位置編集なし。強度・色のみフォームで編集。
  - Directional: position は「ワールド上の点」として数値入力または 3D 上でダミー Mesh を動かして編集。必要なら target も別オブジェクトで同様に編集。
  - Point: 上記の「ダミー Mesh + TransformControls」で 3D ドラッグ。
  - Spot: position をダミー Mesh、target を別のダミーまたは数値入力で編集。

---

### 2.9 ワールド id の固定と新規作成・削除

- **現象**: 「id は固定」と「新規作成・削除」を両立させると、新規ワールドの id をどう決めるかが曖昧になる。
- **理由**: id を変更不可にすると、新規作成時は「新 id を一度決めて以後固定」という意味になる。削除時はその id のワールドを JSON から削除するだけ。
- **解決策**:
  - 新規作成時は `id` をユーザー入力または自動生成（例: `world_${Date.now()}` や slug 化した名前）で決定し、一度作成したら id は変更不可とする。名前（表示用）だけ変更可能にする。
  - 削除は「そのワールドを worlds から削除」し、他ワールドのテレポーターの `destinationWorld` が削除 id を指していれば、保存時に警告または未指定扱いにする。

---

### 2.10 本番の WorldManager が JSON を参照するようにする変更

- **現象**: 現在 `WORLDS` は world-manager.js の定数。JSON に移行すると、本番の world-manager は「起動時に GET /api/worlds で取得したオブジェクト」を参照する必要がある。
- **理由**: サーバー再起動で反映ということは、サーバーが `data/worlds.json` を読んで保持し、GET /api/worlds で返す。クライアントはその API を叩いてワールド一覧を取得する形になる。
- **解決策**:
  - WorldManager のコンストラクタまたは `init()` で `fetch('/api/worlds')` を行い、返却されたオブジェクトを `this.worlds = data` のように保持。`getWorld(id)` は `this.worlds[id]`、`getAllWorlds()` は `Object.values(this.worlds)` を返す。
  - 初期表示では「ワールド一覧取得中」を表示し、取得完了後に `loadWorld(defaultWorldId)` を呼ぶ。サーバー側は起動時に `data/worlds.json` を読み、存在しなければ現在の `WORLDS` 相当のデフォルトで作成する。

---

### 2.11 サーバー起動時に worlds.json が無い

- **現象**: 初回や設定未作成で `data/worlds.json` が存在せず、GET /api/worlds や設定読み込みが失敗する。
- **理由**: 既存の WORLDS はコード内にあるため、JSON は「初回は無い」状態になりうる。
- **解決策**:
  - サーバー起動時に `data/worlds.json` が無ければ、現在の world-manager.js の WORLDS 相当の内容でファイルを生成する（シード用のデフォルトをコードまたは別 JSON で持っておく）。
  - または GET /api/worlds で「ファイルが無い場合はデフォルトのワールド一覧を返す」ようにし、初回保存で worlds.json を生成する。

---

### 2.12 multer のファイル名・拡張子・保存先

- **現象**: アップロードファイルが .glb 以外だったり、保存先が public/models/ でなかったり、ファイル名に危険文字が含まれる。
- **理由**: multer はそのまま使うと元のファイル名で保存する。拡張子チェックやサニタイズをしないとセキュリティ・運用で問題になる。
- **解決策**:
  - `fileFilter` で `req.file.mimetype` および拡張子が .glb 相当かチェック。.glb は `model/gltf-binary` など。
  - 保存先を `path.join(__dirname, 'public', 'models')` に固定。
  - ファイル名は `path.basename(file.originalname)` をサニタイズ（例: 英数字とハイフン・アンダースコアのみ許可）するか、元ファイル名を許可するなら `..` や絶対パスを除く。

---

### 2.13 CORS / 認証（setting が別オリジンでない場合）

- **現象**: setting.html も同じオリジンで配信するため、通常は CORS 問題は起きない。認証は Basic を設定で使う。
- **理由**: 同一オリジンなら CORS は不要。Basic 認証はブラウザがダイアログを出し、以降同じオリジンのリクエストに Authorization ヘッダーを付ける。
- **解決策**: setting.html と API を同じオリジンにし、/setting.html および /api/* に同じ basicAuth を適用する。fetch は `credentials: 'include'` は通常不要（同一オリジンでは Cookie も送られる）。

---

### 2.14 TransformControls の space（world / local）

- **現象**: 回転・スケールを「ワールド基準」でやりたいのに「ローカル基準」になっている、またはその逆。
- **理由**: TransformControls の `space` が `'world'` か `'local'` で挙動が変わる。
- **解決策**: 仕様に合わせて `transformControls.space = 'world'` または `'local'` を設定する。通常、移動は world、回転は local の方が直感的なことが多い。

---

### 2.15 アニメーション（rotation）の保存形式

- **現象**: 現在は `animate: { rotation: { x, y, z } }`（度/フレーム）。setting で「オン/オフ」と「各軸の度/フレーム」を編集する必要がある。
- **理由**: scene-manager の `updateAnimations()` がこの形式を期待している。JSON に保存するときも同じ形にしないと本番で動かない。
- **解決策**: 設定画面の「アニメーション」欄で、有効/無効と rotation.x / y / z（度/フレーム）を数値入力。保存時は `animate: { rotation: { x, y, z } }` の形で worlds のモデル設定に含める。無効の場合は `animate` を省略または null にする。

---

## 3. 実装時のチェックリスト（要約）

- [ ] OrbitControls: ドラッグ＝回転、SHIFT+ドラッグ＝パン、ホイール＝ズーム
- [ ] TransformControls の mouseDown/mouseUp で OrbitControls の enabled を切り替え
- [ ] Raycaster の NDC は canvas の getBoundingClientRect() 基準で計算
- [ ] ヒットしたオブジェクトから「編集対象のルート」を userData または parent 遡りで決定
- [ ] ワールド設定は data/worlds.json に保存、書き込みは一時ファイル＋rename または write-file-atomic
- [ ] 本番の WorldManager は GET /api/worlds でワールド一覧を取得する非同期初期化に変更
- [ ] サーバー起動時、worlds.json が無ければデフォルトで作成する
- [ ] モデルアップロード: .glb のみ、保存先は public/models/、同名時は上書き確認
- [ ] ポイントライトの 3D ドラッグは「ダミー Mesh + userData.lightRef」で実装
- [ ] 新規ワールドは id を一度決めて固定、名前のみ変更可。削除時は他ワールドの destinationWorld をチェック

---

**出典**:  
- Three.js: https://threejs.org/docs/  
- Express / Multer: https://expressjs.com/  
- Node.js fs: https://nodejs.org/api/fs.html  
- Stack Overflow / three.js forum の該当スレッド（本文中リンク）
