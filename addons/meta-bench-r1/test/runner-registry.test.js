// addons/meta-bench-r1/test/runner-registry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    registerRunner,
    clearRunners,
    buildRunnerReportInfo,
} from '../lib/runner-registry.js';

test('buildRunnerReportInfo includes hostInfo from register', () => {
    clearRunners();
    registerRunner({
        name: 'ec2-a',
        recommendedMaxBots: 50,
        hostInfo: {
            hostname: 'ip-10-0-0-1',
            cpuModel: 'Intel Xeon',
            cpuCores: 4,
            totalMemGb: 16,
            platform: 'Linux 6.8.0',
            nodeVersion: 'v22.22.0',
            arch: 'x64',
            mediasoupMode: 'aiortc',
            collectedAt: 1,
        },
    });
    const info = buildRunnerReportInfo('ec2-a');
    assert.equal(info?.name, 'ec2-a');
    assert.equal(info?.hostname, 'ip-10-0-0-1');
    assert.equal(info?.mediasoupMode, 'aiortc');
    assert.equal(info?.recommendedMaxBots, 50);
    clearRunners();
});

test('buildRunnerReportInfo marks missing hostInfo', () => {
    clearRunners();
    const info = buildRunnerReportInfo('ghost-runner');
    assert.equal(info?.name, 'ghost-runner');
    assert.equal(info?.missing, true);
    clearRunners();
});
