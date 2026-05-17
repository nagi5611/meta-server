// lib/prefab-bundle-upload.js — Prefab ZIP 展開（複数 GLB＋同梱アセット）→ models 配下に保存しマニフェストを出力
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { MODEL_UPLOAD_MAX_BYTES } from './model-upload-max-bytes.js';
import { runGlbTextureResizeQueued, parseTextureMaxEdgeFromUploadBody } from './glb-texture-resize.js';

const DEFAULT_PREFAB_ZIP_MAX_ENTRIES = 500;
/** 環境変数で上げすぎないよう上限（DoS・メモリ対策） */
const PREFAB_ZIP_MAX_ENTRIES_HARD_CAP = 100000;

/**
 * .env の PREFAB_ZIP_MAX_ENTRIES（ZIP 内のファイル本数の上限）。無効・未設定は 500。
 * @returns {number}
 */
function computePrefabZipMaxEntries() {
    const raw = process.env.PREFAB_ZIP_MAX_ENTRIES;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_PREFAB_ZIP_MAX_ENTRIES;
    }
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
        console.warn(
            `[prefab-upload] Invalid PREFAB_ZIP_MAX_ENTRIES="${raw}", using default ${DEFAULT_PREFAB_ZIP_MAX_ENTRIES}`,
        );
        return DEFAULT_PREFAB_ZIP_MAX_ENTRIES;
    }
    if (n > PREFAB_ZIP_MAX_ENTRIES_HARD_CAP) {
        console.warn(
            `[prefab-upload] PREFAB_ZIP_MAX_ENTRIES=${n} exceeds hard cap ${PREFAB_ZIP_MAX_ENTRIES_HARD_CAP}, clamping`,
        );
        return PREFAB_ZIP_MAX_ENTRIES_HARD_CAP;
    }
    return n;
}

const PREFAB_ZIP_MAX_ENTRIES = computePrefabZipMaxEntries();
const PREFAB_MAX_UNCOMPRESSED = MODEL_UPLOAD_MAX_BYTES * 3;

const ALLOWED_EXT = new Set([
    '.glb', '.gltf', '.bin', '.obj', '.mtl',
    '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis',
    '.hdr', '.exr',
]);

/**
 * @param {string} manifestFileName
 * @returns {string|null}
 */
export function baseNameFromManifestFilename(manifestFileName) {
    const name = String(manifestFileName || '');
    const su = '-prefab-manifest.json';
    if (!name.toLowerCase().endsWith(su)) return null;
    return name.slice(0, -su.length) || null;
}

/**
 * models 相対のマニフェストパスとサムディレクトリを一括削除（storage API 用）
 * @param {string} modelsDir
 * @param {string} manifestRel models 相対 (例: MyBuild-prefab-manifest.json)
 * @returns {{ relPaths: string[] }}
 */
export function removePrefabBundleFromDisk(modelsDir, manifestRel) {
    const rel = String(manifestRel || '').replace(/\\/g, '/').trim();
    const base = baseNameFromManifestFilename(path.basename(rel));
    /** @type {string[]} */
    const relPaths = [];
    if (!base) {
        return { relPaths };
    }
    const manifestPath = path.join(modelsDir, rel);
    const assetDirName = prefabAssetDirName(base);
    const assetDir = path.join(modelsDir, assetDirName);
    if (fs.existsSync(assetDir)) {
        const collect = (dir, prefix) => {
            for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, n.name);
                const pre = prefix ? `${prefix}/${n.name}` : n.name;
                if (n.isDirectory()) {
                    collect(p, pre);
                } else {
                    relPaths.push(pre.split(path.sep).join('/'));
                }
            }
        };
        collect(assetDir, assetDirName);
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
        const mr = rel.split(path.sep).join('/');
        relPaths.push(mr);
        fs.unlinkSync(manifestPath);
    }
    return { relPaths };
}

/**
 * ZIP エントリキーを models 下の相対パスに正規化（Zip slip 拒否）
 * @param {string} name
 * @returns {string|null}
 */
function safeZipEntryRelativePath(name) {
    const n = String(name || '').replace(/\\/g, '/');
    if (!n || n.includes('\0') || n.startsWith('/')) return null;
    const parts = n.split('/').filter((p) => p && p !== '.');
    if (parts.length === 0) return null;
    if (parts.some((p) => p === '..')) return null;
    return parts.join('/');
}

