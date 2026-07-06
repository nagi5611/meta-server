// addons/time-machine/lib/sqlite-backup.js — sqlite3 .backup 子プロセス
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @returns {Promise<boolean>}
 */
export async function isSqlite3Available() {
    return new Promise((resolve) => {
        const cp = spawn('sqlite3', ['-version'], { stdio: 'ignore', windowsHide: true });
        cp.on('error', () => resolve(false));
        cp.on('close', (code) => resolve(code === 0));
    });
}

/**
 * @param {string} srcDb
 * @param {string} destBackup
 * @returns {Promise<void>}
 */
export function backupSqliteFile(srcDb, destBackup) {
    const parent = path.dirname(destBackup);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

    return new Promise((resolve, reject) => {
        const cmd = `.backup '${destBackup.replace(/'/g, "''")}'`;
        const cp = spawn('sqlite3', [srcDb, cmd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        cp.stderr?.on('data', (c) => {
            stderr += String(c);
        });
        cp.on('error', (e) => reject(e));
        cp.on('close', (code) => {
            if (code === 0 && fs.existsSync(destBackup)) resolve();
            else reject(new Error(stderr.trim() || `sqlite3 backup failed (code ${code})`));
        });
    });
}

/**
 * @param {string[]} srcDbPaths
 * @param {string} destDir
 * @param {string} destPrefix
 * @returns {Promise<{ backed: string[], errors: string[] }>}
 */
export async function backupSqliteFiles(srcDbPaths, destDir, destPrefix = 'db') {
    const backed = [];
    const errors = [];
    for (const src of srcDbPaths) {
        const rel = path.basename(src);
        const dest = path.join(destDir, destPrefix, `${rel}.bak`);
        try {
            await backupSqliteFile(src, dest);
            backed.push(dest);
        } catch (e) {
            errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { backed, errors };
}
