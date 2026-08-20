// lib/caption-translation.js — Google Cloud Translation API による字幕翻訳（final 時のみ）
import { v2 } from '@google-cloud/translate';
import { resolveSpeechCredentials } from './captions-config.js';
import { normalizeUiLocale, uiLocaleToGoogleTranslateCode } from './ui-locale.js';

/** @type {import('@google-cloud/translate').v2.Translate | null} */
let translateClient = null;

/**
 * Google Cloud Translation v2 クライアントを遅延生成する
 * @returns {Promise<import('@google-cloud/translate').v2.Translate>}
 */
async function getTranslateClient() {
    if (!translateClient) {
        const creds = resolveSpeechCredentials();
        if (creds && creds.mode === 'inline') {
            translateClient = new v2.Translate({
                credentials: creds.credentials,
                projectId: creds.projectId,
            });
        } else {
            translateClient = new v2.Translate();
        }
    }
    return translateClient;
}

/**
 * 字幕確定文を指定ロケールへ翻訳する
 * @param {{ text: string, sourceLocale: import('./ui-locale.js').UiLocale | string, targetLocale: import('./ui-locale.js').UiLocale | string }} params
 * @returns {Promise<{ translated: string, skipped: boolean }>}
 */
export async function translateCaptionText(params) {
    const trimmed = String(params.text || '').trim();
    if (!trimmed) {
        return { translated: trimmed, skipped: true };
    }

    const sourceLocale = normalizeUiLocale(params.sourceLocale);
    const targetLocale = normalizeUiLocale(params.targetLocale);
    if (sourceLocale === targetLocale) {
        return { translated: trimmed, skipped: true };
    }

    const from = uiLocaleToGoogleTranslateCode(sourceLocale);
    const to = uiLocaleToGoogleTranslateCode(targetLocale);

    try {
        const client = await getTranslateClient();
        const [translation] = await client.translate(trimmed, { from, to });
        const translated = String(translation || '').trim();
        if (!translated || translated === trimmed) {
            return { translated: trimmed, skipped: true };
        }
        return { translated, skipped: false };
    } catch (err) {
        console.error('[captions-tr] translation failed:', err?.message || err);
        return { translated: trimmed, skipped: true };
    }
}
