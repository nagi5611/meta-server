// public/js/view-distance-streaming.js — View-Distance Asset Streaming（VAS）

import * as THREE from 'three';
import { clampViewDistanceM } from './ibl-setup.js';
import {
    fetchPrefabManifestJson,
    normalizePrefabManifest,
    prefabManifestHasStreamingBounds,
    prefabManifestHasPartStreamingBounds,
} from './prefab-load-shared.js';

/** 同時ストリーミング DL 上限 */
const VAS_MAX_CONCURRENT_LOADS = 3;

/** 描画距離の何倍以上離れたらメモリからアンロードするか */
const VAS_UNLOAD_DISTANCE_MULTIPLIER = 2;

/** 1 tick あたりの最大アンロード数 */
const VAS_MAX_UNLOADS_PER_TICK = 4;

/**
 * マニフェスト bounds.center を models[].TRS でワールド空間へ変換し、判定用の球を返す
 * @param {object} config models[] の1要素
 * @param {import('./prefab-load-shared.js').PrefabBounds} manifestBounds
 * @returns {{ center: THREE.Vector3, radius: number }}
 */
export function computeWorldLoadSphere(config, manifestBounds) {
    const position = config.position || { x: 0, y: 0, z: 0 };
    const rotation = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 1, y: 1, z: 1 };

    const pos = new THREE.Vector3(position.x, position.y, position.z);
    const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
            (rotation.x * Math.PI) / 180,
            (rotation.y * Math.PI) / 180,
            (rotation.z * Math.PI) / 180,
            'XYZ'
        )
    );
    const scl = new THREE.Vector3(scale.x, scale.y, scale.z);
    const matrix = new THREE.Matrix4().compose(pos, quat, scl);

    const localCenter = new THREE.Vector3(
        manifestBounds.center[0],
        manifestBounds.center[1],
        manifestBounds.center[2]
    );
    const worldCenter = localCenter.applyMatrix4(matrix);
    const maxScale = Math.max(
        Math.abs(scale.x),
        Math.abs(scale.y),
        Math.abs(scale.z),
        1e-6
    );
    return {
        center: worldCenter,
        radius: manifestBounds.radius * maxScale,
    };
}

/**
 * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
 * @param {THREE.Vector3} worldCenter
 * @param {number} worldRadius
 * @param {number} viewDistanceM
 * @returns {boolean}
 */
export function isWithinViewDistanceLoadRange(feetWorld, worldCenter, worldRadius, viewDistanceM) {
    const R = clampViewDistanceM(viewDistanceM);
    const p =
        feetWorld instanceof THREE.Vector3
            ? feetWorld
            : new THREE.Vector3(feetWorld.x, feetWorld.y, feetWorld.z);
    return p.distanceTo(worldCenter) <= R + worldRadius;
}

/**
 * 描画距離の2倍以上離れているか（アンロード判定）
 * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
 * @param {THREE.Vector3} worldCenter
 * @param {number} worldRadius
 * @param {number} viewDistanceM
 * @returns {boolean}
 */
export function isBeyondViewDistanceUnloadRange(feetWorld, worldCenter, worldRadius, viewDistanceM) {
    const R = clampViewDistanceM(viewDistanceM);
    const unloadR = R * VAS_UNLOAD_DISTANCE_MULTIPLIER;
    const p =
        feetWorld instanceof THREE.Vector3
            ? feetWorld
            : new THREE.Vector3(feetWorld.x, feetWorld.y, feetWorld.z);
    return p.distanceTo(worldCenter) > unloadR + worldRadius;
}

/**
 * @param {import('./view-distance-streaming.js').ViewDistanceEntry} entry
 * @returns {boolean}
 */
function isDistanceGatedStreamingEntry(entry) {
    return entry.mode === 'streaming' || entry.mode === 'streaming_part';
}

/**
 * View-Distance Asset Streaming コントローラ
 */
