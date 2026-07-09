/**
 * idle-control-hint.js - 無操作時のシンプルな操作案内（グレースケール）
 */

import { t, applyMetaverseI18nToDocument } from './metaverse-i18n.js';
import { isMobile, getControlScheme, CONTROL_SCHEME_TOUCH } from './mobile-utils.js';

const IDLE_MS = 3000;
const POLL_MS = 250;

class IdleControlHint {
    constructor() {
        this.root = null;
        this.visible = false;
        this.lastActivityAt = 0;
        this.pollId = null;
        this.app = null;
        this.boundKeyDown = null;
        this.boundPointerDown = null;
        this.boundTouchStart = null;
        this.boundLocale = null;
    }

    /**
     * @param {import('./main.js').default | object} app
     */
    start(app) {
        this.stop();
        this.app = app;
        this.lastActivityAt = performance.now();
        this.ensureDom();
        this.hide();

        this.boundKeyDown = (e) => this.onKeyDown(e);
        this.boundPointerDown = () => this.noteActivity();
        this.boundTouchStart = () => this.noteActivity();
        this.boundLocale = () => this.refreshCopy();

        document.addEventListener('keydown', this.boundKeyDown, true);
        document.addEventListener('pointerdown', this.boundPointerDown, true);
        document.addEventListener('touchstart', this.boundTouchStart, { capture: true, passive: true });
        window.addEventListener('metaverse-locale-changed', this.boundLocale);
        window.addEventListener('metaverse-control-scheme-change', this.boundLocale);

        this.pollId = window.setInterval(() => this.tick(), POLL_MS);
    }

    stop() {
        if (this.pollId != null) {
            clearInterval(this.pollId);
            this.pollId = null;
        }
        if (this.boundKeyDown) {
            document.removeEventListener('keydown', this.boundKeyDown, true);
            this.boundKeyDown = null;
        }
        if (this.boundPointerDown) {
            document.removeEventListener('pointerdown', this.boundPointerDown, true);
            this.boundPointerDown = null;
        }
        if (this.boundTouchStart) {
            document.removeEventListener('touchstart', this.boundTouchStart, true);
            this.boundTouchStart = null;
        }
        if (this.boundLocale) {
            window.removeEventListener('metaverse-locale-changed', this.boundLocale);
            window.removeEventListener('metaverse-control-scheme-change', this.boundLocale);
            this.boundLocale = null;
        }
        this.hide();
        this.app = null;
    }

    noteActivity() {
        this.lastActivityAt = performance.now();
        if (this.visible) this.hide();
    }

    /**
     * @param {KeyboardEvent} e
     */
    onKeyDown(e) {
        if (e.repeat) return;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) {
            this.noteActivity();
        }
    }

    /**
     * オーバーレイが表示中か
     * @param {string} id
     * @returns {boolean}
     */
    isOverlayVisible(id) {
        const el = document.getElementById(id);
        if (!el) return false;
        if (el.classList.contains('visible')) return true;
        if (el.hasAttribute('hidden')) return false;
        const display = el.style.display;
        if (display === 'none') return false;
        if (display && display !== 'none') return true;
        return getComputedStyle(el).display !== 'none';
    }

    /**
     * 案内を出すべきでない状態か
     * @returns {boolean}
     */
    isBlocked() {
        const cc = this.app?.characterController;
        if (cc?.isInputActive?.()) return true;
        if (cc?.shouldBlockDesktopInput?.()) return true;
        if (this.app?.aircraftManager?.isPiloting || this.app?.aircraftManager?.isPassenger) return true;
        if (this.app?.isImmersivePresenting?.()) return true;
        if (document.body.dataset.pdfViewerOpen === '1') return true;
        if (document.getElementById('control-scheme-overlay')) return true;
        if (this.isOverlayVisible('settings-modal')) return true;
        if (this.isOverlayVisible('help-modal')) return true;
        if (this.isOverlayVisible('logout-modal')) return true;
        if (this.isOverlayVisible('taiko-game-overlay')) return true;
        if (this.isOverlayVisible('world-load-overlay')) return true;
        return false;
    }

    /**
     * 移動操作中か
     * @returns {boolean}
     */
    isActivelyMoving() {
        const cc = this.app?.characterController;
        if (!cc) return false;
        if (cc.moveForward || cc.moveBackward || cc.moveLeft || cc.moveRight) return true;
        if (cc.isMobileMode && (cc.mobileMoveVector?.x || cc.mobileMoveVector?.y)) return true;
        return false;
    }

    tick() {
        if (!this.app) return;

        if (this.isActivelyMoving()) {
            this.noteActivity();
            return;
        }

        if (this.isBlocked()) {
            this.lastActivityAt = performance.now();
            if (this.visible) this.hide();
            return;
        }

        const idleFor = performance.now() - this.lastActivityAt;
        if (idleFor >= IDLE_MS) {
            this.show();
        }
    }

    ensureDom() {
        let root = document.getElementById('idle-control-hint');
        if (!root) {
            root = document.createElement('div');
            root.id = 'idle-control-hint';
            root.className = 'idle-control-hint';
            root.setAttribute('aria-hidden', 'true');
            root.innerHTML = `
                <div class="idle-control-hint-panel" role="status">
                    <div class="idle-control-hint-keyboard" hidden>
                        <div class="idle-wasd" aria-hidden="true">
                            <kbd class="idle-key idle-key-w">W</kbd>
                            <div class="idle-wasd-row">
                                <kbd class="idle-key">A</kbd>
                                <kbd class="idle-key">S</kbd>
                                <kbd class="idle-key">D</kbd>
                            </div>
                        </div>
                        <p class="idle-control-hint-text" data-i18n="idleHint.pressW">Wキーを押す</p>
                    </div>
                    <div class="idle-control-hint-touch" hidden>
                        <div class="idle-stick" aria-hidden="true">
                            <span class="idle-stick-base"></span>
                            <span class="idle-stick-knob"></span>
                        </div>
                        <p class="idle-control-hint-text" data-i18n="idleHint.moveStick">スティックを動かす</p>
                    </div>
                </div>
            `;
            document.body.appendChild(root);
        }
        this.root = root;
        this.refreshCopy();
    }

    refreshCopy() {
        if (!this.root) return;
        applyMetaverseI18nToDocument();
        const touch = getControlScheme() === CONTROL_SCHEME_TOUCH || isMobile();
        const kb = this.root.querySelector('.idle-control-hint-keyboard');
        const th = this.root.querySelector('.idle-control-hint-touch');
        if (kb) kb.hidden = touch;
        if (th) th.hidden = !touch;
        const wText = this.root.querySelector('.idle-control-hint-keyboard .idle-control-hint-text');
        const tText = this.root.querySelector('.idle-control-hint-touch .idle-control-hint-text');
        if (wText) wText.textContent = t('idleHint.pressW');
        if (tText) tText.textContent = t('idleHint.moveStick');
    }

    show() {
        if (!this.root) this.ensureDom();
        this.refreshCopy();
        this.visible = true;
        this.root.classList.add('visible');
        this.root.setAttribute('aria-hidden', 'false');
    }

    hide() {
        this.visible = false;
        if (!this.root) return;
        this.root.classList.remove('visible');
        this.root.setAttribute('aria-hidden', 'true');
    }
}

export default new IdleControlHint();
