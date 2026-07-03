# meta-benchR1 運用手順書

ベンチマーク実行前に毎回この手順を実施してください（要件 §4.2 / D-13）。

## 1. addon 準備

1. 管理画面 → **アドオン** で `meta-benchR1` **以外をすべて無効化**
2. `meta-benchR1` のみ **有効化**
3. **Node プロセスを再起動**（[addons-restart-policy.md](../addons-restart-policy.md)）
4. 管理画面 → **ベンチR1** でプリフライト（P-07）が合格することを確認

P-07 不合格時の表示例: 「読み込み addon が meta-benchR1 のみではありません」→ 他 addon を無効化して再起動。

## 2. 設定

`addons/meta-benchR1/config.json`（`config.json.example` をコピー）:

| キー | 説明 |
|------|------|
| `runnerSecret` | Runner 登録用共有シークレット |
| `defaultBotCount` | 既定 bot 数（既定 50） |
| `benchPdfPath` | PDF VC 用 PDF パス |
| `hwCpuCalibrationOpsPerSec` | hw-cpu 80 点基準（0=自動） |
| `reportMaxFiles` | レポート最大保持件数（30） |
| `reportMaxAgeDays` | レポート最大保持日数（90） |

環境変数 `BENCH_TOKEN_SECRET`（未設定時は `SOCKET_AUTH_SECRET`）で benchToken を署名します。

## 3. Bench Runner 起動（手元 PC）

```bash
cd addons/meta-benchR1/runner
node serve.js --server https://your-meta-server.example --secret YOUR_RUNNER_SECRET --name my-pc --max-bots 50
```

ペアリングコード利用時:

1. 管理画面で「ペアリングコード発行」
2. `node serve.js --server URL --pairing 123456 --name my-pc`

Runner は 30 秒以内に heartbeat を送ります。管理画面の Runner 状態が「接続中」になることを確認。

## 4. ベンチ実行

1. 管理画面 → **ベンチR1**
2. **プリフライト** → 合格
3. bot 数を設定 → **ベンチ開始**
4. 完了後「レポートを開く」で HTML を確認

所要時間の目安: 3〜5 分（最大 6 分でタイムアウト）。

## 5. ベンチ後

1. 必要に応じて他 addon を再有効化
2. **Node 再起動**（通常運用に戻す）
3. `bench_users` が残っている場合は管理画面の失敗メッセージに従い手動削除

## 6. M4 スパイク（開発用）

FakeHandler で VC パイプライン検証:

```bash
node addons/meta-benchR1/runner/spike-aiortc.js --server http://localhost:3000 --bench-token TOKEN
```

本番計測は **Linux Runner** + [mediasoup-client-aiortc](https://github.com/versatica/mediasoup-client-aiortc) を使用してください（Windows は FakeHandler フォールバックのみ）。

## 7. テスト

```bash
npm run test:meta-benchR1
```
