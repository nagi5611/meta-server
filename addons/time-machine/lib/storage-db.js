// addons/time-machine/lib/storage-db.js — addon SQLite 操作
/** @typedef {'off' | 'hourly' | 'daily' | 'both'} StorageRole */

/**
 * @param {import('better-sqlite3').Database} db
 */
export function seedStorageSettings(db, mountIds) {
    const insert = db.prepare(`
        INSERT INTO storage_settings (mount_id, role, hourly_retention, daily_retention, daily_hour, enabled)
        VALUES (?, 'off', 48, 14, 3, 1)
        ON CONFLICT(mount_id) DO NOTHING
    `);
    for (const id of mountIds) insert.run(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ mountId: string, role: StorageRole, hourlyRetention: number, dailyRetention: number, dailyHour: number, enabled: boolean }>}
 */
export function listStorageSettings(db) {
    const rows = db
        .prepare(
            `SELECT mount_id, role, hourly_retention, daily_retention, daily_hour, enabled
               FROM storage_settings
              ORDER BY mount_id ASC`,
        )
        .all();
    return rows.map((r) => ({
        mountId: r.mount_id,
        role: /** @type {StorageRole} */ (r.role),
        hourlyRetention: r.hourly_retention,
        dailyRetention: r.daily_retention,
        dailyHour: r.daily_hour,
        enabled: r.enabled === 1,
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} mountId
 * @param {Partial<{ role: StorageRole, hourlyRetention: number, dailyRetention: number, dailyHour: number, enabled: boolean }>} patch
 */
export function updateStorageSetting(db, mountId, patch) {
    const cur = db.prepare('SELECT * FROM storage_settings WHERE mount_id = ?').get(mountId);
    if (!cur) {
        db.prepare(
            `INSERT INTO storage_settings (mount_id, role, hourly_retention, daily_retention, daily_hour, enabled)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            mountId,
            patch.role ?? 'off',
            patch.hourlyRetention ?? 48,
            patch.dailyRetention ?? 14,
            patch.dailyHour ?? 3,
            patch.enabled === false ? 0 : 1,
        );
        return;
    }
    db.prepare(
        `UPDATE storage_settings SET
            role = ?,
            hourly_retention = ?,
            daily_retention = ?,
            daily_hour = ?,
            enabled = ?,
            updated_at = ?
         WHERE mount_id = ?`,
    ).run(
        patch.role ?? cur.role,
        patch.hourlyRetention ?? cur.hourly_retention,
        patch.dailyRetention ?? cur.daily_retention,
        patch.dailyHour ?? cur.daily_hour,
        patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
        Date.now(),
        mountId,
    );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string | null}
 */
export function getAppState(db, key) {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row ? String(row.value) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} value
 */
export function setAppState(db, key, value) {
    db.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function tryAcquireMutex(db) {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get('mutex');
    if (row && row.value === '1') return false;
    setAppState(db, 'mutex', '1');
    return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function releaseMutex(db) {
    setAppState(db, 'mutex', '0');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function isMutexHeld(db) {
    return getAppState(db, 'mutex') === '1';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} run
 */
export function insertBackupRun(db, run) {
    db.prepare(
        `INSERT INTO backup_runs (id, kind, scope, mount_id, snapshot_dir, status, bytes, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        run.id,
        run.kind,
        run.scope,
        run.mountId,
        run.snapshotDir,
        run.status,
        run.bytes ?? 0,
        run.error ?? null,
        run.startedAt,
        run.finishedAt ?? null,
    );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {Partial<{ status: string, bytes: number, error: string, finishedAt: number }>} patch
 */
export function updateBackupRun(db, id, patch) {
    const cur = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
    if (!cur) return;
    db.prepare(
        `UPDATE backup_runs SET status = ?, bytes = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).run(
        patch.status ?? cur.status,
        patch.bytes ?? cur.bytes,
        patch.error !== undefined ? patch.error : cur.error,
        patch.finishedAt ?? cur.finished_at,
        id,
    );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} [limit]
 */
export function listRecentBackupRuns(db, limit = 20) {
    return db
        .prepare(
            `SELECT id, kind, scope, mount_id, snapshot_dir, status, bytes, error, started_at, finished_at
               FROM backup_runs
              ORDER BY started_at DESC
              LIMIT ?`,
        )
        .all(limit)
        .map((r) => ({
            id: r.id,
            kind: r.kind,
            scope: r.scope,
            mountId: r.mount_id,
            snapshotDir: r.snapshot_dir,
            status: r.status,
            bytes: r.bytes,
            error: r.error,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
        }));
}
