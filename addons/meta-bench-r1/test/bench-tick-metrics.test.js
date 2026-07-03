// addons/meta-bench-r1/test/bench-tick-metrics.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    startTickSampling,
    stopTickSampling,
    recordTickEmit,
    getTickMetricsSnapshot,
    registerTickHookInstalled,
    diagnoseTickMetrics,
} from '../../../lib/bench-tick-metrics.js';
import { setBenchMaintenance } from '../../../lib/bench-maintenance.js';

test('recordTickEmit counts only while sampling is active', () => {
    stopTickSampling();
    setBenchMaintenance({ active: false });
    recordTickEmit('lobby');
    let snap = getTickMetricsSnapshot();
    assert.equal(snap.avgTickPerSec, 0);
    assert.equal(snap.debug.totalRecordedEmits, 0);
    assert.ok(snap.debug.skippedNotSampling >= 1);

    registerTickHookInstalled();
    setBenchMaintenance({ active: true, runId: 'test-run' });
    startTickSampling('test-run');
    for (let i = 0; i < 35; i++) recordTickEmit('lobby');
    snap = getTickMetricsSnapshot();
    assert.ok(snap.avgTickPerSec >= 30);
    assert.equal(snap.byRoom.lobby, 35);
    assert.equal(snap.debug.totalRecordedEmits, 35);
    assert.equal(snap.debug.hookInstalled, true);
    stopTickSampling();
    setBenchMaintenance({ active: false });
});

test('avgTickPerSec uses mean not worst second', () => {
    stopTickSampling();
    registerTickHookInstalled();
    startTickSampling('avg-test');
    // 1秒目: 11 tick, 2秒目: 30 tick（バケットを進める）
    for (let i = 0; i < 11; i++) recordTickEmit('lobby');
    const bucketStart = Date.now();
    while (Date.now() - bucketStart < 1000) {
        /* wait for next second bucket */
    }
    for (let i = 0; i < 30; i++) recordTickEmit('lobby');
    const snap = getTickMetricsSnapshot();
    assert.equal(snap.minTickPerSec, 11);
    assert.ok(snap.avgTickPerSec >= 20, `expected avg >= 20, got ${snap.avgTickPerSec}`);
    stopTickSampling();
});

test('diagnoseTickMetrics explains skip-not-sampling', () => {
    const msg = diagnoseTickMetrics({
        hookInstalled: true,
        totalHookCalls: 100,
        totalRecordedEmits: 0,
        skippedNotSampling: 100,
        pid: 12345,
    });
    assert.match(msg, /sampling=false/);
    assert.match(msg, /12345/);
});
