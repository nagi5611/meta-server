// addons/time-machine/lib/snapshot-meta.js — manifest.json 読み書き
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} SnapshotManifest
 * @property {number} v
 * @property {string} snapshotId
 * @property {'hourly' | 'daily'} kind
 * @property {string} scope
 * @property {string} mountId
 * @property {string} hostname
 * @property {string} createdAt
 * @property {string} [serverVersion]
 * @property {number} bytes
 * @property {string[]} [restoreTargets]
 */

export const MANIFEST_FILENAME = 'manifest.json';

/**
 * @param {string} snapshotDir
 * @param {SnapshotManifest} manifest
 */
export function writeManifest(snapshotDir, manifest) {
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const filePath = path.join(snapshotDir, MANIFEST_FILENAME);
    const tmp = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

/**
 * @param {string} snapshotDir
 * @returns {SnapshotManifest | null}
 */
export function readManifest(snapshotDir) {
    const filePath = path.join(snapshotDir, MANIFEST_FILENAME);
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        return /** @type {SnapshotManifest} */ (parsed);
    } catch {
        return null;
    }
}

/**
 * @param {Date} [now]
 * @returns {string}
 */
export function formatHourlySnapshotId(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-00-00`;
}

/**
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDailySnapshotId(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * @param {string} mountRoot
 * @param {string} hostname
 * @param {'hourly' | 'daily'} kind
 * @returns {string[]}
 */
export function listSnapshotDirs(mountRoot, hostname, kind) {
    const base = path.join(mountRoot, 'metaverse-simple', hostname, kind);
    if (!fs.existsSync(base)) return [];
    return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(base, e.name))
        .sort((a, b) => b.localeCompare(a));
}
