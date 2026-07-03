// addons/meta-benchR1/test/scoring.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    clampScore,
    scoreMvTps,
    scoreCpuDegrade,
    scorePingP95,
    scoreMvDegrade,
    scoreDbLatency,
    scorePacketLoss,
    scoreVoiceMatch,
    scoreMvConnect,
    overallScore,
} from '../lib/scoring.js';

describe('scoring', () => {
    it('clampScore bounds 0-100', () => {
        assert.equal(clampScore(-5), 0);
        assert.equal(clampScore(150), 100);
        assert.equal(clampScore(50), 50);
    });

    it('scoreMvTps at theoretical max', () => {
        assert.equal(scoreMvTps(30, 30), 100);
        assert.ok(scoreMvTps(27, 30) < 100);
    });

    it('scoreCpuDegrade', () => {
        assert.equal(scoreCpuDegrade(0), 100);
        assert.equal(scoreCpuDegrade(0.5), 0);
    });

    it('scorePingP95', () => {
        assert.equal(scorePingP95(50), 100);
        assert.equal(scorePingP95(300), 0);
    });

    it('scoreMvDegrade weighted', () => {
        const s = scoreMvDegrade({ tpsScore: 100, cpuScore: 100, pingScore: 100 });
        assert.equal(s, 100);
    });

    it('scoreDbLatency', () => {
        assert.equal(scoreDbLatency(5), 100);
        assert.equal(scoreDbLatency(200), 0);
    });

    it('scorePacketLoss', () => {
        assert.equal(scorePacketLoss(0), 100);
        assert.equal(scorePacketLoss(5), 0);
    });

    it('scoreVoiceMatch', () => {
        assert.equal(scoreVoiceMatch(100), 100);
        assert.equal(scoreVoiceMatch(50), 50);
        assert.equal(scoreVoiceMatch(null), 0);
    });

    it('scoreMvConnect', () => {
        assert.ok(scoreMvConnect(100, 50) >= 90);
    });

    it('overallScore averages', () => {
        assert.equal(overallScore({ a: 80, b: 60 }), 70);
        assert.equal(overallScore({}, ['a']), null);
        assert.equal(overallScore({ a: 80, b: 20 }, ['a']), 80);
    });
});
