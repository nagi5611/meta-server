// addons/qr-ar/client/ar/qr-status-panel.js — QR認識・姿勢推定・トラッキングの状態表示

/** @typedef {'idle'|'ok'|'fail'|'hold'|'active'|'lost'} StatusKind */

const LABELS = {
    detect: {
        idle: '待機',
        ok: '検出',
        fail: '未検出',
        hold: '保持',
    },
    pose: {
        idle: '—',
        ok: '成功',
        fail: '失敗',
    },
    track: {
        idle: '—',
        active: '追従中',
        lost: 'ロスト',
    },
};

/**
 * 画面下部の QR パイプライン状態パネル
 */
export function createQrStatusPanel() {
    const panel = document.getElementById('qr-ar-status-panel');
    const detectEl = document.getElementById('qr-ar-status-detect');
    const poseEl = document.getElementById('qr-ar-status-pose');
    const trackEl = document.getElementById('qr-ar-status-track');
    const hintEl = document.getElementById('qr-ar-status-hint');

    /**
     * @param {HTMLElement|null} el
     * @param {StatusKind} kind
     * @param {string} text
     */
    function setCell(el, kind, text) {
        if (!el) return;
        el.textContent = text;
        el.dataset.state = kind;
    }

    return {
        /**
         * @param {StatusKind} kind
         * @param {string} [detail]
         */
        setDetect(kind, detail = '') {
            const base = LABELS.detect[kind] || kind;
            setCell(detectEl, kind, detail ? `${base} · ${detail}` : base);
        },

        /**
         * @param {StatusKind} kind
         * @param {string} [detail]
         */
        setPose(kind, detail = '') {
            const base = LABELS.pose[kind] || kind;
            setCell(poseEl, kind, detail ? `${base} · ${detail}` : base);
        },

        /**
         * @param {StatusKind} kind
         * @param {string} [detail]
         */
        setTrack(kind, detail = '') {
            const base = LABELS.track[kind] || kind;
            setCell(trackEl, kind, detail ? `${base} · ${detail}` : base);
        },

        /**
         * @param {string} message
         * @param {boolean} [isError]
         */
        setHint(message, isError = false) {
            if (!hintEl) return;
            hintEl.textContent = message;
            hintEl.classList.toggle('error', isError);
        },

        /**
         * @param {boolean} visible
         */
        setVisible(visible) {
            if (panel) panel.hidden = !visible;
        },
    };
}
