// addons/time-machine/lib/backup-runner.js — バックアップジョブ実行
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    resolveScopeTargets,
    defaultScopeForKind,
    listSqliteDbFiles,
    shouldExcludeDir,
    getRepoRoot,
} from './backup-scopes.js';
import { buildSnapshotDir } from './mounts.js';
import {
    formatDailySnapshotId,
    formatHourlySnapshotId,
    writeManifest,
} from './snapshot-meta.js';
import { copyDir, copyFile, dirSizeBytes } from './file-copy.js';
import { backupSqliteFiles, isSqlite3Available } from './sqlite-backup.js';
import { pruneSnapshots } from './retention.js';
import {
    insertBackupRun,
    updateBackupRun,
    tryAcquireMutex,
    releaseMutex,
    listStorageSettings,
} from './storage-db.js';

const EXCLUDE_NAMES = ['node_modules', '.git', 'logs', 'metaverse-simple'];

/**
 * @typedef {object} BackupRunRequest
 * @property {'hourly' | 'daily' | 'immediate'} kind
 * @property {import('./backup-scopes.js').BackupScope} [scope]
 * @property {string} mountId
 * @property {string} mountPath
 * @property {import('better-sqlite3').Database} db
 * @property {string} [serverVersion]
 * @property {number} [hourlyRetention]
 * @property {number} [dailyRetention]
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} mountId
 * @param {'hourly' | 'daily'} kind
 * @returns {{ mountId: string, mountPath: string, hourlyRetention: number, dailyRetention: number } | null}
 */
export function resolveMountForScheduled(db, mountId, mountPath, kind) {
    const settings = listStorageSettings(db);
    const s = settings.find((x) => x.mountId === mountId);
    if (!s || !s.enabled) return null;
    if (kind === 'hourly' && s.role !== 'hourly' && s.role !== 'both') return null;
    if (kind === 'daily' && s.role !== 'daily' && s.role !== 'both') return null;
    return {
        mountId,
        mountPath,
        hourlyRetention: s.hourlyRetention,
        dailyRetention: s.dailyRetention,
    };
}

/**
 * @param {BackupRunRequest} req
 * @returns {Promise<{ ok: boolean, runId: string, snapshotDir?: string, error?: string }>}
 */
export async function runBackupJob(req) {
    const { kind, mountId, mountPath, db } = req;
    if (!tryAcquireMutex(db)) {
        return { ok: false, runId: '', error: 'backup_or_rollback_in_progress' };
    }

    const runId = crypto.randomUUID();
    const hostname = os.hostname();
    const scope = req.scope ?? defaultScopeForKind(kind === 'immediate' ? 'state' : kind);
    const snapshotKind = kind === 'daily' || (kind === 'immediate' && scope === 'full') ? 'daily' : 'hourly';
    const snapshotId =
        snapshotKind === 'daily' ? formatDailySnapshotId() : formatHourlySnapshotId();
    const snapshotDir = buildSnapshotDir(mountPath, hostname, snapshotKind, snapshotId);
    const lockFile = path.join(mountPath, 'metaverse-simple', '.backup-in-progress');

    insertBackupRun(db, {
        id: runId,
        kind,
        scope,
        mountId,
        snapshotDir,
        status: 'running',
        bytes: 0,
        startedAt: Date.now(),
    });

    try {
        if (!(await isSqlite3Available())) {
            throw new Error('sqlite3 CLI not found in PATH');
        }

        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        fs.writeFileSync(lockFile, `${runId}\n`, 'utf8');
        fs.mkdirSync(snapshotDir, { recursive: true });

        const backupMountRoots = [mountPath];
        const targets = resolveScopeTargets(scope, backupMountRoots);
        const skipDir = (d) => shouldExcludeDir(d, backupMountRoots);

        for (const t of targets) {
            if (t.type === 'file') {
                copyFile(t.src, path.join(snapshotDir, t.destSub));
            } else if (t.type === 'dir') {
                const dest = path.join(snapshotDir, t.destSub);
                if (scope === 'state' && t.destSub === 'db') {
                    const dbs = listSqliteDbFiles(t.src);
                    const { errors } = await backupSqliteFiles(dbs, snapshotDir, 'db');
                    if (errors.length) throw new Error(errors.join('; '));
                } else if (scope === 'state' && t.destSub === 'db/plugin-databases') {
                    const dbs = listSqliteDbFiles(t.src);
                    const { errors } = await backupSqliteFiles(dbs, snapshotDir, 'db/plugin-databases');
                    if (errors.length) throw new Error(errors.join('; '));
                } else if (scope === 'state' && t.destSub === 'data') {
                    await copyDir(t.src, dest, [...EXCLUDE_NAMES, 'plugin-databases']);
                } else {
                    await copyDir(t.src, dest, EXCLUDE_NAMES);
                }
            }
        }

        if (scope === 'state') {
            const pluginDbDir = path.join(snapshotDir, 'db', 'plugin-databases');
            const dataPluginDir = path.join(getRepoRoot(), 'data', 'plugin-databases');
            if (
                fs.existsSync(dataPluginDir) &&
                !fs.existsSync(pluginDbDir) &&
                listSqliteDbFiles(dataPluginDir).length
            ) {
                const { errors } = await backupSqliteFiles(
                    listSqliteDbFiles(dataPluginDir),
                    snapshotDir,
                    'db/plugin-databases',
                );
                if (errors.length) throw new Error(errors.join('; '));
            }
        }

        const bytes = dirSizeBytes(snapshotDir);
        const restoreTargets = targets.map((t) => (t.type === 'file' ? t.destSub : t.destSub));

        writeManifest(snapshotDir, {
            v: 1,
            snapshotId,
            kind: snapshotKind,
            scope,
            mountId,
            hostname,
            createdAt: new Date().toISOString(),
            serverVersion: req.serverVersion,
            bytes,
            restoreTargets,
        });

        const hourlyRetention = req.hourlyRetention ?? 48;
        const dailyRetention = req.dailyRetention ?? 14;
        if (snapshotKind === 'hourly') {
            pruneSnapshots(mountPath, hostname, 'hourly', hourlyRetention);
        } else {
            pruneSnapshots(mountPath, hostname, 'daily', dailyRetention);
        }

        updateBackupRun(db, runId, { status: 'completed', bytes, finishedAt: Date.now() });
        return { ok: true, runId, snapshotDir };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateBackupRun(db, runId, { status: 'failed', error: msg, finishedAt: Date.now() });
        try {
            if (fs.existsSync(snapshotDir)) fs.rmSync(snapshotDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
        return { ok: false, runId, error: msg };
    } finally {
        try {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {
            /* ignore */
        }
        releaseMutex(db);
    }
}
