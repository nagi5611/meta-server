// public/js/admin-api-fetch.js — 管理 API 向け fetch（CSRF トークン付与）
export const ADMIN_CSRF_HEADER = 'X-Admin-CSRF';

/** installAdminFetchPatch 前の fetch（再帰呼び出し防止） */
const nativeFetch = globalThis.fetch.bind(globalThis);

/** @type {string|null} */
let cachedToken = null;
/** @type {number} */
let cachedExpiresAt = 0;
/** @type {Promise<void>|null} */
let initPromise = null;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * fetch 引数からパス判定用 URL 文字列を得る
 * @param {RequestInfo | URL} url
 * @returns {string}
 */
export function resolveRequestUrl(url) {
    if (typeof url === 'string') return url;
    if (url instanceof URL) return url.pathname + url.search;
    if (typeof Request !== 'undefined' && url instanceof Request) return url.url;
    return String(url);
}

/**
 * @param {string} urlStr
 */
function needsCsrf(urlStr) {
    if (urlStr.startsWith('/admin') || urlStr.startsWith('/host-monitor')) return true;
    if (typeof window !== 'undefined' && urlStr.startsWith('http')) {
        try {
            const u = new URL(urlStr, window.location.origin);
            return u.pathname.startsWith('/admin') || u.pathname.startsWith('/host-monitor');
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * CSRF トークンを取得・キャッシュする
 * @returns {Promise<void>}
 */
export async function initAdminCsrf() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const res = await nativeFetch('/admin/csrf-token', { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`CSRF token fetch failed: ${res.status}`);
        }
        const data = await res.json();
        cachedToken = String(data?.token || '');
        cachedExpiresAt = Number(data?.expiresAt) || 0;
        if (!cachedToken) {
            throw new Error('CSRF token missing in response');
        }
    })();
    return initPromise;
}

/**
 * 期限切れ前ならトークンを再取得する
 */
async function ensureCsrfToken() {
    const now = Date.now();
    if (cachedToken && cachedExpiresAt > now + 60_000) return;
    initPromise = null;
    await initAdminCsrf();
}

/**
 * 管理 API 向け fetch
 * @param {RequestInfo | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function adminFetch(url, init = {}) {
    const urlStr = resolveRequestUrl(url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});

    if (needsCsrf(urlStr) && MUTATING.has(method)) {
        await ensureCsrfToken();
        if (cachedToken) {
            headers.set(ADMIN_CSRF_HEADER, cachedToken);
        }
    }

    return nativeFetch(url, {
        ...init,
        credentials: init.credentials ?? 'include',
        headers,
    });
}

/**
 * 既存の fetch 呼び出しを /admin・/host-monitor の変更系でラップする
 */
export function installAdminFetchPatch() {
    if (typeof window === 'undefined' || window.__adminFetchPatched) return;
    window.fetch = (url, init) => {
        const urlStr = resolveRequestUrl(url);
        const method = String(init?.method || 'GET').toUpperCase();
        if (needsCsrf(urlStr) && MUTATING.has(method)) {
            return adminFetch(url, init);
        }
        return nativeFetch(url, init);
    };
    window.__adminFetchPatched = true;
    window.adminFetch = adminFetch;
    window.getAdminCsrfToken = async () => {
        await ensureCsrfToken();
        return cachedToken;
    };
}
