/**
 * idle-control-hint.js - 入室後の初回無操作時のみ出す操作案内
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

/**
 * ANSI 85%（TKL）レイアウト。
 * main は各行 15u で揃える。nav は右側クラスタ。
 * @type {{ main: object[], nav?: object[] }[]}
 */
const KB_ROWS = [
    {
        main: [
            { label: 'Esc', w: 1 },
            { gap: 1 },
            { label: 'F1' }, { label: 'F2' }, { label: 'F3' }, { label: 'F4' },
            { gap: 0.5 },
            { label: 'F5' }, { label: 'F6' }, { label: 'F7' }, { label: 'F8' },
            { gap: 0.5 },
            { label: 'F9' }, { label: 'F10' }, { label: 'F11' }, { label: 'F12' },
        ],
        nav: [
            { label: 'Prt' }, { label: 'Scr' }, { label: 'Pse' },
        ],
    },
    {
        main: [
            { label: '`' },
            { label: '1' }, { label: '2' }, { label: '3' }, { label: '4' },
            { label: '5' }, { label: '6' }, { label: '7' }, { label: '8' },
            { label: '9' }, { label: '0' }, { label: '-' }, { label: '=' },
            { label: '⌫', w: 2 },
        ],
        nav: [
            { label: 'Ins' }, { label: 'Hom' }, { label: 'PgU' },
        ],
    },
    {
        main: [
            { label: 'Tab', w: 1.5 },
            { label: 'Q' },
            { label: 'W', wasd: true, focus: true },
            { label: 'E' }, { label: 'R' }, { label: 'T' }, { label: 'Y' },
            { label: 'U' }, { label: 'I' }, { label: 'O' }, { label: 'P' },
            { label: '[' }, { label: ']' }, { label: '\\', w: 1.5 },
        ],
        nav: [
            { label: 'Del' }, { label: 'End' }, { label: 'PgD' },
        ],
    },
    {
        main: [
            { label: 'Caps', w: 1.75 },
            { label: 'A', wasd: true },
            { label: 'S', wasd: true },
            { label: 'D', wasd: true },
            { label: 'F' }, { label: 'G' }, { label: 'H' }, { label: 'J' },
            { label: 'K' }, { label: 'L' }, { label: ';' }, { label: "'" },
            { label: '↵', w: 2.25 },
        ],
        nav: [
            { ghost: true }, { ghost: true }, { ghost: true },
        ],
    },
    {
        main: [
            { label: 'Shift', w: 2.25 },
            { label: 'Z' }, { label: 'X' }, { label: 'C' }, { label: 'V' },
            { label: 'B' }, { label: 'N' }, { label: 'M' }, { label: ',' },
            { label: '.' }, { label: '/' }, { label: 'Shift', w: 2.75 },
        ],
        nav: [
            { ghost: true }, { label: '↑' }, { ghost: true },
        ],
    },
    {
        main: [
            { label: 'Ctrl', w: 1.25 },
            { label: 'Win', w: 1.25 },
            { label: 'Alt', w: 1.25 },
            { label: '', w: 6.25, space: true, glow: true },
            { label: 'Alt', w: 1.25 },
            { label: 'Fn', w: 1.25 },
            { label: 'Menu', w: 1.25 },
            { label: 'Ctrl', w: 1.25 },
        ],
        nav: [
            { label: '←' }, { label: '↓' }, { label: '→' },
        ],
    },
];

/**
 * @param {object} k
 * @returns {string}
 */
function renderKey(k) {
    if (k.gap) {
        return `<span class="idle-kb-gap" style="--u:${k.gap}"></span>`;
    }
    if (k.ghost) {
        return `<span class="idle-kb-key idle-kb-ghost" style="--u:1"><span class="idle-kb-cap"></span></span>`;
    }
    const w = k.w || 1;
    const classes = ['idle-kb-key'];
    if (k.wasd) classes.push('idle-kb-wasd');
    if (k.focus) classes.push('idle-kb-focus');
    if (k.space) classes.push('idle-kb-space');
    if (k.glow) classes.push('idle-kb-glow');
    const label = k.space ? '' : (k.label ?? '');
    return `<span class="${classes.join(' ')}" style="--u:${w}"><span class="idle-kb-cap">${label}</span></span>`;
}

/**
 * @param {object[]} items
 * @returns {string}
 */
function renderKeys(items) {
    return items.map(renderKey).join('');
}

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
            const nav = row.nav ? `<div class="idle-kb-nav">${renderKeys(row.nav)}</div>` : '';
            return `<div class="idle-kb-row"><div class="idle-kb-main">${renderKeys(row.main)}</div>${nav}</div>`;
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
        // レイアウト更新を確実に反映（古い DOM が残っていても差し替え）
        const mount = this.root.querySelector('.idle-kb-mount');
        if (mount) mount.innerHTML = this.buildKeyboardHtml();
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
