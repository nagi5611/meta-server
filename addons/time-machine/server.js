// addons/time-machine/server.js
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HOOKS } from '../../lib/hook-registry.js';
import { validateMounts } from './lib/mounts.js';
import {
    seedStorageSettings,
    listStorageSettings,
    updateStorageSetting,
    listRecentBackupRuns,
    isMutexHeld,
    setAppState,
} from './lib/storage-db.js';
import { startScheduler } from './lib/scheduler.js';
import { runBackupJob } from './lib/backup-runner.js';
import {
    buildRollbackPlan,
    validateSnapshotForRollback,
    writeRollbackPlan,
} from './lib/rollback-plan.js';
import { listSnapshotDirs, readManifest } from './lib/snapshot-meta.js';
import { invalidateAllAssetPrefixes } from './lib/cloudfront-admin.js';

const JSON_LIMIT = '64kb';

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/**
 * @param {Record<string, unknown>} ctxConfig
 * @returns {string}
 */
function getMountsRaw(ctxConfig) {
    const v = ctxConfig.mounts ?? ctxConfig.MOUNTS;
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {Record<string, unknown>} ctxConfig
 * @returns {string}
 */
function getRollbackPin(ctxConfig) {
    const v = ctxConfig.rollback_pin ?? ctxConfig.rollbackPin;
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {Record<string, unknown>} ctxConfig
 * @returns {string}
 */
function getSystemdServiceName(ctxConfig) {
    const v = ctxConfig.systemdservicename ?? ctxConfig.systemdServiceName;
    return typeof v === 'string' && v.trim() ? v.trim() : 'metaverse-simple';
}

export default {
    /**
     * @param {import('../../lib/plugin-loader.js').PluginRegisterApi} ctx
     */
    async register(ctx) {
        const db = ctx.openDatabase();
        const mountsRaw = getMountsRaw(ctx.config);
        const rollbackPin = getRollbackPin(ctx.config);
        const systemdServiceName = getSystemdServiceName(ctx.config);
        const workDir = path.join(ctx.paths.addonRoot, 'work');
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

        const mountInfos = validateMounts(mountsRaw);
        seedStorageSettings(
            db,
            mountInfos.map((m) => m.id),
        );

        startScheduler(db, mountsRaw, ctx.coreVersion);

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            const jsonMw = express.json({ limit: JSON_LIMIT });
            const api = '/admin/addons/time-machine';

            app.get(`${api}/status`, (_req, res) => {
                res.json({
                    ok: true,
                    hostname: os.hostname(),
                    mounts: mountInfos,
                    mutexHeld: isMutexHeld(db),
                    rollbackPinConfigured: rollbackPin.length > 0,
                    systemdServiceName,
                    recentRuns: listRecentBackupRuns(db, 10),
                });
            });

            app.get(`${api}/storages`, (_req, res) => {
                const settings = listStorageSettings(db);
                const merged = mountInfos.map((m) => {
                    const s = settings.find((x) => x.mountId === m.id);
                    return {
                        ...m,
                        role: s?.role ?? 'off',
                        hourlyRetention: s?.hourlyRetention ?? 48,
                        dailyRetention: s?.dailyRetention ?? 14,
                        dailyHour: s?.dailyHour ?? 3,
                        enabled: s?.enabled ?? true,
                    };
                });
                res.json({ ok: true, storages: merged });
            });

            app.put(`${api}/storages`, jsonMw, (req, res) => {
                const body = req.body || {};
                const mountId = typeof body.mountId === 'string' ? body.mountId.trim() : '';
                if (!mountId) return res.status(400).json({ ok: false, error: 'mountId required' });
                if (!mountInfos.some((m) => m.id === mountId)) {
                    return res.status(400).json({ ok: false, error: 'unknown_mount' });
                }
                const role = body.role;
                const validRoles = new Set(['off', 'hourly', 'daily', 'both']);
                if (role !== undefined && !validRoles.has(role)) {
                    return res.status(400).json({ ok: false, error: 'invalid_role' });
                }
                updateStorageSetting(db, mountId, {
                    role,
                    hourlyRetention:
                        typeof body.hourlyRetention === 'number' ? body.hourlyRetention : undefined,
                    dailyRetention:
                        typeof body.dailyRetention === 'number' ? body.dailyRetention : undefined,
                    dailyHour: typeof body.dailyHour === 'number' ? body.dailyHour : undefined,
                    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
                });
                res.json({ ok: true, storages: listStorageSettings(db) });
            });

            app.get(`${api}/snapshots`, (req, res) => {
                const mountId = typeof req.query.mountId === 'string' ? req.query.mountId : '';
                const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
                const hostname = os.hostname();
                /** @type {Array<object>} */
                const snapshots = [];

                for (const m of mountInfos) {
                    if (mountId && m.id !== mountId) continue;
                    if (!m.exists) continue;
                    for (const k of ['hourly', 'daily']) {
                        if (kind && kind !== k) continue;
                        for (const dir of listSnapshotDirs(m.path, hostname, /** @type {'hourly'|'daily'} */ (k))) {
                            const manifest = readManifest(dir);
                            snapshots.push({
                                mountId: m.id,
                                kind: k,
                                snapshotDir: dir,
                                snapshotId: manifest?.snapshotId ?? path.basename(dir),
                                createdAt: manifest?.createdAt ?? null,
                                bytes: manifest?.bytes ?? 0,
                                scope: manifest?.scope ?? null,
                            });
                        }
                    }
                }

                snapshots.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
                res.json({ ok: true, snapshots });
            });

            app.post(`${api}/backup/run`, jsonMw, async (req, res) => {
                const body = req.body || {};
                const scope = typeof body.scope === 'string' ? body.scope : 'state';
                const validScopes = new Set(['state', 'full', 'addons', 'server_src']);
                if (!validScopes.has(scope)) {
                    return res.status(400).json({ ok: false, error: 'invalid_scope' });
                }

                let mountId = typeof body.mountId === 'string' ? body.mountId.trim() : '';
                if (!mountId) {
                    const settings = listStorageSettings(db);
                    const first = settings.find((s) => s.enabled && s.role !== 'off');
                    mountId = first?.mountId ?? mountInfos[0]?.id ?? '';
                }
                const mount = mountInfos.find((m) => m.id === mountId);
                if (!mount || !mount.exists || !mount.writable) {
                    return res.status(400).json({ ok: false, error: 'invalid_mount' });
                }

                const settings = listStorageSettings(db).find((s) => s.mountId === mountId);
                const kind =
                    scope === 'full' || scope === 'server_src' ? 'daily' : 'immediate';

                const result = await runBackupJob({
                    kind: kind === 'daily' ? 'daily' : 'immediate',
                    scope: /** @type {import('./lib/backup-scopes.js').BackupScope} */ (scope),
                    mountId,
                    mountPath: mount.path,
                    db,
                    serverVersion: ctx.coreVersion,
                    hourlyRetention: settings?.hourlyRetention ?? 48,
                    dailyRetention: settings?.dailyRetention ?? 14,
                });

                if (!result.ok) {
                    return res.status(409).json({ ok: false, error: result.error, runId: result.runId });
                }
                res.json({ ok: true, runId: result.runId, snapshotDir: result.snapshotDir });
            });

            app.post(`${api}/rollback`, jsonMw, (req, res) => {
                if (!rollbackPin) {
                    return res.status(503).json({ ok: false, error: 'rollback_pin_not_configured' });
                }
                const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin : '';
                if (!safeStringEqual(pin, rollbackPin)) {
                    return res.status(403).json({ ok: false, error: 'invalid_pin' });
                }

                const mountId = typeof req.body?.mountId === 'string' ? req.body.mountId.trim() : '';
                const snapshotId =
                    typeof req.body?.snapshotId === 'string' ? req.body.snapshotId.trim() : '';
                const snapshotDirBody =
                    typeof req.body?.snapshotDir === 'string' ? req.body.snapshotDir.trim() : '';

                const mount = mountInfos.find((m) => m.id === mountId);
                if (!mount) return res.status(400).json({ ok: false, error: 'invalid_mount' });

                let snapshotDir = snapshotDirBody;
                if (!snapshotDir && snapshotId) {
                    const hostname = os.hostname();
                    const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'hourly';
                    snapshotDir = path.join(
                        mount.path,
                        'metaverse-simple',
                        hostname,
                        kind,
                        snapshotId,
                    );
                }
                if (!snapshotDir) {
                    return res.status(400).json({ ok: false, error: 'snapshotDir_or_snapshotId_required' });
                }

                const validation = validateSnapshotForRollback(snapshotDir, mount.path);
                if (!validation.ok) {
                    return res.status(400).json({ ok: false, error: validation.error });
                }

                if (isMutexHeld(db)) {
                    return res.status(409).json({ ok: false, error: 'backup_or_rollback_in_progress' });
                }

                setAppState(db, 'mutex', '1');

                const plan = buildRollbackPlan(snapshotDir, systemdServiceName);
                const planPath = writeRollbackPlan(workDir, plan);
                const scriptPath = path.join(ctx.paths.addonRoot, 'scripts', 'rollback-exec.sh');

                if (!fs.existsSync(scriptPath)) {
                    setAppState(db, 'mutex', '0');
                    return res.status(500).json({ ok: false, error: 'rollback_script_missing' });
                }

                try {
                    const cp = spawn('bash', [scriptPath, planPath], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true,
                    });
                    cp.unref();
                    res.json({
                        ok: true,
                        message: 'ロールバックを開始しました。サーバーは再起動されます。',
                        planPath,
                    });
                } catch (e) {
                    setAppState(db, 'mutex', '0');
                    const msg = e instanceof Error ? e.message : String(e);
                    res.status(500).json({ ok: false, error: msg });
                }
            });

            app.post(`${api}/cloudfront/invalidate`, async (_req, res) => {
                const result = await invalidateAllAssetPrefixes();
                if (!result.ok) {
                    return res.status(result.skipped ? 200 : 500).json(result);
                }
                res.json(result);
            });
        });

        ctx.logger.info('registered');
    },
};
