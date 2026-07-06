// addons/time-machine/lib/backup-scopes.js — バックアップ対象パス定義
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_PATHS } from '../../../config/storage-paths.js';

/** @typedef {'state' | 'full' | 'addons' | 'server_src'} BackupScope */

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'logs']);

/**
 * @returns {string}
 */
export function getRepoRoot() {
    return process.cwd();
}

/**
 * @returns {string | null}
 */
export function getEnvFilePath() {
    const envPath = path.join(getRepoRoot(), '.env');
    return fs.existsSync(envPath) ? envPath : null;
}

/**
 * @returns {string | null}
 */
export function getSrcDirectory() {
    if (STORAGE_PATHS.SRC_DIRECTORY) {
        return path.resolve(STORAGE_PATHS.SRC_DIRECTORY);
    }
    return null;
}

/**
 * META_SRC_DIRECTORY 未設定時のフォールバックルート一覧
 * @returns {string[]}
 */
export function getExplicitStorageRoots() {
    const roots = new Set();
    const add = (p) => {
        if (p && fs.existsSync(p)) roots.add(path.resolve(p));
    };
    add(STORAGE_PATHS.DATA_DIR);
    add(STORAGE_PATHS.MODELS_DIR);
    add(STORAGE_PATHS.PLANE_DIR);
    add(STORAGE_PATHS.AVATARS_DIR);
    add(STORAGE_PATHS.PDFS_DIR);
    add(STORAGE_PATHS.IMAGES_DIR);
    add(STORAGE_PATHS.ENV_DIR);
    add(STORAGE_PATHS.DB_DIR);
    add(STORAGE_PATHS.PLUGIN_DATABASES_DIR);
    add(STORAGE_PATHS.NFC_INSTANCES_DIR);
    add(STORAGE_PATHS.CHART_BGM_DIR);
    return [...roots];
}

/**
 * @param {string} dir
 * @param {string[]} backupMountRoots
 * @returns {boolean}
 */
export function shouldExcludeDir(dir, backupMountRoots) {
    const base = path.basename(dir);
    if (EXCLUDE_DIR_NAMES.has(base)) return true;
    for (const root of backupMountRoots) {
        const rel = path.relative(root, dir);
        if (rel === 'metaverse-simple' || rel.startsWith(`metaverse-simple${path.sep}`)) {
            return true;
        }
    }
    return false;
}

/**
 * @param {BackupScope} scope
 * @param {string[]} backupMountRoots
 * @returns {{ type: 'dir', src: string, destSub: string } | { type: 'file', src: string, destSub: string }[]}
 */
export function resolveScopeTargets(scope, backupMountRoots = []) {
    const envFile = getEnvFilePath();
    const envTarget = envFile ? [{ type: 'file', src: envFile, destSub: 'env/.env' }] : [];

    if (scope === 'state') {
        /** @type {Array<{ type: 'dir' | 'file', src: string, destSub: string }>} */
        const targets = [];
        if (STORAGE_PATHS.DATA_DIR && fs.existsSync(STORAGE_PATHS.DATA_DIR)) {
            targets.push({ type: 'dir', src: STORAGE_PATHS.DATA_DIR, destSub: 'data' });
        }
        if (STORAGE_PATHS.DB_DIR && fs.existsSync(STORAGE_PATHS.DB_DIR)) {
            targets.push({ type: 'dir', src: STORAGE_PATHS.DB_DIR, destSub: 'db' });
        }
        if (STORAGE_PATHS.PLUGIN_DATABASES_DIR && fs.existsSync(STORAGE_PATHS.PLUGIN_DATABASES_DIR)) {
            targets.push({
                type: 'dir',
                src: STORAGE_PATHS.PLUGIN_DATABASES_DIR,
                destSub: 'db/plugin-databases',
            });
        }
        return [...targets, ...envTarget];
    }

    if (scope === 'addons') {
        const addonsDir = path.join(getRepoRoot(), 'addons');
        if (!fs.existsSync(addonsDir)) return [...envTarget];
        return [{ type: 'dir', src: addonsDir, destSub: 'addons' }, ...envTarget];
    }

    if (scope === 'server_src' || scope === 'full') {
        const src = getSrcDirectory();
        if (src) {
            return [{ type: 'dir', src, destSub: 'src' }, ...envTarget];
        }
        const roots = getExplicitStorageRoots();
        return [
            ...roots.map((r) => ({
                type: 'dir',
                src: r,
                destSub: `src/${path.basename(r)}`,
            })),
            ...envTarget,
        ];
    }

    return envTarget;
}

/**
 * @param {'hourly' | 'daily'} kind
 * @returns {BackupScope}
 */
export function defaultScopeForKind(kind) {
    return kind === 'hourly' ? 'state' : 'full';
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function listSqliteDbFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                if (!shouldExcludeDir(full, [])) walk(full);
            } else if (ent.isFile() && ent.name.endsWith('.db')) {
                out.push(full);
            }
        }
    };
    walk(dir);
    return out;
}
