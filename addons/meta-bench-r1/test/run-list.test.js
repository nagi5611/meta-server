// addons/meta-bench-r1/test/run-list.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cfg-'));
process.env.META_SRC_DIRECTORY = cfgRoot;
fs.mkdirSync(path.join(cfgRoot, 'data'), { recursive: true });

const { listRunsPublic } = await import('../lib/run-orchestrator.js');

describe('listRunsPublic', () => {
    /** @type {import('better-sqlite3').Database} */
    let db;
    /** @type {string} */
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-list-'));
        db = new Database(path.join(tmpDir, 'test.db'));
        const migration = fs.readFileSync(
            path.join(process.cwd(), 'addons/meta-bench-r1/migrations/001_bench_runs.sql'),
            'utf8'
        );
        db.exec(migration);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns runs newest first with overall score', () => {
        const now = Date.now();
        db.prepare(
            `INSERT INTO bench_runs (id, status, phase, bot_count, scores_json, started_at, created_at)
             VALUES ('old1', 'completed', 'done', 25, '{"hw-cpu":80,"hw-mem":100}', ?, ?)`
        ).run(now - 60_000, now - 60_000);
        db.prepare(
            `INSERT INTO bench_runs (id, status, phase, bot_count, scores_json, started_at, created_at)
             VALUES ('new1', 'partial', 'done', 10, '{"hw-cpu":50,"hw-mem":90}', ?, ?)`
        ).run(now, now);

        const runs = listRunsPublic(db, 10);
        assert.equal(runs.length, 2);
        assert.equal(runs[0].id, 'new1');
        assert.equal(runs[0].status, 'partial');
        assert.equal(typeof runs[0].overallScore, 'number');
        assert.equal(runs[1].id, 'old1');
    });
});
