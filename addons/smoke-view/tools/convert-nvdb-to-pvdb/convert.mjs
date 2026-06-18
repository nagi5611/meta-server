#!/usr/bin/env node
// addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs — nvdb → pvdb（PicoVDB Zig コンバータラッパー）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDON_ROOT = path.resolve(__dirname, '..', '..');
const TOOLS_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ADDON_ROOT, 'vendor', 'picovdb');
const ZIG_OUT_BIN = path.join(VENDOR_DIR, 'zig-out', 'bin');
const PICOVDB_EXE = process.platform === 'win32'
    ? path.join(ZIG_OUT_BIN, 'picovdb.exe')
    : path.join(ZIG_OUT_BIN, 'picovdb');
const BUNDLED_ZIG_DIRS = [
    path.join(TOOLS_ROOT, 'zig-0.15.2', 'zig-x86_64-windows-0.15.2'),
    path.join(TOOLS_ROOT, 'zig-0.15.2', 'zig-aarch64-windows-0.15.2'),
    path.join(TOOLS_ROOT, 'zig-0.16.0', 'zig-x86_64-windows-0.16.0'),
    path.join(TOOLS_ROOT, 'zig-0.16.0', 'zig-aarch64-windows-0.16.0'),
];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const positional = [];
    let gzip = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--gzip' || a === '-z') {
            gzip = true;
            continue;
        }
        if (a === '--help' || a === '-h') {
            return { help: true, gzip, positional };
        }
        positional.push(a);
    }
    return { help: false, gzip, positional };
}

function printHelp() {
    console.log(`Usage: node convert.mjs [--gzip] <input.nvdb> <output.pvdb>

Converts NanoVDB (.nvdb) to PicoVDB (.pvdb) using the vendored PicoVDB Zig tool.

Options:
  --gzip, -z   Write gzip-compressed output (appends .gz if missing)

Requires Zig 0.15.2 (bundled under addons/smoke-view/tools/zig-0.15.2/ or on PATH).
Vendor: addons/smoke-view/vendor/picovdb @ tag 0.0.1
`);
}

/**
 * @param {string} zigExe
 * @returns {Record<string, string>}
 */
function zigEnv(zigExe) {
    const libDir = path.join(path.dirname(zigExe), 'lib');
    return {
        ...process.env,
        ZIG_LIB_DIR: libDir,
    };
}

/**
 * @param {string} zigExe
 * @param {string[]} args
 * @param {{ cwd?: string, stdio?: 'inherit' | 'pipe' }} [opts]
 */
function runZig(zigExe, args, opts = {}) {
    return spawnSync(zigExe, args, {
        cwd: opts.cwd,
        stdio: opts.stdio ?? 'pipe',
        shell: false,
        env: zigEnv(zigExe),
        encoding: 'utf8',
    });
}

/**
 * @param {string} zigExe
 * @returns {boolean}
 */
function validateZigInstall(zigExe) {
    const stdZig = path.join(path.dirname(zigExe), 'lib', 'std', 'std.zig');
    if (!fs.existsSync(stdZig)) {
        console.error(`Error: incomplete Zig install (missing ${stdZig}).`);
        console.error('Use Zig 0.15.2–0.16.x from https://ziglang.org/download/');
        console.error('Avoid 0.17 dev builds unless the full std library is present.');
        if (process.platform === 'win32' && zigExe.includes('Program Files')) {
            console.error('Tip: install to a path without spaces (e.g. C:\\zig) or use the bundled zig-0.16.0 folder.');
        }
        return false;
    }
    return true;
}

/**
 * @returns {{ zigExe: string } | null}
 */
function resolveZig() {
    for (const dir of BUNDLED_ZIG_DIRS) {
        const exe = process.platform === 'win32'
            ? path.join(dir, 'zig.exe')
            : path.join(dir, 'zig');
        if (fs.existsSync(exe) && validateZigInstall(exe)) {
            return { zigExe: exe };
        }
    }

    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['zig'], {
        encoding: 'utf8',
        shell: false,
    });
    if (which.status === 0) {
        const candidates = (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && validateZigInstall(candidate)) {
                return { zigExe: candidate };
            }
        }
    }

    console.error('Error: zig not found or incomplete install.');
    console.error('Install Zig 0.15.2 from https://ziglang.org/download/0.15.2/');
    console.error('Or extract to addons/smoke-view/tools/zig-0.15.2/zig-x86_64-windows-0.15.2/');
    return null;
}

/**
 * @param {string} zigExe
 * @returns {boolean}
 */
function ensureZig(zigExe) {
    const r = runZig(zigExe, ['version']);
    if (r.status !== 0) {
        console.error('Error: zig failed to run.');
        if (r.stderr) console.error(r.stderr.trim());
        return false;
    }
    console.log(`Zig: ${(r.stdout || r.stderr || '').trim()}`);
    return true;
}

