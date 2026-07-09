/**
 * idle-control-hint.js - 入室後の初回無操作時のみ出す操作案内（グレースケール）
 */

import { t, applyMetaverseI18nToDocument } from './metaverse-i18n.js';
import { isMobile, getControlScheme, CONTROL_SCHEME_TOUCH } from './mobile-utils.js';

const IDLE_MS = 3000;
const POLL_MS = 250;

/** 操作済みとみなすキー */
const DISMISS_KEY_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
    'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyE',
]);

/** 85%（TKL）配列。wasd / spaceGlow / focus で強調 */
const KB_ROWS = [
    [
        { label: 'Esc', w: 1.15 },
        { label: 'F1' }, { label: 'F2' }, { label: 'F3' }, { label: 'F4' },
        { label: 'F5' }, { label: 'F6' }, { label: 'F7' }, { label: 'F8' },
        { label: 'F9' }, { label: 'F10' }, { label: 'F11' }, { label: 'F12' },
        { label: 'Prt' }, { label: 'Scr' }, { label: 'Pse' },
    ],
    [
        { label: '`' },
        { label: '1' }, { label: '2' }, { label: '3' }, { label: '4' },
        { label: '5' }, { label: '6' }, { label: '7' }, { label: '8' },
        { label: '9' }, { label: '0' }, { label: '-' }, { label: '=' },
        { label: '⌫', w: 1.6 },
        { label: 'Ins' }, { label: 'Hom' }, { label: 'PgU' },
    ],
    [
        { label: 'Tab', w: 1.4 },
        { label: 'Q' },
        { label: 'W', wasd: true, focus: true },
        { label: 'E' }, { label: 'R' }, { label: 'T' }, { label: 'Y' },
        { label: 'U' }, { label: 'I' }, { label: 'O' }, { label: 'P' },
        { label: '[' }, { label: ']' }, { label: '\\', w: 1.2 },
        { label: 'Del' }, { label: 'End' }, { label: 'PgD' },
    ],
    [
        { label: 'Caps', w: 1.65 },
        { label: 'A', wasd: true },
        { label: 'S', wasd: true },
        { label: 'D', wasd: true },
        { label: 'F' }, { label: 'G' }, { label: 'H' }, { label: 'J' },
        { label: 'K' }, { label: 'L' }, { label: ';' }, { label: "'" },
        { label: '↵', w: 1.95 },
    ],
    [
        { label: 'Shift', w: 2.15 },
        { label: 'Z' }, { label: 'X' }, { label: 'C' }, { label: 'V' },
        { label: 'B' }, { label: 'N' }, { label: 'M' }, { label: ',' },
        { label: '.' }, { label: '/' }, { label: 'Shift', w: 2.35 },
        { label: '↑' },
    ],
    [
        { label: 'Ctrl', w: 1.2 },
        { label: 'Win', w: 1.1 },
        { label: 'Alt', w: 1.1 },
        { label: '', w: 5.4, space: true, spaceGlow: true },
        { label: 'Alt', w: 1.1 },
        { label: 'Fn', w: 1.1 },
        { label: 'Ctrl', w: 1.2 },
        { label: '←' }, { label: '↓' }, { label: '→' },
    ],
];

class IdleControlHint {
    constructor() {
        this.root = null;
        this.visible = false;
        /** 一度でも操作したら以降は出さない */
        this.dismissed = false;
        this.lastActivityAt = 0;
        this.pollId = null;
        this.app = null;
        this.boundKeyDown = null;
        this.boundLocale = null;
        this.boundPointerLock = null;
    }

    /**
     * @param {object} app
     */
    start(app) {
        this.stop();
        this.app = app;
        this.dismissed = false;
        this.lastActivityAt = performance.now();
        this.ensureDom();
        this.hide();

        this.boundKeyDown = (e) => this.onKeyDown(e);
        this.boundLocale = () => this.refreshCopy();
        this.boundPointerLock = () => {
            if (document.pointerLockElement) this.dismissPermanently();
        };

        document.addEventListener('keydown', this.boundKeyDown, true);
        document.addEventListener('pointerlockchange', this.boundPointerLock);
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
        if (this.boundPointerLock) {
            document.removeEventListener('pointerlockchange', this.boundPointerLock);
            this.boundPointerLock = null;
        }
        if (this.boundLocale) {
            window.removeEventListener('metaverse-locale-changed', this.boundLocale);
            window.removeEventListener('metaverse-control-scheme-change', this.boundLocale);
            this.boundLocale = null;
        }
        this.hide();
        this.app = null;
    }

    /**
     * 操作済みとして案内を二度と出さない
     */
    dismissPermanently() {
        this.dismissed = true;
        this.lastActivityAt = performance.now();
        if (this.visible) this.hide();
    }

    /**
     * @param {KeyboardEvent} e
     */
    onKeyDown(e) {
        if (e.repeat) return;
        if (DISMISS_KEY_CODES.has(e.code)) {
            this.dismissPermanently();
        }
    }

    /**
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
        if (!this.app || this.dismissed) return;

        if (this.isActivelyMoving()) {
            this.dismissPermanently();
            return;
        }

        if (this.isBlocked()) {
            // ブロック中はタイマーを進めない（入室直後のロード等）
            this.lastActivityAt = performance.now();
            if (this.visible) this.hide();
            return;
        }

        const idleFor = performance.now() - this.lastActivityAt;
        if (idleFor >= IDLE_MS) {
            this.show();
        }
    }

    /**
     * @returns {string}
     */
    buildKeyboardHtml() {
        const rows = KB_ROWS.map((row) => {
            const keys = row.map((k) => {
                const w = k.w || 1;
                const classes = ['idle-kb-key'];
                if (k.wasd) classes.push('idle-kb-wasd');
                if (k.focus) classes.push('idle-kb-focus');
                if (k.space) classes.push('idle-kb-space');
                if (k.spaceGlow) classes.push('idle-kb-space-glow');
                const style = `style="--u:${w}"`;
                const label = k.space ? '' : k.label;
                return `<span class="${classes.join(' ')}" ${style}><span class="idle-kb-cap">${label}</span></span>`;
            }).join('');
            return `<div class="idle-kb-row">${keys}</div>`;
        }).join('');
        return `<div class="idle-kb" aria-hidden="true">${rows}</div>`;
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
                        <div class="idle-kb-mount"></div>
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
        const mount = this.root.querySelector('.idle-kb-mount');
        if (mount) mount.innerHTML = this.buildKeyboardHtml();
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
        if (this.dismissed) return;
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
