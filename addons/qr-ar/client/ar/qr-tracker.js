// addons/qr-ar/client/ar/qr-tracker.js — QR 検出（ZXing + nimiq + BarcodeDetector + jsQR）
import jsQR from 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';
import { estimatePoseFromQrCorners } from './pose-from-qr.js';
import { detectWithZxing, detectWithZxingRotations } from './zxing-detect.js';
import { detectWithNimiq } from './nimiq-detect.js';

/**
 * @typedef {import('./pose-from-qr.js').QrPose} QrPose
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 * @typedef {{ cardId: string, location: QrLocation, pose: QrPose|null, source: string }} QrDetection
 */

/** 検出用の最大幅 */
const SCAN_MAX_WIDTH = 960;

/** @type {BarcodeDetector|null} */
let barcodeDetector = null;
let barcodeDetectorInit = false;

/**
 * BarcodeDetector を初期化する
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
 * @param {number} scale
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
 * @param {{ data: string, location: QrLocation }} found
 * @param {string} source
 * @param {number} fullWidth
 * @param {number} fullHeight
 * @param {number} scale
 * @returns {QrDetection|null}
 */
function buildDetection(found, source, fullWidth, fullHeight, scale) {
    if (!found?.data || !found.location) return null;
    const location = scaleQrLocation(found.location, scale);
    const pose = estimatePoseFromQrCorners(location, fullWidth, fullHeight, 0.02);
    return {
        cardId: found.data,
        location,
        pose,
        source,
    };
}

/**
 * jsQR で QR を検出する
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
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
 * 同期スキャン（ZXing TRY_HARDER → jsQR）
 * @param {ImageData} imageData
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
function detectSyncOnFrame(imageData, canvas, ctx) {
    let found = detectWithZxing(imageData);
    if (found) return { found, source: 'zxing' };

    found = detectWithJsQr(imageData.data, imageData.width, imageData.height);
    if (found) return { found, source: 'jsqr' };

    found = detectWithZxingRotations(canvas, ctx);
    if (found) return { found, source: 'zxing-rotated' };

    return null;
}

/**
 * QR 検出ループ用キャンバスを用意する
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
 * video フレームを検出用キャンバスへ描画
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
 * video フレームをキャンバスへ描画（フル解像度・後方互換）
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
 * ImageData から QR を検出
 */
export function scanQrFromImageData(imageData, fullWidth = imageData.width, fullHeight = imageData.height, scale = 1) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    ctx.putImageData(imageData, 0, 0);

    const sync = detectSyncOnFrame(imageData, canvas, ctx);
    if (!sync) return null;
    return buildDetection(sync.found, sync.source, fullWidth, fullHeight, scale);
}

/**
 * canvas から QR を検出（非同期: nimiq → BarcodeDetector → 同期再試行）
 */
export async function scanQrFromCanvas(canvas, fullWidth, fullHeight, scale = 1) {
    await ensureBarcodeDetector();

    const nimiqHit = await detectWithNimiq(canvas);
    if (nimiqHit) {
        return buildDetection(nimiqHit, 'nimiq-qr-scanner', fullWidth, fullHeight, scale);
    }

    const barcodeHit = await detectWithBarcodeDetector(canvas);
    if (barcodeHit) {
        return buildDetection(barcodeHit, 'barcode-detector', fullWidth, fullHeight, scale);
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sync = detectSyncOnFrame(imageData, canvas, ctx);
    if (!sync) return null;
    return buildDetection(sync.found, sync.source, fullWidth, fullHeight, scale);
}

/**
 * フレームから QR を検出（同期・後方互換）
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
 */
export function refinePoseWithCardConfig(pose, qrPhysicalSizeM, videoWidth, videoHeight, location) {
    const refined = estimatePoseFromQrCorners(location, videoWidth, videoHeight, qrPhysicalSizeM);
    return refined || pose;
}

/**
 * QR トラッカー
 */
export function createQrTracker(options = {}) {
    const lostFramesMax = options.lostFramesMax ?? 60;
    const asyncFallbackIntervalMs = options.asyncFallbackIntervalMs ?? 80;

    let lostFrames = 0;
    let lastDetection = null;
    let asyncFallbackBusy = false;
    let lastAsyncAttemptMs = 0;

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
        const sync = detectSyncOnFrame(imageData, canvas, ctx);
        const syncHit = sync ? buildDetection(sync.found, sync.source, fullWidth, fullHeight, scale) : null;

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
     * 同期検出失敗時に nimiq / BarcodeDetector を非同期で試す
     */
    function maybeScanAsync(canvas, fullWidth, fullHeight, scale, onDetected) {
        const now = performance.now();
        if (asyncFallbackBusy || now - lastAsyncAttemptMs < asyncFallbackIntervalMs) return;

        asyncFallbackBusy = true;
        lastAsyncAttemptMs = now;

        void scanQrFromCanvas(canvas, fullWidth, fullHeight, scale)
            .then((hit) => {
                if (hit) {
                    lostFrames = 0;
                    lastDetection = hit;
                    onDetected(hit);
                }
            })
            .finally(() => {
                asyncFallbackBusy = false;
            });
    }

    return {
        scanSync,
        maybeScanAsync,
        /** @deprecated */ maybeScanBarcodeAsync: maybeScanAsync,
        reset() {
            lostFrames = 0;
            lastDetection = null;
        },
        getLostFrames: () => lostFrames,
        isTracking: () => lostFrames <= lostFramesMax && lastDetection !== null,
    };
}

void ensureBarcodeDetector();
