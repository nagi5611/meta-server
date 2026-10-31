// public/js/world-preload-manifests.js — 入場先ワールドのマニフェスト先読み（ロッド非依存）

import ViewDistanceStreaming from './view-distance-streaming.js';
import { resolveWorldModelsForRod, DEFAULT_ROD_ID } from './world-rod-resolve.js';
import { clampViewDistanceM, VIEW_DISTANCE_M_DEFAULT } from './ibl-setup.js';
import { fetchPrefabManifestJson } from './prefab-load-shared.js';

const SPAWN_API_BASE = '/api/addons/nfc-spawn/spawn';

/**
 * URL からワールド ID を読む
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
 * @param {Record<string, unknown>} world
 * @param {{ rodId?: string, viewDistanceM?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function collectEntryWorldPreloadPaths(world, opts = {}) {
    if (!world || typeof world !== 'object') return [];

    const rodId = opts.rodId || DEFAULT_ROD_ID;
    const modelsForRod = resolveWorldModelsForRod(
        Array.isArray(world.models) ? world.models : [],
        rodId
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
 * ログイン画面: worlds 取得 + 入場先の prefab マニフェスト JSON を並列先読み
 * @param {string} [hintWorldId]
 * @returns {Promise<string|null>}
 */
export async function prefetchManifestsForWorld(hintWorldId) {
    const res = await fetch('/api/worlds');
    if (!res.ok) return null;
    const worlds = await res.json();
    if (!worlds || typeof worlds !== 'object') return null;

    const hint = String(hintWorldId || '').trim();
    let worldId = hint && worlds[hint] ? hint : await resolveEntryWorldId(worlds);
    if (!worldId) return null;

    const world = worlds[worldId];
    if (!world || typeof world !== 'object') return null;

    const models = resolveWorldModelsForRod(
        Array.isArray(world.models) ? world.models : [],
        DEFAULT_ROD_ID
    );
    /** @type {Set<string>} */
    const manifestPaths = new Set();
    for (const cfg of models) {
        const pfm = String(cfg.prefabManifest || '').trim();
        if (pfm) manifestPaths.add(pfm);
    }

    const list = [...manifestPaths];
    if (list.length) {
        let cursor = 0;
        const concurrency = Math.min(16, list.length);
        async function worker() {
            while (cursor < list.length) {
                const i = cursor++;
                try {
                    await fetchPrefabManifestJson(list[i]);
                } catch {
                    /* 入場時に再試行 */
                }
            }
        }
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        console.info(`[world-preload] prefetched ${list.length} manifest(s) for world: ${worldId}`);
    }

    return worldId;
}
