// addons/smoke-view/tools/convert-nvdb-to-pvdb/patch-openvdb-headers.mjs
// Patches fetched OpenVDB PNanoVDB.h for Zig translate-c on Windows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPLACEMENTS = [
    ['static inline __forceinline', 'static inline'],
    ['static __host__ __device__ __forceinline', 'static inline'],
];

/**
 * @param {string} root
 */
function walkPnanoHeaders(root) {
    const found = [];
    if (!fs.existsSync(root)) return found;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...walkPnanoHeaders(full));
            continue;
        }
        if (entry.name === 'PNanoVDB.h') found.push(full);
    }
    return found;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function patchFile(filePath) {
    let text = fs.readFileSync(filePath, 'utf8');
    let changed = false;
    for (const [from, to] of REPLACEMENTS) {
        if (text.includes(from)) {
            text = text.split(from).join(to);
            changed = true;
        }
    }
    if (changed) {
        fs.writeFileSync(filePath, text);
        console.log(`Patched: ${filePath}`);
    }
    return changed;
}

const zigCache = process.env.ZIG_GLOBAL_CACHE_DIR
    ?? path.join(os.homedir(), 'AppData', 'Local', 'zig');
const pkgRoot = path.join(zigCache, 'p');
const headers = walkPnanoHeaders(pkgRoot);
let count = 0;
for (const h of headers) {
    if (patchFile(h)) count += 1;
}
if (count === 0) {
    console.warn('No PNanoVDB.h files needed patching (run after zig build --fetch).');
} else {
    console.log(`Patched ${count} header file(s).`);
}
