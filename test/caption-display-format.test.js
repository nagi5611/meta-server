// test/caption-display-format.test.js — 字幕翻訳表示フォーマットの回帰テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * caption-manager.js の _formatDisplayText と同等のロジック
 * @param {string} original
 * @param {string|undefined} translatedMessage
 * @param {boolean} isOwnSpeaker
 */
function formatCaptionDisplayText(original, translatedMessage, isOwnSpeaker = false) {
    if (isOwnSpeaker) return original;
    const translated = translatedMessage;
    if (typeof translated === 'string' && translated.trim() && translated !== original) {
        return `${original} (${translated.trim()})`;
    }
    return original;
}

describe('formatCaptionDisplayText', () => {
    it('shows original (translation) for other speakers', () => {
        assert.equal(
            formatCaptionDisplayText('こんにちは', 'Hello'),
            'こんにちは (Hello)',
        );
    });

    it('shows original only for own speaker', () => {
        assert.equal(
            formatCaptionDisplayText('Hello', 'こんにちは', true),
            'Hello',
        );
    });

    it('shows original when translation matches or is missing', () => {
        assert.equal(formatCaptionDisplayText('Hi', undefined), 'Hi');
        assert.equal(formatCaptionDisplayText('Hi', 'Hi'), 'Hi');
    });
});
