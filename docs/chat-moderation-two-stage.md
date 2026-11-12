# チャットモデレーション（二段構成）

## フロー

1. **禁止語リスト**（同期・即時）
2. **JEV 一次判定**（`JEV_API_URL` + `JEV_API_KEY` 設定時）
   - **許可** → 即座にチャット配信・`ack`（Gemini モデレーションなし）
   - 翻訳は Gemini があれば **非同期**（`chat-receive-translation`）
   - **拒否** → **Gemini 二次判定**（カテゴリ `category_ja` + 理由 `reason_ja`）
3. **JEV 未設定** → 従来どおり全件 Gemini モデレーション + 翻訳を並行

二次で Gemini が `inappropriate: false` と返した場合は **JEV の誤検知として通過**。

## JEV API 契約（想定）

`POST` JSON:

```json
{ "text": "送信1行", "context": "過去ログ（任意）" }
```

応答のいずれか:

```json
{ "allowed": true, "score": 0.12 }
{ "allow": false, "score": 0.88, "reason": "..." }
{ "score": 0.88 }
```

`score` のみのときは **`score >= JEV_THRESHOLD` で拒否**（既定 0.5）。

認証: 既定 `Authorization: Bearer <JEV_API_KEY>`（`JEV_API_KEY_HEADER` / `JEV_API_KEY_PREFIX` で変更可）。

## 環境変数

`.env.example` の JEV 節を参照。
