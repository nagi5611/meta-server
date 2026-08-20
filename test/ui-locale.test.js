// test/ui-locale.test.js — UI ロケールヘルパーの回帰テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCaptionListenerTargetLocales, getListenerTargetLocales, normalizeUiLocale } from '../lib/ui-locale.js';

/**
 * @param {Record<string, { uiLocale?: string }>} players
 */
function makeRoomState(players) {
    return { players: new Map(Object.entries(players)) };
}

describe('normalizeUiLocale', () => {
    it('returns ja, en, zh, ko, zh-tw as-is', () => {
        assert.equal(normalizeUiLocale('ja'), 'ja');
        assert.equal(normalizeUiLocale('en'), 'en');
        assert.equal(normalizeUiLocale('zh'), 'zh');
        assert.equal(normalizeUiLocale('ko'), 'ko');
        assert.equal(normalizeUiLocale('zh-tw'), 'zh-tw');
    });

    it('maps zh-hant variants to zh-tw', () => {
        assert.equal(normalizeUiLocale('zh-TW'), 'zh-tw');
        assert.equal(normalizeUiLocale('zh-hant'), 'zh-tw');
    });

    it('maps ko variants to ko', () => {
        assert.equal(normalizeUiLocale('ko-KR'), 'ko');
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

describe('getCaptionListenerTargetLocales', () => {
    it('only considers caption listener socket ids', () => {
        const room = makeRoomState({
            speaker: { uiLocale: 'ja' },
            listenerA: { uiLocale: 'en' },
            listenerB: { uiLocale: 'zh' },
            notListening: { uiLocale: 'ko' },
        });
        const targets = getCaptionListenerTargetLocales(
            room,
            new Set(['listenerA', 'listenerB']),
            'speaker',
            'ja',
        );
        assert.deepEqual(targets.sort(), ['en', 'zh']);
    });

    it('excludes speaker and same-locale listeners', () => {
        const room = makeRoomState({
            speaker: { uiLocale: 'ja' },
            listenerA: { uiLocale: 'ja' },
            listenerB: { uiLocale: 'en' },
        });
        assert.deepEqual(
            getCaptionListenerTargetLocales(room, new Set(['speaker', 'listenerA', 'listenerB']), 'speaker', 'ja'),
            ['en'],
        );
    });
});