export default class ViewDistanceStreaming {
    /**
     * @param {import('./scene-manager.js').default} sceneManager
     */
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        /** @type {ViewDistanceEntry[]} */
        this.entries = [];
        this._loadingCount = 0;
        this._tickRunning = false;
    }

    reset() {
        this.entries = [];
        this._loadingCount = 0;
        this._tickRunning = false;
    }

    /**
     * ワールド models[] から VAS レジストリを構築（マニフェスト JSON のみ fetch）
     * @param {Array<object|string>} modelConfigs
     */
    async buildRegistry(modelConfigs) {
        this.reset();
        if (!Array.isArray(modelConfigs)) return;

        for (let i = 0; i < modelConfigs.length; i++) {
            const config = typeof modelConfigs[i] === 'string' ? { path: modelConfigs[i] } : modelConfigs[i];
            const pfm = String(config.prefabManifest || '').trim();
            const modelPath = String(config.path || '').trim();

            if (!pfm && !modelPath) continue;

            if (!pfm) {
                this.entries.push({
                    idx: i,
                    mode: 'legacy',
                    state: 'idle',
                    config,
                });
                continue;
            }

            try {
                const raw = await fetchPrefabManifestJson(pfm);
                const man = normalizePrefabManifest(raw);

                if (prefabManifestHasPartStreamingBounds(man)) {
                    for (let pi = 0; pi < man.parts.length; pi++) {
                        const part = man.parts[pi];
                        if (part.bounds) {
                            const sphere = computeWorldLoadSphere(config, part.bounds);
                            this.entries.push({
                                idx: i,
                                partIndex: pi,
                                mode: 'streaming_part',
                                state: 'idle',
                                config,
                                prefabManifest: pfm,
                                manifest: man,
                                worldCenter: sphere.center,
                                worldRadius: sphere.radius,
                            });
                        } else {
                            this.entries.push({
                                idx: i,
                                partIndex: pi,
                                mode: 'streaming_part_piggyback',
                                state: 'idle',
                                config,
                                prefabManifest: pfm,
                                manifest: man,
                                piggyback: true,
                            });
                        }
                    }
                } else if (prefabManifestHasStreamingBounds(man) && man.bounds) {
                    const sphere = computeWorldLoadSphere(config, man.bounds);
                    this.entries.push({
                        idx: i,
                        mode: 'streaming',
                        state: 'idle',
                        config,
                        prefabManifest: pfm,
                        manifest: man,
                        worldCenter: sphere.center,
                        worldRadius: sphere.radius,
                    });
                } else {
                    this.entries.push({
                        idx: i,
                        mode: 'legacy',
                        state: 'idle',
                        config,
                        prefabManifest: pfm,
                    });
                }
            } catch (err) {
                console.warn('[VAS] manifest fetch failed, legacy fallback:', pfm, err);
                this.entries.push({
                    idx: i,
                    mode: 'legacy',
                    state: 'idle',
                    config,
                    prefabManifest: pfm,
                });
            }
        }
    }

    /**
     * @param {number} idx
     * @returns {boolean}
     */
    isLegacyIndex(idx) {
        const forIdx = this.entries.filter((e) => e.idx === idx);
        if (!forIdx.length) return true;
        return forIdx.every((e) => e.mode === 'legacy');
    }

    /**
     * spawn 周辺の streaming エントリを初回ロード（並列上限のため複数パス）
     * @param {{ x: number, y: number, z: number }} spawnPoint
     * @param {number} viewDistanceM
     */
    async runInitialNearSpawn(spawnPoint, viewDistanceM) {
        const feet = new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z);
        for (let pass = 0; pass < 256; pass++) {
            if (!this._hasIdleStreamingInRange(feet, viewDistanceM)) break;
            await this._drainInRangeLoads(feet, viewDistanceM);
        }
    }

    /**
     * @param {THREE.Vector3} feetWorld
     * @param {number} viewDistanceM
     * @returns {boolean}
     */
    _hasIdleStreamingInRange(feetWorld, viewDistanceM) {
        return this.entries.some(
            (entry) =>
                isDistanceGatedStreamingEntry(entry)
                && entry.state === 'idle'
                && entry.worldCenter
                && Number.isFinite(entry.worldRadius)
                && isWithinViewDistanceLoadRange(
                    feetWorld,
                    entry.worldCenter,
                    entry.worldRadius,
                    viewDistanceM
                )
        );
    }

    /**
     * 毎フレーム: 描画距離内の未ロード prefab / パーツを順次 DL
     * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
     * @param {number} viewDistanceM
     */
    async tick(feetWorld, viewDistanceM) {
        if (this._tickRunning) return;
        this._tickRunning = true;
        try {
            const bvhDirty = this._drainOutOfRangeUnloads(feetWorld, viewDistanceM);
            if (bvhDirty) {
                this.sceneManager.scheduleBVHRegeneration();
            }
            await this._drainInRangeLoads(feetWorld, viewDistanceM);
        } finally {
            this._tickRunning = false;
        }
    }

    /**
     * @param {number} modelIdx
     */
    async _loadPiggybackPartsForModel(modelIdx) {
        const piggybacks = this.entries.filter(
            (e) =>
                e.idx === modelIdx
                && e.mode === 'streaming_part_piggyback'
                && e.state === 'idle'
        );
        for (const entry of piggybacks) {
            if (entry.partIndex === undefined || !entry.manifest || !entry.prefabManifest) continue;
            entry.state = 'loading';
            try {
                await this.sceneManager.loadStreamingPrefabPart(
                    entry.idx,
                    entry.partIndex,
                    entry.manifest,
                    entry.prefabManifest
                );
                entry.state = 'loaded';
            } catch (err) {
                console.error('[VAS] piggyback part load failed', entry.idx, entry.partIndex, err);
                entry.state = 'failed';
            }
        }
    }

    /**
     * 描画距離の2倍より外のロード済みパーツ / prefab をメモリから解放
     * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
     * @param {number} viewDistanceM
     * @returns {boolean} BVH 再生成が必要なら true
     */
    _drainOutOfRangeUnloads(feetWorld, viewDistanceM) {
        let bvhDirty = false;
        let unloadCount = 0;

        for (const entry of this.entries) {
            if (unloadCount >= VAS_MAX_UNLOADS_PER_TICK) break;

            if (entry.mode === 'streaming_part' && entry.state === 'loaded') {
                if (!entry.worldCenter || !Number.isFinite(entry.worldRadius)) continue;
                if (entry.partIndex === undefined) continue;
                if (!isBeyondViewDistanceUnloadRange(
                    feetWorld,
                    entry.worldCenter,
                    entry.worldRadius,
                    viewDistanceM
                )) {
                    continue;
                }
                if (this.sceneManager.unloadStreamingPrefabPart(entry.idx, entry.partIndex)) {
                    entry.state = 'idle';
                    bvhDirty = true;
                    unloadCount++;
                }
                continue;
            }

            if (entry.mode === 'streaming' && entry.state === 'loaded') {
                if (!entry.worldCenter || !Number.isFinite(entry.worldRadius)) continue;
                if (!isBeyondViewDistanceUnloadRange(
                    feetWorld,
                    entry.worldCenter,
                    entry.worldRadius,
                    viewDistanceM
                )) {
                    continue;
                }
                if (this.sceneManager.unloadSingleWorldModelEntry(entry.idx)) {
                    entry.state = 'idle';
                    bvhDirty = true;
                    unloadCount++;
                }
            }
        }

        for (const entry of this.entries) {
            if (unloadCount >= VAS_MAX_UNLOADS_PER_TICK) break;
            if (entry.mode !== 'streaming_part_piggyback' || entry.state !== 'loaded') continue;
            if (entry.partIndex === undefined) continue;
            if (!this._shouldUnloadPiggybackPart(entry.idx, feetWorld, viewDistanceM)) continue;
            if (this.sceneManager.unloadStreamingPrefabPart(entry.idx, entry.partIndex)) {
                entry.state = 'idle';
                bvhDirty = true;
                unloadCount++;
            }
        }

        return bvhDirty;
    }

    /**
     * bounds 無し piggyback: 同 idx の bounded パーツがメモリに無ければアンロード可
     * @param {number} modelIdx
     * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
     * @param {number} viewDistanceM
     * @returns {boolean}
     */
    _shouldUnloadPiggybackPart(modelIdx, feetWorld, viewDistanceM) {
        const bounded = this.entries.filter(
            (e) => e.idx === modelIdx && e.mode === 'streaming_part'
        );
        const anyBoundedLoaded = bounded.some((e) => e.state === 'loaded');
        if (anyBoundedLoaded) return false;
        const anyBoundedInLoadRange = bounded.some(
            (e) =>
                e.worldCenter
                && Number.isFinite(e.worldRadius)
                && isWithinViewDistanceLoadRange(
                    feetWorld,
                    e.worldCenter,
                    e.worldRadius,
                    viewDistanceM
                )
        );
        return !anyBoundedInLoadRange;
    }

    /**
     * @param {ViewDistanceEntry} entry
     */
    async _loadEntry(entry) {
        if (entry.mode === 'streaming') {
            await this.sceneManager.loadSingleWorldModelEntry(entry.idx);
            return;
        }
        if (entry.mode === 'streaming_part') {
            if (entry.partIndex === undefined || !entry.manifest || !entry.prefabManifest) {
                throw new Error('streaming_part entry missing manifest or partIndex');
            }
            await this.sceneManager.loadStreamingPrefabPart(
                entry.idx,
                entry.partIndex,
                entry.manifest,
                entry.prefabManifest
            );
            await this._loadPiggybackPartsForModel(entry.idx);
            return;
        }
        throw new Error(`unsupported VAS load mode: ${entry.mode}`);
    }

    /**
     * @param {THREE.Vector3 | { x: number, y: number, z: number }} feetWorld
     * @param {number} viewDistanceM
     */
    async _drainInRangeLoads(feetWorld, viewDistanceM) {
        /** @type {Promise<void>[]} */
        const jobs = [];

        for (const entry of this.entries) {
            if (!isDistanceGatedStreamingEntry(entry)) continue;
            if (entry.state !== 'idle') continue;
            if (!entry.worldCenter || !Number.isFinite(entry.worldRadius)) continue;
            if (!isWithinViewDistanceLoadRange(feetWorld, entry.worldCenter, entry.worldRadius, viewDistanceM)) {
                continue;
            }
            if (this._loadingCount + jobs.length >= VAS_MAX_CONCURRENT_LOADS) {
                break;
            }

            entry.state = 'loading';
            this._loadingCount++;
            jobs.push(
                (async () => {
                    try {
                        await this._loadEntry(entry);
                        entry.state = 'loaded';
                        this.sceneManager.scheduleBVHRegeneration();
                    } catch (err) {
                        console.error('[VAS] load failed for entry', entry.idx, entry.partIndex, err);
                        entry.state = 'failed';
                    } finally {
                        this._loadingCount--;
                    }
                })()
            );
        }

        if (jobs.length) {
            await Promise.all(jobs);
        }
    }
}

/**
 * @typedef {object} ViewDistanceEntry
 * @property {number} idx models[] インデックス
 * @property {number} [partIndex] prefab パーツ index（パーツ単位ストリーミング時）
 * @property {'streaming' | 'streaming_part' | 'streaming_part_piggyback' | 'legacy'} mode
 * @property {'idle' | 'loading' | 'loaded' | 'failed'} state
 * @property {object} config
 * @property {string} [prefabManifest]
 * @property {ReturnType<typeof normalizePrefabManifest>} [manifest]
 * @property {THREE.Vector3} [worldCenter]
 * @property {number} [worldRadius]
 * @property {boolean} [piggyback] bounds 無しパーツ（同プレハブの近傍パーツロード時に追随）
 */
