// public/js/prefab-manifest-cache.js — prefab マニフェスト JSON のセッション内再利用

/** @type {Map<string, object>} */
const manifestJsonByPath = new Map();

/**
 * @param {string} manifestPath
 * @returns {object | undefined}
 */
export function getCachedPrefabManifestJson(manifestPath) {
    const key = String(manifestPath || '').trim();
    if (!key) return undefined;
    return manifestJsonByPath.get(key);
}

/**
 * @param {string} manifestPath
 * @param {object} json
 */
export function putCachedPrefabManifestJson(manifestPath, json) {
    const key = String(manifestPath || '').trim();
    if (!key || !json || typeof json !== 'object') return;
    manifestJsonByPath.set(key, json);
}

export function clearPrefabManifestCache() {
    manifestJsonByPath.clear();
}
