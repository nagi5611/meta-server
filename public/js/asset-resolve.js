// public/js/asset-resolve.js — CDN → オリジン順でモデル取得 URL を用意（CloudFront 署名 + 認証済みフォールバック）

/** @typedef {{ mode?: 'cdn'|'local', cdnBaseUrl?: string | null, cdnHostname?: string | null }} AssetModelsCfg */

/** @type {Promise<unknown> | null} */
let configPromise = null;

/**
 * /api/client-config を一度だけ取得
 * @returns {Promise<unknown>}
 */
export function loadClientConfigOnce() {
    if (!configPromise) {
        configPromise = fetch('/api/client-config').then((r) => r.json());
    }
    return configPromise;
}

/**
 * @returns {Promise<AssetModelsCfg>}
 */
export async function getAssetModelsConfig() {
    const j = await loadClientConfigOnce();
    const a = j && typeof j === 'object' && 'assetModels' in j ? j.assetModels : null;
    return a && typeof a === 'object' ? /** @type {AssetModelsCfg} */ (a) : { mode: 'local' };
}

/**
 * CDN 絶対 URL から同一パスをオリジンへ写す（フォールバック GET 用）
 * @param {string} cdnUrl
 * @returns {string}
 */
function originUrlFromCdnUrl(cdnUrl) {
    try {
        const u = new URL(cdnUrl);
        return `${window.location.origin}${u.pathname}${u.search}`;
    } catch {
        return cdnUrl;
    }
}

/**
 * ワールド参照（models/... または https CDN）を実際に fetch / GLTFLoader が取りに行ける URL へ
 * @param {string} pathOrUrl
 * @returns {Promise<string>}
 */
export async function resolveModelAssetHref(pathOrUrl) {
    const raw = String(pathOrUrl || '').trim();
    if (!raw) return raw;
    const cfg = await getAssetModelsConfig();

    if (raw.startsWith('https://') || raw.startsWith('http://')) {
        if (cfg.mode !== 'cdn' || !cfg.cdnBaseUrl) {
            return raw;
        }
        try {
            const uKey = raw.split('#')[0];
            const res = await fetch('/api/metaverse/sign-asset-urls', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: [uKey] }),
            });
            if (res.ok) {
                const j = await res.json();
                const signed = j.signed && typeof j.signed === 'object' ? j.signed[uKey] : null;
                if (typeof signed === 'string' && signed.length > 0) {
                    return signed;
                }
            }
        } catch {
            /* fall through */
        }
        return originUrlFromCdnUrl(raw);
    }

    const pathStr = raw.startsWith('/') ? raw.slice(1) : raw;
    const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    const sameOriginPath = '/' + encodedPath;

    if (cfg.mode !== 'cdn' || !cfg.cdnBaseUrl) {
        return sameOriginPath;
    }

    const base = String(cfg.cdnBaseUrl).replace(/\/+$/, '');
    const canonical = `${base}/${encodedPath.replace(/^\/+/, '')}`;
    const uKey = canonical.split('#')[0];
    try {
        const res = await fetch('/api/metaverse/sign-asset-urls', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [uKey] }),
        });
        if (res.ok) {
            const j = await res.json();
            const signed = j.signed && typeof j.signed === 'object' ? j.signed[uKey] : null;
            if (typeof signed === 'string' && signed.length > 0) {
                return signed;
            }
        }
    } catch {
        /* use origin */
    }
    return sameOriginPath;
}
