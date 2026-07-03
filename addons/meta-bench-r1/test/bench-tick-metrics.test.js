// addons/meta-bench-r1/test/bench-tick-metrics.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    startTickSampling,
    stopTickSampling,
    recordTickEmit,
    getTickMetricsSnapshot,
} from '../../../lib/bench-tick-metrics.js';

test('recordTickEmit counts only while sampling is active', () => {
    stopTickSampling();
    recordTickEmit('lobby');
    let snap = getTickMetricsSnapshot();
    assert.equal(snap.minTickPerSec, 0);
    assert.equal(snap.debug.totalRecordedEmits, 0);

    startTickSampling();
    for (let i = 0; i < 35; i++) recordTickEmit('lobby');
    snap = getTickMetricsSnapshot();
    assert.ok(snap.minTickPerSec >= 30);
    assert.equal(snap.byRoom.lobby, 35);
    assert.equal(snap.debug.totalRecordedEmits, 35);
    stopTickSampling();
});
