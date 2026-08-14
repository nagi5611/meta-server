# QR-AR 参照ライブラリ（クローン）

斜め・傾き QR の認識強化のため、以下をクローンして参照しています。

| ディレクトリ | GitHub | 用途 |
|---|---|---|
| `third-party/qr-scanner` | [nimiq/qr-scanner](https://github.com/nimiq/qr-scanner) | カメラ向け改良 jsQR + Worker（`npm: qr-scanner`） |
| `third-party/zxing-js-library` | [zxing-js/library](https://github.com/zxing-js/library) | ZXing TRY_HARDER（`npm: @zxing/library`） |
| `third-party/QR_code_orientation_OpenCV` | [TemugeB/QR_code_orientation_OpenCV](https://github.com/TemugeB/QR_code_orientation_OpenCV) | 姿勢推定の参考（Python/OpenCV） |

ブラウザデモ:
- `/qr-ar/axes/` — ZXing/nimiq 検出 + JS solvePnP
- `/qr-ar/temugeb/` — OpenCV.js `QRCodeDetector` + solvePnP（`run_qr.py` 同等）
