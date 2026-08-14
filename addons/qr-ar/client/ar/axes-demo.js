// addons/qr-ar/client/ar/axes-demo.js — TemugeB 方式 QR 軸表示デモ
import { startCameraStream, stopCameraStream } from './camera-stream.js';
import {
    createScanCanvas,
    captureVideoFrameForScan,
    createQrTracker,
} from './qr-tracker.js';
import {
    estimateTemugebQrPose,
    projectTemugebAxes,
    drawTemugebAxesOnCanvas,
} from './temugeb-pose.js';

const QR_SIZE_M = 0.05;
const AXIS_LENGTH = QR_SIZE_M;

const mount = document.getElementById('qr-ar-axes-mount');
const statusEl = document.getElementById('qr-ar-status');
const startGuide = document.getElementById('qr-ar-start-guide');
const startBtn = document.getElementById('qr-ar-start-btn');

/** @type {MediaStream|null} */
let mediaStream = null;
/** @type {HTMLVideoElement|null} */
let videoEl = null;
/** @type {HTMLCanvasElement|null} */
let overlayCanvas = null;
/** @type {CanvasRenderingContext2D|null} */
let overlayCtx = null;
/** @type {ReturnType<typeof createScanCanvas>|null} */
let scanSurface = null;
/** @type {ReturnType<typeof createQrTracker>|null} */
let qrTracker = null;
let scanning = false;

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

/**
 * 映像とオーバーレイキャンバスのサイズを同期する
 */
function syncOverlaySize() {
    if (!videoEl || !overlayCanvas) return;
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (!w || !h) return;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
}

/**
 * @param {{ cardId: string, location: object }} detection
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function drawAxesForDetection(detection, frameWidth, frameHeight) {
    if (!overlayCtx || !detection?.location) return;

    const pose = estimateTemugebQrPose(detection.location, frameWidth, frameHeight, QR_SIZE_M);
    if (!pose) {
        setStatus('QR を検出しましたが姿勢推定に失敗しました', true);
        return;
    }

    const projected = projectTemugebAxes(pose, AXIS_LENGTH);
    drawTemugebAxesOnCanvas(overlayCtx, projected, { lineWidth: 5 });
    setStatus(
        `QR ${detection.cardId} — 軸表示中（${detection.source} / 誤差 ${pose.reprojectionError.toFixed(2)} px）`
    );
}

/**
 * QR 検出ループ
 */
function scanLoop() {
    if (!scanning || !scanSurface || !videoEl || !overlayCtx || !overlayCanvas || !qrTracker) return;

    syncOverlaySize();
    const { canvas, ctx } = scanSurface;
    const captured = captureVideoFrameForScan(videoEl, canvas, ctx);

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (captured) {
        const detected = qrTracker.scanSync(videoEl, canvas, ctx);
        if (detected) {
            drawAxesForDetection(detected, captured.fullWidth, captured.fullHeight);
        } else if (!qrTracker.isTracking()) {
            setStatus('QR コードをカメラに映してください');
        }

        if (!detected) {
            qrTracker.maybeScanBarcodeAsync(
                canvas,
                captured.fullWidth,
                captured.fullHeight,
                captured.scale,
                (hit) => drawAxesForDetection(hit, captured.fullWidth, captured.fullHeight)
            );
        }
    }

    requestAnimationFrame(scanLoop);
}

/**
 * カメラとオーバーレイを起動する
 */
async function startAxesDemo() {
    if (scanning) return;
    startGuide?.setAttribute('hidden', 'hidden');
    setStatus('カメラを起動しています…');

    try {
        const { video, stream } = await startCameraStream();
        mediaStream = stream;
        videoEl = video;
        if (!mount) throw new Error('mount_missing');

        video.classList.add('qr-ar-axes-video');
        mount.appendChild(video);

        overlayCanvas = document.createElement('canvas');
        overlayCanvas.className = 'qr-ar-axes-overlay';
        mount.appendChild(overlayCanvas);
        overlayCtx = overlayCanvas.getContext('2d');
        if (!overlayCtx) throw new Error('overlay_ctx_unavailable');

        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        scanSurface = createScanCanvas(w, h);
        qrTracker = createQrTracker({ lostFramesMax: 48 });
        scanning = true;
        setStatus('QR コードをカメラに映してください');
        scanLoop();
    } catch (e) {
        console.error('[qr-ar-axes] start failed:', e);
        let msg = 'カメラを起動できませんでした（HTTPS が必要です）';
        if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
            msg = 'カメラの使用が許可されていません';
        }
        setStatus(msg, true);
        startGuide?.removeAttribute('hidden');
    }
}

startBtn?.addEventListener('click', () => {
    void startAxesDemo();
});

window.addEventListener('beforeunload', () => {
    scanning = false;
    stopCameraStream(mediaStream);
});
