// public/js/metaverse-entry-welcome.js — メタバース入場時の Welcome 演出（5秒・裏でプリロード）

import {
    ENTRY_WELCOME_MS,
    clearPendingEntryWelcome,
    peekPendingEntryWelcome,
} from './login-preload-state.js';

const WELCOME_ROOT_ID = 'met-entry-welcome-root';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 早期スクリプトで表示した Welcome を除去する
 */
function teardownWelcomeOverlay() {
    document.getElementById(WELCOME_ROOT_ID)?.remove();
    document.documentElement.classList.remove('met-entry-welcome-active');
    document.body.style.overflow = '';
}

/**
 * Welcome 用オーバーレイを生成する（早期表示が無い場合のフォールバック）
 * @param {string} displayName
 * @returns {HTMLElement}
 */
function createWelcomeOverlay(displayName) {
    const CF_ORANGE = '#f38020';
    const CF_ORANGE_RGB = '243, 128, 32';

    if (!document.getElementById('met-entry-welcome-fallback-styles')) {
        const style = document.createElement('style');
        style.id = 'met-entry-welcome-fallback-styles';
        style.textContent = `
            html.met-entry-welcome-active,
            html.met-entry-welcome-active body { overflow: hidden !important; background: #fafafa !important; }
            #${WELCOME_ROOT_ID} {
                --met-accent: ${CF_ORANGE};
                --met-accent-rgb: ${CF_ORANGE_RGB};
                position: fixed; inset: 0; z-index: 100000;
                display: flex; align-items: center; justify-content: center;
                font-family: 'Segoe UI', system-ui, sans-serif;
                background: #fafafa; color: #1d1d1f;
            }
            #${WELCOME_ROOT_ID} .met-entry-card {
                width: min(92vw, 420px); padding: 40px 32px; border-radius: 16px;
                background: #fff; border: 1px solid rgba(0,0,0,0.06);
                box-shadow: 0 12px 40px rgba(0,0,0,0.08); text-align: center;
            }
            #${WELCOME_ROOT_ID} .met-entry-welcome-badge {
                display: inline-flex; width: 56px; height: 56px; border-radius: 50%;
                align-items: center; justify-content: center;
                background: rgba(var(--met-accent-rgb), 0.12); color: var(--met-accent);
                font-size: 1.75rem; margin-bottom: 4px;
            }
            #${WELCOME_ROOT_ID} .met-entry-welcome-label {
                font-size: clamp(2rem, 8vw, 2.75rem); font-weight: 800; margin: 0;
            }
            #${WELCOME_ROOT_ID} .met-entry-welcome-name {
                font-size: clamp(1.1rem, 4vw, 1.45rem); font-weight: 600;
                color: var(--met-accent); margin: 8px 0 0;
            }
            #${WELCOME_ROOT_ID} .met-entry-welcome-sub {
                font-size: 0.9rem; color: #6b6b6f; margin: 12px 0 0;
            }
        `;
        document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.id = WELCOME_ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
        <div class="met-entry-card">
            <div class="met-entry-welcome-badge" aria-hidden="true">✓</div>
            <p class="met-entry-welcome-label">Welcome!</p>
            <p class="met-entry-welcome-name"></p>
            <p class="met-entry-welcome-sub">ワールドを準備しています</p>
        </div>
    `;
    const nameEl = root.querySelector('.met-entry-welcome-name');
    if (nameEl) nameEl.textContent = displayName;
    return root;
}

/**
 * Welcome を表示する（早期スクリプト分があれば再利用）
 * @param {string} displayName
 */
function ensureWelcomeVisible(displayName) {
    document.documentElement.classList.add('met-entry-welcome-active');
    document.body.style.overflow = 'hidden';

    let root = document.getElementById(WELCOME_ROOT_ID);
    if (!root) {
        root = createWelcomeOverlay(displayName);
        document.body.prepend(root);
        return;
    }

    const nameEl = root.querySelector('.met-entry-welcome-name');
    if (nameEl) nameEl.textContent = displayName;
}

/**
 * ログイン経由の入場時: Welcome を最低5秒表示しつつ bootstrap を並行実行
 * @param {() => Promise<void>} bootstrapWork
 * @returns {Promise<void>}
 */
export async function runEntryWelcomeIfPending(bootstrapWork) {
    const pending = peekPendingEntryWelcome();
    if (!pending) {
        await bootstrapWork();
        return;
    }

    const welcomeStartedAt = Date.now();
    ensureWelcomeVisible(pending.displayName);

    try {
        await Promise.all([bootstrapWork(), delay(ENTRY_WELCOME_MS)]);
    } finally {
        const elapsed = Date.now() - welcomeStartedAt;
        if (elapsed < ENTRY_WELCOME_MS) {
            await delay(ENTRY_WELCOME_MS - elapsed);
        }
        teardownWelcomeOverlay();
        clearPendingEntryWelcome();
    }
}

export { ENTRY_WELCOME_MS };
