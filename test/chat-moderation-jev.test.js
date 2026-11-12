// test/chat-moderation-jev.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    interpretJevModerationResponse,
    jevPrimaryChatCheck,
    getJevThreshold,
    extractJevNoulScore,
    buildJevSystemOneRequestBody,
    DEFAULT_JEV_API_URL,
    isJevChatModerationEnabled,
} from '../lib/chat-moderation-jev.js';
import { formatSecondaryModerationReason } from '../lib/chat-moderation.js';

describe('extractJevNoulScore', () => {
    it('reads harmful.noul', () => {
        assert.equal(extractJevNoulScore({ harmful: { noul: 0.83 } }), 0.83);
    });
});

describe('buildJevSystemOneRequestBody', () => {
    it('includes noul question by default', () => {
        const body = buildJevSystemOneRequestBody('hello');
        assert.equal(body.model, 'jev-latest');
        assert.ok(body.questions?.harmful?.type === 'noul');
    });
});

describe('interpretJevModerationResponse', () => {
    const threshold = 0.6;

    it('blocks when noul >= threshold', () => {
        assert.equal(
            interpretJevModerationResponse({ harmful: { noul: 0.9 } }, threshold).allow,
            false,
        );
        assert.equal(
            interpretJevModerationResponse({ harmful: { noul: 0.2 } }, threshold).allow,
            true,
        );
    });

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
    it('posts System One JSON and maps noul', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return {
                ok: true,
                async text() {
                    return JSON.stringify({ harmful: { noul: 0.1 } });
                },
            };
        };

        const result = await jevPrimaryChatCheck({
            text: 'こんにちは',
            apiUrl: DEFAULT_JEV_API_URL,
            apiKey: 'test-key',
            threshold: 0.5,
            fetchImpl,
        });

        assert.equal(result.allow, true);
        assert.equal(calls[0].url, DEFAULT_JEV_API_URL);
        assert.equal(calls[0].body.state, 'こんにちは');
        assert.equal(calls[0].body.questions.harmful.type, 'noul');
    });
});

describe('isJevChatModerationEnabled', () => {
    it('is false without env in test process', () => {
        assert.equal(isJevChatModerationEnabled(), false);
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
