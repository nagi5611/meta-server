// addons/meta-bench-r1/test/bench-audio-path.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBenchAudioPath, PROJECT_ROOT } from '../lib/bench-audio-path.js';

describe('bench-audio-path', () => {
    it('defaults to public/music/bench_sample.mp3', () => {
        const p = resolveBenchAudioPath();
        assert.equal(p, path.resolve(PROJECT_ROOT, 'public/music/bench_sample.mp3'));
    });

    it('resolves relative path under project root', () => {
        const p = resolveBenchAudioPath('public/music/bench_sample.mp3');
        assert.equal(p, path.resolve(PROJECT_ROOT, 'public/music/bench_sample.mp3'));
    });
});
