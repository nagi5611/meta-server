// public/js/chunk-manifest-constants.js — クライアント用（lib/chunk-manifest-constants.js と値を揃える）

export const CHUNK_MANIFEST_SUFFIX = '.chunk.json';
export const LEGACY_CHUNK_MANIFEST_SUFFIX = '.chunks.json';

/**
 * @param {string} modelPath
 * @returns {string|null}
 */
export function implicitChunkManifestPathFromGlbModelPath(modelPath) {
    const p = String(modelPath || '').trim();
    if (!p.toLowerCase().endsWith('.glb')) return null;
    return `${p.slice(0, -4)}${CHUNK_MANIFEST_SUFFIX}`;
}

/**
 * @param {string} pathOrName
 * @returns {string|null} alternate path for fetch retry
 */
/**
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

export function alternateChunkManifestPath(pathOrName) {
    const s = String(pathOrName || '');
    if (s.toLowerCase().endsWith(CHUNK_MANIFEST_SUFFIX)) {
        return s.slice(0, -CHUNK_MANIFEST_SUFFIX.length) + LEGACY_CHUNK_MANIFEST_SUFFIX;
    }
    if (s.toLowerCase().endsWith(LEGACY_CHUNK_MANIFEST_SUFFIX)) {
        return s.slice(0, -LEGACY_CHUNK_MANIFEST_SUFFIX.length) + CHUNK_MANIFEST_SUFFIX;
    }
    return null;
}
