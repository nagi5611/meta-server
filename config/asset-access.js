// config/asset-access.js — メタバース静的アセットのセッション必須・許可ドメイン制限
import { USE_S3_MODELS } from './s3-assets.js';

/** 本番 S3 モード時に /models 等の直リンクを抑止するか（開発では常に false） */
export const REQUIRE_SESSION_FOR_STATIC_ASSETS = USE_S3_MODELS;

/** @type {string[] | null} */
let cachedAllowedHosts = null;

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseHostList(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * @param {string} host
 * @returns {string}
 */
function stripPort(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h) return '';
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end >= 0 ? h.slice(0, end + 1) : h;
    }
    const colon = h.lastIndexOf(':');
    if (colon > 0 && !h.slice(0, colon).includes(':')) {
        return h.slice(0, colon);
    }
    return h;
}

/**
 * USE_S3_MODELS 時に静的アセット GET を許可する Host 一覧。
 * META_ASSET_ALLOWED_HOSTS → PROXY_SERVICE_DOMAIN → metair.mmh-virtual.jp の順で解決。
 * @returns {string[]}
 */
export function getAllowedAssetHosts() {
    if (cachedAllowedHosts !== null) return cachedAllowedHosts;

    const explicit = parseHostList(process.env.META_ASSET_ALLOWED_HOSTS);
    if (explicit.length > 0) {
        cachedAllowedHosts = explicit.map(stripPort);
        return cachedAllowedHosts;
    }

    const proxyDomain = String(process.env.PROXY_SERVICE_DOMAIN || '').trim().toLowerCase();
    if (proxyDomain) {
        cachedAllowedHosts = [stripPort(proxyDomain)];
        return cachedAllowedHosts;
    }

    if (USE_S3_MODELS) {
        cachedAllowedHosts = ['metair.mmh-virtual.jp'];
        return cachedAllowedHosts;
    }

    cachedAllowedHosts = [];
    return cachedAllowedHosts;
}

/**
 * @param {string} host
 * @param {string[]} allowed
 * @returns {boolean}
 */
function hostMatchesAllowed(host, allowed) {
    const h = stripPort(host);
    if (!h) return false;
    return allowed.some((a) => h === a);
}

/**
 * @param {string} headerValue
 * @returns {string|null}
 */
function hostFromOriginOrReferer(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    try {
        return new URL(headerValue.trim()).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Host / Origin / Referer が許可ドメインに一致するか（保護無効時は常に true）
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isAssetRequestHostAllowed(req) {
    if (!REQUIRE_SESSION_FOR_STATIC_ASSETS) return true;

    const allowed = getAllowedAssetHosts();
    if (allowed.length === 0) return true;

    const reqHost = stripPort(req.hostname || '');
    if (!hostMatchesAllowed(reqHost, allowed)) {
        return false;
    }

    const origin = req.headers.origin;
    if (origin) {
        const oh = hostFromOriginOrReferer(origin);
        if (oh && !hostMatchesAllowed(oh, allowed)) return false;
    }

    const referer = req.headers.referer;
    if (referer) {
        const rh = hostFromOriginOrReferer(referer);
        if (rh && !hostMatchesAllowed(rh, allowed)) return false;
    }

    return true;
}
