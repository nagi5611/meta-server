// public/js/world-preload.js — ログイン画面から入場先ワールドのアセットを事前取得

import { prefetchManifestsForWorld } from './world-preload-manifests.js';
import { registerMetaverseServiceWorker, awaitMetaverseServiceWorkerReady } from './service-worker-register.js';
import {
    LOGIN_PRELOAD_FRESH_MS,
    clearLoginPreloadState,
    isLoginPreloadFresh,
    markLoginPreloadComplete,
    recordLoginEntryClick,
} from './login-preload-state.js';

export {
    LOGIN_PRELOAD_FRESH_MS,
    clearLoginPreloadState,
    isLoginPreloadFresh,
    markLoginPreloadComplete,
    recordLoginEntryClick,
} from './login-preload-state.js';

export {
    resolvePrefabPartLodRank,
    shouldPreloadLightestLodPart,
    collectEntryWorldPreloadPaths,
} from './world-preload-manifests.js';

/** @type {Promise<void> | null} */
let activePreload = null;

/**
 * ログイン画面用: マニフェスト JSON のみ先読み（GLB 温めはロッド確定後に world-asset-preload）
 * @returns {Promise<void>}
 */
export function startLoginWorldPreload(expectedWorldId) {
    const expected = String(expectedWorldId || '').trim();
    if (isLoginPreloadFresh(expected || undefined)) {
        if (!activePreload) activePreload = Promise.resolve();
        return activePreload;
    }

    if (activePreload) return activePreload;

    activePreload = (async () => {
        try {
            registerMetaverseServiceWorker();
            await awaitMetaverseServiceWorkerReady();
            const worldId = await prefetchManifestsForWorld(expected || undefined);
            if (worldId) markLoginPreloadComplete(worldId, { phase: 'manifest-only' });
        } catch (e) {
            console.warn('[world-preload] failed:', e);
        }
    })();

    return activePreload;
}

/**
 * メイン画面の loadWorld 前に、ログイン画面で開始したプリロード完了を待つ
 * @returns {Promise<void>}
 */
export async function awaitWorldPreloadIfAny() {
    if (!activePreload) return;
    try {
        await activePreload;
    } catch {
        /* ignore */
    }
}
