// addons/meta-bench-r1/test/bench-phases.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeBenchPhases,
    isBenchPhaseEnabled,
    scoreKeysForPhases,
    DEFAULT_BENCH_PHASES,
} from '../lib/bench-phases.js';

describe('bench-phases', () => {
    it('defaults to all phases', () => {
        assert.deepEqual(normalizeBenchPhases(undefined), DEFAULT_BENCH_PHASES);
        assert.deepEqual(normalizeBenchPhases([]), DEFAULT_BENCH_PHASES);
    });

    it('filters invalid phase ids', () => {
        const p = normalizeBenchPhases(['audio-vc', 'invalid', 'hw']);
        assert.deepEqual(p, ['audio-vc', 'hw']);
    });

    it('scoreKeysForPhases audio only', () => {
        const keys = scoreKeysForPhases(['audio-vc']);
        assert.deepEqual(keys, ['audio-vc']);
        assert.equal(isBenchPhaseEnabled(['audio-vc'], 'db-sqlite'), false);
    });
});
