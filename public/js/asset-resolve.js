// public/js/asset-resolve.js — CDN → オリジン順でモデル取得 URL を用意（CloudFront 署名 + 認証済みフォールバック）

/** @typedef {{ mode?: 'cdn'|'local', cdnBaseUrl?: string | null, cdnHostname?: string | null, iblDefaultHdrUrl?: string | null }} AssetModelsCfg */

/** @type {Promise<unknown> | null} */
let configPromise = null;

/**
 * /api/client-config を一度だけ取得
 * @returns {Promise<unknown>}
 */
export function loadClientConfigOnce() {
    if (!configPromise) {
        configPromise = fetch('/api/client-config', { credentials: 'include' }).then((r) => r.json());
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
        // ワールド等に同一オリジン絶対 URL が載っている場合、署名 API は CDN ホスト以外を拒否する（host mismatch 400）。
        // 相対パス扱いへ落として CDN 正規 URL を組み立て署名させる。
        try {
            if (typeof window !== 'undefined') {
                const abs = new URL(raw);
                if (abs.origin === window.location.origin) {
                    const pathAndQuery = `${abs.pathname.replace(/^\//, '')}${abs.search}`;
                    if (pathAndQuery.length > 0) {
                        return resolveModelAssetHref(pathAndQuery);
                    }
                }
            }
        } catch {
            /* fall through */
        }
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

    let base = String(cfg.cdnBaseUrl).replace(/\/+$/, '');
    // META_CDN_PUBLIC_BASE が .../models で終わる構成でも、兄弟フォルダ avatars は CDN 上で並ぶ想定のため末尾 models を落として署名 URL と整合させる
    if (pathStr.startsWith('avatars/') || /^[^/]+\/avatars\//.test(pathStr)) {
        base = base.replace(/\/models\/?$/i, '');
    }
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

/**
 * IBL 用 /env/default.hdr を CDN モードではサーバ提示の正規 CDN URLへ寄せて署名付き GET にする（未設定時は同一オリジン）
 * @param {string} pathOrUrl - 例 /env/default.hdr やクエリ付き
 * @returns {Promise<string>}
 */
export async function resolveEnvAssetHref(pathOrUrl) {
    const raw = String(pathOrUrl || '').trim();
    if (!raw) return raw;

    const cfg = await getAssetModelsConfig();

    const hashIdx = raw.indexOf('#');
    const rawNoHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const trailingHash = hashIdx >= 0 ? raw.slice(hashIdx) : '';

    if (rawNoHash.startsWith('https://') || rawNoHash.startsWith('http://')) {
        try {
            if (typeof window !== 'undefined') {
                const abs = new URL(rawNoHash);
                if (abs.origin === window.location.origin) {
                    const pathAndQuery = `${abs.pathname.replace(/^\//, '')}${abs.search}`;
                    if (pathAndQuery.length > 0) {
                        return resolveEnvAssetHref(pathAndQuery + trailingHash);
                    }
                }
            }
        } catch {
            /* fall through */
        }
        if (cfg.mode !== 'cdn' || !cfg.cdnBaseUrl) {
            return raw;
        }
        try {
            const uKey = rawNoHash.split('#')[0];
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
                    return signed + trailingHash;
                }
            }
        } catch {
            /* fall through */
        }
        return originUrlFromCdnUrl(rawNoHash) + trailingHash;
    }

    const qIdx = rawNoHash.indexOf('?');
    const pathOnly = qIdx >= 0 ? rawNoHash.slice(0, qIdx) : rawNoHash;
    const querySuffix = qIdx >= 0 ? rawNoHash.slice(qIdx) : '';

    const normalizedPath = pathOnly.startsWith('/') ? pathOnly.slice(1) : pathOnly;
    const encodedPath = normalizedPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    const sameOriginPath = '/' + encodedPath + querySuffix + trailingHash;

    const iblCanon =
        cfg.iblDefaultHdrUrl && typeof cfg.iblDefaultHdrUrl === 'string'
            ? cfg.iblDefaultHdrUrl.trim()
            : '';

    const isDefaultHdr = normalizedPath === 'env/default.hdr';

    if (!(cfg.mode === 'cdn' && cfg.cdnBaseUrl)) {
        return sameOriginPath;
    }

    if (iblCanon && isDefaultHdr) {
        const canonicalForSign = iblCanon.split('#')[0] + querySuffix;
        try {
            const res = await fetch('/api/metaverse/sign-asset-urls', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: [canonicalForSign] }),
            });
            if (res.ok) {
                const j = await res.json();
                const signed =
                    j.signed && typeof j.signed === 'object' ? j.signed[canonicalForSign] : null;
                if (typeof signed === 'string' && signed.length > 0) {
                    return signed + trailingHash;
                }
            }
        } catch {
            /* fall through */
        }
        return sameOriginPath;
    }

    if (!normalizedPath.startsWith('env/')) {
        return sameOriginPath;
    }

    let base = String(cfg.cdnBaseUrl).replace(/\/+$/, '');
    base = base.replace(/\/models\/?$/i, '');
    const canonical = `${base}/${encodedPath.replace(/^\/+/, '')}`;
    const uKey = canonical.split('#')[0] + querySuffix;
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
                return signed + trailingHash;
            }
        }
    } catch {
        /* use origin */
    }
    return sameOriginPath;
}
