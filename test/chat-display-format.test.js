// test/chat-display-format.test.js — チャット翻訳表示フォーマットの回帰テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * chat-manager.js の formatDisplayMessage と同等のロジック
 * @param {{ message?: string, translatedMessage?: string }} data
 * @param {boolean} isOwnMessage
 */
function formatDisplayMessage(data, isOwnMessage = false) {
    const original = data.message ?? '';
    if (isOwnMessage) {
        return original;
    }
    const translated = data.translatedMessage;
    if (typeof translated === 'string' && translated.trim() && translated !== original) {
        return `${original} (${translated})`;
    }
    return original;
}

/**
 * emitChatToRoomWithLocale のペイロード組み立てロジック
 * @param {'ja' | 'en' | 'zh'} senderLocale
 * @param {'ja' | 'en' | 'zh'} listenerLocale
 * @param {string} originalMessage
 * @param {Partial<Record<'ja' | 'en' | 'zh', string>>} translationsByLocale
 */
function buildRecipientPayload(senderLocale, listenerLocale, originalMessage, translationsByLocale) {
    const translated = translationsByLocale[listenerLocale];
    if (listenerLocale !== senderLocale && translated && translated !== originalMessage) {
        return { message: originalMessage, translatedMessage: translated };
    }
    return { message: originalMessage };
}

describe('formatDisplayMessage', () => {
    it('shows original (translation) for recipients', () => {
        assert.equal(
            formatDisplayMessage({ message: 'こんにちは', translatedMessage: 'Hello' }),
            'こんにちは (Hello)',
        );
    });

    it('shows original only for own messages', () => {
        assert.equal(
            formatDisplayMessage({ message: 'Hello', translatedMessage: 'こんにちは' }, true),
            'Hello',
        );
    });

    it('shows original when translation matches or is missing', () => {
        assert.equal(formatDisplayMessage({ message: 'Hi' }), 'Hi');
        assert.equal(formatDisplayMessage({ message: 'Hi', translatedMessage: 'Hi' }), 'Hi');
    });
});

describe('buildRecipientPayload', () => {
    it('adds translatedMessage when locales differ', () => {
        const payload = buildRecipientPayload('ja', 'en', 'こんにちは', { en: 'Hello' });
        assert.deepEqual(payload, { message: 'こんにちは', translatedMessage: 'Hello' });
    });

    it('omits translatedMessage when locales match', () => {
        const payload = buildRecipientPayload('ja', 'ja', 'こんにちは', { en: 'Hello' });
        assert.deepEqual(payload, { message: 'こんにちは' });
    });
});
