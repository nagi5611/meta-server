// addons/meta-benchR1/test/bench-token.test.js
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
    signBenchToken,
    verifyBenchToken,
    peekBenchToken,
} from '../../../lib/bench-maintenance.js';

describe('bench-token', () => {
    before(() => {
        process.env.BENCH_TOKEN_SECRET = 'test-secret-for-bench-token-unit-tests';
    });

    it('sign and verify roundtrip', () => {
        const token = signBenchToken('run-abc', 60_000);
        const v = verifyBenchToken(token);
        assert.ok(v);
        assert.equal(v.runId, 'run-abc');
        assert.equal(peekBenchToken(token), true);
    });

    it('rejects tampered token', () => {
        const token = signBenchToken('run-xyz');
        const bad = token.slice(0, -2) + 'xx';
        assert.equal(verifyBenchToken(bad), null);
    });

    it('rejects empty runId', () => {
        assert.throws(() => signBenchToken(''));
    });
});
