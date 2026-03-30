# Meta Quest / WebXR 利用メモ

本番・実機検証では **HTTPS**（Secure Context）が必要です。手順の骨子は [DEPLOY_PRODUCTION_HTTPS.md](./DEPLOY_PRODUCTION_HTTPS.md) を参照してください。LAN 内の Quest から PC を叩く場合は、`https://<PCのLAN-IP>:ポート` で届くよう TLS を構成し、証明書を端末側で信頼させる必要があります。

## 機能概要

- **VR ボタン**（画面下中央付近）: 没入セッションの開始／終了。
- **移動モード**（`#xr-dom-overlay-root`）: 「両方」「スムーズ」「テレポート」。選択は `localStorage` キー `metaverse-vr-locomotion` に保存されます。
- **左コントローラー スティック**: スムーズ移動（モードによる）。
- **右コントローラー スティック左右**: スナップターン（約 30°、クールダウンあり）。
- **左グリップ（squeeze）**: ジャンプ。
- **右トリガー離し（selectend）**: テレポート（「テレポート」「両方」モード。右手が接続されているときは右手のみ）。

## 技術メモ

- レンダラは `WebGLRenderer.xr.enabled` と `setAnimationLoop` を使用しています。
- `local-floor` を希望し、失敗時は `local-floor` なし→さらに feature なしの順で再試行します。
- `dom-overlay` はオーバーレイ要素がある場合のみ `optionalFeatures` に含めます。未対応端末では再試行で外れます。

## 既知の制限

- VR 中はキーボード移動・マウス視点回転は無効（HMD 視点が優先）。
- 管理者の飛行モード等のキーバインドは VR 中は効きません。
- テレポートは静的 BVH コライダーへのレイキャストに基づきます。視覚メッシュとコライダーがずれるワールドでは着地が不自然になることがあります。
- 片手のみ接続の環境では、割り当てが想定と異なる場合があります。

## デバッグ

- Meta の [WebXR Workflow](https://developers.meta.com/horizon/documentation/web/webxr-workflow)（リモートデバッグ・エミュレータ）。
- PC Chrome のリモートデバッグで Quest のタブを検査し、コンソールエラーを確認してください。
