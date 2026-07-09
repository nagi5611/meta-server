/**
 * mobile-utils.js - 操作方式（タッチ/キーボード）判定と全画面・横画面ユーティリティ
 */

export const CONTROL_SCHEME_STORAGE_KEY = 'metaverse-control-scheme';
export const CONTROL_SCHEME_TOUCH = 'touch';
export const CONTROL_SCHEME_KEYBOARD = 'keyboard';

const CONTROL_SCHEME_CHANGE_EVENT = 'metaverse-control-scheme-change';

/**
 * タッチ主入力っぽいか（初回選択の推奨用）
 * @returns {boolean}
 */
export function prefersTouchInput() {
    try {
        return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {
        return (navigator.maxTouchPoints || 0) > 0;
    }
}

/**
 * 保存済みの操作方式を返す
 * @returns {'touch'|'keyboard'|null}
 */
export function getControlScheme() {
    try {
        const raw = localStorage.getItem(CONTROL_SCHEME_STORAGE_KEY);
        if (raw === CONTROL_SCHEME_TOUCH || raw === CONTROL_SCHEME_KEYBOARD) return raw;
    } catch (_) {
        /* ignore */
    }
    return null;
}

/**
 * html[data-control-scheme] を現在の設定に合わせる
 * @param {'touch'|'keyboard'|null} [scheme]
 */
export function applyControlSchemeToDocument(scheme = getControlScheme()) {
    const root = document.documentElement;
    if (scheme === CONTROL_SCHEME_TOUCH || scheme === CONTROL_SCHEME_KEYBOARD) {
        root.setAttribute('data-control-scheme', scheme);
    } else {
        root.removeAttribute('data-control-scheme');
    }
}

/**
 * 操作方式を保存し、document と購読者へ反映する
 * @param {'touch'|'keyboard'} scheme
 * @returns {'touch'|'keyboard'}
 */
export function setControlScheme(scheme) {
    if (scheme !== CONTROL_SCHEME_TOUCH && scheme !== CONTROL_SCHEME_KEYBOARD) {
        throw new Error(`Invalid control scheme: ${scheme}`);
    }
    localStorage.setItem(CONTROL_SCHEME_STORAGE_KEY, scheme);
    applyControlSchemeToDocument(scheme);
    window.dispatchEvent(
        new CustomEvent(CONTROL_SCHEME_CHANGE_EVENT, { detail: { scheme } })
    );
    return scheme;
}

/**
 * タッチ操作 UI（仮想スティック等）を使うか
 * @returns {boolean}
 */
export function isMobile() {
    return getControlScheme() === CONTROL_SCHEME_TOUCH;
}

/**
 * 操作方式が未選択なら選択 UI を出し、確定まで待つ
 * @returns {Promise<'touch'|'keyboard'>}
 */
export async function ensureControlSchemeChosen() {
    applyControlSchemeToDocument();
    const existing = getControlScheme();
    if (existing) return existing;

    const { showControlSchemePicker } = await import('./control-scheme-picker.js');
    return showControlSchemePicker();
}

/**
 * 全画面モードをリクエスト（ユーザージェスチャー内で呼ぶこと）
 * @returns {Promise<boolean>} 成功可否
 */
export async function setupFullscreen() {
    const doc = document.documentElement;
    try {
        if (!document.fullscreenElement) {
            await doc.requestFullscreen();
            return true;
        }
        return true;
    } catch (err) {
        console.warn('[mobile-utils] Fullscreen failed:', err);
        return false;
    }
}

/**
 * 横画面ロックを試行（全画面時のみ有効、iOS Safari は未対応）
 * @returns {Promise<boolean>} 成功可否
 */
export async function tryLockLandscape() {
    if (!screen?.orientation?.lock) return false;
    try {
        await screen.orientation.lock('landscape');
        return true;
    } catch (err) {
        console.warn('[mobile-utils] Orientation lock failed:', err);
        return false;
    }
}

/**
 * 操作方式の変更を購読する（旧 onResize の代替）
 * @param {(isMobile: boolean) => void} callback
 * @returns {() => void} 解除関数
 */
export function onControlSchemeChange(callback) {
    applyControlSchemeToDocument();
    let wasMobile = isMobile();
    callback(wasMobile);

    const handler = () => {
        const nowMobile = isMobile();
        if (nowMobile === wasMobile) return;
        wasMobile = nowMobile;
        callback(nowMobile);
    };

    window.addEventListener(CONTROL_SCHEME_CHANGE_EVENT, handler);
    return () => window.removeEventListener(CONTROL_SCHEME_CHANGE_EVENT, handler);
}

/**
 * @deprecated 画面サイズではなく操作方式で切り替える。onControlSchemeChange を使うこと。
 * @param {(isMobile: boolean) => void} callback
 * @returns {() => void}
 */
export function onResize(callback) {
    return onControlSchemeChange(callback);
}
