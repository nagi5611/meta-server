// addons/qr-ar/client/ar/qr-tracker.js — QR 検出（BarcodeDetector + jsQR、低解像度スキャン）
import jsQR from 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';
import { estimatePoseFromQrCorners } from './pose-from-qr.js';

/**
 * @typedef {import('./pose-from-qr.js').QrPose} QrPose
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 * @typedef {{ cardId: string, location: QrLocation, pose: QrPose|null, source: string }} QrDetection
 */

/** 検出用の最大幅（TemugeB 推奨: 低解像度でスキャンして座標を戻す） */
const SCAN_MAX_WIDTH = 800;

/** @type {BarcodeDetector|null} */
let barcodeDetector = null;
let barcodeDetectorInit = false;

/**
 * BarcodeDetector を初期化する（利用可能な場合のみ）
 */
async function ensureBarcodeDetector() {
    if (barcodeDetectorInit) return;
    barcodeDetectorInit = true;
    if (!('BarcodeDetector' in globalThis)) return;
    try {
        const supported = await BarcodeDetector.getSupportedFormats();
        if (!supported.includes('qr_code')) return;
        barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch {
        barcodeDetector = null;
    }
}

/**
 * BarcodeDetector の cornerPoints を jsQR location 形式へ
 * @param {DOMPointReadOnly[]} points
 * @returns {QrLocation|null}
 */
function barcodeCornersToLocation(points) {
    if (!points || points.length < 4) return null;
    const pts = points.map((p) => ({ x: p.x, y: p.y }));
    const sorted = [...pts].sort((a, b) => a.y - b.y);
    const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
    return {
        topLeftCorner: top[0],
        topRightCorner: top[1],
        bottomLeftCorner: bottom[0],
        bottomRightCorner: bottom[1],
    };
}

/**
 * location 座標をフル解像度へスケールする
 * @param {QrLocation} location
 * @param {number} scale スキャン時の縮小率（scan/full）
 */
function scaleQrLocation(location, scale) {
    if (!location || scale >= 1) return location;
    const inv = 1 / scale;
    const scalePoint = (p) => ({ x: p.x * inv, y: p.y * inv });
    return {
        topLeftCorner: scalePoint(location.topLeftCorner),
        topRightCorner: scalePoint(location.topRightCorner),
        bottomRightCorner: scalePoint(location.bottomRightCorner),
        bottomLeftCorner: scalePoint(location.bottomLeftCorner),
    };
}

/**
 * jsQR で QR を検出する
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {{ data: string, location: QrLocation }|null}
 */
function detectWithJsQr(data, width, height) {
    const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    if (!code?.location) return null;
    const text = code.data ? String(code.data).trim() : '';
    if (!text) return null;
    return { data: text, location: code.location };
}

/**
 * BarcodeDetector で canvas から QR を検出する
 * @param {HTMLCanvasElement} canvas
 */
async function detectWithBarcodeDetector(canvas) {
    if (!barcodeDetector) return null;
    try {
        const codes = await barcodeDetector.detect(canvas);
        const code = codes?.[0];
        if (!code?.rawValue || !code.cornerPoints?.length) return null;
        const location = barcodeCornersToLocation(code.cornerPoints);
        if (!location) return null;
        const text = String(code.rawValue).trim();
        if (!text) return null;
        return { data: text, location };
    } catch {
        return null;
    }
}

/**
 * QR 検出ループ用キャンバスを用意する
 * @param {number} width
 * @param {number} height
 */
export function createScanCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas_2d_unavailable');
    return { canvas, ctx };
}

/**
 * video フレームを検出用キャンバスへ描画して ImageData を返す
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @returns {{ imageData: ImageData, scale: number, fullWidth: number, fullHeight: number }|null}
 */
export function captureVideoFrameForScan(video, canvas, ctx) {
    const fullWidth = video.videoWidth;
    const fullHeight = video.videoHeight;
    if (!fullWidth || !fullHeight) return null;

    const scale = Math.min(1, SCAN_MAX_WIDTH / fullWidth);
    const scanWidth = Math.max(1, Math.round(fullWidth * scale));
    const scanHeight = Math.max(1, Math.round(fullHeight * scale));

    if (canvas.width !== scanWidth || canvas.height !== scanHeight) {
        canvas.width = scanWidth;
        canvas.height = scanHeight;
    }

    ctx.drawImage(video, 0, 0, scanWidth, scanHeight);
    const imageData = ctx.getImageData(0, 0, scanWidth, scanHeight);
    return { imageData, scale, fullWidth, fullHeight };
}

/**
 * video フレームをキャンバスへ描画して ImageData を返す（フル解像度・後方互換）
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
export function captureVideoFrame(video, canvas, ctx) {
    const captured = captureVideoFrameForScan(video, canvas, ctx);
    if (!captured) return null;
    if (captured.scale < 1) {
        canvas.width = captured.fullWidth;
        canvas.height = captured.fullHeight;
        ctx.drawImage(video, 0, 0, captured.fullWidth, captured.fullHeight);
        return ctx.getImageData(0, 0, captured.fullWidth, captured.fullHeight);
    }
    return captured.imageData;
}

/**
 * ImageData から QR を検出（同期: jsQR）
 * @param {ImageData} imageData
 * @param {number} [fullWidth]
 * @param {number} [fullHeight]
 * @param {number} [scale]
 * @returns {QrDetection|null}
 */
