// test/chat-moderation-jev.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    interpretJevModerationResponse,
    jevPrimaryChatCheck,
    getJevThreshold,
} from '../lib/chat-moderation-jev.js';
import { formatSecondaryModerationReason } from '../lib/chat-moderation.js';

describe('interpretJevModerationResponse', () => {
    const threshold = 0.6;

    it('honors allowed boolean', () => {
        assert.deepEqual(interpretJevModerationResponse({ allowed: true, score: 0.1 }, threshold), {
            allow: true,
            score: 0.1,
            reason: null,
        });
    });

    it('blocks when score >= threshold', () => {
        assert.equal(interpretJevModerationResponse({ score: 0.9 }, threshold).allow, false);
        assert.equal(interpretJevModerationResponse({ score: 0.2 }, threshold).allow, true);
    });

    it('blocks on action block', () => {
        assert.equal(interpretJevModerationResponse({ action: 'block' }, threshold).allow, false);
    });
});

describe('jevPrimaryChatCheck', () => {
    it('posts JSON and maps allow from score', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return {
                ok: true,
                async text() {
                    return JSON.stringify({ score: 0.1 });
                },
            };
        };

        const result = await jevPrimaryChatCheck({
            text: 'こんにちは',
            apiUrl: 'https://jev.example/check',
            apiKey: 'test-key',
            threshold: 0.5,
            fetchImpl,
        });

        assert.equal(result.allow, true);
        assert.equal(calls[0].body.text, 'こんにちは');
    });
});

describe('formatSecondaryModerationReason', () => {
    it('combines category and reason', () => {
        assert.equal(
            formatSecondaryModerationReason({ category_ja: '暴言', reason_ja: '攻撃的な表現' }),
            '【暴言】攻撃的な表現',
        );
    });
});

describe('getJevThreshold', () => {
    it('defaults to 0.5 when env unset', () => {
        assert.equal(getJevThreshold(), 0.5);
    });
});
