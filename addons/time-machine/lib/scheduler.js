// addons/time-machine/lib/scheduler.js — hourly/daily スケジューラ
import { validateMounts } from './mounts.js';
import { runBackupJob, resolveMountForScheduled } from './backup-runner.js';
import { getAppState, setAppState, listStorageSettings, isMutexHeld } from './storage-db.js';
import { defaultScopeForKind } from './backup-scopes.js';

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} mountsRaw
 * @param {string} [serverVersion]
 */
export function startScheduler(db, mountsRaw, serverVersion) {
    if (timer) return;
    timer = setInterval(() => {
        tickScheduler(db, mountsRaw, serverVersion).catch((e) => {
            console.error('[time-machine] scheduler tick error:', e);
        });
    }, 60_000);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function stopScheduler(db) {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} mountsRaw
 * @param {string} [serverVersion]
 */
export async function tickScheduler(db, mountsRaw, serverVersion) {
    if (isMutexHeld(db)) return;

    const mounts = validateMounts(mountsRaw).filter((m) => m.exists && m.writable);
    const settings = listStorageSettings(db);
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    for (const mount of mounts) {
        const s = settings.find((x) => x.mountId === mount.id);
        if (!s || !s.enabled) continue;

        if (s.role === 'hourly' || s.role === 'both') {
            const lastKey = `last_hourly_${mount.id}`;
            const last = getAppState(db, lastKey);
            const lastMs = last ? Number(last) : 0;
            if (Date.now() - lastMs >= 60 * 60 * 1000) {
                const resolved = resolveMountForScheduled(db, mount.id, mount.path, 'hourly');
                if (resolved) {
                    const result = await runBackupJob({
                        kind: 'hourly',
                        scope: defaultScopeForKind('hourly'),
                        mountId: mount.id,
                        mountPath: mount.path,
                        db,
                        serverVersion,
                        hourlyRetention: resolved.hourlyRetention,
                        dailyRetention: resolved.dailyRetention,
                    });
                    if (result.ok) setAppState(db, lastKey, String(Date.now()));
                }
            }
        }

        if (s.role === 'daily' || s.role === 'both') {
            if (now.getHours() !== s.dailyHour) continue;
            const lastDayKey = `last_daily_${mount.id}`;
            const lastDay = getAppState(db, lastDayKey);
            if (lastDay === todayKey) continue;

            const resolved = resolveMountForScheduled(db, mount.id, mount.path, 'daily');
            if (resolved) {
                const result = await runBackupJob({
                    kind: 'daily',
                    scope: defaultScopeForKind('daily'),
                    mountId: mount.id,
                    mountPath: mount.path,
                    db,
                    serverVersion,
                    hourlyRetention: resolved.hourlyRetention,
                    dailyRetention: resolved.dailyRetention,
                });
                if (result.ok) setAppState(db, lastDayKey, todayKey);
            }
        }
    }
}
