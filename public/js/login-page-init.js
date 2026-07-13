// public/js/login-page-init.js — ログイン画面の演出モジュールを先に登録し、重いプリロードは遅延読み込み

import { runLoginEntryTransition } from './login-entry-transition.js';

/** @typedef {'guest'|'student'|'teacher'} LoginPageTheme */

let preloadCallPromise = null;

/**
 * 重い world-preload を動的 import して開始する
 * @returns {Promise<void>}
 */
function preloadStart() {
    if (!preloadCallPromise) {
        preloadCallPromise = import('./world-preload.js').then((m) => m.startLoginWorldPreload());
    }
    return preloadCallPromise;
}

/**
 * ログイン画面の演出・プリロード API を window に登録する
 * @param {{ theme: LoginPageTheme, onAuthFailed?: (err: unknown) => void }} options
 */
export function initLoginPage(options) {
    const { theme, onAuthFailed } = options;

    window.metaverseWorldPreload = { start: preloadStart };
    void preloadStart();

    window.metaverseLoginEntry = {
        run: ({ displayName, authTask, redirectUrl }) =>
            runLoginEntryTransition({
                displayName,
                theme,
                authTask,
                redirectUrl,
                preloadStart,
                onAuthFailed,
            }),
    };
}

/**
 * 演出モジュールの準備完了を待つ（インライン script から利用）
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function waitForLoginEntryModule(timeoutMs = 15000) {
    if (window.metaverseLoginEntry?.run) return true;

    const start = Date.now();
    while (!window.metaverseLoginEntry?.run) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((resolve) => setTimeout(resolve, 32));
    }
    return true;
}

window.waitForLoginEntryModule = waitForLoginEntryModule;
