// test/caption-translation.test.js — 字幕翻訳ヘルパーの単体テスト（API 呼び出しなし）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uiLocaleToGoogleTranslateCode } from '../lib/ui-locale.js';
import { translateCaptionText } from '../lib/caption-translation.js';

describe('uiLocaleToGoogleTranslateCode', () => {
    it('maps ui locales to Google Translation codes', () => {
        assert.equal(uiLocaleToGoogleTranslateCode('ja'), 'ja');
        assert.equal(uiLocaleToGoogleTranslateCode('en'), 'en');
        assert.equal(uiLocaleToGoogleTranslateCode('zh'), 'zh-CN');
        assert.equal(uiLocaleToGoogleTranslateCode('ko'), 'ko');
        assert.equal(uiLocaleToGoogleTranslateCode('zh-tw'), 'zh-TW');
    });
});

describe('translateCaptionText (skipped paths)', () => {
    it('skips empty text', async () => {
        const result = await translateCaptionText({
            text: '   ',
            sourceLocale: 'ja',
            targetLocale: 'en',
        });
        assert.equal(result.skipped, true);
        assert.equal(result.translated, '');
    });

    it('skips when source and target locales match', async () => {
        const result = await translateCaptionText({
            text: 'こんにちは',
            sourceLocale: 'ja',
            targetLocale: 'ja',
        });
        assert.equal(result.skipped, true);
        assert.equal(result.translated, 'こんにちは');
    });
});
