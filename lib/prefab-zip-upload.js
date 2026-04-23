// lib/prefab-zip-upload.js — 手製 prefab 用 ZIP を models に展開（fflate・Zip slip 拒否・検証）

import path from 'path';
import fs from 'fs';
import { unzipSync } from 'fflate';
import { MODEL_UPLOAD_MAX_BYTES } from './model-upload-max-bytes.js';
import { CHUNK_MANIFEST_SUFFIX, LEGACY_CHUNK_MANIFEST_SUFFIX } from './chunk-manifest-constants.js';

/** ZIP 内の最大ファイル数 */
const PREFAB_ZIP_MAX_ENTRIES = 300;

/** 非圧縮合計の上限（ZIP 最大の 3 倍まで） */
const PREFAB_MAX_UNCOMPRESSED = MODEL_UPLOAD_MAX_BYTES * 3;

const CHUNK_GLB_RE = /^[^/\\]+\.chunk_\d+\.glb$/i;

/**
 * @param {string} zipKey
 * @returns {string|null} 1 セグメントの安全なファイル名
 */
function safeSingleSegmentName(zipKey) {
    const n = String(zipKey || '').replace(/\\/g, '/');
    if (n.includes('..') || n.startsWith('/') || n.includes('\0')) return null;
    const parts = n.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    return parts[0];
}

/**
 * @param {unknown} manifest
 * @returns {boolean}
 */
function validateManifestShape(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    if (!Array.isArray(manifest.chunks)) return false;
    for (const c of manifest.chunks) {
        if (!c || typeof c !== 'object') return false;
        if (typeof c.file !== 'string' || !c.file.trim()) return false;
        if (!Array.isArray(c.center) || c.center.length < 3) return false;
        for (let i = 0; i < 3; i++) {
            if (typeof c.center[i] !== 'number' || !Number.isFinite(c.center[i])) return false;
        }
        if (typeof c.radius !== 'number' || !Number.isFinite(c.radius)) return false;
    }
    return manifest.chunks.length > 0;
}

/**
 * @param {string} filePath
 * @param {string} manifestBase
 * @returns {string|null}
 */
