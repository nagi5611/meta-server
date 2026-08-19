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
 * 送信者と異なる uiLocale を持つリスナーのユニークなロケール一覧を返す
 * @param {{ players: Map<string, { uiLocale?: string }> }} roomState
 * @param {string} excludeSocketId
 * @param {UiLocale} senderLocale
 * @returns {UiLocale[]}
 */
export function getListenerTargetLocales(roomState, excludeSocketId, senderLocale) {
    /** @type {Set<UiLocale>} */
    const targets = new Set();
    for (const [id, p] of roomState.players) {
        if (id === excludeSocketId) continue;
        const locale = normalizeUiLocale(p.uiLocale);
        if (locale !== senderLocale) {
            targets.add(locale);
        }
    }
    return [...targets];
}
