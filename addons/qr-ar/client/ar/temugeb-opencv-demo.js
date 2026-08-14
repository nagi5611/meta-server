// addons/qr-ar/client/ar/temugeb-opencv-demo.js — TemugeB/run_qr.py を OpenCV.js で再現
// 参照: third-party/QR_code_orientation_OpenCV/run_qr.py（QRCodeDetector + solvePnP）

import { startCameraStream, stopCameraStream } from './camera-stream.js';
import { createQrStatusPanel } from './qr-status-panel.js';

const DETECT_MAX_PX = 480;
const LOST_FRAMES_MAX = 60;

const mount = document.getElementById('qr-ar-temugeb-mount');
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
/** @type {HTMLCanvasElement|null} */
let detectCanvas = null;
/** @type {CanvasRenderingContext2D|null} */
let detectCtx = null;

let scanning = false;
let lostFrames = 0;
/** @type {import('opencv-ts').cv.QRCodeDetector|null} */
let qrDetector = null;

/**
 * OpenCV.js を読み込む
 */
function loadOpenCvRuntime() {
    if (globalThis.cv?.Mat) {
        return Promise.resolve(globalThis.cv);
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/build/opencv.js';
        script.onerror = () => reject(new Error('opencv_load_failed'));
        script.onload = () => {
            const cv = globalThis.cv;
            if (!cv) {
                reject(new Error('opencv_missing'));
                return;
            }
            if (cv.Mat) {
                resolve(cv);
                return;
            }
            cv.onRuntimeInitialized = () => resolve(cv);
        };
        document.head.appendChild(script);
    });
}

/**
 * FOV からカメラ行列を生成（Web カメラ用。実機キャリブレーションは run_qr.py の intrinsic.dat）
 * @param {typeof cv} cv
 * @param {number} width
 * @param {number} height
 */
function buildCameraMatrix(cv, width, height) {
    const fovDeg = 60;
    const fov = (fovDeg * Math.PI) / 180;
    const fy = height / (2 * Math.tan(fov / 2));
    const fx = fy;
    const cx = width / 2;
    const cy = height / 2;
    return cv.matFromArray(3, 3, cv.CV_64FC1, [fx, 0, cx, 0, fy, cy, 0, 0, 1]);
}

/**
 * run_qr.py get_qr_coords 相当
 * @param {typeof cv} cv
 * @param {import('opencv-ts').cv.Mat} cmtx
 * @param {import('opencv-ts').cv.Mat} dist
 * @param {import('opencv-ts').cv.Mat} imagePoints
 */
function getQrCoords(cv, cmtx, dist, imagePoints) {
    const objectPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
        0, 0, 0,
        0, 1, 0,
        1, 1, 0,
        1, 0, 0,
    ]);
    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const ok = cv.solvePnP(
        objectPoints,
        imagePoints,
        cmtx,
        dist,
        rvec,
        tvec,
        false,
        cv.SOLVEPNP_ITERATIVE
    );

    objectPoints.delete();
    if (!ok) {
        rvec.delete();
        tvec.delete();
        return null;
    }

    const unitPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
    ]);
    const projected = new cv.Mat();
    cv.projectPoints(unitPoints, rvec, tvec, cmtx, dist, projected);
    unitPoints.delete();

    const result = {
        projected,
        rvec,
        tvec,
    };
    return result;
}

/**
 * 映像とオーバーレイのサイズを同期
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
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('opencv-ts').cv.Mat} projected
 * @param {number} imgW
 * @param {number} imgH
 */
