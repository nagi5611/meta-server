// public/js/model-load-batch.js — モデル URL の一括 HEAD / GET（セッションキャッシュへ）

import { loadClientConfigOnce } from './asset-resolve.js';
import {
    canonicalAssetCacheKey,
    getCachedAssetBuffer,
    getCachedContentLength,
    putCachedAssetBuffer,
    putCachedContentLength,
} from './model-asset-session-cache.js';

/**
 * @returns {Promise<number>}
 */
async function getPlanLoadConcurrency() {
    const fallback = 24;
    try {
        const j = await loadClientConfigOnce();
        const n = j && typeof j === 'object' ? j.planLoadConcurrency : undefined;
        const num = Number(n);
        if (Number.isFinite(num) && num >= 1) return Math.min(128, Math.floor(num));
    } catch {
        /* ignore */
    }
    return fallback;
}

/**
 * @param {string} url
 * @returns {'include' | 'omit'}
 */
function fetchCredentialsForUrl(url) {
    if (typeof window === 'undefined') return 'omit';
    try {
        const abs = url.startsWith('http://') || url.startsWith('https://')
            ? new URL(url)
            : new URL(url, window.location.origin);
        return abs.origin === window.location.origin ? 'include' : 'omit';
    } catch {
        return 'omit';
    }
}

/**
 * HEAD で Content-Length を取得（キャッシュにも保存）
 * @param {string} url
 * @returns {Promise<number|null>}
 */
async function headContentLength(url) {
    const key = canonicalAssetCacheKey(url);
    if (!key) return null;
    const cached = getCachedContentLength(url);
    if (cached != null) return cached;

    try {
        const isOtherOriginHttp =
            typeof window !== 'undefined' &&
            /^https?:\/\//i.test(url) &&
            (() => {
                try {
                    return new URL(url).origin !== window.location.origin;
                } catch {
                    return false;
                }
            })();
        const r = await fetch(url, {
            method: 'HEAD',
            credentials: isOtherOriginHttp ? 'omit' : fetchCredentialsForUrl(url),
        });
        if (!r.ok) return null;
        const cl = r.headers.get('Content-Length');
        if (cl == null || cl === '') return null;
        const n = parseInt(cl, 10);
        if (!Number.isFinite(n) || n < 0) return null;
        putCachedContentLength(url, n);
        return n;
    } catch {
        return null;
    }
}

/**
 * 全 URL を先に HEAD して Content-Length をキャッシュする
 * @param {string[]} urls
 * @param {number} [concurrency]
 * @returns {Promise<Map<string, number|null>>}
 */
export async function batchFetchModelContentLengths(urls, concurrencyArg) {
    const unique = [...new Set(urls.filter(Boolean))];
    const conc =
        typeof concurrencyArg === 'number' && concurrencyArg >= 1
            ? Math.min(128, Math.floor(concurrencyArg))
            : await getPlanLoadConcurrency();

    /** @type {Map<string, number|null>} */
    const out = new Map();
    let cursor = 0;
    async function worker() {
        while (cursor < unique.length) {
            const i = cursor++;
            const url = unique[i];
            const key = canonicalAssetCacheKey(url);
            const len = await headContentLength(url);
            out.set(key, len);
        }
    }
    const workers = Math.min(conc, Math.max(1, unique.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
}

/**
 * GET して ArrayBuffer をセッションキャッシュへ（既にあればスキップ）
 * @param {string} url
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function fetchAndCacheAssetBuffer(url) {
    const existing = getCachedAssetBuffer(url);
    if (existing) return existing;
    try {
        const res = await fetch(url, { credentials: fetchCredentialsForUrl(url) });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        putCachedAssetBuffer(url, buffer);
        return buffer;
    } catch {
        return null;
    }
}

/**
 * 解決済み URL 群を並列 GET してセッションキャッシュを温める
 * @param {string[]} urls
 * @param {number} [concurrency]
 * @returns {Promise<void>}
 */
export async function batchWarmAssetBuffers(urls) {
    const unique = [...new Set(urls.filter(Boolean))].filter((u) => !getCachedAssetBuffer(u));
    if (!unique.length) return;
    const conc = await getPlanLoadConcurrency();
    let cursor = 0;
    async function worker() {
        while (cursor < unique.length) {
            const i = cursor++;
            await fetchAndCacheAssetBuffer(unique[i]);
        }
    }
    const workers = Math.min(conc, unique.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
}
