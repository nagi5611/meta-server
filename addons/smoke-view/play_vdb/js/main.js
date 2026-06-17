// addons/smoke-view/play_vdb/js/main.js — Play_VDB エントリ
import { parsePicoVDBFromBuffer, computeAutoTransform } from './picovdb-file.js';
import { createPlayVdbRenderer } from './renderer.js';

const statusEl = document.getElementById('play-vdb-status');
const infoEl = document.getElementById('play-vdb-info');
const fpsEl = document.getElementById('play-vdb-fps');
const errorEl = document.getElementById('play-vdb-error');
const fileInput = document.getElementById('play-vdb-file-input');
const openBtn = document.getElementById('play-vdb-open-btn');
const resetBtn = document.getElementById('play-vdb-reset-camera');
const canvas = document.getElementById('play-vdb-canvas');

/**
 * @param {string} msg
 */
function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
}

/**
 * @param {string} msg
 */
function setInfo(msg) {
    if (infoEl) infoEl.textContent = msg;
}

/**
 * @param {string} msg
 */
function setError(msg) {
    if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
    }
}

/** @type {Awaited<ReturnType<typeof createPlayVdbRenderer>> | null} */
let renderer = null;

async function init() {
    if (!canvas) {
        setError('canvas 要素が見つかりません');
        return;
    }

    try {
        renderer = await createPlayVdbRenderer(canvas, {
            onStatus: setStatus,
            onInfo: setInfo,
            onFps: (fps) => {
                if (fpsEl) fpsEl.textContent = `${fps} FPS`;
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus('初期化失敗');
        console.error('[play_vdb] init failed:', err);
        return;
    }

    openBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', async (e) => {
        const input = /** @type {HTMLInputElement} */ (e.target);
        const file = input.files?.[0];
        if (!file || !renderer) return;

        setError('');
        setStatus(`読み込み中: ${file.name}…`);

        try {
            const buffer = await file.arrayBuffer();
            const picoFile = await parsePicoVDBFromBuffer(buffer, { fileName: file.name });
            const transform = computeAutoTransform(picoFile);
            renderer.uploadPicoVDB(picoFile, transform);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            setStatus('読み込み失敗');
            console.error('[play_vdb] load failed:', err);
        } finally {
            input.value = '';
        }
    });

    resetBtn?.addEventListener('click', () => {
        renderer?.resetCamera();
    });
}

init();
