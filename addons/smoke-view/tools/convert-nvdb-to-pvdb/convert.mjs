#!/usr/bin/env node
// addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs — nvdb → pvdb（PicoVDB Zig コンバータラッパー）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDON_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_DIR = path.join(ADDON_ROOT, 'vendor', 'picovdb');
const ZIG_OUT_BIN = path.join(VENDOR_DIR, 'zig-out', 'bin');
const PICOVDB_EXE = process.platform === 'win32'
    ? path.join(ZIG_OUT_BIN, 'picovdb.exe')
    : path.join(ZIG_OUT_BIN, 'picovdb');

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

Requires Zig on PATH: https://ziglang.org/download/
Vendor: addons/smoke-view/vendor/picovdb @ tag 0.0.1
`);
}

/**
 * @returns {boolean}
 */
function ensureZig() {
    const r = spawnSync('zig', ['version'], { encoding: 'utf8' });
    if (r.status !== 0) {
        console.error('Error: zig not found on PATH.');
        console.error('Install Zig from https://ziglang.org/download/ and retry.');
        return false;
    }
    console.log(`Zig: ${(r.stdout || r.stderr || '').trim()}`);
    return true;
}

/**
 * @returns {boolean}
 */
function ensurePicovdbBinary() {
    if (fs.existsSync(PICOVDB_EXE)) {
        return true;
    }
    if (!fs.existsSync(path.join(VENDOR_DIR, 'build.zig'))) {
        console.error(`Error: PicoVDB vendor not found at ${VENDOR_DIR}`);
        console.error('Run: git submodule update --init addons/smoke-view/vendor/picovdb');
        return false;
    }
    console.log('Building PicoVDB converter (zig build)...');
    const r = spawnSync('zig', ['build'], { cwd: VENDOR_DIR, stdio: 'inherit', shell: false });
    if (r.status !== 0 || !fs.existsSync(PICOVDB_EXE)) {
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

    const r = spawnSync(PICOVDB_EXE, [inputPath, tmpOut], { stdio: 'inherit', shell: false });
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

if (!ensureZig()) process.exit(1);
if (!ensurePicovdbBinary()) process.exit(1);

const rawOut = gzip
    ? outputPath.replace(/\.gz$/i, '')
    : outputPath;

if (!runConvert(inputPath, rawOut)) process.exit(1);

if (gzip) {
    gzipFile(rawOut, outputPath);
}

console.log('Done.');
