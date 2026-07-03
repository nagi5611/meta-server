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
    assert.equal(snap.minTickPerSec, 0);
    assert.equal(snap.debug.totalRecordedEmits, 0);
    assert.ok(snap.debug.skippedNotSampling >= 1);

    registerTickHookInstalled();
    setBenchMaintenance({ active: true, runId: 'test-run' });
    startTickSampling('test-run');
    for (let i = 0; i < 35; i++) recordTickEmit('lobby');
    snap = getTickMetricsSnapshot();
    assert.ok(snap.minTickPerSec >= 30);
    assert.equal(snap.byRoom.lobby, 35);
    assert.equal(snap.debug.totalRecordedEmits, 35);
    assert.equal(snap.debug.hookInstalled, true);
    stopTickSampling();
    setBenchMaintenance({ active: false });
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
