// lib/ui-locale.js — メタバース UI 言語コードの正規化

/** @typedef {'ja' | 'en' | 'zh'} UiLocale */

/**
 * @param {unknown} raw
 * @returns {UiLocale}
 */
export function normalizeUiLocale(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'ja' || s === 'en' || s === 'zh') {
        return s;
    }
    return 'ja';
}

/**
 * ルーム内に日本語 UI の他プレイヤーがいるか
 * @param {{ players: Map<string, { uiLocale?: string }> }} roomState
 * @param {string} excludeSocketId
 * @returns {boolean}
 */
export function roomHasJapaneseListener(roomState, excludeSocketId) {
    for (const [id, p] of roomState.players) {
        if (id === excludeSocketId) continue;
        if (normalizeUiLocale(p.uiLocale) === 'ja') return true;
    }
    return false;
}
