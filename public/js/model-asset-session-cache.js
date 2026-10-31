// public/js/model-asset-session-cache.js — 入場プリロードと GLB ロードで ArrayBuffer / Content-Length を共有

/** @type {Map<string, ArrayBuffer>} */
const bufferByUrl = new Map();

/** @type {Map<string, number>} */
const contentLengthByUrl = new Map();

/** キャッシュ合計のソフト上限（約 512 MiB） */
const MAX_CACHED_BYTES = 512 * 1024 * 1024;

/** @type {number} */
let cachedBytes = 0;

/** LRU 用（先頭が最古） */
/** @type {string[]} */
const bufferLru = [];

/**
 * fetch / HEAD 用のキャッシュキー（# 以降は除外）
 * @param {string} url
 * @returns {string}
 */
export function canonicalAssetCacheKey(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        const abs = raw.startsWith('http://') || raw.startsWith('https://')
            ? new URL(raw)
            : new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://local');
        return `${abs.origin}${abs.pathname}${abs.search}`;
    } catch {
        const noHash = raw.split('#')[0];
        return noHash;
    }
}

/**
 * @param {string} url
 * @returns {ArrayBuffer | undefined}
 */
export function getCachedAssetBuffer(url) {
    const key = canonicalAssetCacheKey(url);
    if (!key) return undefined;
    const buf = bufferByUrl.get(key);
    if (!buf) return undefined;
    const idx = bufferLru.indexOf(key);
    if (idx >= 0) {
        bufferLru.splice(idx, 1);
        bufferLru.push(key);
    }
    return buf;
}

/**
 * @param {string} url
 * @returns {number | undefined}
 */
export function getCachedContentLength(url) {
    const key = canonicalAssetCacheKey(url);
    if (!key) return undefined;
    const n = contentLengthByUrl.get(key);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {string} url
 * @param {number|null|undefined} length
 */
export function putCachedContentLength(url, length) {
    const key = canonicalAssetCacheKey(url);
    if (!key || length == null || !Number.isFinite(length) || length < 0) return;
    contentLengthByUrl.set(key, length);
}

/**
 * @param {string} url
 * @param {ArrayBuffer} buffer
 */
export function putCachedAssetBuffer(url, buffer) {
    const key = canonicalAssetCacheKey(url);
    if (!key || !(buffer instanceof ArrayBuffer)) return;

    const prev = bufferByUrl.get(key);
    if (prev) {
        cachedBytes -= prev.byteLength;
        bufferByUrl.delete(key);
        const idx = bufferLru.indexOf(key);
        if (idx >= 0) bufferLru.splice(idx, 1);
    }

    bufferByUrl.set(key, buffer);
    bufferLru.push(key);
    cachedBytes += buffer.byteLength;
    putCachedContentLength(url, buffer.byteLength);

    while (cachedBytes > MAX_CACHED_BYTES && bufferLru.length > 0) {
        const evict = bufferLru.shift();
        if (!evict) break;
        const b = bufferByUrl.get(evict);
        if (b) cachedBytes -= b.byteLength;
        bufferByUrl.delete(evict);
    }
}

/**
 * @returns {Map<string, number>}
 */
export function getContentLengthMapSnapshot() {
    return new Map(contentLengthByUrl);
}

/** ワールド切替時に GLB バッファを破棄（Content-Length は保持可だがまとめてクリア） */
export function clearModelAssetSessionCache() {
    bufferByUrl.clear();
    contentLengthByUrl.clear();
    bufferLru.length = 0;
    cachedBytes = 0;
}
