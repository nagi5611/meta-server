// addons/meta-bench-r1/test/preflight.test.js
import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.META_SRC_DIRECTORY = repoRoot;

const { runPreflightChecks } = await import('../lib/preflight.js');
const { registerRunner, attachRunnerSocket, clearRunners } = await import('../lib/runner-registry.js');
const { setMediasoupReadyChecker } = await import('../../../lib/bench-maintenance.js');

describe('preflight', () => {
    beforeEach(() => {
        clearRunners();
        setMediasoupReadyChecker(() => true);
        registerRunner({ name: 'test-runner', recommendedMaxBots: 20 });
        attachRunnerSocket('test-runner', 'test-socket-id');
    });

    it('fails when bot count exceeds recommended max', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pf-'));
        const result = runPreflightChecks({
            db: { prepare: () => ({ get: () => ({}) }) },
            reportsDir: dir,
            botCount: 50,
            hasActiveRun: false,
            runnerName: 'test-runner',
        });
        assert.equal(result.ok, false);
        assert.ok(result.failures.some((f) => f.includes('推奨 max')));
    });

    it('fails when runner socket is not attached', () => {
        clearRunners();
        registerRunner({ name: 'test-runner', recommendedMaxBots: 20 });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pf-'));
        const result = runPreflightChecks({
            db: { prepare: () => ({ get: () => ({}) }) },
            reportsDir: dir,
            botCount: 10,
            hasActiveRun: false,
            runnerName: 'test-runner',
        });
        assert.equal(result.ok, false);
        assert.ok(result.failures.some((f) => f.includes('Socket.IO')));
    });

    it('fails when another run is active', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pf-'));
        const result = runPreflightChecks({
            db: { prepare: () => ({ get: () => ({}) }) },
            reportsDir: dir,
            botCount: 10,
            hasActiveRun: true,
            runnerName: 'test-runner',
        });
        assert.equal(result.ok, false);
        assert.ok(result.failures.some((f) => f.includes('実行中')));
    });

    it('fails when runner not selected', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pf-'));
        const result = runPreflightChecks({
            db: { prepare: () => ({ get: () => ({}) }) },
            reportsDir: dir,
            botCount: 10,
            hasActiveRun: false,
        });
        assert.equal(result.ok, false);
        assert.ok(result.failures.some((f) => f.includes('Runner を選択')));
    });
});
