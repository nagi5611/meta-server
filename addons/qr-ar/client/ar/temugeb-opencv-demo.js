// addons/qr-ar/client/ar/temugeb-opencv-demo.js — TemugeB/run_qr.py を OpenCV.js で再現
// 参照: third-party/QR_code_orientation_OpenCV/run_qr.py（QRCodeDetector + solvePnP）

import { startCameraStream, stopCameraStream } from './camera-stream.js';
import { createQrStatusPanel } from './qr-status-panel.js';

/** run_qr.py README 推奨: 検出は低解像度（480p 以下） */
const DETECT_MAX_PX = 360;
/** OpenCV 検出間隔（ms）。毎フレーム detectAndDecode は重すぎる */
const DETECT_INTERVAL_MS = 280;
const LOST_FRAMES_MAX = 60;

const OPENCV_JS_URL =
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

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
let detectBusy = false;
let lostFrames = 0;
let overlayW = 0;
let overlayH = 0;
let detectW = 0;
let detectH = 0;
let cachedCamW = 0;
let cachedCamH = 0;

/** @type {typeof cv|null} */
let cvRuntime = null;
/** @type {import('opencv-ts').cv.QRCodeDetector|null} */
let qrDetector = null;
/** @type {import('opencv-ts').cv.Mat|null} */
let cachedCmtx = null;
/** @type {import('opencv-ts').cv.Mat|null} */
let cachedDist = null;
/** @type {import('opencv-ts').cv.Mat|null} */
let reusableObjectPoints = null;
/** @type {import('opencv-ts').cv.Mat|null} */
let reusableUnitPoints = null;

/** 描画用: 最後に投影した軸端点（ピクセル） */
let lastAxisPixels = null;

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
        script.src = OPENCV_JS_URL;
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
 * OpenCV 用の再利用 Mat を初期化
 * @param {typeof cv} cv
 */
function initReusableMats(cv) {
    reusableObjectPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
        0, 0, 0,
        0, 1, 0,
        1, 1, 0,
        1, 0, 0,
    ]);
    reusableUnitPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
    ]);
    cachedDist = cv.Mat.zeros(4, 1, cv.CV_64FC1);
}

/**
 * カメラ行列を解像度変更時のみ再生成
 * @param {typeof cv} cv
 * @param {number} width
 * @param {number} height
 */
function ensureCameraMatrix(cv, width, height) {
    if (cachedCmtx && cachedCamW === width && cachedCamH === height) return;
    if (cachedCmtx) cachedCmtx.delete();

    const fovDeg = 60;
    const fov = (fovDeg * Math.PI) / 180;
    const fy = height / (2 * Math.tan(fov / 2));
    const fx = fy;
    const cx = width / 2;
    const cy = height / 2;
    cachedCmtx = cv.matFromArray(3, 3, cv.CV_64FC1, [fx, 0, cx, 0, fy, cy, 0, 0, 1]);
    cachedCamW = width;
    cachedCamH = height;
}

/**
 * run_qr.py get_qr_coords 相当（Mat は呼び出し側で delete）
 * @param {typeof cv} cv
 * @param {import('opencv-ts').cv.Mat} imagePoints
 */
function getQrCoords(cv, imagePoints) {
    if (!cachedCmtx || !cachedDist || !reusableObjectPoints || !reusableUnitPoints) return null;

    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const ok = cv.solvePnP(
        reusableObjectPoints,
        imagePoints,
        cachedCmtx,
        cachedDist,
        rvec,
        tvec,
        false,
        cv.SOLVEPNP_ITERATIVE
    );

    if (!ok) {
        rvec.delete();
        tvec.delete();
        return null;
    }

    const projected = new cv.Mat();
    cv.projectPoints(reusableUnitPoints, rvec, tvec, cachedCmtx, cachedDist, projected);
    rvec.delete();
    tvec.delete();
    return projected;
}

/**
 * 映像サイズが変わったときだけオーバーレイをリサイズ
 */
function syncOverlaySizeIfNeeded() {
    if (!videoEl || !overlayCanvas) return;
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (!w || !h || w === overlayW && h === overlayH) return;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    overlayW = w;
    overlayH = h;
}

/**
 * 検出用キャンバスを必要時のみリサイズ
 * @param {number} scanW
 * @param {number} scanH
 */
function ensureDetectCanvasSize(scanW, scanH) {
    if (!detectCanvas) return;
    if (scanW === detectW && scanH === detectH) return;
    detectCanvas.width = scanW;
    detectCanvas.height = scanH;
    detectW = scanW;
    detectH = scanH;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ ox: number, oy: number, axes: { x: number, y: number, color: string, label: string }[] }} drawData
 * @param {number} imgW
 */
