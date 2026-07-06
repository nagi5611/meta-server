// addons/time-machine/lib/retention.js — 世代削除
import fs from 'node:fs';
import { listSnapshotDirs } from './snapshot-meta.js';

/**
 * @param {string} mountRoot
 * @param {string} hostname
 * @param {'hourly' | 'daily'} kind
 * @param {number} keepCount
 * @returns {string[]}
 */
export function pruneSnapshots(mountRoot, hostname, kind, keepCount) {
    const dirs = listSnapshotDirs(mountRoot, hostname, kind);
    const toDelete = dirs.slice(Math.max(0, keepCount));
    for (const dir of toDelete) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
            console.warn('[time-machine] prune failed:', dir, e);
        }
    }
    return toDelete;
}
