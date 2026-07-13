// public/js/metaverse-entry-welcome.js — メタバース入場時の Welcome 演出（5秒・裏でプリロード）

import {
    ENTRY_WELCOME_OVERLAY_CSS,
    entryWelcomeMessageFromStorage,
    pickRandomEntryWelcomeMessage,
    renderEntryWelcomeMessage,
} from './entry-welcome-messages.js';
import {
    startEntryWelcomeMusic,
    stopEntryWelcomeMusic,
} from './entry-welcome-audio.js';
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
    style.textContent = ENTRY_WELCOME_OVERLAY_CSS.replace(
        'transition: opacity 1s ease',
        `transition: opacity ${WELCOME_FADE_MS}ms ease`
    );
    document.head.appendChild(style);
}

/**
 * @param {import('./entry-welcome-messages.js').EntryWelcomeMessage} message
 * @returns {HTMLElement}
 */
function createWelcomeOverlay(message) {
    const root = document.createElement('div');
    root.id = WELCOME_ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-live', 'polite');
    renderEntryWelcomeMessage(root, message);
    return root;
}

/**
 * @param {ReturnType<typeof peekPendingEntryWelcome>} pending
 * @returns {import('./entry-welcome-messages.js').EntryWelcomeMessage}
 */
function resolveWelcomeMessage(pending) {
    const fromStorage = pending ? entryWelcomeMessageFromStorage(pending) : null;
    return fromStorage || pickRandomEntryWelcomeMessage();
}

/**
 * Welcome を白背景で表示する
 * @param {import('./entry-welcome-messages.js').EntryWelcomeMessage} message
 */
function ensureWelcomeVisible(message) {
    ensureWelcomeStyles();
    document.documentElement.classList.add('met-entry-welcome-active');
    document.body.style.overflow = 'hidden';

    let root = document.getElementById(WELCOME_ROOT_ID);
    if (!root) {
        root = createWelcomeOverlay(message);
        document.body.prepend(root);
        return;
    }

    renderEntryWelcomeMessage(root, message);
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

    const message = resolveWelcomeMessage(pending);
    const holdMs = Math.max(0, ENTRY_WELCOME_MS - WELCOME_FADE_MS);
    ensureWelcomeVisible(message);
    startEntryWelcomeMusic();

    try {
        await Promise.all([bootstrapWork(), delay(holdMs)]);
    } finally {
        await fadeOutWelcomeOverlay();
        stopEntryWelcomeMusic();
        clearPendingEntryWelcome();
    }
}

export { ENTRY_WELCOME_MS };
