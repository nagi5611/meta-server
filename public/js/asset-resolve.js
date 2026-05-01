// public/js/asset-resolve.js — CDN → オリジン順でモデル取得 URL を用意（CloudFront 署名 + 認証済みフォールバック）

/** @typedef {{ mode?: 'cdn'|'local', cdnBaseUrl?: string | null, cdnHostname?: string | null, iblDefaultHdrUrl?: string | null }} AssetModelsCfg */

/** @typedef {{ logicalPath: string, resolvedPath: string, version: string, contentHash: string | null, size: number, updatedAt: string }} ModelManifestItemDto */

/** @type {{ manifestGeneration: number|null, itemsByLogical: Map<string, ModelManifestItemDto>, contentHashFilenames: boolean } | null} */
let modelManifestCache = null;
/** @type {Promise<{ manifestGeneration: number|null, itemsByLogical: Map<string, ModelManifestItemDto>, contentHashFilenames: boolean } | null> | null} */
let modelManifestInflight = null;

/** サーバ側の資産更新後にマニフェストのクライアントキャッシュを無効化する */
export function clearModelManifestCache() {
    modelManifestCache = null;
    modelManifestInflight = null;
}

/**
 * Fetch 用。models/ 相対・絶対クエリなしのパスを論理キーに正規化する
 * @param {string} rawPath
 * @returns {string}
 */
export function canonicalModelsLogicalKey(rawPath) {
    let s = String(rawPath || '').trim();
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    const q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    s = s.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!s.toLowerCase().startsWith('models/')) {
        s = `models/${s}`;
    }
    return s;
}

/**
 * BASE.<hex>.{glb|obj} 形式のファイル名か
 * @param {string} basename
 * @returns {boolean}
 */
function looksContentHashedModelsBasename(basename) {
    return /\.([a-f0-9]{12,64})\.(glb|obj)$/i.test(String(basename || ''));
}

/**
 * /api/model-manifest をキャッシュ付きで読み、論理パス → 条項のマップを返す
 * @returns {Promise<{ manifestGeneration: number|null, itemsByLogical: Map<string, ModelManifestItemDto>, contentHashFilenames: boolean } | null>}
 */
async function fetchModelManifestIndexOnce() {
    if (modelManifestCache) return modelManifestCache;
    if (modelManifestInflight) return modelManifestInflight;
    modelManifestInflight = (async () => {
        try {
            const r = await fetch('/api/model-manifest', { credentials: 'include' });
            if (!r.ok) {
                modelManifestInflight = null;
                return null;
            }
            const data = await r.json();
            const itemsByLogical = new Map();
            for (const it of Array.isArray(data.items) ? data.items : []) {
                if (!it || typeof it !== 'object') continue;
                const lp = typeof it.logicalPath === 'string' ? it.logicalPath.trim() : '';
                if (!lp) continue;
                itemsByLogical.set(lp, /** @type {ModelManifestItemDto} */ (it));
            }
            const cached = {
                manifestGeneration:
                    typeof data.manifestGeneration === 'number' ? data.manifestGeneration : null,
                itemsByLogical,
                contentHashFilenames: !!data.contentHashFilenames,
            };
            modelManifestCache = cached;
            modelManifestInflight = null;
            return cached;
        } catch {
            modelManifestInflight = null;
            return null;
        }
    })();
    return modelManifestInflight;
}

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

    const hashIdxRel = raw.indexOf('#');
    const rawNoHashRel = hashIdxRel >= 0 ? raw.slice(0, hashIdxRel) : raw;
    const trailingHashRel = hashIdxRel >= 0 ? raw.slice(hashIdxRel) : '';

    const qIdxRel = rawNoHashRel.indexOf('?');
    const existingQueryRel = qIdxRel >= 0 ? rawNoHashRel.slice(qIdxRel + 1) : '';
    const pathOnlyForLookup = (qIdxRel >= 0 ? rawNoHashRel.slice(0, qIdxRel) : rawNoHashRel).trim();

    let pathStr = pathOnlyForLookup.startsWith('/') ? pathOnlyForLookup.slice(1) : pathOnlyForLookup;

    /** @type {string[]} */
    const queryPieces = [];
    if (existingQueryRel) {
        queryPieces.push(existingQueryRel);
    }

    const pLow = pathStr.toLowerCase();
    const looksLikeModelsRef =
        pLow.startsWith('models/') ||
        (!pLow.startsWith('avatars/') && /\.(glb|obj)$/i.test(pathStr.split('/').pop() || ''));

    if (pathStr && looksLikeModelsRef) {
        try {
            const idx = await fetchModelManifestIndexOnce();
            if (idx?.itemsByLogical) {
                const key = canonicalModelsLogicalKey(pathStr);
                const ent = idx.itemsByLogical.get(key);
                if (ent?.resolvedPath) {
                    pathStr = ent.resolvedPath.replace(/^models\//, '').replace(/^\//, '');
                    const bn = pathStr.split('/').pop() || '';
                    const skipVersQs =
                        looksContentHashedModelsBasename(bn) ||
                        (idx.contentHashFilenames &&
                            !!(ent.contentHash && String(ent.contentHash).length >= 12));
                    if (!skipVersQs && ent.version) {
                        queryPieces.push(`_mmv=${encodeURIComponent(ent.version)}`);
                    }
                }
            }
        } catch {
            /* ignore manifest */
        }
    }

    const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    const queryStr = queryPieces.length ? `?${queryPieces.join('&')}` : '';
    const sameOriginPath = '/' + encodedPath + queryStr + trailingHashRel;

    if (cfg.mode !== 'cdn' || !cfg.cdnBaseUrl) {
        return sameOriginPath;
    }

    let base = String(cfg.cdnBaseUrl).replace(/\/+$/, '');
    // META_CDN_PUBLIC_BASE が .../models で終わる構成でも、兄弟フォルダ avatars は CDN 上で並ぶ想定のため末尾 models を落として署名 URL と整合させる
    if (pathStr.startsWith('avatars/') || /^[^/]+\/avatars\//.test(pathStr)) {
        base = base.replace(/\/models\/?$/i, '');
    }
    const canonical = `${base}/${encodedPath.replace(/^\/+/, '')}${queryStr}`;
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
                const signedHash = signed.indexOf('#');
                const signedHadHash = signedHash >= 0;
                const signedBase = signedHadHash ? signed.slice(0, signedHash) : signed;
                return `${signedBase}${trailingHashRel}`;
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
