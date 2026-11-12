# チャットモデレーション（二段構成）

## フロー

1. **禁止語リスト**（同期・即時）
2. **JEV 一次判定**（`JEV_API_URL` + `JEV_API_KEY` 設定時）
   - **許可** → 即座にチャット配信・`ack`（Gemini モデレーションなし）
   - 翻訳は Gemini があれば **非同期**（`chat-receive-translation`）
   - **拒否** → **Gemini 二次判定**（カテゴリ `category_ja` + 理由 `reason_ja`）
3. **JEV 未設定** → 従来どおり全件 Gemini モデレーション + 翻訳を並行

二次で Gemini が `inappropriate: false` と返した場合は **JEV の誤検知として通過**。

## 環境変数（最低限）

```env
JEV_API_KEY=sk_...
JEV_THRESHOLD=0.5
```

**エンドポイント URL の指定は不要**（既定で `https://jevai.website/api/v1/systemone`）。

プレイグラウンドで作った質問セットを使う場合だけ `JEV_QUESTION_SET_ID` を指定する。

## Jev リクエスト（サーバーが自動生成）

TypeSafe System One 形式。Noul の「はい」確率が `JEV_THRESHOLD` 未満なら一次通過。

出典: [コンテンツモデレーション — Jev AI API](https://jevai.website/ja/use-cases/content-moderation)
