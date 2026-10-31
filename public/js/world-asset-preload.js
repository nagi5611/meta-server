// public/js/world-asset-preload.js — 入場前の論理パス収集・一括 HEAD・GLB セッションキャッシュ

import ViewDistanceStreaming from './view-distance-streaming.js';
import { prefetchSignedAssetHrefs, resolveModelAssetHref } from './asset-resolve.js';
import { resolveWorldModelsForRod } from './world-rod-resolve.js';
import { clampViewDistanceM, VIEW_DISTANCE_M_DEFAULT } from './ibl-setup.js';
import { batchFetchModelContentLengths, batchWarmAssetBuffers } from './model-load-batch.js';
import { clearModelAssetSessionCache } from './model-asset-session-cache.js';
import { clearPrefabManifestCache } from './prefab-manifest-cache.js';
import {
    isLoginWorldAssetWarmFresh,
    markLoginWorldAssetWarmComplete,
} from './login-preload-state.js';
import {
    resolvePrefabPartAssetPath,
    normalizePrefabManifest,
} from './prefab-load-shared.js';
/**
 * @param {Record<string, unknown>} config
 * @param {ReturnType<typeof normalizePrefabManifest>} manifest
 * @param {number} partIndex
 * @returns {number}
 */
function resolvePrefabPartLodRank(config, manifest, partIndex) {
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
 * @param {Record<string, unknown>} config
 * @param {ReturnType<typeof normalizePrefabManifest>} manifest
 * @param {number} partIndex
 * @returns {boolean}
 */
function shouldPreloadLightestLodPart(config, manifest, partIndex) {
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
 * @param {string} rodId
 * @param {number} viewDistanceM
 * @param {ViewDistanceStreaming} vas
 * @returns {Promise<string[]>}
 */
export async function collectEntryAssetLogicalPaths(world, rodId, viewDistanceM, vas) {
    if (!world || typeof world !== 'object') return [];

    const modelsForRod = resolveWorldModelsForRod(
        Array.isArray(world.models) ? world.models : [],
        rodId
    );
    const spawn = world.spawnPoint && typeof world.spawnPoint === 'object'
        ? world.spawnPoint
        : { x: 0, y: 10, z: 0 };
    const vd = clampViewDistanceM(viewDistanceM ?? VIEW_DISTANCE_M_DEFAULT);

    /** @type {Set<string>} */
    const paths = new Set(
        vas.collectInitialPrefetchPaths(spawn, vd, {
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
 * 論理パスのうち GLB/モデル本体（JSON マニフェスト以外）だけ返す
 * @param {string[]} logicalPaths
 * @returns {string[]}
 */
export function filterModelBinaryLogicalPaths(logicalPaths) {
    return logicalPaths.filter((p) => {
        const lower = String(p || '').toLowerCase();
        if (!lower) return false;
        if (lower.endsWith('.json')) return false;
        return (
            lower.endsWith('.glb')
            || lower.endsWith('.gltf')
            || lower.endsWith('.obj')
            || lower.includes('.glb?')
            || lower.includes('.gltf?')
        );
    });
}

/**
 * 入場ワールドのアセットを一括 HEAD + GET（セッションキャッシュ）する
 * @param {{
 *   worldId: string,
 *   world: Record<string, unknown>,
 *   rodId: string,
 *   viewDistanceM: number,
 *   vas: ViewDistanceStreaming,
 * }} params
 * @returns {Promise<void>}
 */
export async function ensureEntryWorldAssetsReady(params) {
    const worldId = String(params.worldId || '').trim();
    const rodId = String(params.rodId || '').trim();
    const { world, vas, viewDistanceM } = params;
    if (!worldId || !world || !vas) return;

    if (isLoginWorldAssetWarmFresh(worldId, rodId)) {
        return;
    }

    const logicalPaths = await collectEntryAssetLogicalPaths(world, rodId, viewDistanceM, vas);
    if (!logicalPaths.length) {
        markLoginWorldAssetWarmComplete(worldId, rodId);
        return;
    }

    await prefetchSignedAssetHrefs(logicalPaths);

    const binaryPaths = filterModelBinaryLogicalPaths(logicalPaths);
    const resolved = await Promise.all(binaryPaths.map((p) => resolveModelAssetHref(p)));
    const urls = [...new Set(resolved.filter(Boolean))];

    if (urls.length) {
        await batchFetchModelContentLengths(urls);
        await batchWarmAssetBuffers(urls);
    }

    markLoginWorldAssetWarmComplete(worldId, rodId);
}

/**
 * ワールド切替時: バイナリキャッシュのみ破棄（マニフェスト JSON は再利用可）
 */
export function clearWorldBinaryAssetCache() {
    clearModelAssetSessionCache();
}

/**
 * 完全リセット（デバッグ・強制再読込用）
 */
export function clearAllWorldAssetCaches() {
    clearModelAssetSessionCache();
    clearPrefabManifestCache();
}

/**
 * legacy 初回 loadWorldModels 向け: サイズチェック対象 URL を収集
 * @param {Array<object|string>} modelConfigs
 * @param {(idx: number) => ReturnType<typeof normalizePrefabManifest>|null} getLegacyManifest
 * @param {(idx: number) => boolean} modelIndexFilter
 * @param {(path: string) => Promise<string>} resolveHref
 * @returns {Promise<string[]>}
 */
export async function collectLegacyLoadSizeCheckUrls(
    modelConfigs,
    getLegacyManifest,
    modelIndexFilter,
    resolveHref
) {
    /** @type {string[]} */
    const hrefs = [];
    for (let idx = 0; idx < modelConfigs.length; idx++) {
        if (typeof modelIndexFilter === 'function' && !modelIndexFilter(idx)) continue;
        const fullConfig = typeof modelConfigs[idx] === 'string' ? { path: modelConfigs[idx] } : modelConfigs[idx];
        const modelPath = String(fullConfig.path || '').trim();
        const pfm = String(fullConfig.prefabManifest || '').trim();

        if (pfm) {
            const man =
                typeof getLegacyManifest === 'function' ? getLegacyManifest(idx) : null;
            if (man?.parts?.length) {
                for (const part of man.parts) {
                    const partPath = resolvePrefabPartAssetPath(part.file);
                    hrefs.push(await resolveHref(partPath));
                }
            }
            continue;
        }
        if (!modelPath) continue;
        hrefs.push(await resolveHref(modelPath));
        const mtlPath = String(fullConfig.mtlPath || '').trim();
        if (mtlPath) hrefs.push(await resolveHref(mtlPath));
    }
    return [...new Set(hrefs.filter(Boolean))];
}
