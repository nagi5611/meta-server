// addons/meta-bench-r1/test/audio-match.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAudioMatchPct } from '../runner/audio-match.js';
import { SAMPLE_RATE } from '../runner/audio-decode.js';

describe('audio-match', () => {
    it('identical PCM scores near 100', () => {
        const len = SAMPLE_RATE * 2;
        const pcm = new Float32Array(len);
        for (let i = 0; i < len; i++) pcm[i] = Math.sin((i / SAMPLE_RATE) * 440 * 2 * Math.PI) * 0.5;
        const score = computeAudioMatchPct(pcm, pcm);
        assert.ok(score >= 95, `expected >=95 got ${score}`);
    });

    it('uncorrelated noise scores low', () => {
        const len = SAMPLE_RATE * 2;
        const a = new Float32Array(len);
        const b = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            a[i] = Math.sin((i / SAMPLE_RATE) * 440 * 2 * Math.PI);
            b[i] = Math.random() * 2 - 1;
        }
        const score = computeAudioMatchPct(a, b);
        assert.ok(score < 50, `expected <50 got ${score}`);
    });
});
