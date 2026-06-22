// addons/webxr-vr/client/vr-quick-menu-debug.js — VR 中 DOM オーバーレイデバッグ HUD

/**
 * Quest 等でコンソールが見えないときの診断表示（dom-overlay 内）
 */
export class VrQuickMenuDebugHud {
    /**
     * @param {HTMLElement|null} overlayRoot
     */
    constructor(overlayRoot) {
        this.el = document.createElement('div');
        this.el.id = 'vr-quick-menu-debug';
        this.el.className = 'vr-quick-menu-debug';
        this.el.setAttribute('aria-live', 'polite');
        this.el.hidden = true;
        (overlayRoot || document.body).appendChild(this.el);
    }

    /**
     * @param {object} state
     * @param {boolean} state.presenting
     * @param {boolean} state.attached
     * @param {boolean} state.menuVisible
     * @param {boolean} state.yPressed
     * @param {boolean} state.yEdge
     * @param {string} state.fontStatus
     * @param {string} [state.yDetail]
     * @param {string} [state.error]
     */
    update(state) {
        if (!state.presenting) {
            this.el.hidden = true;
            return;
        }
        this.el.hidden = false;
        const lines = [
            `VRメニュー: ${state.attached ? '接続' : '未接続'} | 表示: ${state.menuVisible ? 'ON' : 'off'}`,
            `Y(btn5): ${state.yPressed ? '押下' : '—'}${state.yEdge ? ' → トグル!' : ''}`,
            state.yDetail ? `Y詳細: ${state.yDetail}` : '',
            `フォント: ${state.fontStatus}`,
            state.error ? `ERR: ${state.error}` : '',
            '左手Yでメニュー / pre_xrで詳細検査',
        ].filter(Boolean);
        this.el.textContent = lines.join('\n');
    }

    dispose() {
        this.el.remove();
    }
}
