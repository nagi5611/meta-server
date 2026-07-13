// public/js/world-preload.js — ログイン画面から入場先ワールドのアセットを事前取得

import ViewDistanceStreaming from './view-distance-streaming.js';
import { prefetchSignedAssetHrefs, resolveModelAssetHref, loadClientConfigOnce } from './asset-resolve.js';
import { resolveWorldModelsForRod, DEFAULT_ROD_ID } from './world-rod-resolve.js';
import { VIEW_DISTANCE_M_DEFAULT, clampViewDistanceM } from './ibl-setup.js';
import { registerMetaverseServiceWorker } from './service-worker-register.js';
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

const SPAWN_API_BASE = '/api/addons/nfc-spawn/spawn';

/** @type {Promise<void> | null} */
let activePreload = null;

/**
 * URL からワールド ID を読む（main.js と同じ優先度の一部）
 * @returns {string|null}
 */
function getWorldIdFromUrl() {
    try {
        const fromQuery = new URLSearchParams(window.location.search).get('world');
        if (fromQuery != null) {
            const id = String(fromQuery).trim();
            if (id) return id;
        }
        const rawHash = window.location.hash.replace(/^#/, '');
        if (rawHash.startsWith('world=')) {
            const id = rawHash.slice('world='.length).split('&')[0].trim();
            if (id) return decodeURIComponent(id);
        }
    } catch {
        /* ignore */
    }
    return null;
}

/**
 * NFC spawn トークンからワールド ID を解決する
 * @param {string} token
 * @returns {Promise<string|null>}
 */
async function resolveSpawnWorldId(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    try {
        const res = await fetch(`${SPAWN_API_BASE}/${encodeURIComponent(t)}`, {
            credentials: 'same-origin',
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.ok || !data.world) return null;
        return String(data.world);
    } catch {
        return null;
    }
}

/**
 * 入場先ワールド ID を決定する（?spawn= > ?world= > lobby > 先頭）
 * @param {Record<string, unknown>} worlds
 * @returns {Promise<string|null>}
 */
export async function resolveEntryWorldId(worlds) {
    if (!worlds || typeof worlds !== 'object') return null;

    const spawnToken = window.metaverseSpawnPending?.getPendingSpawnToken?.();
    if (spawnToken) {
        const fromSpawn = await resolveSpawnWorldId(spawnToken);
        if (fromSpawn && worlds[fromSpawn]) return fromSpawn;
    }

    const urlWorld = getWorldIdFromUrl();
    if (urlWorld && worlds[urlWorld]) return urlWorld;

    if (worlds.lobby) return 'lobby';
    const first = Object.values(worlds).find((w) => w && typeof w === 'object' && w.id);
    return first && typeof first.id === 'string' ? first.id : null;
}

/**
 * prefab パーツの LOD ランクを解決する（scene-manager と同じ優先度）
 * @param {Record<string, unknown>} config
 * @param {ReturnType<import('./prefab-load-shared.js').normalizePrefabManifest>} manifest
 * @param {number} partIndex
 * @returns {number}
 */
export function resolvePrefabPartLodRank(config, manifest, partIndex) {
    const defRank = Number.isFinite(config.lodRank) ? Math.max(1, Math.floor(Number(config.lodRank))) : 1;
    const part = manifest?.parts?.[partIndex];
    const partRanks = config.lodPartRanks;
    if (partRanks && typeof partRanks === 'object' && !Array.isArray(partRanks) && part?.file) {
        const key = String(part.file).trim();
        if (key && partRanks[key] != null) {
            const r = Number(partRanks[key]);
            if (Number.isFinite(r) && r > 0) return Math.max(1, Math.floor(r));
        }
    }
    if (Array.isArray(config.lodRanks) && config.lodRanks.length > partIndex) {
        const r = Number(config.lodRanks[partIndex]);
        if (Number.isFinite(r) && r > 0) return Math.max(1, Math.floor(r));
    }
    return defRank;
}

/**
 * 距離 LOD がある場合は最軽量（数字が最小）のパーツのみ事前取得対象にする
 * @param {Record<string, unknown>} config
 * @param {ReturnType<import('./prefab-load-shared.js').normalizePrefabManifest>} manifest
 * @param {number} partIndex
 * @returns {boolean}
 */
export function shouldPreloadLightestLodPart(config, manifest, partIndex) {
    const lodId = String(config.lodId || '').trim();
    if (!lodId || !manifest?.parts?.length) return true;

    let minRank = Infinity;
    for (let i = 0; i < manifest.parts.length; i++) {
        minRank = Math.min(minRank, resolvePrefabPartLodRank(config, manifest, i));
    }
    if (!Number.isFinite(minRank)) return true;
    return resolvePrefabPartLodRank(config, manifest, partIndex) === minRank;
}

/**
 * ロッド1（既定・軽量）向けに入場周辺アセットの論理パスを収集する
 * @param {Record<string, unknown>} world
 * @param {{ viewDistanceM?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function collectEntryWorldPreloadPaths(world, opts = {}) {
    if (!world || typeof world !== 'object') return [];

    const modelsForRod = resolveWorldModelsForRod(
        Array.isArray(world.models) ? world.models : [],
        DEFAULT_ROD_ID
    );
    const spawn = world.spawnPoint && typeof world.spawnPoint === 'object'
        ? world.spawnPoint
        : { x: 0, y: 10, z: 0 };
    const viewDistanceM = clampViewDistanceM(opts.viewDistanceM ?? VIEW_DISTANCE_M_DEFAULT);

    const vas = new ViewDistanceStreaming(null);
    await vas.buildRegistry(modelsForRod);

    /** @type {Set<string>} */
    const paths = new Set(
        vas.collectInitialPrefetchPaths(spawn, viewDistanceM, {
            partFilter: shouldPreloadLightestLodPart,
        })
    );

    for (const cfg of modelsForRod) {
        const pfm = String(cfg.prefabManifest || '').trim();
        if (pfm) paths.add(pfm);
        const plain = String(cfg.path || '').trim();
        if (plain && !pfm) paths.add(plain);
    }

    return [...paths].filter(Boolean);
}

/**
 * 論理パス群を fetch してブラウザ / SW キャッシュを温める
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
async function warmFetchAssetPaths(paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    if (!unique.length) return;

    await prefetchSignedAssetHrefs(unique);

    let concurrency = 24;
    try {
        const cfg = await loadClientConfigOnce();
        const n = cfg && typeof cfg === 'object' ? cfg.planLoadConcurrency : undefined;
        const num = Number(n);
        if (Number.isFinite(num) && num >= 1) concurrency = Math.min(128, Math.floor(num));
    } catch {
        /* ignore */
    }

    const urls = await Promise.all(unique.map((p) => resolveModelAssetHref(p)));
    const deduped = [...new Set(urls.filter(Boolean))];

    let cursor = 0;
    async function worker() {
        while (cursor < deduped.length) {
            const i = cursor++;
            const url = deduped[i];
            try {
                const credentials = (() => {
                    try {
                        const abs = url.startsWith('http') ? new URL(url) : new URL(url, window.location.origin);
                        return abs.origin === window.location.origin ? 'include' : 'omit';
                    } catch {
                        return 'omit';
                    }
                })();
                await fetch(url, { credentials });
            } catch {
                /* 失敗しても入場時に再試行 */
            }
        }
    }
    const workers = Math.min(concurrency, deduped.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * 指定ワールドの入場周辺アセットを事前取得する
 * @param {string} worldId
 * @param {Record<string, unknown>} [worlds] 省略時は /api/worlds を取得
 * @returns {Promise<void>}
 */
export async function preloadWorldAssets(worldId, worlds) {
    let worldMap = worlds;
    if (!worldMap) {
        const res = await fetch('/api/worlds');
        if (!res.ok) return;
        worldMap = await res.json();
    }
    if (!worldMap || typeof worldMap !== 'object') return;

    const world = worldMap[worldId];
    if (!world || typeof world !== 'object') return;

    const paths = await collectEntryWorldPreloadPaths(world);
    if (!paths.length) return;

    console.info(`[world-preload] warming ${paths.length} assets for world: ${worldId}`);
    await warmFetchAssetPaths(paths);
}

/**
 * ログイン画面用: 入場先ワールドの事前取得を開始（多重呼び出し安全）
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
            const res = await fetch('/api/worlds');
            if (!res.ok) return;
            const worlds = await res.json();
            const worldId = await resolveEntryWorldId(worlds);
            if (!worldId) return;
            await preloadWorldAssets(worldId, worlds);
            markLoginPreloadComplete(worldId);
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
