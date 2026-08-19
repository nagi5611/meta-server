// test/ui-locale.test.js — UI ロケールヘルパーの回帰テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getListenerTargetLocales, normalizeUiLocale } from '../lib/ui-locale.js';

/**
 * @param {Record<string, { uiLocale?: string }>} players
 */
function makeRoomState(players) {
    return { players: new Map(Object.entries(players)) };
}

describe('normalizeUiLocale', () => {
    it('returns ja, en, zh as-is', () => {
        assert.equal(normalizeUiLocale('ja'), 'ja');
        assert.equal(normalizeUiLocale('en'), 'en');
        assert.equal(normalizeUiLocale('zh'), 'zh');
    });

    it('defaults unknown values to ja', () => {
        assert.equal(normalizeUiLocale('fr'), 'ja');
        assert.equal(normalizeUiLocale(''), 'ja');
    });
});

describe('getListenerTargetLocales', () => {
    it('returns unique listener locales different from sender', () => {
        const room = makeRoomState({
            sender: { uiLocale: 'ja' },
            a: { uiLocale: 'en' },
            b: { uiLocale: 'en' },
            c: { uiLocale: 'zh' },
        });
        const targets = getListenerTargetLocales(room, 'sender', 'ja');
        assert.deepEqual(targets.sort(), ['en', 'zh']);
    });

    it('excludes sender socket id from listener scan', () => {
        const room = makeRoomState({
            sender: { uiLocale: 'ja' },
            other: { uiLocale: 'en' },
        });
        assert.deepEqual(getListenerTargetLocales(room, 'sender', 'ja'), ['en']);
        assert.deepEqual(getListenerTargetLocales(room, 'other', 'en'), ['ja']);
    });

    it('returns empty when all listeners share sender locale', () => {
        const room = makeRoomState({
            sender: { uiLocale: 'ja' },
            a: { uiLocale: 'ja' },
        });
        assert.deepEqual(getListenerTargetLocales(room, 'sender', 'ja'), []);
    });
});