/**
 * @param {string} zipName
 * @returns {string}
 */
export function baseNameFromZipFilename(zipName) {
    const b = path.basename(String(zipName || ''), path.extname(String(zipName || '')));
    const s = b.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '') || 'prefab';
    return s.slice(0, 120);
}

/**
 * マニフェスト相対名（{base}-prefab-manifest.json）
 * @param {string} base
 * @returns {string}
 */
export function prefabManifestFilename(base) {
    return `${base}-prefab-manifest.json`;
}

/**
 * アセット用サブディレクトリ名（{base}_prefab）
 * @param {string} base
 * @returns {string}
 */
export function prefabAssetDirName(base) {
    return `${base}_prefab`;
}

/**
 * v1: .gltf を含むとエラー
 * @param {string} rel
 * @returns {boolean}
 */
function hasForbiddenGltfJson(rel) {
    return rel.toLowerCase().endsWith('.gltf');
}

/**
 * @param {import('fflate').Unzipped} unz
 * @param {string} base
 * @param {string} modelsDir
 * @param {string} outRelDir models 相対（base_prefab）
 * @param {boolean} confirm
 * @param {{ maxEdgePx?: number, skipTextureResize?: boolean, prefabBaseOverride?: string, publicUrlPrefix?: string }} glbOptions
 *   publicUrlPrefix: マニフェスト・parts[].file の URL 先頭（既定 `models`。飛行機用は `plane`）
 * @param {{ onProgress?: (label: string) => void }} [hooks]
 * @returns {Promise<{
 *   success: true,
 *   manifestRelativePath: string,
 *   prefabGroupId: string,
 *   displayName: string,
 *   writtenFiles: string[],
 *   glbCount: number,
 *   textureResizeNotes: string[]
 * } | { success: false, error: string, code: string, status: number, conflictingFiles?: string[] }>}
 */
