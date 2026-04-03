// public/js/service-worker-register.js
/** ストレージ使用率がこの割合を超えたら SW への cache 書き込みを抑制 */
const CACHE_WRITE_USAGE_THRESHOLD = 0.92;

/**
 * アセット相対パスを fetch と同じルート URL に変換（セグメントごと encode）
 * @param {string} assetPath - 例 models/foo.glb / pdfs/a.pdf
 * @returns {string}
 */
export function encodeAssetPathToUrlPath(assetPath) {
    const pathStr = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return '/' + encodedPath;
}

/**
 * Service Worker にキャッシュ無効化を依頼（同一タブのアップロード直後など）
 * @param {string[]} urls - 同一オリジンの絶対パス（/models/... または /pdfs/...）
 */
export async function notifyServiceWorkerInvalidate(urls) {
    const list = (urls || []).filter((u) => typeof u === 'string' && u.length > 0);
    if (!list.length || !('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.active) {
            reg.active.postMessage({ type: 'INVALIDATE', urls: list });
        }
    } catch (_) { /* プライベートモード等 */ }
}

/**
 * クォータ逼迫時に SW のキャッシュ書き込みを止める
 */
async function applyStoragePressureToServiceWorker() {
    if (!navigator.storage?.estimate) return;
    try {
        const est = await navigator.storage.estimate();
        const quota = est.quota;
        const usage = est.usage || 0;
        if (quota != null && quota > 0 && usage / quota > CACHE_WRITE_USAGE_THRESHOLD) {
            const reg = await navigator.serviceWorker.ready;
            reg.active?.postMessage({ type: 'SET_CACHE_WRITES_DISABLED', value: true });
        }
    } catch (_) { /* ignore */ }
}

/**
 * メタバース／管理画面で /sw.js を登録する（失敗してもアプリは継続）
 */
export function registerMetaverseServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    registerMetaverseServiceWorkerAsync().catch(() => {});
}

async function registerMetaverseServiceWorkerAsync() {
    try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await applyStoragePressureToServiceWorker();
    } catch (_) { /* 非セキュアコンテキスト・拒否など */ }
}
