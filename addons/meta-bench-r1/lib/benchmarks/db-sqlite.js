// addons/meta-bench-r1/lib/benchmarks/db-sqlite.js
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { STORAGE_PATHS } from '../../../../config/storage-paths.js';
import { countBenchUsers } from '../../../../db/users.js';

/**
 * @param {string} dbPath
 * @param {() => void} runQuery
 * @returns {number} max latency ms
 */
function measureQuery(dbPath, runQuery) {
    if (!fs.existsSync(dbPath)) return -1;
    const db = new Database(dbPath, { readonly: false });
    try {
        const start = process.hrtime.bigint();
        runQuery(db);
        return Number(process.hrtime.bigint() - start) / 1e6;
    } finally {
        db.close();
    }
}

/**
 * @param {string} addonDbPath
 * @returns {{ maxLatencyMs: number, details: Array<{ target: string, latencyMs: number }> }}
 */
export function runDbSqliteBenchmark(addonDbPath) {
    /** @type {Array<{ target: string, latencyMs: number }>} */
    const details = [];

    const usersPath = path.join(STORAGE_PATHS.DB_DIR, 'users.db');
    details.push({
        target: 'users.db SELECT',
        latencyMs: measureQuery(usersPath, (db) => {
            db.prepare('SELECT COUNT(*) AS c FROM students').get();
            db.prepare('SELECT COUNT(*) AS c FROM bench_users').get();
        }),
    });

    const registryPath = path.join(STORAGE_PATHS.DB_DIR, 'addons_registry.db');
    details.push({
        target: 'addons_registry.db SELECT',
        latencyMs: measureQuery(registryPath, (db) => {
            db.prepare('SELECT COUNT(*) AS c FROM addon_enabled').get();
        }),
    });

    if (addonDbPath && fs.existsSync(addonDbPath)) {
        details.push({
            target: 'meta-bench-r1.db SELECT',
            latencyMs: measureQuery(addonDbPath, (db) => {
                db.prepare('SELECT COUNT(*) AS c FROM bench_runs').get();
            }),
        });
        details.push({
            target: 'meta-bench-r1.db INSERT/DELETE',
            latencyMs: measureQuery(addonDbPath, (db) => {
                db.exec('BEGIN');
                try {
                    db.prepare(
                        `INSERT INTO bench_runs (id, status, phase, bot_count) VALUES ('__bench_probe__', 'failed', 'probe', 0)`
                    ).run();
                    db.prepare(`DELETE FROM bench_runs WHERE id = '__bench_probe__'`).run();
                    db.exec('COMMIT');
                } catch (e) {
                    db.exec('ROLLBACK');
                    throw e;
                }
            }),
        });
    }

    void countBenchUsers;

    const valid = details.filter((d) => d.latencyMs >= 0);
    const maxLatencyMs = valid.length ? Math.max(...valid.map((d) => d.latencyMs)) : 0;
    return { maxLatencyMs, details };
}
