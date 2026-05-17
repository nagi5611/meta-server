// public/sw.js — /models/* /plane/* と /pdfs/* の Stale-While-Revalidate + Cache API
// 注: CloudFront 等の別オリジンのモデル URL はここを通らずネットワークフェッチされる
const CACHE_VERSION = 'v1';
const CACHE_NAME = `metaverse-assets-${CACHE_VERSION}`;

/** @type {boolean} */
let cacheWritesDisabled = false;

/**
 * アセット GET のみを扱うか
 * @param {URL} url
 * @returns {boolean}
 */
function isAssetUrl(url) {
    return url.origin === self.location.origin &&
        (url.pathname.startsWith('/models/') ||
            url.pathname.startsWith('/plane/') ||
            url.pathname.startsWith('/pdfs/') ||
            url.pathname.startsWith('/env/'));
}

/**
 * ネット応答がキャッシュに格納可能か
 * @param {Response} res
 * @returns {boolean}
 */
function isCacheableResponse(res) {
    return res && res.ok && res.status === 200 && res.type === 'basic';
}

/**
 * @param {Cache} cache
 * @param {Request} request
 * @param {Response} response
 */
async function safeCachePut(cache, request, response) {
    if (cacheWritesDisabled) return;
    try {
        await cache.put(request, response.clone());
    } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
            try {
                const keys = await cache.keys();
                for (const k of keys) {
                    await cache.delete(k);
                }
            } catch (_) { /* ignore */ }
            try {
                await cache.put(request, response.clone());
            } catch (_) {
                cacheWritesDisabled = true;
            }
        }
    }
}

/**
 * バックグラウンドでネット取得しキャッシュを更新（304 は無視）
 * @param {Request} request
 * @param {Cache} cache
 */
async function revalidateInBackground(request, cache) {
    try {
        const response = await fetch(request);
        if (!isCacheableResponse(response)) return;
        await safeCachePut(cache, request, response);
    } catch (_) { /* オンライン前提: 失敗は無視 */ }
}

/**
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function staleWhileRevalidate(event) {
    const request = event.request;
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    if (cached) {
        event.waitUntil(revalidateInBackground(request, cache));
        return cached;
    }

    try {
        const response = await fetch(request);
        if (isCacheableResponse(response)) {
            await safeCachePut(cache, request, response);
        }
        return response;
    } catch (err) {
        const fallback = await cache.match(request);
        if (fallback) return fallback;
        throw err;
    }
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((k) => k.startsWith('metaverse-assets-') && k !== CACHE_NAME)
                .map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'SET_CACHE_WRITES_DISABLED') {
        cacheWritesDisabled = !!data.value;
        return;
    }
    
    if (data.type === 'INVALIDATE' && Array.isArray(data.urls)) {
        event.waitUntil((async () => {
            const cache = await caches.open(CACHE_NAME);
            for (const u of data.urls) {
                if (typeof u !== 'string' || !u) continue;
                let pathname;
                try {
                    pathname = new URL(u, self.location.origin).pathname;
                } catch (_) {
                    continue;
                }
                if (!pathname.startsWith('/models/') &&
                    !pathname.startsWith('/plane/') &&
                    !pathname.startsWith('/pdfs/') &&
                    !pathname.startsWith('/env/')) continue;
                const keys = await cache.keys();
                for (const req of keys) {
                    try {
                        const p = new URL(req.url).pathname;
                        if (p === pathname) await cache.delete(req);
                    } catch (_) { /* ignore */ }
                }
            }
        })());
    }
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (!isAssetUrl(url)) return;
    if (event.request.headers.has('range')) {
        event.respondWith(fetch(event.request));
        return;
    }
    event.respondWith(staleWhileRevalidate(event));
});
