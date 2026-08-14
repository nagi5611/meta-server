// addons/qr-ar/client/ar/main.js — QR-AR エントリ
import { startCameraStream, stopCameraStream } from './camera-stream.js';
import {
    createScanCanvas,
    captureVideoFrameForScan,
    createQrTracker,
    refinePoseWithCardConfig,
} from './qr-tracker.js';
import { smoothQrPose } from './pose-from-qr.js';
import { createArRenderer } from './ar-renderer.js';
import { createQrStatusPanel } from './qr-status-panel.js';

const API_BASE = '/api/addons/qr-ar/cards';

const mount = document.getElementById('qr-ar-mount');
const startGuide = document.getElementById('qr-ar-start-guide');
const startBtn = document.getElementById('qr-ar-start-btn');
const statusPanel = createQrStatusPanel();

/** @type {MediaStream|null} */
let mediaStream = null;
/** @type {ReturnType<typeof createArRenderer>|null} */
let arRenderer = null;
/** @type {import('./pose-from-qr.js').QrPose|null} */
let smoothedPose = null;
/** @type {Map<string, object>} */
const cardCache = new Map();
let activeCardId = null;
let scanning = false;
/** @type {ReturnType<typeof createScanCanvas>|null} */
let scanSurface = null;
/** @type {ReturnType<typeof createQrTracker>|null} */
let qrTracker = null;

/**
 * 検出結果から画面下部ステータスを更新する
 * @param {import('./qr-tracker.js').QrDetection|null} detected
 * @param {boolean} freshHit 今フレームで新規検出したか
 */
function updatePipelineStatus(detected, freshHit) {
    if (!qrTracker) return;

    const tracking = qrTracker.isTracking();
    const lostFrames = qrTracker.getLostFrames();

    if (detected) {
        if (freshHit) {
            statusPanel.setDetect('ok', `${detected.source} · ${detected.cardId}`);
        } else {
            statusPanel.setDetect('hold', `${lostFrames} フレーム保持 · ${detected.source}`);
        }

        if (detected.pose) {
            statusPanel.setPose('ok', `誤差 ${detected.pose.reprojectionError.toFixed(1)} px`);
        } else {
            statusPanel.setPose('fail', '四隅はあるが PnP 失敗');
        }

        statusPanel.setTrack('active', activeCardId ? `カード ${activeCardId}` : '姿勢のみ');
    } else if (tracking) {
        statusPanel.setDetect('hold', `${lostFrames} フレーム保持`);
        statusPanel.setPose(smoothedPose ? 'ok' : 'fail', smoothedPose ? '前フレームの姿勢' : '—');
        statusPanel.setTrack('active', '直前結果を維持');
    } else {
        statusPanel.setDetect('fail');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
    }
}

/**
 * @param {string} cardId
 */
async function fetchCardConfig(cardId) {
    if (cardCache.has(cardId)) return cardCache.get(cardId);
    const r = await fetch(`${API_BASE}/${encodeURIComponent(cardId)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`card_fetch_${r.status}`);
    const j = await r.json();
    if (!j?.ok || !j.card) throw new Error('card_invalid');
    cardCache.set(cardId, j.card);
    return j.card;
}

/**
 * @param {import('./qr-tracker.js').QrDetection} detected
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function applyDetection(detected, frameWidth, frameHeight) {
    const cardId = detected.cardId;
    if (!cardId) return;

    if (cardId !== activeCardId) {
        activeCardId = cardId;
        statusPanel.setHint(`カード ${cardId} — モデルを読み込み中…`);
        fetchCardConfig(cardId)
            .then((card) => {
                const pose = refinePoseWithCardConfig(
                    detected.pose,
                    card.qrPhysicalSizeM || 0.02,
                    frameWidth,
                    frameHeight,
                    detected.location
                );
                if (pose) smoothedPose = pose;
                return arRenderer?.setCard({
                    cardId: card.cardId,
                    modelUrl: card.modelUrl,
                    modelScale: card.modelScale,
                    offset: card.offset,
                    qrPhysicalSizeM: card.qrPhysicalSizeM,
                });
            })
            .then(() => {
                statusPanel.setHint(`カード ${cardId} — AR 表示中`);
            })
            .catch((e) => {
                console.warn('[qr-ar] card load failed:', e);
                statusPanel.setHint(`カード ${cardId} のモデルが見つかりません`, true);
                activeCardId = null;
            });
        return;
    }

    if (!activeCardId || !cardCache.has(activeCardId)) return;

    const card = cardCache.get(activeCardId);
    const pose = refinePoseWithCardConfig(
        detected.pose,
        card.qrPhysicalSizeM || 0.02,
        frameWidth,
        frameHeight,
        detected.location
    );
    if (pose) {
        smoothedPose = smoothQrPose(smoothedPose, pose, 0.35);
    }
}

/**
 * @param {HTMLVideoElement} video
 */
function scanLoop(video) {
    if (!scanning || !scanSurface || !arRenderer || !qrTracker) return;
    const { canvas, ctx } = scanSurface;

    const captured = captureVideoFrameForScan(video, canvas, ctx);
    if (!captured) {
        requestAnimationFrame(() => scanLoop(video));
        return;
    }

    const { fullWidth, fullHeight, scale } = captured;
    const detected = qrTracker.scanSync(video, canvas, ctx);
    const freshHit = detected && qrTracker.getLostFrames() === 0;

    if (detected) {
        applyDetection(detected, fullWidth, fullHeight);
    } else if (!qrTracker.isTracking()) {
        smoothedPose = null;
        activeCardId = null;
        statusPanel.setHint('カードの QR をカメラに映してください');
    }

    updatePipelineStatus(detected, freshHit);

    if (!detected && captured) {
        qrTracker.maybeScanAsync(canvas, fullWidth, fullHeight, scale, (hit) => {
            applyDetection(hit, fullWidth, fullHeight);
            updatePipelineStatus(hit, true);
        });
    }

    arRenderer.updatePose(smoothedPose);
    arRenderer.render();
    requestAnimationFrame(() => scanLoop(video));
}

/**
 * AR 体験を開始する
 */
async function startAr() {
    if (scanning) return;
    startGuide?.setAttribute('hidden', 'hidden');
    statusPanel.setVisible(true);
    statusPanel.setHint('カメラを起動しています…');
    try {
        const { video, stream } = await startCameraStream();
        mediaStream = stream;
        if (!mount) throw new Error('mount_missing');
        arRenderer = createArRenderer({ video, mount });
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        scanSurface = createScanCanvas(w, h);
        qrTracker = createQrTracker({ lostFramesMax: 60 });
        scanning = true;
        statusPanel.setDetect('idle');
        statusPanel.setPose('idle');
        statusPanel.setTrack('lost');
        statusPanel.setHint('カードの QR をカメラに映してください');
        scanLoop(video);
    } catch (e) {
        console.error('[qr-ar] start failed:', e);
        let msg = 'カメラを起動できませんでした（HTTPS が必要です）';
        if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
            msg = 'カメラの使用が許可されていません';
        } else if (e?.name === 'NotFoundError' || e?.name === 'DevicesNotFoundError') {
            msg = 'カメラが見つかりません';
        } else if (e?.message === 'camera_not_supported') {
            msg = 'このブラウザはカメラ API をサポートしていません';
        }
        statusPanel.setHint(msg, true);
        startGuide?.removeAttribute('hidden');
    }
}

startBtn?.addEventListener('click', () => {
    void startAr();
});

window.addEventListener('beforeunload', () => {
    scanning = false;
    if (arRenderer) arRenderer.dispose();
    stopCameraStream(mediaStream);
});