function drawAxesFromCache(ctx, drawData, imgW) {
    if (!drawData) return;
    const maxCoord = imgW * 5;
    const { ox, oy, axes } = drawData;
    if (ox > maxCoord || oy > maxCoord || ox < -maxCoord || oy < -maxCoord) return;

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
 * projected Mat を描画キャッシュへ変換
 * @param {import('opencv-ts').cv.Mat} projected
 */
function projectedToDrawCache(projected) {
    if (!projected || projected.rows < 4) return null;
    return {
        ox: projected.data32F[0],
        oy: projected.data32F[1],
        axes: [
            { x: projected.data32F[2], y: projected.data32F[3], color: '#ff3333', label: 'X' },
            { x: projected.data32F[4], y: projected.data32F[5], color: '#33ff33', label: 'Y' },
            { x: projected.data32F[6], y: projected.data32F[7], color: '#3399ff', label: 'Z' },
        ],
    };
}

/**
 * 低解像度で OpenCV QR 検出（detect のみ。decode は重いので省略）
 * @param {typeof cv} cv
 * @param {number} fullW
 * @param {number} fullH
 */
function detectQrOpenCv(cv, fullW, fullH) {
    if (!detectCanvas || !detectCtx || !videoEl || !qrDetector) return null;

    const scale = Math.min(1, DETECT_MAX_PX / Math.max(fullW, fullH));
    const scanW = Math.max(1, Math.round(fullW * scale));
    const scanH = Math.max(1, Math.round(fullH * scale));

    ensureDetectCanvasSize(scanW, scanH);
    detectCtx.drawImage(videoEl, 0, 0, scanW, scanH);

    const src = cv.imread(detectCanvas);
    const points = new cv.Mat();
    const detected = qrDetector.detect(src, points);

    if (!detected || points.rows !== 4) {
        src.delete();
        points.delete();
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

    return { imagePoints: scaledPoints };
}

/**
 * 表示ループ（軽量・毎フレーム）
 */
function displayLoop() {
    if (!scanning || !overlayCtx || !overlayCanvas) return;

    syncOverlaySizeIfNeeded();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (lastAxisPixels && lostFrames <= LOST_FRAMES_MAX) {
        drawAxesFromCache(overlayCtx, lastAxisPixels, overlayW || overlayCanvas.width);
    }

    requestAnimationFrame(displayLoop);
}

/**
 * 検出ループ（間引き・重い処理はここだけ）
 * @param {typeof cv} cv
 */
function runDetectTick(cv) {
    if (!scanning || !videoEl) return;
    if (detectBusy) {
        scheduleDetectTick(cv);
        return;
    }

    const fullW = videoEl.videoWidth;
    const fullH = videoEl.videoHeight;
    if (!fullW || !fullH) {
        scheduleDetectTick(cv);
        return;
    }

    detectBusy = true;
    const startMs = performance.now();

    try {
        ensureCameraMatrix(cv, fullW, fullH);
        const hit = detectQrOpenCv(cv, fullW, fullH);

        if (hit) {
            lostFrames = 0;
            statusPanel.setDetect('ok', `opencv · ~${Math.round(1000 / DETECT_INTERVAL_MS)}Hz`);
            statusPanel.setTrack('active');

            const projected = getQrCoords(cv, hit.imagePoints);
            hit.imagePoints.delete();

            if (projected) {
                lastAxisPixels = projectedToDrawCache(projected);
                projected.delete();
                statusPanel.setPose('ok', 'solvePnP OK');
                statusPanel.setHint(
                    `OpenCV detect + solvePnP（検出 ${DETECT_MAX_PX}px / ${DETECT_INTERVAL_MS}ms）`
                );
            } else {
                lastAxisPixels = null;
                statusPanel.setPose('fail', 'solvePnP 失敗');
                statusPanel.setHint('QR は検出されたが姿勢推定に失敗', true);
            }
        } else {
            lostFrames += 1;
            if (lostFrames > LOST_FRAMES_MAX) {
                lastAxisPixels = null;
                statusPanel.setDetect('fail');
                statusPanel.setPose('idle');
                statusPanel.setTrack('lost');
                statusPanel.setHint('QR をカメラに映してください');
            } else {
                statusPanel.setDetect('hold', `${lostFrames}/${LOST_FRAMES_MAX}`);
                statusPanel.setTrack('active', '直前の軸を表示');
            }
        }
    } catch (e) {
        console.warn('[qr-ar-temugeb] detect tick failed:', e);
    } finally {
        detectBusy = false;
        const elapsed = performance.now() - startMs;
        if (elapsed > DETECT_INTERVAL_MS * 1.5) {
            statusPanel.setHint(`検出に ${Math.round(elapsed)}ms（重いため間隔を広げています）`);
        }
        scheduleDetectTick(cv);
    }
}

/**
 * @param {typeof cv} cv
 */
function scheduleDetectTick(cv) {
    if (!scanning) return;
    setTimeout(() => runDetectTick(cv), DETECT_INTERVAL_MS);
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
        cvRuntime = cv;
        qrDetector = new cv.QRCodeDetector();
        initReusableMats(cv);

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
        lastAxisPixels = null;
        statusPanel.setDetect('idle');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
        statusPanel.setHint('QR をカメラに映してください（OpenCV 検出）');

        displayLoop();
        scheduleDetectTick(cv);
    } catch (e) {
        console.error('[qr-ar-temugeb] start failed:', e);
        let msg = '起動に失敗しました';
        if (e?.name === 'NotAllowedError') msg = 'カメラの使用が許可されていません';
        else if (e?.message === 'opencv_load_failed') {
            msg = 'OpenCV.js の読み込みに失敗しました（ネットワークまたは CDN を確認）';
        }
        statusPanel.setHint(msg, true);
        startGuide?.removeAttribute('hidden');
    }
}

function releaseOpenCvResources() {
    if (cachedCmtx) {
        cachedCmtx.delete();
        cachedCmtx = null;
    }
    if (cachedDist) {
        cachedDist.delete();
        cachedDist = null;
    }
    if (reusableObjectPoints) {
        reusableObjectPoints.delete();
        reusableObjectPoints = null;
    }
    if (reusableUnitPoints) {
        reusableUnitPoints.delete();
        reusableUnitPoints = null;
    }
    cachedCamW = 0;
    cachedCamH = 0;
    qrDetector = null;
    cvRuntime = null;
}

startBtn?.addEventListener('click', () => {
    void startTemugebDemo();
});

window.addEventListener('beforeunload', () => {
    scanning = false;
    stopCameraStream(mediaStream);
    releaseOpenCvResources();
});
