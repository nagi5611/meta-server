// addons/time-machine/lib/mounts.js — ADDON_TIME_MACHINE_MOUNTS 解析・検証
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ id: string, path: string, exists: boolean, writable: boolean, freeBytes: number | null, error?: string }} MountInfo
 */

/**
 * @param {string} mountsRaw
 * @returns {Array<{ id: string, path: string }>}
 */
export function parseMountsEnv(mountsRaw) {
    if (!mountsRaw || typeof mountsRaw !== 'string') return [];
    const out = [];
    for (const part of mountsRaw.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf(':');
        if (eq <= 0) continue;
        const id = trimmed.slice(0, eq).trim();
        const mountPath = trimmed.slice(eq + 1).trim();
        if (!id || !mountPath) continue;
        out.push({ id, path: path.resolve(mountPath) });
    }
    return out;
}

/**
 * @param {string} dirPath
 * @returns {number | null}
 */
function getFreeBytesSync(dirPath) {
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(dirPath);
            return Number(st.bfree) * Number(st.bsize);
        }
    } catch {
        /* fall through */
    }
    return null;
}

/**
 * @param {string} mountsRaw
 * @returns {MountInfo[]}
 */
export function validateMounts(mountsRaw) {
    const parsed = parseMountsEnv(mountsRaw);
    return parsed.map(({ id, path: mountPath }) => {
        /** @type {MountInfo} */
        const info = {
            id,
            path: mountPath,
            exists: false,
            writable: false,
            freeBytes: null,
        };
        try {
            if (!fs.existsSync(mountPath)) {
                info.error = 'path does not exist';
                return info;
            }
            const stat = fs.statSync(mountPath);
            if (!stat.isDirectory()) {
                info.error = 'not a directory';
                return info;
            }
            info.exists = true;
            fs.accessSync(mountPath, fs.constants.W_OK);
            info.writable = true;
            info.freeBytes = getFreeBytesSync(mountPath);
        } catch (e) {
            info.error = e instanceof Error ? e.message : String(e);
        }
        return info;
    });
}

/**
 * @param {string} mountRoot
 * @param {string} hostname
 * @param {'hourly' | 'daily'} kind
 * @param {string} snapshotId
 * @returns {string}
 */
export function buildSnapshotDir(mountRoot, hostname, kind, snapshotId) {
    return path.join(mountRoot, 'metaverse-simple', hostname, kind, snapshotId);
}

/**
 * @param {string} snapshotDir
 * @param {string} mountRoot
 * @returns {boolean}
 */
export function isPathUnderMount(snapshotDir, mountRoot) {
    const resolved = path.resolve(snapshotDir);
    const root = path.resolve(mountRoot);
    const rel = path.relative(root, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