export async function applyPrefabBundleZipToModels(zipBuffer, modelsDir, zipOriginalName, confirm, glbOptions = {}, hooks = {}) {
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 4) {
        return { success: false, error: 'ZIP が空です', code: 'empty_zip', status: 400 };
    }
    if (zipBuffer.length > MODEL_UPLOAD_MAX_BYTES) {
        return { success: false, error: 'ZIP サイズが大きすぎます', code: 'zip_too_large', status: 400 };
    }

    /** @type {string} */
    let base = baseNameFromZipFilename(zipOriginalName);
    const override = String(glbOptions.prefabBaseOverride || '').trim();
    if (override) {
        const o = override.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '').slice(0, 120);
        if (o) base = o;
    }
    const publicUrlPrefix = String(glbOptions.publicUrlPrefix || 'models').replace(/^\/+|\/+$/g, '') || 'models';
    const assetDirRel = prefabAssetDirName(base);
    const manifestName = prefabManifestFilename(base);
    const manifestRel = manifestName;
    const assetDirAbs = path.join(modelsDir, assetDirRel);

    let unz;
    try {
        unz = /** @type {import('fflate').Unzipped} */ (unzipSync(new Uint8Array(zipBuffer)));
    } catch (e) {
        return {
            success: false,
            error: e instanceof Error ? e.message : 'ZIP の展開に失敗しました',
            code: 'unzip_failed',
            status: 400,
        };
    }

    const keys = Object.keys(unz).filter((k) => !k.startsWith('__') && !k.startsWith('.'));
    if (keys.length > PREFAB_ZIP_MAX_ENTRIES) {
        return { success: false, error: 'ZIP 内のエントリが多すぎます', code: 'too_many_entries', status: 400 };
    }

    let ucTotal = 0;
    const entries = [];
    for (const key of keys) {
        const rel = safeZipEntryRelativePath(key);
        if (!rel) {
            return { success: false, error: 'ZIP 内のパスが不正です', code: 'bad_path', status: 400 };
        }
        const data = unz[key];
        if (!data || data.byteLength === 0) {
            return { success: false, error: '空のファイルを含めないでください', code: 'empty_file', status: 400 };
        }
        if (hasForbiddenGltfJson(rel)) {
            return {
                success: false,
                error: 'v1 では拡散 glTF（.gltf + 外部 .bin/画像）は未対応です。GLB にバンドルしてください。',
                code: 'gltf_json_not_supported',
                status: 400,
            };
        }
        const ext = path.extname(rel).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) {
            return { success: false, error: `許可されていない拡張子です: ${ext || '(なし)'}`, code: 'bad_ext', status: 400 };
        }
        ucTotal += data.byteLength;
        entries.push({ rel, data, ext });
    }

    if (ucTotal > PREFAB_MAX_UNCOMPRESSED) {
        return { success: false, error: '非圧縮合計が大きすぎます', code: 'uncompressed_too_large', status: 400 };
    }

    const glbEntries = entries.filter((e) => e.ext === '.glb');
    if (glbEntries.length === 0) {
        return { success: false, error: 'ZIP 内に .glb がありません', code: 'no_glb', status: 400 };
    }

    const destRels = [];
    for (const e of entries) {
        const destRel = path.join(assetDirRel, e.rel).split(path.sep).join('/');
        destRels.push(destRel);
    }
    const manifestDestRel = manifestRel;
    const allToWrite = [manifestDestRel, ...destRels];
    if (!confirm) {
        const conflicting = [];
        for (const r of allToWrite) {
            const abs = path.join(modelsDir, r);
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                conflicting.push(r);
            }
        }
        if (conflicting.length) {
            return {
                success: false,
                error: '一部ファイルが既に存在します。上書きする場合は confirm=1 を付けてください',
                code: 'file_exists',
                status: 409,
                conflictingFiles: conflicting,
            };
        }
    }

    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }
    if (!fs.existsSync(assetDirAbs)) {
        fs.mkdirSync(assetDirAbs, { recursive: true });
    }

    const textureResizeNotes = [];
    const { maxEdgePx, skipTextureResize = false } = glbOptions;

    const written = [];
    try {
        for (const e of entries) {
            const outRel = path.join(assetDirRel, e.rel).split(path.sep).join('/');
            const outAbs = path.join(modelsDir, outRel);
            const dir = path.dirname(outAbs);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (e.ext === '.glb') {
                const buf = Buffer.from(e.data);
                hooks.onProgress?.(outRel);
                let toWrite = buf;
                if (!skipTextureResize) {
                    const r = await runGlbTextureResizeQueued(buf, { maxEdgePx });
                    toWrite = r.buffer;
                    if (r.textureResize?.message) {
                        textureResizeNotes.push(String(e.rel) + ': ' + (r.textureResize.message || ''));
                    }
                }
                fs.writeFileSync(outAbs, toWrite);
            } else {
                fs.writeFileSync(outAbs, Buffer.from(e.data));
            }
            written.push(outRel);
        }

        const prefabGroupId = crypto.randomUUID();
        const parts = glbEntries.map((e) => ({
            file: `${publicUrlPrefix}/${path.join(assetDirRel, e.rel).split(path.sep).join('/')}`.replace(/\/+/g, '/'),
        }));

        const manifest = {
            version: 1,
            prefabGroupId,
            displayName: base,
            parts,
        };

        const manifestPath = path.join(modelsDir, manifestDestRel);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        written.push(manifestDestRel);

        return {
            success: true,
            manifestRelativePath: `${publicUrlPrefix}/${manifestDestRel.split(path.sep).join('/')}`.replace(/\/+/g, '/'),
            prefabGroupId,
            displayName: base,
            writtenFiles: written,
            glbCount: glbEntries.length,
            textureResizeNotes,
        };
    } catch (err) {
        for (const w of written) {
            try {
                const p = path.join(modelsDir, w);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {
                /* ignore */
            }
        }
        return {
            success: false,
            error: err instanceof Error ? err.message : '保存に失敗しました',
            code: 'write_failed',
            status: 500,
        };
    }
}

/**
 * リクエスト body から glb オプションを解釈（/admin/upload と揃える）
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {{ maxEdgePx: number, skipTextureResize: boolean, parseError?: string }}
 */
export function parseGlbOptionsFromPrefabBody(body) {
    const skip = body?.skipTextureResize === '1' || body?.skipTextureResize === 'true';
    const p = parseTextureMaxEdgeFromUploadBody(body?.textureMaxEdge);
    if (!p.ok) {
        return { maxEdgePx: 2048, skipTextureResize: skip, parseError: p.error };
    }
    return { maxEdgePx: p.value, skipTextureResize: skip };
}
