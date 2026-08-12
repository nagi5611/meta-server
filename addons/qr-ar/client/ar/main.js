// addons/qr-ar/client/ar/main.js — QR-AR エントリ
import { startCameraStream, stopCameraStream } from './camera-stream.js';
import {
    createScanCanvas,
    captureVideoFrame,
    detectQrInFrame,
    refinePoseWithCardConfig,
} from './qr-tracker.js';
import { smoothQrPose } from './pose-from-qr.js';
import { createArRenderer } from './ar-renderer.js';

const API_BASE = '/api/addons/qr-ar/cards';
const LOST_FRAMES_MAX = 8;

const mount = document.getElementById('qr-ar-mount');
const statusEl = document.getElementById('qr-ar-status');
const startGuide = document.getElementById('qr-ar-start-guide');
const startBtn = document.getElementById('qr-ar-start-btn');

/** @type {MediaStream|null} */
let mediaStream = null;
/** @type {ReturnType<typeof createArRenderer>|null} */
let arRenderer = null;
/** @type {import('./pose-from-qr.js').QrPose|null} */
let smoothedPose = null;
/** @type {Map<string, object>} */
const cardCache = new Map();
let activeCardId = null;
let lostFrames = 0;
let scanning = false;
/** @type {ReturnType<typeof createScanCanvas>|null} */
let scanSurface = null;

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
 * @param {HTMLVideoElement} video
 */
function scanLoop(video) {
    if (!scanning || !scanSurface || !arRenderer) return;
    const { canvas, ctx } = scanSurface;
    const imageData = captureVideoFrame(video, canvas, ctx);
    if (!imageData) {
        requestAnimationFrame(() => scanLoop(video));
        return;
    }

    const detected = detectQrInFrame(imageData.data, imageData.width, imageData.height);
    if (detected) {
        lostFrames = 0;
        const cardId = detected.cardId;
        if (cardId !== activeCardId) {
            activeCardId = cardId;
            setStatus(`カード ${cardId} を認識 — モデルを読み込み中…`);
            fetchCardConfig(cardId)
                .then((card) => {
                    const pose = refinePoseWithCardConfig(
                        detected.pose,
                        card.qrPhysicalSizeM || 0.02,
                        imageData.width,
                        imageData.height,
                        detected.location
                    );
                    smoothedPose = pose;
                    return arRenderer.setCard({
                        cardId: card.cardId,
                        modelUrl: card.modelUrl,
                        modelScale: card.modelScale,
                        offset: card.offset,
                        qrPhysicalSizeM: card.qrPhysicalSizeM,
                    });
                })
                .then(() => {
                    setStatus(`カード ${cardId} — AR 表示中`);
                })
                .catch((e) => {
                    console.warn('[qr-ar] card load failed:', e);
                    setStatus(`カード ${cardId} のモデルが見つかりません`, true);
                    activeCardId = null;
                });
        } else if (activeCardId && cardCache.has(activeCardId)) {
            const card = cardCache.get(activeCardId);
            const pose = refinePoseWithCardConfig(
                detected.pose,
                card.qrPhysicalSizeM || 0.02,
                imageData.width,
                imageData.height,
                detected.location
            );
            smoothedPose = smoothQrPose(smoothedPose, pose, 0.4);
        } else {
            smoothedPose = smoothQrPose(smoothedPose, detected.pose, 0.4);
        }
    } else {
        lostFrames += 1;
        if (lostFrames > LOST_FRAMES_MAX) {
            smoothedPose = null;
            activeCardId = null;
            setStatus('カードの QR をカメラに映してください');
        }
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
    setStatus('カメラを起動しています…');
    try {
        const { video, stream } = await startCameraStream();
        mediaStream = stream;
        if (!mount) throw new Error('mount_missing');
        arRenderer = createArRenderer({ video, mount });
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        scanSurface = createScanCanvas(w, h);
        scanning = true;
        setStatus('カードの QR をカメラに映してください');
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
        setStatus(msg, true);
        startGuide?.removeAttribute('hidden');
    }
}

function bindUi() {
    startBtn?.addEventListener('click', () => {
        void startAr();
    });
}

bindUi();

window.addEventListener('beforeunload', () => {
    scanning = false;
    if (arRenderer) arRenderer.dispose();
    stopCameraStream(mediaStream);
});
