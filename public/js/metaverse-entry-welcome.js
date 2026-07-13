// public/js/metaverse-entry-welcome.js — メタバース入場時の Welcome 演出（5秒・裏でプリロード）

import {
    ENTRY_WELCOME_MS,
    clearPendingEntryWelcome,
    peekPendingEntryWelcome,
} from './login-preload-state.js';

const WELCOME_ROOT_ID = 'met-entry-welcome-root';
const WELCOME_FADE_MS = 1000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Welcome 用スタイルを注入する
 */
function ensureWelcomeStyles() {
    if (document.getElementById('met-entry-welcome-styles')) return;

    const style = document.createElement('style');
    style.id = 'met-entry-welcome-styles';
    style.textContent = `
        html.met-entry-welcome-active,
        html.met-entry-welcome-active body {
            overflow: hidden !important;
            background: #ffffff !important;
        }
        #${WELCOME_ROOT_ID} {
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #ffffff;
            opacity: 1;
            transition: opacity ${WELCOME_FADE_MS}ms ease;
            pointer-events: auto;
        }
        #${WELCOME_ROOT_ID}.met-entry-welcome-fading {
            opacity: 0;
            pointer-events: none;
        }
        #${WELCOME_ROOT_ID} .met-entry-welcome-text {
            margin: 0;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            font-size: clamp(2.5rem, 11vw, 4rem);
            font-weight: 300;
            letter-spacing: 0.04em;
            color: #1d1d1f;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Welcome 用オーバーレイを生成する（早期表示が無い場合のフォールバック）
 * @returns {HTMLElement}
 */
function createWelcomeOverlay() {
    const root = document.createElement('div');
    root.id = WELCOME_ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = '<p class="met-entry-welcome-text">Welcome</p>';
    return root;
}

/**
 * Welcome を白背景で表示する
 */
function ensureWelcomeVisible() {
    ensureWelcomeStyles();
    document.documentElement.classList.add('met-entry-welcome-active');
    document.body.style.overflow = 'hidden';

    if (!document.getElementById(WELCOME_ROOT_ID)) {
        document.body.prepend(createWelcomeOverlay());
    }
}

/**
 * Welcome をフェードアウトして除去する
 * @returns {Promise<void>}
 */
async function fadeOutWelcomeOverlay() {
    const root = document.getElementById(WELCOME_ROOT_ID);
    if (!root) {
        document.documentElement.classList.remove('met-entry-welcome-active');
        document.body.style.overflow = '';
        return;
    }

    root.classList.add('met-entry-welcome-fading');
    await delay(WELCOME_FADE_MS);
    root.remove();
    document.documentElement.classList.remove('met-entry-welcome-active');
    document.body.style.overflow = '';
}

/**
 * ログイン経由の入場時: Welcome を表示しつつ bootstrap を並行実行し、フェードアウトで退場
 * @param {() => Promise<void>} bootstrapWork
 * @returns {Promise<void>}
 */
export async function runEntryWelcomeIfPending(bootstrapWork) {
    const pending = peekPendingEntryWelcome();
    if (!pending) {
        await bootstrapWork();
        return;
    }

    const holdMs = Math.max(0, ENTRY_WELCOME_MS - WELCOME_FADE_MS);
    ensureWelcomeVisible();

    try {
        await Promise.all([bootstrapWork(), delay(holdMs)]);
    } finally {
        await fadeOutWelcomeOverlay();
        clearPendingEntryWelcome();
    }
}

export { ENTRY_WELCOME_MS };
