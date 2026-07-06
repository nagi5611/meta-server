// addons/time-machine/lib/rollback-plan.js — 復元計画 JSON
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_PATHS } from '../../../config/storage-paths.js';
import { getRepoRoot, getSrcDirectory } from './backup-scopes.js';
import { readManifest } from './snapshot-meta.js';
import { isPathUnderMount } from './mounts.js';

/**
 * @typedef {object} RollbackPlan
 * @property {number} v
 * @property {string} snapshotDir
 * @property {string} systemdServiceName
 * @property {string} repoRoot
 * @property {string | null} srcDirectory
 * @property {string | null} envFile
 * @property {Array<{ from: string, to: string, type?: string }>} copies
 */

/**
 * @param {string} snapshotDir
 * @param {string} mountPath
 * @returns {{ ok: boolean, error?: string, manifest?: import('./snapshot-meta.js').SnapshotManifest }}
 */
export function validateSnapshotForRollback(snapshotDir, mountPath) {
    if (!isPathUnderMount(snapshotDir, mountPath)) {
        return { ok: false, error: 'snapshot_outside_mount' };
    }
    const manifest = readManifest(snapshotDir);
    if (!manifest) return { ok: false, error: 'manifest_missing' };
    if (!fs.existsSync(snapshotDir)) return { ok: false, error: 'snapshot_not_found' };
    return { ok: true, manifest };
}

/**
 * @param {string} snapshotDir
 * @param {string} systemdServiceName
 * @returns {RollbackPlan}
 */
export function buildRollbackPlan(snapshotDir, systemdServiceName) {
    const repoRoot = getRepoRoot();
    const srcDirectory = getSrcDirectory();
    const envFile = path.join(repoRoot, '.env');

    /** @type {Array<{ from: string, to: string }>} */
    const copies = [];

    const srcSnap = path.join(snapshotDir, 'src');
    if (fs.existsSync(srcSnap) && srcDirectory) {
        copies.push({ from: srcSnap, to: srcDirectory });
    }

    const dataSnap = path.join(snapshotDir, 'data');
    if (fs.existsSync(dataSnap) && STORAGE_PATHS.DATA_DIR) {
        copies.push({ from: dataSnap, to: STORAGE_PATHS.DATA_DIR });
    }

    const dbSnap = path.join(snapshotDir, 'db');
    if (fs.existsSync(dbSnap) && STORAGE_PATHS.DB_DIR) {
        copies.push({ from: dbSnap, to: STORAGE_PATHS.DB_DIR, type: 'db' });
    }

    const pluginDbSnap = path.join(snapshotDir, 'db', 'plugin-databases');
    if (fs.existsSync(pluginDbSnap) && STORAGE_PATHS.PLUGIN_DATABASES_DIR) {
        copies.push({
            from: pluginDbSnap,
            to: STORAGE_PATHS.PLUGIN_DATABASES_DIR,
            type: 'db',
        });
    }

    const envSnap = path.join(snapshotDir, 'env', '.env');
    if (fs.existsSync(envSnap)) {
        copies.push({ from: envSnap, to: envFile });
    }

    const addonsSnap = path.join(snapshotDir, 'addons');
    if (fs.existsSync(addonsSnap)) {
        copies.push({ from: addonsSnap, to: path.join(repoRoot, 'addons') });
    }

    return {
        v: 1,
        snapshotDir,
        systemdServiceName,
        repoRoot,
        srcDirectory,
        envFile: fs.existsSync(envFile) ? envFile : null,
        copies,
    };
}

/**
 * @param {string} workDir
 * @param {RollbackPlan} plan
 * @returns {string}
 */
export function writeRollbackPlan(workDir, plan) {
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    const planPath = path.join(workDir, `rollback-plan-${Date.now()}.json`);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return planPath;
}
