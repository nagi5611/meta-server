// addons/time-machine/lib/file-copy.js — rsync 優先、無ければ fs.cp
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @returns {Promise<boolean>}
 */
export async function isRsyncAvailable() {
    return new Promise((resolve) => {
        const cp = spawn('rsync', ['--version'], { stdio: 'ignore', windowsHide: true });
        cp.on('error', () => resolve(false));
        cp.on('close', (code) => resolve(code === 0));
    });
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string[]} excludeDirNames
 * @returns {Promise<void>}
 */
export async function copyDirRsync(srcDir, destDir, excludeDirNames = []) {
    if (!fs.existsSync(srcDir)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const args = ['-a', '--delete'];
    for (const name of excludeDirNames) {
        args.push(`--exclude=${name}`);
    }
    args.push(`${srcDir.replace(/\\/g, '/')}/`, `${destDir.replace(/\\/g, '/')}/`);

    return new Promise((resolve, reject) => {
        const cp = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        cp.stderr?.on('data', (c) => {
            stderr += String(c);
        });
        cp.on('error', reject);
        cp.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `rsync failed (code ${code})`));
        });
    });
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {(dir: string) => boolean} [shouldSkipDir]
 * @returns {void}
 */
export function copyDirRecursive(srcDir, destDir, shouldSkipDir) {
    if (!fs.existsSync(srcDir)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, ent.name);
        const destPath = path.join(destDir, ent.name);
        if (ent.isDirectory()) {
            if (shouldSkipDir?.(srcPath)) continue;
            copyDirRecursive(srcPath, destPath, shouldSkipDir);
        } else if (ent.isFile()) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string[]} excludeDirNames
 * @returns {Promise<void>}
 */
export async function copyDir(srcDir, destDir, excludeDirNames = []) {
    const skip = (d) => excludeDirNames.includes(path.basename(d));
    if (await isRsyncAvailable()) {
        await copyDirRsync(srcDir, destDir, excludeDirNames);
    } else {
        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }
        copyDirRecursive(srcDir, destDir, skip);
    }
}

/**
 * @param {string} srcFile
 * @param {string} destFile
 */
export function copyFile(srcFile, destFile) {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
}

/**
 * @param {string} dir
 * @returns {number}
 */
export function dirSizeBytes(dir) {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile()) total += fs.statSync(full).size;
        }
    };
    walk(dir);
    return total;
}