export function scanQrFromImageData(imageData, fullWidth = imageData.width, fullHeight = imageData.height, scale = 1) {
    const found = detectWithJsQr(imageData.data, imageData.width, imageData.height);
    if (!found) return null;

    const location = scaleQrLocation(found.location, scale);
    const pose = estimatePoseFromQrCorners(location, fullWidth, fullHeight, 0.02);
    return {
        cardId: found.data,
        location,
        pose,
        source: 'jsqr',
    };
}

/**
 * canvas から QR を検出（非同期: BarcodeDetector → jsQR フォールバック）
 * @param {HTMLCanvasElement} canvas
 * @param {number} fullWidth
 * @param {number} fullHeight
 * @param {number} scale
 * @returns {Promise<QrDetection|null>}
 */
export async function scanQrFromCanvas(canvas, fullWidth, fullHeight, scale = 1) {
    await ensureBarcodeDetector();

    const barcodeHit = await detectWithBarcodeDetector(canvas);
    if (barcodeHit) {
        const location = scaleQrLocation(barcodeHit.location, scale);
        const pose = estimatePoseFromQrCorners(location, fullWidth, fullHeight, 0.02);
        return {
            cardId: barcodeHit.data,
            location,
            pose,
            source: 'barcode-detector',
        };
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return scanQrFromImageData(imageData, fullWidth, fullHeight, scale);
}

/**
 * フレームから QR を検出する（同期・後方互換）
 * @param {Uint8ClampedArray} imageData
 * @param {number} width
 * @param {number} height
 * @returns {QrDetection|null}
 */
export function detectQrInFrame(imageData, width, height) {
    const data = imageData instanceof Uint8ClampedArray ? imageData : imageData?.data;
    if (!data) return null;
    return scanQrFromImageData({ data, width, height }, width, height, 1);
}

/**
 * @param {QrPose|null} pose
 * @param {number} qrPhysicalSizeM
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {QrLocation} location
 * @returns {QrPose|null}
 */
export function refinePoseWithCardConfig(pose, qrPhysicalSizeM, videoWidth, videoHeight, location) {
    const refined = estimatePoseFromQrCorners(location, videoWidth, videoHeight, qrPhysicalSizeM);
    return refined || pose;
}

/**
 * QR トラッカー（検出の粘り・BarcodeDetector 併用）
 */
export function createQrTracker(options = {}) {
    const lostFramesMax = options.lostFramesMax ?? 48;
    const barcodeFallbackIntervalMs = options.barcodeFallbackIntervalMs ?? 120;

    let lostFrames = 0;
    let lastDetection = null;
    let barcodeFallbackBusy = false;
    let lastBarcodeAttemptMs = 0;

    /**
     * @param {HTMLVideoElement} video
     * @param {HTMLCanvasElement} canvas
     * @param {CanvasRenderingContext2D} ctx
     * @returns {QrDetection|null}
     */
    function scanSync(video, canvas, ctx) {
        const captured = captureVideoFrameForScan(video, canvas, ctx);
        if (!captured) return lastDetection;

        const { imageData, scale, fullWidth, fullHeight } = captured;
        const syncHit = scanQrFromImageData(imageData, fullWidth, fullHeight, scale);

        if (syncHit) {
            lostFrames = 0;
            lastDetection = syncHit;
            return syncHit;
        }

        lostFrames += 1;
        if (lostFrames <= lostFramesMax) {
            return lastDetection;
        }

        lastDetection = null;
        return null;
    }

    /**
     * jsQR で失敗したとき BarcodeDetector を非同期で試す
     * @param {HTMLCanvasElement} canvas
     * @param {number} fullWidth
     * @param {number} fullHeight
     * @param {number} scale
     * @param {(detection: QrDetection) => void} onDetected
     */
    function maybeScanBarcodeAsync(canvas, fullWidth, fullHeight, scale, onDetected) {
        const now = performance.now();
        if (barcodeFallbackBusy || now - lastBarcodeAttemptMs < barcodeFallbackIntervalMs) return;
        if (!barcodeDetector && !('BarcodeDetector' in globalThis)) return;

        barcodeFallbackBusy = true;
        lastBarcodeAttemptMs = now;

        void scanQrFromCanvas(canvas, fullWidth, fullHeight, scale)
            .then((hit) => {
                if (hit) {
                    lostFrames = 0;
                    lastDetection = hit;
                    onDetected(hit);
                }
            })
            .finally(() => {
                barcodeFallbackBusy = false;
            });
    }

    return {
        scanSync,
        maybeScanBarcodeAsync,
        reset() {
            lostFrames = 0;
            lastDetection = null;
        },
        getLostFrames: () => lostFrames,
        isTracking: () => lostFrames <= lostFramesMax && lastDetection !== null,
    };
}

// 起動時に BarcodeDetector を温める
void ensureBarcodeDetector();
