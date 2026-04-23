// lib/chunk-manifest-constants.js — チャンク用マニフェストのファイル名（v1: .chunk.json を正とし、.chunks.json を後方互換で読取）

/** 現行のマニフェスト拡張子（prefab / 空間分割の新規出力） */
export const CHUNK_MANIFEST_SUFFIX = '.chunk.json';

/** 旧拡張子（後方互換。読取のみ） */
export const LEGACY_CHUNK_MANIFEST_SUFFIX = '.chunks.json';

/**
 * モデルパス models/foo.glb から、優先する暗黙マニフェスト相対名（.chunk.json）
 * @param {string} modelPath
 * @returns {string|null}
 */
export function implicitChunkManifestPathFromGlbModelPath(modelPath) {
    const p = String(modelPath || '').trim();
    if (!p.toLowerCase().endsWith('.glb')) return null;
    return `${p.slice(0, -4)}${CHUNK_MANIFEST_SUFFIX}`;
}

/**
 * basename（拡張子なし）に対するマニフェスト候補（先頭が新形式）
 * @param {string} baseNoExt
 * @returns {string[]}
 */
export function manifestFileNamesForBase(baseNoExt) {
    return [`${baseNoExt}${CHUNK_MANIFEST_SUFFIX}`, `${baseNoExt}${LEGACY_CHUNK_MANIFEST_SUFFIX}`];
}

/**
 * ファイル名がいずれかのマニフェストか
 * @param {string} name
 * @returns {boolean}
 */
export function isChunkManifestFilename(name) {
    const low = String(name || '').toLowerCase();
    return low.endsWith(CHUNK_MANIFEST_SUFFIX) || low.endsWith(LEGACY_CHUNK_MANIFEST_SUFFIX);
}

/**
 * マニフェストファイル名から basename（拡張子なしのプレハブ名）を取り出す
 * @param {string} name
 * @returns {string|null}
 */
export function baseNameFromManifestFileName(name) {
    const n = String(name || '');
    if (n.toLowerCase().endsWith(CHUNK_MANIFEST_SUFFIX)) {
        return n.slice(0, -CHUNK_MANIFEST_SUFFIX.length);
    }
    if (n.toLowerCase().endsWith(LEGACY_CHUNK_MANIFEST_SUFFIX)) {
        return n.slice(0, -LEGACY_CHUNK_MANIFEST_SUFFIX.length);
    }
    return null;
}