function normalizeModelFileToBasename(filePath, manifestBase) {
    let s = String(filePath || '').trim().replace(/^\//, '');
    if (s.toLowerCase().startsWith('models/')) s = s.slice(7);
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return null;
    if (!CHUNK_GLB_RE.test(s)) return null;
    const m = s.match(/^(.*)\.chunk_\d+\.glb$/i);
    if (!m || m[1] !== manifestBase) return null;
    return s;
}

/**
 * @param {Buffer} zipBuffer
 * @param {string} modelsDir
 * @param {boolean} [confirm] 上書きの許可
 * @returns {{ success: true, chunkManifest: string, writtenFiles: string[] } | { success: false, error: string, code?: string, status: number, filename?: string }}
 */
export function applyPrefabZipToModels(zipBuffer, modelsDir, confirm = false) {
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 4) {
        return { success: false, error: 'ZIP が空です', code: 'empty_zip', status: 400 };
    }
    if (zipBuffer.length > MODEL_UPLOAD_MAX_BYTES) {
        return { success: false, error: 'ZIP サイズが大きすぎます', code: 'zip_too_large', status: 400 };
    }

    /** @type {{ [K: string]: Uint8Array }} */
    let unz;
    try {
        unz = /** @type {{ [K: string]: Uint8Array }} */ (unzipSync(new Uint8Array(zipBuffer)));
    } catch (e) {
        return {
            success: false,
            error: e instanceof Error ? e.message : 'ZIP の展開に失敗しました',
            code: 'unzip_failed',
            status: 400
        };
    }

    const keys = Object.keys(unz).filter((k) => !k.startsWith('__'));
    if (keys.length > PREFAB_ZIP_MAX_ENTRIES) {
        return { success: false, error: 'ZIP 内のエントリが多すぎます', code: 'too_many_entries', status: 400 };
    }

    let ucTotal = 0;
    const fileMap = new Map();
    for (const key of keys) {
        const safe = safeSingleSegmentName(key);
        if (!safe) {
            return { success: false, error: 'ZIP 内のパスは 1 階層のファイル名のみにしてください', code: 'path_not_flat', status: 400 };
        }
        const data = unz[key];
        if (!data || data.byteLength === 0) {
            return { success: false, error: '空のファイルを含めないでください', code: 'empty_file', status: 400 };
        }
        ucTotal += data.byteLength;
        const low = safe.toLowerCase();
        if (low.endsWith('.glb')) {
            if (!CHUNK_GLB_RE.test(safe)) {
                return { success: false, error: 'チャンク GLB の名前は BaseName.chunk_N.glb 形式にしてください', code: 'bad_glb_name', status: 400 };
            }
        } else if (!low.endsWith(CHUNK_MANIFEST_SUFFIX) && !low.endsWith(LEGACY_CHUNK_MANIFEST_SUFFIX)) {
            return { success: false, error: '許可されていない拡張子です（.glb または マニフェスト JSON）', code: 'bad_ext', status: 400 };
        }
        if (fileMap.has(safe)) {
            return { success: false, error: 'ZIP 内のファイル名が重複しています', code: 'duplicate', status: 400 };
        }
        fileMap.set(safe, data);
    }

    if (ucTotal > PREFAB_MAX_UNCOMPRESSED) {
        return { success: false, error: '非圧縮合計が大きすぎます', code: 'uncompressed_too_large', status: 400 };
    }

    const manNew = [...fileMap.keys()].filter((k) => k.toLowerCase().endsWith(CHUNK_MANIFEST_SUFFIX));
    const manLegacy = [...fileMap.keys()].filter((k) => k.toLowerCase().endsWith(LEGACY_CHUNK_MANIFEST_SUFFIX));
    if (manNew.length + manLegacy.length === 0) {
        return { success: false, error: 'マニフェスト（*chunk.json）が 1 本必要です', code: 'no_manifest', status: 400 };
    }
    if (manNew.length + manLegacy.length > 1) {
        return { success: false, error: 'マニフェスト JSON は 1 本のみにしてください', code: 'too_many_manifests', status: 400 };
    }

    const manName = manNew.length ? manNew[0] : manLegacy[0];
    const manSuffix = manNew.length ? CHUNK_MANIFEST_SUFFIX : LEGACY_CHUNK_MANIFEST_SUFFIX;
    const manBase = path.basename(manName, manSuffix);

    let manifest;
    try {
        const txt = Buffer.from(fileMap.get(manName) || new Uint8Array(0)).toString('utf8');
        manifest = JSON.parse(txt);
    } catch {
        return { success: false, error: 'マニフェスト JSON の解析に失敗しました', code: 'bad_json', status: 400 };
    }
    if (!validateManifestShape(manifest)) {
        return { success: false, error: 'マニフェストの形式が正しくありません', code: 'bad_schema', status: 400 };
    }

    if (manifest.baseName != null && String(manifest.baseName) !== manBase) {
        return { success: false, error: 'baseName がファイル名と一致しません', code: 'base_mismatch', status: 400 };
    }

    const referencedGlb = new Set();
    for (const c of manifest.chunks) {
        const bn = normalizeModelFileToBasename(c.file, manBase);
        if (!bn || !fileMap.has(bn)) {
            return { success: false, error: `マニフェスト内の file が ZIP 内の GLB と一致しません: ${c.file}`, code: 'file_missing', status: 400 };
        }
        referencedGlb.add(bn);
    }

    for (const k of fileMap.keys()) {
        if (k === manName) continue;
        if (!k.toLowerCase().endsWith('.glb')) continue;
        if (!referencedGlb.has(k)) {
            return { success: false, error: `マニフェストに含まれていない GLB: ${k}`, code: 'orphan_glb', status: 400 };
        }
    }

    for (const name of fileMap.keys()) {
        const dest = path.join(modelsDir, name);
        if (fs.existsSync(dest) && !confirm) {
            return { success: false, error: '上書き時は確認が必要です', code: 'file_exists', status: 409, filename: name };
        }
    }

    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    const written = [];
    try {
        for (const [name, u8] of fileMap) {
            const dest = path.join(modelsDir, name);
            fs.writeFileSync(dest, Buffer.from(u8));
            written.push(name);
        }
    } catch (e) {
        for (const name of written) {
            try {
                fs.unlinkSync(path.join(modelsDir, name));
            } catch {
                /* ignore */
            }
        }
        return {
            success: false,
            error: e instanceof Error ? e.message : '保存に失敗しました',
            code: 'write_failed',
            status: 500
        };
    }

    return {
        success: true,
        chunkManifest: `models/${manName}`.split(path.sep).join('/'),
        writtenFiles: written
    };
}
