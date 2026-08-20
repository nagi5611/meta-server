// test/speech-captions.test.js — mock STT プロバイダの単体テスト（資格情報不要）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionSession, isCaptionStreamWritable } from '../lib/speech-captions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 16kHz mono 16bit LE の「発話相当」PCM（~100ms=1600 サンプル）を作る */
function makeSpeechChunk() {
    const buf = Buffer.alloc(1600 * 2);
    for (let i = 0; i < 1600; i++) buf.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
    return buf;
}

/** 無音 PCM */
function makeSilenceChunk() {
    return Buffer.alloc(1600 * 2); // all zeros
}

describe('isCaptionStreamWritable', () => {
    it('null / destroyed / non-writable を拒否する', () => {
        assert.equal(isCaptionStreamWritable(null), false);
        assert.equal(isCaptionStreamWritable(undefined), false);
        assert.equal(isCaptionStreamWritable({ destroyed: true, writable: true }), false);
        assert.equal(isCaptionStreamWritable({ destroyed: false, writable: false }), false);
        assert.equal(isCaptionStreamWritable({ destroyed: false, writable: true }), true);
        assert.equal(isCaptionStreamWritable({ destroyed: false }), true);
    });
});

describe('speech-captions (mock provider)', () => {
    it('発話 PCM で interim と final を返す', async () => {
        const events = [];
        const session = await createCaptionSession({
            provider: 'mock',
            onInterim: (t) => events.push(['interim', t]),
            onFinal: (t) => events.push(['final', t]),
        });
        assert.equal(session.isMock, true);

        // ~1.4s ぶん発話を流す
        const speech = makeSpeechChunk();
        for (let i = 0; i < 14; i++) { session.write(speech); await sleep(100); }
        // 無音にして final を待つ
        await sleep(1500);
        session.close();

        const hasInterim = events.some((e) => e[0] === 'interim');
        const hasFinal = events.some((e) => e[0] === 'final');
        assert.ok(hasInterim, 'interim が発生すること');
        assert.ok(hasFinal, 'final が発生すること');
    });

    it('無音のみでは final を出さない', async () => {
        const events = [];
        const session = await createCaptionSession({
            provider: 'mock',
            onInterim: (t) => events.push(['interim', t]),
            onFinal: (t) => events.push(['final', t]),
        });
        const silence = makeSilenceChunk();
        for (let i = 0; i < 6; i++) { session.write(silence); await sleep(100); }
        await sleep(600);
        session.close();
        assert.equal(events.length, 0, '無音では何も出力しない');
    });
});
