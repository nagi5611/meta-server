// addons/qr-ar/client/ar/axes-demo.js — QR 中心原点の軸表示デモ
import { startCameraStream, stopCameraStream } from './camera-stream.js';
import {
    createScanCanvas,
    captureVideoFrameForScan,
    createQrTracker,
} from './qr-tracker.js';
import {
    estimateCenterQrAxesPose,
    projectCenterQrAxes,
    drawCenterQrAxesOverlay,
} from './center-qr-axes.js';
import { createQrStatusPanel } from './qr-status-panel.js';

const QR_SIZE_M = 0.05;
/** 中心から伸ばす軸の長さ（QR 辺の半分） */
const AXIS_LENGTH = QR_SIZE_M * 0.5;

const mount = document.getElementById('qr-ar-axes-mount');
const startGuide = document.getElementById('qr-ar-start-guide');
const startBtn = document.getElementById('qr-ar-start-btn');
const statusPanel = createQrStatusPanel();

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

/** トラッキング保持中の最後の描画データ */
let lastOverlayLocation = null;
let lastProjectedAxes = null;

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
 * @param {import('./qr-tracker.js').QrDetection|null} detection
 * @param {boolean} freshHit
 */
function updatePipelineStatus(detection, freshHit) {
    if (!qrTracker) return;

    const tracking = qrTracker.isTracking();
    const lostFrames = qrTracker.getLostFrames();

    if (detection) {
        if (freshHit) {
            statusPanel.setDetect('ok', `${detection.source} · ${detection.cardId}`);
        } else {
            statusPanel.setDetect('hold', `${lostFrames} フレーム保持 · ${detection.source}`);
        }
        statusPanel.setTrack('active');
    } else if (tracking) {
        statusPanel.setDetect('hold', `${lostFrames} フレーム保持`);
        statusPanel.setTrack('active', '直前結果を維持');
    } else {
        statusPanel.setDetect('fail');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
    }
}

/**
 * @param {{ cardId: string, location: object, source: string }} detection
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function updateAxesForDetection(detection, frameWidth, frameHeight) {
    if (!detection?.location) return;

    const pose = estimateCenterQrAxesPose(detection.location, frameWidth, frameHeight, QR_SIZE_M);
    if (!pose) {
        statusPanel.setPose('fail', 'solvePnP 失敗');
        statusPanel.setHint('四隅はあるが姿勢推定に失敗', true);
        return;
    }

    lastOverlayLocation = pose.location;
    lastProjectedAxes = projectCenterQrAxes(pose, AXIS_LENGTH);
    statusPanel.setPose('ok', `誤差 ${pose.reprojectionError.toFixed(1)} px · 中心原点`);
    statusPanel.setHint(`青=ファインダ3隅 / 黄=中心原点 / 軸（${detection.source}）`);
}

/**
 * 保持中のマーカーと軸を描画
 */
function paintOverlay() {
    if (!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (lastOverlayLocation && lastProjectedAxes) {
        drawCenterQrAxesOverlay(overlayCtx, lastOverlayLocation, lastProjectedAxes);
    }
}

/**
 * QR 検出ループ
 */
function scanLoop() {
    if (!scanning || !scanSurface || !videoEl || !overlayCtx || !overlayCanvas || !qrTracker) return;

    syncOverlaySize();
    const { canvas, ctx } = scanSurface;
    const captured = captureVideoFrameForScan(videoEl, canvas, ctx);

    if (captured) {
        const detected = qrTracker.scanSync(videoEl, canvas, ctx);
        const freshHit = detected && qrTracker.getLostFrames() === 0;

        if (detected) {
            updateAxesForDetection(detected, captured.fullWidth, captured.fullHeight);
        } else if (!qrTracker.isTracking()) {
            lastOverlayLocation = null;
            lastProjectedAxes = null;
            statusPanel.setHint('QR コードをカメラに映してください');
        }

        updatePipelineStatus(detected, freshHit);

        if (!detected) {
            qrTracker.maybeScanAsync(
                canvas,
                captured.fullWidth,
                captured.fullHeight,
                captured.scale,
                (hit) => {
                    updateAxesForDetection(hit, captured.fullWidth, captured.fullHeight);
                    updatePipelineStatus(hit, true);
                }
            );
        }
    }

    paintOverlay();
    requestAnimationFrame(scanLoop);
}

/**
 * カメラとオーバーレイを起動する
 */
async function startAxesDemo() {
    if (scanning) return;
    startGuide?.setAttribute('hidden', 'hidden');
    statusPanel.setVisible(true);
    statusPanel.setHint('カメラを起動しています…');

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
        qrTracker = createQrTracker({ lostFramesMax: 60 });
        scanning = true;
        lastOverlayLocation = null;
        lastProjectedAxes = null;
        statusPanel.setDetect('idle');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
        statusPanel.setHint('QR を映すと青=3隅・黄=中心・RGB=軸');
        scanLoop();
    } catch (e) {
        console.error('[qr-ar-axes] start failed:', e);
        let msg = 'カメラを起動できませんでした（HTTPS が必要です）';
        if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
            msg = 'カメラの使用が許可されていません';
        }
        statusPanel.setHint(msg, true);
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
