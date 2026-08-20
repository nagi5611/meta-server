// lib/ui-locale.js — メタバース UI 言語コードの正規化

/** @typedef {'ja' | 'en' | 'zh' | 'ko' | 'zh-tw'} UiLocale */

/**
 * @param {unknown} raw
 * @returns {UiLocale}
 */
export function normalizeUiLocale(raw) {
    const s = String(raw || '').toLowerCase().replace(/_/g, '-');
    if (s === 'ja' || s === 'en' || s === 'zh' || s === 'ko' || s === 'zh-tw') {
        return s;
    }
    if (s === 'zh-hk' || s === 'zh-mo' || s === 'zh-hant' || s.startsWith('zh-tw')) {
        return 'zh-tw';
    }
    if (s.startsWith('ko')) {
        return 'ko';
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

/** @type {Record<UiLocale, string>} */
const GOOGLE_TRANSLATE_CODES = {
    ja: 'ja',
    en: 'en',
    zh: 'zh-CN',
    ko: 'ko',
    'zh-tw': 'zh-TW',
};

/**
 * uiLocale を Google Cloud Translation API の言語コードへ変換する
 * @param {unknown} raw
 * @returns {string}
 */
export function uiLocaleToGoogleTranslateCode(raw) {
    const locale = normalizeUiLocale(raw);
    return GOOGLE_TRANSLATE_CODES[locale] || GOOGLE_TRANSLATE_CODES.ja;
}

/**
 * 字幕 ON の聞き手のうち、話者と uiLocale が異なるユニークロケール一覧を返す
 * @param {{ players: Map<string, { uiLocale?: string }> }} roomState
 * @param {Iterable<string>} captionListenerIds
 * @param {string} speakerSocketId
 * @param {UiLocale} speakerLocale
 * @returns {UiLocale[]}
 */
export function getCaptionListenerTargetLocales(roomState, captionListenerIds, speakerSocketId, speakerLocale) {
    /** @type {Set<UiLocale>} */
    const targets = new Set();
    for (const id of captionListenerIds) {
        if (id === speakerSocketId) continue;
        const p = roomState.players.get(id);
        if (!p) continue;
        const locale = normalizeUiLocale(p.uiLocale);
        if (locale !== speakerLocale) {
            targets.add(locale);
        }
    }
    return [...targets];
}
