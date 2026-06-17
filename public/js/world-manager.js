/**
 * WorldManager - Manages world configurations and switching.
 * Worlds are loaded from GET /api/worlds (data/worlds.json). No hardcoded fallback.
 */

import ViewDistanceStreaming from './view-distance-streaming.js';
import { prefetchSignedAssetHrefs } from './asset-resolve.js';
import { promptRodSelection } from './rod-selection.js';
import { resolveWorldModelsForRod, DEFAULT_ROD_ID } from './world-rod-resolve.js';

class WorldManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.currentWorld = null;
        this.onWorldChangeCallback = null;
        this.worlds = null; // Set by init() from API
        /** @type {{ begin?: (o: { totalCount: number, preparing?: boolean }) => void, progress?: (o: { fileName: string, completedCount: number, totalCount: number, loadKind?: string }) => void, finalize?: (beforePaint?: () => void) => Promise<void>, onLoadStart?: () => void, onLoadComplete?: () => void | Promise<void> } | null} */
        this._worldLoadUi = null;
        /** @type {ViewDistanceStreaming | null} */
        this._viewDistanceStreaming = null;
        /** @type {string} 現在の品質ロッド（クライアントローカルのみ） */
        this._activeRodId = DEFAULT_ROD_ID;
    }

    /**
     * 現在選択中の品質ロッド ID（他プレイヤーには送信しない）
     * @returns {string}
     */
    getActiveRodId() {
        return this._activeRodId || DEFAULT_ROD_ID;
    }

    /**
     * @returns {ViewDistanceStreaming | null}
     */
    getViewDistanceStreaming() {
        return this._viewDistanceStreaming;
    }

    /**
     * ワールド読み込み中のロードバー等（メインクライアントから登録）
     * @param {{ begin?: (o: { totalCount: number, preparing?: boolean }) => void, progress?: (o: { fileName: string, completedCount: number, totalCount: number, loadKind?: string }) => void, finalize?: (beforePaint?: () => void) => Promise<void>, onLoadStart?: () => void, onLoadComplete?: () => void | Promise<void> } | null} handlers
     */
    setWorldLoadUiHandlers(handlers) {
        this._worldLoadUi = handlers || null;
    }

    /**
     * モデル設定から path ありの件数を数える
     * @param {Array} modelList
     * @returns {number}
     */
    _countModelsWithPath(modelList) {
        if (!Array.isArray(modelList)) return 0;
        let n = 0;
        for (const c of modelList) {
            const o = typeof c === 'string' ? { path: c } : c;
            if (String(o?.path || '').trim() || String(o?.prefabManifest || '').trim()) n++;
        }
        return n;
    }

    /**
     * Load worlds from API. Call once before loadWorld.
     */
    async init() {
        try {
            const res = await fetch('/api/worlds');
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object') {
                    this.worlds = data;
                    console.log('Worlds loaded from API');
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to fetch worlds:', err.message);
        }
        this.worlds = this.worlds || {};
    }

    /**
     * Get world configuration by ID
     */
    getWorld(worldId) {
        if (!this.worlds) return null;
        return this.worlds[worldId] || null;
    }

    /**
     * Get current world
     */
    getCurrentWorld() {
        return this.currentWorld;
    }

    /**
     * Get current world ID
     */
    getCurrentWorldId() {
        return this.currentWorld ? this.currentWorld.id : null;
    }

    /**
     * Load a world by ID
     * @param {string} worldId - World ID to load
     * @param {function} onComplete - Callback when world is loaded
     */
    async loadWorld(worldId, onComplete) {
        const world = this.getWorld(worldId);
        if (!world) {
            console.error(`World not found: ${worldId}`);
            return;
        }

        console.log(`Loading world: ${worldId}`);

        this._worldLoadUi?.onLoadStart?.();

        const rodId = await promptRodSelection(world);
        this._activeRodId = rodId;
        const modelsForRod = resolveWorldModelsForRod(
            Array.isArray(world.models) ? world.models : [],
            rodId
        );

        // Clear current world if any
        if (this.currentWorld) {
            this._viewDistanceStreaming?.reset();
            this._viewDistanceStreaming = null;
            this.sceneManager.clearWorld();
        }

        // Set current world
        this.currentWorld = world;

        this.sceneManager.setFloorVisible(world.floorEnabled !== false);
        this.sceneManager.applyFloorDimensionsFromWorld(world);

        // Add world-specific lights (position, type, intensity)
        this.sceneManager.addWorldLights(world.lights);

        const modelList = modelsForRod;
        const pdfList = Array.isArray(world.pdfs) ? world.pdfs : [];
        const totalAssets = this._countModelsWithPath(modelList) + pdfList.length;

        /** @type {{ completedCount: number, totalCount: number }} */
        const loadState = { completedCount: 0, totalCount: 0 };
        if (totalAssets > 0) {
            this._worldLoadUi?.begin?.({ totalCount: 0, preparing: true });
        }

        const vas = new ViewDistanceStreaming(this.sceneManager);
        await vas.buildRegistry(modelList);
        this._viewDistanceStreaming = vas;

        const spawn = world.spawnPoint || { x: 0, y: 10, z: 0 };
        const viewDistanceM = this.sceneManager.graphicsOptions.viewDistanceM;
        loadState.totalCount = vas.countInitialLoadUnits(spawn, viewDistanceM, pdfList.length);

        const prefetchPaths = vas.collectInitialPrefetchPaths(spawn, viewDistanceM);
        if (prefetchPaths.length > 0) {
            await prefetchSignedAssetHrefs(prefetchPaths);
        }

        const onLoadProgress = (detail) => {
            this._worldLoadUi?.progress?.(detail);
        };

        if (totalAssets > 0 && loadState.totalCount > 0) {
            this._worldLoadUi?.begin?.({ totalCount: loadState.totalCount, preparing: false });
        } else if (totalAssets > 0) {
            this._worldLoadUi?.begin?.({ totalCount: 1, preparing: false });
            loadState.totalCount = 1;
        }

        try {
            await this.sceneManager.loadWorldModels(
                modelsForRod,
                async () => {
                    await vas.runInitialNearSpawn(spawn, viewDistanceM);
                    await this.sceneManager.flushBVHRegeneration();

                    await this.sceneManager.loadWorldPdfs(world.pdfs || [], {
                        loadState,
                        onLoadProgress,
                    });
                    if (typeof this._loadWorldFlightBoards === 'function') {
                        await this._loadWorldFlightBoards(world);
                    }

                    if (loadState.totalCount > 0 && loadState.completedCount < loadState.totalCount) {
                        loadState.completedCount = loadState.totalCount;
                        onLoadProgress({
                            fileName: '',
                            completedCount: loadState.completedCount,
                            totalCount: loadState.totalCount,
                        });
                    }
                },
                {
                    loadState,
                    onLoadProgress,
                    getLegacyManifest: (idx) => vas.getLegacyManifest(idx),
                    worldAircraftPhysics: world.aircraftPhysics,
                    worldLodSystem: world.lodSystem && typeof world.lodSystem === 'object' ? world.lodSystem : null,
                    modelIndexFilter: (idx) => vas.isLegacyIndex(idx),
                }
            );
        } finally {
            if (totalAssets > 0) {
                await this._worldLoadUi?.finalize?.(() => {
                    this.sceneManager.render();
                });
            }
            console.log(`World loaded: ${worldId}`);
            if (onComplete) {
                onComplete(world);
            }
            if (this.onWorldChangeCallback) {
                this.onWorldChangeCallback(world);
            }
            await this._worldLoadUi?.onLoadComplete?.();
        }
    }

    /**
     * Switch to a different world
     * @param {string} worldId - Target world ID
     * @param {function} onComplete - Callback when switch is complete
     */
    async switchWorld(worldId, onComplete) {
        console.log(`Switching to world: ${worldId}`);
        await this.loadWorld(worldId, onComplete);
    }

    /**
     * ワールド切替時コールバックを登録する（既存ハンドラは保持して連鎖）
     * @param {(world: object) => void} callback
     */
    onWorldChange(callback) {
        if (typeof callback !== 'function') return;
        const prev = this.onWorldChangeCallback;
        this.onWorldChangeCallback = (world) => {
            if (typeof prev === 'function') prev(world);
            callback(world);
        };
    }

    /**
     * Get spawn point for current world
     */
    getSpawnPoint() {
        if (!this.currentWorld) {
            return { x: 0, y: 10, z: 0 }; // Default spawn
        }
        return this.currentWorld.spawnPoint;
    }

    /**
     * Get all available worlds
     */
    getAllWorlds() {
        if (!this.worlds) return [];
        return Object.values(this.worlds);
    }
}

export default WorldManager;