/**
 * @param {string} zigExe
 * @returns {boolean}
 */
function ensurePicovdbBinary(zigExe) {
    if (fs.existsSync(PICOVDB_EXE)) {
        return true;
    }
    if (!zigExe) {
        console.error('Error: picovdb binary missing and no zig executable provided.');
        return false;
    }
    if (!fs.existsSync(path.join(VENDOR_DIR, 'build.zig'))) {
        console.error(`Error: PicoVDB vendor not found at ${VENDOR_DIR}`);
        console.error('Run: git submodule update --init addons/smoke-view/vendor/picovdb');
        return false;
    }

    console.log('Fetching PicoVDB dependencies (zig build --fetch)...');
    const fetch = runZig(zigExe, ['build', '--fetch'], { cwd: VENDOR_DIR, stdio: 'inherit' });
    if (fetch.status !== 0) {
        console.error('Error: zig build --fetch failed.');
        console.error('If hash mismatch on openvdb, update vendor/picovdb/build.zig.zon .hash (see README).');
        return false;
    }

    if (process.platform === 'win32') {
        const patchScript = path.join(__dirname, 'patch-openvdb-headers.mjs');
        console.log('Patching OpenVDB headers for Windows Zig translate-c...');
        const patch = spawnSync(process.execPath, [patchScript], { stdio: 'inherit', shell: false });
        if (patch.status !== 0) {
            console.error('Error: OpenVDB header patch failed.');
            return false;
        }
    }

    console.log('Building PicoVDB converter (zig build)...');
    const build = runZig(zigExe, ['build'], { cwd: VENDOR_DIR, stdio: 'inherit' });
    if (build.status !== 0 || !fs.existsSync(PICOVDB_EXE)) {
        console.error('Error: zig build failed or picovdb binary missing.');
        return false;
    }
    return true;
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {boolean}
 */
function runConvert(inputPath, outputPath) {
    const inStat = fs.statSync(inputPath);
    console.log(`Input:  ${inputPath} (${(inStat.size / 1024 / 1024).toFixed(2)} MiB)`);

    const tmpOut = outputPath.endsWith('.gz')
        ? outputPath.replace(/\.gz$/i, '')
        : outputPath;

    const r = spawnSync(PICOVDB_EXE, ['convert', inputPath, tmpOut], { stdio: 'inherit', shell: false });
    if (r.status !== 0) {
        console.error('Error: picovdb converter exited with non-zero status.');
        return false;
    }
    if (!fs.existsSync(tmpOut)) {
        console.error('Error: output file was not created.');
        return false;
    }

    const outStat = fs.statSync(tmpOut);
    console.log(`Output: ${tmpOut} (${(outStat.size / 1024 / 1024).toFixed(2)} MiB)`);
    return true;
}

/**
 * @param {string} pvdbPath
 * @param {string} gzipPath
 */
function gzipFile(pvdbPath, gzipPath) {
    const data = fs.readFileSync(pvdbPath);
    const compressed = zlib.gzipSync(data);
    fs.writeFileSync(gzipPath, compressed);
    console.log(`Gzip:   ${gzipPath} (${(compressed.length / 1024 / 1024).toFixed(2)} MiB)`);
    if (gzipPath !== pvdbPath) {
        fs.unlinkSync(pvdbPath);
    }
}

const { help, gzip, positional } = parseArgs(process.argv.slice(2));
if (help || positional.length < 2) {
    printHelp();
    process.exit(help ? 0 : 1);
}

let [inputPath, outputPath] = positional;
inputPath = path.resolve(inputPath);
outputPath = path.resolve(outputPath);

if (!inputPath.toLowerCase().endsWith('.nvdb')) {
    console.warn('Warning: input does not end with .nvdb');
}
if (!fs.existsSync(inputPath)) {
    console.error(`Error: input not found: ${inputPath}`);
    process.exit(1);
}

if (gzip && !outputPath.toLowerCase().endsWith('.gz')) {
    outputPath += '.gz';
}

if (fs.existsSync(PICOVDB_EXE)) {
    if (!ensurePicovdbBinary('')) {
        process.exit(1);
    }
} else {
    const zigResolved = resolveZig();
    if (!zigResolved) process.exit(1);
    const { zigExe } = zigResolved;
    if (!ensureZig(zigExe)) process.exit(1);
    if (!ensurePicovdbBinary(zigExe)) process.exit(1);
}

const rawOut = gzip
    ? outputPath.replace(/\.gz$/i, '')
    : outputPath;

if (!runConvert(inputPath, rawOut)) process.exit(1);

if (gzip) {
    gzipFile(rawOut, outputPath);
}

console.log('Done.');