function drawTemugebAxesFromProjected(ctx, projected, imgW, imgH) {
    if (!projected || projected.rows < 4) return;

    const maxCoord = imgW * 5;
    const ox = projected.data32F[0];
    const oy = projected.data32F[1];
    if (ox > maxCoord || oy > maxCoord || ox < -maxCoord || oy < -maxCoord) return;

    const axes = [
        { x: projected.data32F[2], y: projected.data32F[3], color: '#ff3333', label: 'X' },
        { x: projected.data32F[4], y: projected.data32F[5], color: '#33ff33', label: 'Y' },
        { x: projected.data32F[6], y: projected.data32F[7], color: '#3399ff', label: 'Z' },
    ];

    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    for (const axis of axes) {
        if (axis.x > maxCoord || axis.y > maxCoord || axis.x < -maxCoord || axis.y < -maxCoord) continue;
        ctx.strokeStyle = axis.color;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(axis.x, axis.y);
        ctx.stroke();
        ctx.fillStyle = axis.color;
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText(axis.label, axis.x + 4, axis.y - 4);
    }

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ox, oy, 7, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * 低解像度で OpenCV QR 検出し、座標をフル解像度へ戻す
 * @param {typeof cv} cv
 * @param {number} fullW
 * @param {number} fullH
 */
function detectQrOpenCv(cv, fullW, fullH) {
    if (!detectCanvas || !detectCtx || !videoEl || !qrDetector) return null;

    const scale = Math.min(1, DETECT_MAX_PX / Math.max(fullW, fullH));
    const scanW = Math.max(1, Math.round(fullW * scale));
    const scanH = Math.max(1, Math.round(fullH * scale));

    detectCanvas.width = scanW;
    detectCanvas.height = scanH;
    detectCtx.drawImage(videoEl, 0, 0, scanW, scanH);

    const src = cv.imread(detectCanvas);
    const points = new cv.Mat();
    const straight = new cv.Mat();
    const decoded = qrDetector.detectAndDecode(src, points, straight);
    const detected = Boolean(decoded) || points.rows === 4;

    if (!detected || points.rows !== 4) {
        src.delete();
        points.delete();
        straight.delete();
        return null;
    }

    const inv = 1 / scale;
    const scaledPoints = new cv.Mat(4, 1, cv.CV_32FC2);
    for (let i = 0; i < 4; i++) {
        scaledPoints.data32F[i * 2] = points.data32F[i * 2] * inv;
        scaledPoints.data32F[i * 2 + 1] = points.data32F[i * 2 + 1] * inv;
    }

    src.delete();
    points.delete();
    straight.delete();

    return {
        data: decoded ? String(decoded).trim() : '',
        imagePoints: scaledPoints,
    };
}

/**
 * メインループ
 * @param {typeof cv} cv
 */
function scanLoop(cv) {
    if (!scanning || !videoEl || !overlayCtx || !overlayCanvas) return;

    syncOverlaySize();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const fullW = videoEl.videoWidth;
    const fullH = videoEl.videoHeight;
    if (!fullW || !fullH) {
        requestAnimationFrame(() => scanLoop(cv));
        return;
    }

    const hit = detectQrOpenCv(cv, fullW, fullH);
  let poseOk = false;

    if (hit) {
        lostFrames = 0;
        statusPanel.setDetect('ok', `opencv · ${hit.data || 'QR'}`);
        statusPanel.setTrack('active');

        const cmtx = buildCameraMatrix(cv, fullW, fullH);
        const dist = cv.Mat.zeros(4, 1, cv.CV_64FC1);
        const coords = getQrCoords(cv, cmtx, dist, hit.imagePoints);

        if (coords) {
            poseOk = true;
            drawTemugebAxesFromProjected(overlayCtx, coords.projected, fullW, fullH);
            statusPanel.setPose('ok', 'solvePnP OK');
            statusPanel.setHint('OpenCV QRCodeDetector + solvePnP（run_qr.py 同等）');
            coords.projected.delete();
            coords.rvec.delete();
            coords.tvec.delete();
        } else {
            statusPanel.setPose('fail', 'solvePnP 失敗');
            statusPanel.setHint('QR は検出されたが姿勢推定に失敗', true);
        }

        cmtx.delete();
        dist.delete();
        hit.imagePoints.delete();
    } else {
        lostFrames += 1;
        if (lostFrames <= LOST_FRAMES_MAX) {
            statusPanel.setDetect('hold', `${lostFrames}/${LOST_FRAMES_MAX} フレーム`);
            statusPanel.setTrack('active', '直前の結果を保持');
        } else {
            statusPanel.setDetect('fail');
            statusPanel.setPose('idle');
            statusPanel.setTrack('lost');
            statusPanel.setHint('QR をカメラに映してください');
        }
    }

    if (!poseOk && hit) {
        // already set fail above
    }

    requestAnimationFrame(() => scanLoop(cv));
}

/**
 * デモ開始
 */
async function startTemugebDemo() {
    if (scanning) return;
    startGuide?.setAttribute('hidden', 'hidden');
    statusPanel.setVisible(true);
    statusPanel.setHint('OpenCV.js を読み込み中…');

    try {
        const cv = await loadOpenCvRuntime();
        qrDetector = new cv.QRCodeDetector();

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

        detectCanvas = document.createElement('canvas');
        detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
        if (!detectCtx) throw new Error('detect_ctx_unavailable');

        scanning = true;
        lostFrames = LOST_FRAMES_MAX + 1;
        statusPanel.setDetect('idle');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
        statusPanel.setHint('QR をカメラに映してください（OpenCV 検出）');
        scanLoop(cv);
    } catch (e) {
        console.error('[qr-ar-temugeb] start failed:', e);
        let msg = '起動に失敗しました';
        if (e?.name === 'NotAllowedError') msg = 'カメラの使用が許可されていません';
        else if (e?.message === 'opencv_load_failed') msg = 'OpenCV.js の読み込みに失敗しました';
        statusPanel.setHint(msg, true);
        startGuide?.removeAttribute('hidden');
    }
}

startBtn?.addEventListener('click', () => {
    void startTemugebDemo();
});

window.addEventListener('beforeunload', () => {
    scanning = false;
    stopCameraStream(mediaStream);
});
