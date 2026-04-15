import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createGLTFLoaderWithDraco } from './gltf-loader-draco.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import {
    migrateLegacyGraphicsKeys,
    clampViewDistanceM,
    normalizeGraphicsTier,
    getShadowMapSize,
    getShadowMapTypeConstant,
    getAntialiasForTier,
    loadSceneIBL,
    disposeSceneIBL,
    applyToneMapping,
    createGradientSkyDomeMesh,
    DEFAULT_HDR_PATH
} from './ibl-setup.js';
import {
    MODEL_MAX_BYTES_OBJ,
    MODEL_MAX_BYTES_GLTF,
    MODEL_MAX_TRIANGLES_TOTAL,
    MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD,
    fetchModelContentLength,
    countTrianglesInObject
} from './model-load-limits.js';
import { mergeAircraftPhysicsForObject } from './aircraft-physics-defaults.js';

/** ワールド複数モデル読み込みの同時実行数（キャッシュヒット時の直列待ちを緩和） */
const WORLD_MODEL_LOAD_CONCURRENCY = 8;

/**
 * 工場関数配列を最大 concurrency 本で同時実行し、結果を入力順の配列で返す
 * @template T
 * @param {number} concurrency
 * @param {Array<() => Promise<T>>} factories
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(concurrency, factories) {
    const n = factories.length;
    const results = new Array(n);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= n) break;
            results[i] = await factories[i]();
        }
    }
    const workers = Math.min(Math.max(1, concurrency), Math.max(1, n));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

class SceneManager {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.canvas = null;
        this.physicsManager = null; // Will be set from main.js
        this.environmentGroup = new THREE.Group(); // Container for all static objects
        this.animatedModels = []; // Track models with animations
        this.teleporters = []; // Track teleporter models
        this.taikos = []; // Track taiko drum models
        /** @type {{ model: THREE.Object3D, mixer: THREE.AnimationMixer }[]} ワールド GLB 用 AnimationMixer */
        this._gltfMixers = [];
        /** @type {{ model: THREE.Object3D, clipName: string, radius: number, label: string, access: string }[]} TeleportManager 登録用 */
        this._glbInteractConfigs = [];
        /** @type {object[]} 飛行機スロット（ワールドロード時に登録） */
        this.aircraftSlots = [];
        /** Lights added for current world (removed on clearWorld) */
        this.worldLights = [];
        /** Ground mesh (first child of environmentGroup). Visibility controlled by setFloorVisible. */
        this.groundMesh = null;
        /** Grid helper. Visibility controlled by setFloorVisible. */
        this.gridHelper = null;
        /** Graphics options (graphicsTier, toneMappingExposure, pixelRatioCap, viewDistanceM) */
        this.graphicsOptions = {
            graphicsTier: 'low',
            toneMappingExposure: 1,
            pixelRatioCap: 1,
            viewDistanceM: 50
        };
        /** 描画距離カリング用フレームカウンタ */
        this._drawCullFrame = 0;
        /** @type {import('three').Object3D[]} */
        this._drawCullTargets = [];
        /** ワールド設定の床表示希望（距離カリングと AND） */
        this._floorWantedVisible = true;
        /** WebXR セッション中は true（FPS 優先のティア上書きに使用） */
        this._xrSessionActive = false;
        /** 直近の MenuManager 設定（XR 終了後の再適用用） */
        this._lastGraphicsSettings = null;
        /** 現在のレンダラの antialias フラグ（ティア変更時の再生成判定） */
        this._rendererAntialias = true;

        this._onXRSessionStart = () => {
            this._xrSessionActive = true;
            this.applyGraphicsSettings(this._lastGraphicsSettings || this.graphicsOptions);
        };
        this._onXRSessionEnd = () => {
            this._xrSessionActive = false;
            this.applyGraphicsSettings(this._lastGraphicsSettings || this.graphicsOptions);
        };
    }

    /**
     * 実効グラフィックティア（WebXR 中は low 相当）
     * @returns {'high'|'medium'|'low'}
     */
    _effectiveGraphicsTier() {
        if (this._xrSessionActive) return 'low';
        return normalizeGraphicsTier(this.graphicsOptions.graphicsTier);
    }

    /**
     * シャドウ map サイズとタイプ
     * @returns {{ mapSize: number, type: number }}
     */
    _getShadowConfigForEffectiveTier() {
        const tier = this._effectiveGraphicsTier();
        return {
            mapSize: getShadowMapSize(tier),
            type: getShadowMapTypeConstant(THREE, tier)
        };
    }

    /**
     * Compute effective pixel ratio from options（WebXR 中は最大 1）
     * @returns {number}
     */
    _getPixelRatio() {
        const cap = this.graphicsOptions.pixelRatioCap;
        const dpr = window.devicePixelRatio || 1;
        let v;
        if (cap === 'full') v = dpr;
        else v = Math.min(dpr, typeof cap === 'number' ? cap : 1);
        if (this._xrSessionActive) return Math.min(1, v);
        return v;
    }

    init() {
        // Get canvas element
        this.canvas = document.getElementById('canvas');

        // Apply saved settings for initial renderer creation (antialias is fixed at creation)
        const saved = localStorage.getItem('metaverse-settings');
        if (saved) {
            try {
                const s = JSON.parse(saved);
                const migrated = migrateLegacyGraphicsKeys(s);
                this.graphicsOptions.graphicsTier = migrated.graphicsTier;
                this.graphicsOptions.toneMappingExposure = migrated.toneMappingExposure;
                this.graphicsOptions.pixelRatioCap = migrated.pixelRatioCap;
                this.graphicsOptions.viewDistanceM = migrated.viewDistanceM;
            } catch (e) { /* ignore */ }
        }

        // Create scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87ceeb); // Sky blue（SkyDome 非表示時のフォールバック）
        this.scene.fog = null;

        // Create camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            5000  // Increased far plane for larger world
        );
        this.camera.position.set(0, 5, 10);

        const initTier = normalizeGraphicsTier(this.graphicsOptions.graphicsTier);
        const antialias = getAntialiasForTier(initTier);
        this._rendererAntialias = antialias;
        const renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias
        });
        this.renderer = renderer;
        this.renderer.xr.enabled = true;
        applyToneMapping(THREE, this.renderer, this.graphicsOptions.toneMappingExposure);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(this._getPixelRatio());
        this.renderer.shadowMap.enabled = true;
        const shadowConfig = this._getShadowConfigForEffectiveTier();
        this.renderer.shadowMap.type = shadowConfig.type;

        this._wireXRGraphicsOverrides();

        // Base lights are added per-world via addWorldLights()

        // Add shader-based sky dome（環境反射には使わない）
        this.addSkyDome();

        // Add static environment
        this.addEnvironment();

        requestAnimationFrame(() => {
            this._loadIBLAsync();
        });

        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
    }

    /**
     * WebXR 中は FPS 優先でシャドウ・ピクセル比を下げる（レンダラ差し替え時は再登録）
     */
    _wireXRGraphicsOverrides() {
        if (!this.renderer?.xr) return;
        this.renderer.xr.removeEventListener('sessionstart', this._onXRSessionStart);
        this.renderer.xr.removeEventListener('sessionend', this._onXRSessionEnd);
        this.renderer.xr.addEventListener('sessionstart', this._onXRSessionStart);
        this.renderer.xr.addEventListener('sessionend', this._onXRSessionEnd);
    }

    /**
     * HDR を読み込み IBL を設定する（失敗時はログのみ）
     */
    async _loadIBLAsync() {
        if (!this.scene || !this.renderer) return;
        const result = await loadSceneIBL(
            THREE,
            { scene: this.scene, renderer: this.renderer, RGBELoader, PMREMGenerator: THREE.PMREMGenerator },
            { hdrUrl: DEFAULT_HDR_PATH }
        );
        if (!result.ok) {
            console.warn('[SceneManager] IBL not available; PBR uses direct lights only until HDR is placed at', DEFAULT_HDR_PATH);
        }
    }

    /**
     * レンダラ再生成（antialias ティア変更時）。WebXR 中は呼ばないこと。
     * @param {boolean} antialias
     */
    _recreateRenderer(antialias) {
        if (this._xrSessionActive) return;
        disposeSceneIBL(this.scene);
        if (this.renderer) {
            this.renderer.dispose();
        }
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias
        });
        this.renderer.xr.enabled = true;
        this._rendererAntialias = antialias;
        applyToneMapping(THREE, this.renderer, this.graphicsOptions.toneMappingExposure);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(this._getPixelRatio());
        this.renderer.shadowMap.enabled = true;
        const shadowConfig = this._getShadowConfigForEffectiveTier();
        this.renderer.shadowMap.type = shadowConfig.type;
        this._wireXRGraphicsOverrides();
        const shadowMapSize = shadowConfig.mapSize;
        this.worldLights.forEach((light) => {
            if (light.castShadow && light.shadow) {
                light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
                if (light.shadow.map) {
                    light.shadow.map.dispose();
                    light.shadow.map = null;
                }
            }
        });
        requestAnimationFrame(() => {
            this._loadIBLAsync();
        });
    }

    /**
     * アセットパスを同一オリジンの絶対 URL に変換（セグメントごとに encode）
     * @param {string} assetPath
     * @returns {string}
     */
    _buildEncodedModelUrl(assetPath) {
        const pathStr = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
        const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
        return '/' + encodedPath;
    }

    /**
     * @param {string} p
     * @returns {boolean}
     */
    _isObjPath(p) {
        return typeof p === 'string' && p.toLowerCase().endsWith('.obj');
    }

    /**
     * 読み込み棄却時にジオメトリ・マテリアルを破棄
     * @param {THREE.Object3D} root
     */
    _disposeModelObject(root) {
        root.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => {
                    if (m.map) m.map.dispose();
                    m.dispose();
                });
            }
        });
    }

    /**
     * 描画距離カリング対象に登録し、ワールド AABB から包絡球を userData に保存する
     * @param {import('three').Object3D} obj
     */
    _registerDrawCullTarget(obj) {
        if (!obj) return;
        if (this._drawCullTargets.includes(obj)) return;
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) {
            obj.userData.drawCullWorld = null;
        } else {
            const sp = new THREE.Sphere();
            box.getBoundingSphere(sp);
            obj.userData.drawCullWorld = {
                center: sp.center.clone(),
                radius: Math.max(sp.radius, 0.05)
            };
        }
        this._drawCullTargets.push(obj);
    }

    /**
     * models/foo.glb から暗黙の models/foo.chunks.json パス（存在は未検証）
     * @param {string} modelPath
     * @returns {string|null}
     */
    _implicitChunksManifestPathFromModelPath(modelPath) {
        const p = String(modelPath || '').trim();
        if (!p.toLowerCase().endsWith('.glb')) return null;
        return `${p.slice(0, -4)}.chunks.json`;
    }

    /**
     * マニフェストを fetch し chunkManifestPlan 相当のエントリを作る（planWorldLoadBytes 用・await 内で長さ取得）
     * @param {string} manifestPath - models/...chunks.json
     * @param {number} FALLBACK
     * @returns {Promise<{ chunks: { url: string, weight: number, label: string, center: number[], radius: number, filePath: string }[], sum: number }|null>}
     */
    async _fetchAndBuildChunkPlanEntries(manifestPath, FALLBACK) {
        const mUrl = this._buildEncodedModelUrl(manifestPath);
        let manifest;
        try {
            const mRes = await fetch(mUrl);
            if (!mRes.ok) throw new Error(`HTTP ${mRes.status}`);
            manifest = await mRes.json();
        } catch {
            return null;
        }
        const chList = Array.isArray(manifest.chunks) ? manifest.chunks : [];
        if (!chList.length) return null;
        const nCh = Math.max(1, chList.length);
        /** @type {(Promise<{ url: string, weight: number, label: string, center: number[], radius: number, filePath: string }|null>)[]} */
        const chunkTasks = chList.map(async (ch) => {
            const fp = String(ch.file || '').replace(/^\//, '');
            if (!fp) return null;
            const u = this._buildEncodedModelUrl(fp);
            const len = await fetchModelContentLength(u);
            const w = len != null && len > 0 ? len : Math.max(1, Math.floor(FALLBACK / nCh));
            const cx = Array.isArray(ch.center) && ch.center.length >= 3 ? ch.center[0] : 0;
            const cy = Array.isArray(ch.center) && ch.center.length >= 3 ? ch.center[1] : 0;
            const cz = Array.isArray(ch.center) && ch.center.length >= 3 ? ch.center[2] : 0;
            const rad = Number.isFinite(ch.radius) ? Math.max(ch.radius, 0.01) : 0.01;
            return {
                url: u,
                weight: w,
                label: fp.split(/[/\\]/).pop() || fp,
                center: [cx, cy, cz],
                radius: rad,
                filePath: fp
            };
        });
        const settled = await Promise.all(chunkTasks);
        /** @type {{ url: string, weight: number, label: string, center: number[], radius: number, filePath: string }[]} */
        const chunkPlan = settled.filter(Boolean);
        const sum = chunkPlan.reduce((s, e) => s + e.weight, 0);
        if (!chunkPlan.length || sum <= 0) return null;
        return { chunks: chunkPlan, sum };
    }

    /**
     * loadOne でプラン欠落時のフォールバック用
     * @param {string} manifestPath
     * @returns {Promise<{ url: string, weight: number, label: string, center: number[], radius: number, filePath: string }[]|null>}
     */
    async _fetchChunkPlanChunksOnly(manifestPath) {
        const built = await this._fetchAndBuildChunkPlanEntries(manifestPath, 5 * 1024 * 1024);
        return built ? built.chunks : null;
    }

    /**
     * 足元中心・描画距離（球）で environment の可視を更新する（4 フレームに 1 回）。
     * 登録時の包絡球心が固定のため、移動するオブジェクト（models[].aircraft）は _drawCullTargets に入れない。
     * @param {import('three').Vector3} feetWorld
     */
    updateDrawDistanceCulling(feetWorld) {
        if (!feetWorld) return;
        this._drawCullFrame = (this._drawCullFrame + 1) % 4;
        if (this._drawCullFrame !== 0) return;

        const R = clampViewDistanceM(this.graphicsOptions.viewDistanceM);
        const p = feetWorld;

        for (const obj of this._drawCullTargets) {
            if (!obj || !obj.parent) continue;
            const c = obj.userData.drawCullWorld;
            let inRange = true;
            if (c && c.center && Number.isFinite(c.radius)) {
                inRange = p.distanceTo(c.center) <= R + c.radius;
            }
            obj.userData._cullInRange = inRange;
            if (obj === this.groundMesh || obj === this.gridHelper) {
                obj.visible = this._floorWantedVisible && inRange;
            } else {
                obj.visible = inRange;
            }
        }
    }

    /**
     * planWorldLoadBytes 用: モデル配列の 1 要素分のバイト見積
     * @param {Object|string} config
     * @param {number} idx
     * @param {number} FALLBACK
     * @returns {Promise<{ idx: number, entry: object, bytes: number }|null>}
     */
    async _planWorldLoadBytesForModel(config, idx, FALLBACK) {
        const fullConfig = typeof config === 'string' ? { path: config } : config;
        let resolvedManifest = String(fullConfig.chunkManifest || '').trim();
        const modelPath = fullConfig.path;
        if (!resolvedManifest && modelPath && modelPath.toLowerCase().endsWith('.glb') && !this._isObjPath(modelPath)) {
            resolvedManifest = String(this._implicitChunksManifestPathFromModelPath(modelPath) || '').trim();
        }
        if (resolvedManifest) {
            const built = await this._fetchAndBuildChunkPlanEntries(resolvedManifest, FALLBACK);
            if (!built) {
                console.warn('[SceneManager] chunk manifest missing or invalid:', resolvedManifest);
                return {
                    idx,
                    entry: {
                        fileLabel: resolvedManifest.split(/[/\\]/).pop() || resolvedManifest,
                        totalFileBytes: FALLBACK,
                        resolvedChunkManifest: resolvedManifest,
                        chunkManifestPlan: null
                    },
                    bytes: FALLBACK
                };
            }
            return {
                idx,
                entry: {
                    fileLabel: resolvedManifest.split(/[/\\]/).pop() || resolvedManifest,
                    totalFileBytes: built.sum,
                    resolvedChunkManifest: resolvedManifest,
                    chunkManifestPlan: { chunks: built.chunks }
                },
                bytes: built.sum
            };
        }

        if (!modelPath) return null;

        const url = this._buildEncodedModelUrl(modelPath);
        const fileLabel = modelPath.split(/[/\\]/).pop() || modelPath;
        if (this._isObjPath(modelPath)) {
            const mtlPath = String(fullConfig.mtlPath || '').trim();
            let objLen;
            let mtlLen = 0;
            if (mtlPath) {
                const mtlUrl = this._buildEncodedModelUrl(mtlPath);
                const pair = await Promise.all([
                    fetchModelContentLength(url),
                    fetchModelContentLength(mtlUrl)
                ]);
                objLen = pair[0];
                const fetched = pair[1];
                mtlLen = fetched != null && fetched > 0 ? fetched : 0;
            } else {
                objLen = await fetchModelContentLength(url);
            }
            let wMtl = 0;
            let wObj = 0;
            if (mtlPath) {
                wMtl = mtlLen > 0 ? mtlLen : Math.min(FALLBACK, Math.max(4096, Math.floor(FALLBACK * 0.05)));
                wObj = objLen != null && objLen > 0 ? objLen : Math.max(1, FALLBACK - wMtl);
            } else {
                wObj = objLen != null && objLen > 0 ? objLen : FALLBACK;
            }
            const totalFile = wMtl + wObj;
            return {
                idx,
                entry: {
                    fileLabel,
                    totalFileBytes: totalFile,
                    wMtl,
                    wObj,
                    contentLenObj: objLen
                },
                bytes: totalFile
            };
        }

        const glbLen = await fetchModelContentLength(url);
        const totalFile = glbLen != null && glbLen > 0 ? glbLen : FALLBACK;
        return {
            idx,
            entry: {
                fileLabel,
                totalFileBytes: totalFile,
                wMtl: 0,
                wObj: totalFile,
                contentLenObj: glbLen
            },
            bytes: totalFile
        };
    }

    /**
     * 各アセットの Content-Length を集計し、進捗バー用の総バイト数を返す（HEAD 不可時は仮定値を混ぜる）
     * @param {Array<Object|string>} modelConfigs
     * @param {Array<Object>} [pdfConfigs]
     * @returns {Promise<{ totalBytes: number, modelByIndex: Map<number, { fileLabel: string, totalFileBytes: number, wMtl: number, wObj: number, contentLenObj: number|null }>, pdfByIndex: Map<number, { fileLabel: string, totalFileBytes: number }> }>}
     */
    async planWorldLoadBytes(modelConfigs, pdfConfigs) {
        const FALLBACK = 5 * 1024 * 1024;
        const list = Array.isArray(modelConfigs) ? modelConfigs : [];
        const modelFactories = list.map(
            (config, idx) => () => this._planWorldLoadBytesForModel(config, idx, FALLBACK)
        );
        const modelSlots = await runWithConcurrency(WORLD_MODEL_LOAD_CONCURRENCY, modelFactories);

        const modelByIndex = new Map();
        let totalBytes = 0;
        for (const slot of modelSlots) {
            if (!slot) continue;
            modelByIndex.set(slot.idx, slot.entry);
            totalBytes += slot.bytes;
        }

        const pdfs = Array.isArray(pdfConfigs) ? pdfConfigs : [];
        const pdfFactories = pdfs.map((pdfCfg, idx) => {
            return async () => {
                const path = pdfCfg.path || '';
                const pdfPath = path || 'pdfs/placeholder.pdf';
                const pdfUrl = pdfPath.startsWith('/') ? pdfPath : '/' + pdfPath;
                const len = await fetchModelContentLength(pdfUrl);
                const fileLabel = pdfPath.split(/[/\\]/).pop() || pdfPath;
                const totalFile = len != null && len > 0 ? len : FALLBACK;
                return { idx, entry: { fileLabel, totalFileBytes: totalFile }, bytes: totalFile };
            };
        });
        const pdfSlots = await runWithConcurrency(WORLD_MODEL_LOAD_CONCURRENCY, pdfFactories);
        const pdfByIndex = new Map();
        for (const slot of pdfSlots) {
            pdfByIndex.set(slot.idx, slot.entry);
            totalBytes += slot.bytes;
        }

        return { totalBytes, modelByIndex, pdfByIndex };
    }

    /**
     * Load multiple world models
     * @param {Array<Object|string>} modelConfigs - Array of model configs or paths
     * @param {function} onComplete - Callback when all models are loaded
     * @param {{ bytePlan?: object, loadState?: { completedBytes: number, totalBytes: number }, onByteProgress?: (o: { fileName: string, loadedBytes: number, totalBytes: number }) => void, worldAircraftPhysics?: Record<string, unknown>|null }} [loadOptions]
     */
    async loadWorldModels(modelConfigs, onComplete, loadOptions = {}) {
        const { bytePlan, loadState, onByteProgress, worldAircraftPhysics } = loadOptions;

        if (!modelConfigs || modelConfigs.length === 0) {
            console.warn('No models to load');
            if (onComplete) onComplete();
            return;
        }

        console.log(`Loading ${modelConfigs.length} models...`);
        let loadedCount = 0;

        const tb = loadState?.totalBytes ?? 0;
        const modelCount = modelConfigs.length;
        /** bytePlan+loadState が無い場合は進捗の都合で並列度1 */
        const useAggregatedProgress = !!(bytePlan && loadState);
        const concurrency = useAggregatedProgress ? WORLD_MODEL_LOAD_CONCURRENCY : 1;
        /** @type {Float64Array|null} */
        const modelProgressFrac = useAggregatedProgress ? new Float64Array(modelCount) : null;

        /**
         * モデルごとの進捗率から loadState / コールバックを更新（複数モデル同時読込用）
         * @param {string} fileName
         */
        const aggregateProgress = (fileName) => {
            if (!useAggregatedProgress || !loadState || !bytePlan || !modelProgressFrac) return;
            let sum = 0;
            for (let i = 0; i < modelCount; i++) {
                const p = bytePlan.modelByIndex.get(i);
                if (p) sum += modelProgressFrac[i] * p.totalFileBytes;
            }
            loadState.completedBytes = Math.min(tb, sum);
            onByteProgress?.({ fileName, loadedBytes: loadState.completedBytes, totalBytes: tb });
        };

        /**
         * インデックス idx のモデルについて、モデル内バイト進捗を反映する
         * @param {number} idx
         * @param {string} fileName
         * @param {number} bytesDoneInModel
         * @param {number} fileBudget
         */
        const setModelBytesProgress = (idx, fileName, bytesDoneInModel, fileBudget) => {
            if (!modelProgressFrac) return;
            const denom = fileBudget > 0 ? fileBudget : 1;
            modelProgressFrac[idx] = Math.min(1, bytesDoneInModel / denom);
            aggregateProgress(fileName);
        };

        /**
         * このアセット開始時点の completedBytes を base とし、ファイル内 xhr 進捗を反映する（直列・非集約時）
         * @param {string} fileName
         * @param {number} loadedInFile
         * @param {number} totalInFile
         * @param {number} fileBudget
         * @param {number} baseBytes
         */
        const emitFromBase = (fileName, loadedInFile, totalInFile, fileBudget, baseBytes) => {
            if (useAggregatedProgress || !onByteProgress || !bytePlan || !loadState) return;
            const denom = totalInFile > 0 ? totalInFile : fileBudget;
            const frac = denom > 0 ? Math.min(1, loadedInFile / denom) : 0;
            const loadedBytes = Math.min(tb, baseBytes + frac * fileBudget);
            onByteProgress({ fileName, loadedBytes, totalBytes: tb });
        };

        /**
         * @param {THREE.Object3D} model
         * @param {object} config
         * @param {string} modelPath
         * @param {number} triangleCount
         */
        const finishAddModel = (model, config, modelPath, triangleCount = 0) => {
            const position = config.position || { x: 0, y: 0, z: 0 };
            const rotation = config.rotation || { x: 0, y: 0, z: 0 };
            const scale = config.scale || { x: 1, y: 1, z: 1 };

            model.position.set(position.x, position.y, position.z);
            model.rotation.set(
                rotation.x * Math.PI / 180,
                rotation.y * Math.PI / 180,
                rotation.z * Math.PI / 180
            );
            model.scale.set(scale.x, scale.y, scale.z);
            model.updateMatrixWorld(true);

            const disableSh = triangleCount > MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD;
            model.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = !disableSh;
                    child.receiveShadow = !disableSh;
                }
            });

            this.environmentGroup.add(model);

            model.updateMatrixWorld(true);
            // 飛行機ルートは操縦で移動するが、drawCull の球心は登録時固定のため、そのままだと離陸後に視距離外扱いで非表示になる
            if (!String(config.chunkManifest || '').trim() && !config.aircraft) {
                this._registerDrawCullTarget(model);
            }

            if (config.animate) {
                this.animatedModels.push({
                    model: model,
                    animation: config.animate
                });
                console.log(`  Animation: Rotation (${config.animate.rotation.x}°, ${config.animate.rotation.y}°, ${config.animate.rotation.z}°) per frame`);
            }

            if (config.teleporter) {
                this.teleporters.push({
                    id: config.teleporter.id,
                    position: position,
                    destinationWorld: config.teleporter.destinationWorld,
                    radius: config.teleporter.radius || 3,
                    label: config.teleporter.label || config.teleporter.destinationWorld,
                    access: config.teleporter.access || 'public',
                    autoTeleport: !!config.teleporter.autoTeleport,
                    autoTeleportOnContact: !!config.teleporter.autoTeleportOnContact
                });
                console.log(`  Teleporter: ID=${config.teleporter.id}, Destination=${config.teleporter.destinationWorld}, access=${config.teleporter.access || 'public'}`);
            }

            if (config.taiko) {
                const t = config.taiko;
                this.taikos.push({
                    position,
                    radius: t.radius || 3,
                    multiplayer: !!t.multiplayer,
                    groupId: t.multiplayer ? String(t.groupId || '').trim() : '',
                    multiplayerChartId: t.multiplayer ? String(t.multiplayerChartId || '').trim() : ''
                });
                console.log(`  Taiko: radius=${t.radius || 3}${t.multiplayer ? ` mp group=${t.groupId}` : ''}`);
            }

            if (config.aircraft) {
                this._registerAircraftSlot(model, config.aircraft, position, worldAircraftPhysics);
            }

            this._registerGlbWorldInteract(model, config);

            loadedCount++;
            console.log(`Loaded model ${loadedCount}/${modelConfigs.length}: ${modelPath}`);
            console.log(`  Position: (${position.x}, ${position.y}, ${position.z})`);
            console.log(`  Rotation: (${rotation.x}°, ${rotation.y}°, ${rotation.z}°)`);
            console.log(`  Scale: (${scale.x}, ${scale.y}, ${scale.z})`);
        };

        const loadOne = async (config, idx) => {
            const fullConfig = typeof config === 'string' ? { path: config } : config;
            const plan = bytePlan?.modelByIndex?.get(idx);
            let manifestPath = String(plan?.resolvedChunkManifest || fullConfig.chunkManifest || '').trim();
            const modelPath = fullConfig.path;
            if (!manifestPath && modelPath && modelPath.toLowerCase().endsWith('.glb') && !this._isObjPath(modelPath)) {
                manifestPath = String(this._implicitChunksManifestPathFromModelPath(modelPath) || '').trim();
            }

            const fileLabel = plan?.fileLabel
                || (modelPath
                    ? (modelPath.split(/[/\\]/).pop() || modelPath)
                    : (manifestPath ? manifestPath.split(/[/\\]/).pop() || manifestPath : 'model'));
            const fileBudget = plan?.totalFileBytes ?? (5 * 1024 * 1024);
            const fileStart = useAggregatedProgress ? 0 : (loadState?.completedBytes ?? 0);

            /**
             * 読み込み失敗・棄却時でもバーが止まらないよう、このアセット分の見積バイトを進捗に反映する
             */
            const snapBudgetDone = () => {
                if (useAggregatedProgress && modelProgressFrac && loadState && bytePlan) {
                    modelProgressFrac[idx] = 1;
                    aggregateProgress(plan?.fileLabel || fileLabel);
                    return;
                }
                if (!loadState || !bytePlan || !plan) return;
                loadState.completedBytes = Math.min(tb, fileStart + plan.totalFileBytes);
                onByteProgress?.({
                    fileName: plan.fileLabel,
                    loadedBytes: loadState.completedBytes,
                    totalBytes: tb
                });
            };

            let chunkPlan = plan?.chunkManifestPlan?.chunks;
            if (manifestPath && (!chunkPlan || chunkPlan.length === 0)) {
                chunkPlan = await this._fetchChunkPlanChunksOnly(manifestPath);
            }

            if (manifestPath && chunkPlan && chunkPlan.length > 0) {
                const totalW = chunkPlan.reduce((s, c) => s + c.weight, 0) || 1;
                const anchor = new THREE.Group();
                const cfgForFinish = { ...fullConfig, chunkManifest: manifestPath };
                let totalTris = 0;
                let completedChunkBytes = 0;
                const loader = createGLTFLoaderWithDraco();
                try {
                    for (let ci = 0; ci < chunkPlan.length; ci++) {
                        const ent = chunkPlan[ci];
                        const chunkBudget = fileBudget * (ent.weight / totalW);
                        const scene = await new Promise((resolve, reject) => {
                            loader.load(
                                ent.url,
                                (gltf) => resolve(gltf.scene),
                                (xhr) => {
                                    const denom = xhr.total > 0 ? xhr.total : chunkBudget;
                                    const chunkFrac = denom > 0 ? Math.min(1, xhr.loaded / denom) : 0;
                                    const bytesIntoModel = completedChunkBytes + chunkFrac * chunkBudget;
                                    if (useAggregatedProgress) {
                                        setModelBytesProgress(idx, ent.label, bytesIntoModel, fileBudget);
                                    } else {
                                        emitFromBase(
                                            ent.label,
                                            xhr.loaded,
                                            xhr.total || 0,
                                            chunkBudget,
                                            fileStart + completedChunkBytes
                                        );
                                    }
                                },
                                reject
                            );
                        });
                        const tris = countTrianglesInObject(scene);
                        totalTris += tris;
                        anchor.add(scene);
                        scene.updateMatrixWorld(true);
                        if (!fullConfig.aircraft) {
                            this._registerDrawCullTarget(scene);
                        }
                        completedChunkBytes += chunkBudget;
                    }
                    if (totalTris > MODEL_MAX_TRIANGLES_TOTAL) {
                        this._disposeModelObject(anchor);
                        console.error(`[SceneManager] chunk manifest 合計ポリゴン過多 (約 ${totalTris} 三角): ${manifestPath}`);
                        window.dispatchEvent(new CustomEvent('metaverse-model-load-guard', {
                            detail: {
                                path: manifestPath,
                                reason: 'too_many_triangles',
                                triangles: totalTris,
                                maxTriangles: MODEL_MAX_TRIANGLES_TOTAL
                            }
                        }));
                        snapBudgetDone();
                        return;
                    }
                    finishAddModel(anchor, cfgForFinish, manifestPath, totalTris);
                    if (loadState) {
                        if (useAggregatedProgress && modelProgressFrac) {
                            modelProgressFrac[idx] = 1;
                            aggregateProgress(plan?.fileLabel || fileLabel);
                        } else {
                            loadState.completedBytes = Math.min(tb, fileStart + fileBudget);
                        }
                    }
                } catch (error) {
                    console.error(`Error loading chunk manifest ${manifestPath}:`, error);
                    snapBudgetDone();
                }
                return;
            }

            if (manifestPath) {
                console.warn('[SceneManager] チャンクプランが無いため単体 path にフォールバックします:', manifestPath);
            }

            if (!modelPath) {
                if (manifestPath) snapBudgetDone();
                return;
            }

            const url = this._buildEncodedModelUrl(modelPath);
            const maxBytes = this._isObjPath(modelPath) ? MODEL_MAX_BYTES_OBJ : MODEL_MAX_BYTES_GLTF;
            let contentLen = plan?.contentLenObj;
            if (contentLen === undefined) {
                contentLen = await fetchModelContentLength(url);
            }
            if (contentLen != null && contentLen > maxBytes) {
                const mb = Math.round(contentLen / 1024 / 1024);
                const maxMb = Math.round(maxBytes / 1024 / 1024);
                console.error(`[SceneManager] モデルが大きすぎます (${mb}MB, 上限約 ${maxMb}MB): ${modelPath}`);
                window.dispatchEvent(new CustomEvent('metaverse-model-load-guard', {
                    detail: { path: modelPath, reason: 'file_too_large', bytes: contentLen, maxBytes }
                }));
                snapBudgetDone();
                return;
            }

            try {
                const model = await new Promise((resolve, reject) => {
                    if (this._isObjPath(modelPath)) {
                        const mtlPath = String(fullConfig.mtlPath || '').trim();
                        const objLoader = new OBJLoader();
                        const wMtl = plan?.wMtl ?? 0;
                        const wObj = plan?.wObj ?? fileBudget;
                        if (!mtlPath) {
                            objLoader.load(
                                url,
                                (object) => resolve(object),
                                (xhr) => {
                                    const denom = xhr.total > 0 ? xhr.total : fileBudget;
                                    const f = denom > 0 ? Math.min(1, xhr.loaded / denom) : 0;
                                    if (useAggregatedProgress) {
                                        setModelBytesProgress(idx, fileLabel, f * fileBudget, fileBudget);
                                    } else {
                                        emitFromBase(fileLabel, xhr.loaded, xhr.total || 0, fileBudget, fileStart);
                                    }
                                },
                                reject
                            );
                            return;
                        }
                        const mtlEncoded = this._buildEncodedModelUrl(mtlPath);
                        const mtlDirUrl = mtlEncoded.slice(0, mtlEncoded.lastIndexOf('/') + 1);
                        const mtlFile = mtlPath.split('/').pop() || '';
                        const objDirUrl = url.slice(0, url.lastIndexOf('/') + 1);
                        const objFile = modelPath.split('/').pop();
                        const mtlLoader = new MTLLoader();
                        mtlLoader.setPath(mtlDirUrl);
                        const baseAfterMtl = fileStart + wMtl;
                        mtlLoader.load(
                            mtlFile,
                            (materials) => {
                                materials.preload();
                                objLoader.setMaterials(materials);
                                objLoader.setPath(objDirUrl);
                                objLoader.load(
                                    objFile,
                                    (object) => resolve(object),
                                    (xhr) => {
                                        const denom = xhr.total > 0 ? xhr.total : wObj;
                                        const f = denom > 0 ? Math.min(1, xhr.loaded / denom) : 0;
                                        if (useAggregatedProgress) {
                                            setModelBytesProgress(idx, fileLabel, wMtl + f * wObj, fileBudget);
                                        } else {
                                            emitFromBase(fileLabel, xhr.loaded, xhr.total || 0, wObj, baseAfterMtl);
                                        }
                                    },
                                    reject
                                );
                            },
                            (xhr) => {
                                const denom = xhr.total > 0 ? xhr.total : wMtl;
                                const f = denom > 0 ? Math.min(1, xhr.loaded / denom) : 0;
                                if (useAggregatedProgress) {
                                    setModelBytesProgress(idx, mtlFile || fileLabel, f * wMtl, fileBudget);
                                } else {
                                    emitFromBase(mtlFile || fileLabel, xhr.loaded, xhr.total || 0, wMtl, fileStart);
                                }
                            },
                            reject
                        );
                        return;
                    }

                    const loader = createGLTFLoaderWithDraco();
                    loader.load(
                        url,
                        (gltf) => {
                            const root = gltf.scene;
                            const anims = Array.isArray(gltf.animations) ? gltf.animations : [];
                            if (anims.length) root.userData.gltfClips = anims;
                            resolve(root);
                        },
                        (xhr) => {
                            const denom = xhr.total > 0 ? xhr.total : fileBudget;
                            const f = denom > 0 ? Math.min(1, xhr.loaded / denom) : 0;
                            if (useAggregatedProgress) {
                                setModelBytesProgress(idx, fileLabel, f * fileBudget, fileBudget);
                            } else {
                                emitFromBase(fileLabel, xhr.loaded, xhr.total || 0, fileBudget, fileStart);
                            }
                        },
                        reject
                    );
                });

                const tris = countTrianglesInObject(model);
                if (tris > MODEL_MAX_TRIANGLES_TOTAL) {
                    this._disposeModelObject(model);
                    console.error(`[SceneManager] ポリゴン過多のため読み込み中止 (約 ${tris} 三角): ${modelPath}`);
                    window.dispatchEvent(new CustomEvent('metaverse-model-load-guard', {
                        detail: {
                            path: modelPath,
                            reason: 'too_many_triangles',
                            triangles: tris,
                            maxTriangles: MODEL_MAX_TRIANGLES_TOTAL
                        }
                    }));
                    snapBudgetDone();
                    return;
                }
                finishAddModel(model, fullConfig, modelPath, tris);
                if (loadState) {
                    if (useAggregatedProgress && modelProgressFrac) {
                        modelProgressFrac[idx] = 1;
                        aggregateProgress(plan?.fileLabel || fileLabel);
                    } else {
                        loadState.completedBytes = Math.min(tb, fileStart + fileBudget);
                    }
                }
            } catch (error) {
                console.error(`Error loading model ${modelPath}:`, error);
                snapBudgetDone();
            }
        };

        try {
            let nextModelIndex = 0;
            /**
             * 共有インデックスから次のモデルを読み込む（最大 concurrency 本まで同時実行）
             */
            const modelWorker = async () => {
                while (true) {
                    const mi = nextModelIndex++;
                    if (mi >= modelConfigs.length) break;
                    await loadOne(modelConfigs[mi], mi);
                }
            };
            const workerCount = Math.min(concurrency, modelConfigs.length);
            await Promise.all(Array.from({ length: workerCount }, () => modelWorker()));
            this.environmentGroup.updateMatrixWorld(true);
            console.log('All models loaded, generating BVH...');

            try {
                this.generateBVH();
            } catch (e) {
                console.warn('[SceneManager] Initial BVH generation failed:', e);
            }

            if (onComplete) {
                const result = onComplete();
                if (result && typeof result.then === 'function') await result;
            }
        } catch (error) {
            console.error('Error loading models:', error);
        }
    }

    /**
     * Load PDF posters (2D planes) for the current world. Renders first page via PDF.js.
     * @param {Array<Object>} [pdfConfigs] - Each item: { path, position?, rotation?, scale? }
     * @param {{ bytePlan?: object, loadState?: { completedBytes: number, totalBytes: number }, onByteProgress?: (o: { fileName: string, loadedBytes: number, totalBytes: number }) => void }} [options]
     */
    async loadWorldPdfs(pdfConfigs, options = {}) {
        if (!pdfConfigs || pdfConfigs.length === 0) return;
        const { bytePlan, loadState, onByteProgress } = options;
        const tb = loadState?.totalBytes ?? 0;
        let pdfjsLib;
        try {
            pdfjsLib = await import('pdfjs-dist');
        } catch (e) {
            console.error('Failed to load pdfjs-dist:', e);
            this._addPdfPlaceholderMeshes(pdfConfigs);
            return;
        }
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            try {
                const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
                pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
            } catch (_) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version || '4.8.69'}/pdf.worker.min.mjs`;
            }
        }
        for (let pi = 0; pi < pdfConfigs.length; pi++) {
            const config = pdfConfigs[pi];
            const path = config.path || 'pdfs/placeholder.pdf';
            const pdfLabel = path.split(/[/\\]/).pop() || path;
            const url = path.startsWith('/') ? path : '/' + path;
            const pdfEntry = bytePlan?.pdfByIndex?.get(pi);
            const fileBudget = pdfEntry?.totalFileBytes ?? (5 * 1024 * 1024);
            const fileStart = loadState?.completedBytes ?? 0;
            const emitPdf = (loadedInFile, totalInFile) => {
                if (!onByteProgress || !bytePlan || !loadState) return;
                const denom = totalInFile > 0 ? totalInFile : fileBudget;
                const frac = denom > 0 ? Math.min(1, loadedInFile / denom) : 0;
                const loadedBytes = Math.min(tb, fileStart + frac * fileBudget);
                onByteProgress({ fileName: pdfLabel, loadedBytes, totalBytes: tb });
            };
            const position = config.position || { x: 0, y: 2, z: -5 };
            const rotation = config.rotation || { x: 0, y: 0, z: 0 };
            const scale = config.scale || { x: 2, y: 2.8, z: 1 };
            try {
                const loadingTask = pdfjsLib.getDocument(url);
                loadingTask.onProgress = ({ loaded, total }) => {
                    emitPdf(loaded, total || 0);
                };
                const pdf = await loadingTask.promise;
                const page = await pdf.getPage(1);
                // 720p相当に制限してテクスチャを軽くする（最長辺 1280px）
                const baseViewport = page.getViewport({ scale: 1 });
                const maxDim = 1280;
                const scaleRatio = Math.min(2, maxDim / Math.max(baseViewport.width, baseViewport.height));
                const viewport = page.getViewport({ scale: scaleRatio });
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                await page.render({ canvasContext: ctx, viewport }).promise;
                const tex = new THREE.CanvasTexture(canvas);
                tex.needsUpdate = true;
                const geom = new THREE.PlaneGeometry(1, 1);
                const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
                const mesh = new THREE.Mesh(geom, mat);
                mesh.position.set(position.x, position.y, position.z);
                mesh.rotation.set(rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180);
                mesh.scale.set(scale.x, scale.y, scale.z);
                mesh.userData.pdfPath = path;
                if (config.teleporter) {
                    mesh.userData.teleporter = config.teleporter;
                    this.teleporters.push({
                        id: config.teleporter.id,
                        position: position,
                        destinationWorld: config.teleporter.destinationWorld,
                        radius: config.teleporter.radius || 3,
                        label: config.teleporter.label || config.teleporter.destinationWorld,
                        access: config.teleporter.access || 'public',
                        autoTeleport: !!config.teleporter.autoTeleport,
                        autoTeleportOnContact: !!config.teleporter.autoTeleportOnContact
                    });
                    console.log(`  PDF Teleporter: ID=${config.teleporter.id}, Destination=${config.teleporter.destinationWorld}`);
                }
                this.environmentGroup.add(mesh);
                mesh.updateMatrixWorld(true);
                this._registerDrawCullTarget(mesh);
                if (loadState) {
                    loadState.completedBytes = Math.min(tb, fileStart + fileBudget);
                }
            } catch (err) {
                console.error('Failed to load PDF:', path, err);
                this._addPdfPlaceholderMesh(position, rotation, scale, path, config.teleporter);
                if (loadState && bytePlan) {
                    loadState.completedBytes = Math.min(tb, fileStart + fileBudget);
                    onByteProgress?.({
                        fileName: pdfLabel,
                        loadedBytes: loadState.completedBytes,
                        totalBytes: tb
                    });
                }
            }
        }
        console.log(`Loaded ${pdfConfigs.length} PDF poster(s)`);
    }

    /**
     * Get the closest PDF mesh within radius of the given position (for E-key viewer / teleporter).
     * @param {THREE.Vector3} position - World position (e.g. player)
     * @param {number} radius - Max distance
     * @returns {{ mesh: THREE.Mesh, pdfPath: string, teleporter?: object } | null}
     */
    getNearbyPdfObject(position, radius) {
        const tempPos = new THREE.Vector3();
        let closest = null;
        let closestDist = radius;
        this.environmentGroup.traverse((obj) => {
            if (!obj.isMesh || !obj.userData.pdfPath) return;
            obj.getWorldPosition(tempPos);
            const dist = position.distanceTo(tempPos);
            if (dist < closestDist) {
                closestDist = dist;
                const teleporter = obj.userData.teleporter || null;
                closest = { mesh: obj, pdfPath: obj.userData.pdfPath, teleporter };
            }
        });
        return closest;
    }

    /**
     * Add a single placeholder plane when PDF load fails.
     * @param {object} [teleporterConfig] - Optional. If set, this PDF acts as a teleporter (same shape as config.teleporter).
     */
    _addPdfPlaceholderMesh(position, rotation, scale, pdfPath, teleporterConfig) {
        const geom = new THREE.PlaneGeometry(1, 1);
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#404040';
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = '#888';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('PDF', 64, 64);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(position.x, position.y, position.z);
        mesh.rotation.set(rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180);
        mesh.scale.set(scale.x, scale.y, scale.z);
        if (pdfPath) mesh.userData.pdfPath = pdfPath;
        if (teleporterConfig) {
            mesh.userData.teleporter = teleporterConfig;
            this.teleporters.push({
                id: teleporterConfig.id,
                position: position,
                destinationWorld: teleporterConfig.destinationWorld,
                radius: teleporterConfig.radius || 3,
                label: teleporterConfig.label || teleporterConfig.destinationWorld,
                access: teleporterConfig.access || 'public',
                autoTeleport: !!teleporterConfig.autoTeleport,
                autoTeleportOnContact: !!teleporterConfig.autoTeleportOnContact
            });
        }
        this.environmentGroup.add(mesh);
        mesh.updateMatrixWorld(true);
        this._registerDrawCullTarget(mesh);
    }

    /**
     * プレイヤーが接触しているPDFテレポーターを返す
     * @param {THREE.Vector3} playerPosition
     * @param {number} [padding=0.2]
     * @returns {{ teleporter: object } | null}
     */
    getTouchedPdfTeleporter(playerPosition, padding = 0.2) {
        const worldBox = new THREE.Box3();
        let touched = null;
        this.environmentGroup.traverse((obj) => {
            if (touched) return;
            if (!obj.isMesh || !obj.userData.pdfPath) return;
            const tp = obj.userData.teleporter;
            if (!tp || !tp.autoTeleportOnContact) return;
            worldBox.setFromObject(obj);
            worldBox.expandByScalar(Math.max(0, Number(padding) || 0));
            if (worldBox.containsPoint(playerPosition)) {
                touched = { teleporter: tp };
            }
        });
        return touched;
    }

    /**
     * Add placeholder planes for all configs (used when PDF.js is unavailable).
     */
    _addPdfPlaceholderMeshes(pdfConfigs) {
        pdfConfigs.forEach((config) => {
            const position = config.position || { x: 0, y: 2, z: -5 };
            const rotation = config.rotation || { x: 0, y: 0, z: 0 };
            const scale = config.scale || { x: 2, y: 2.8, z: 1 };
            const pdfPath = config.path || 'pdfs/placeholder.pdf';
            this._addPdfPlaceholderMesh(position, rotation, scale, pdfPath, config.teleporter);
        });
    }

    /**
     * Add lights for the current world. Removes previous world lights.
     * @param {Array<Object>} [lightsConfig] - Optional. Each item: { type, position?, intensity, color?, castShadow?, target?, distance?, angle?, penumbra? }
     *        type: 'ambient' | 'directional' | 'point' | 'spot'
     *        If omitted or empty, adds default ambient + directional.
     */
    addWorldLights(lightsConfig) {
        this.clearWorldLights();

        const configs = (lightsConfig && lightsConfig.length > 0)
            ? lightsConfig
            : [
                { type: 'ambient', intensity: 0.6, color: 0xffffff },
                { type: 'directional', position: { x: 50, y: 100, z: 50 }, intensity: 0.8, color: 0xffffff, castShadow: true }
            ];

        configs.forEach((cfg) => {
            const color = cfg.color !== undefined ? cfg.color : 0xffffff;
            const intensity = cfg.intensity !== undefined ? cfg.intensity : 1;
            let light;

            switch (cfg.type) {
                case 'ambient':
                    light = new THREE.AmbientLight(color, intensity);
                    break;
                case 'directional': {
                    light = new THREE.DirectionalLight(color, intensity);
                    if (cfg.position) {
                        light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                    }
                    if (cfg.target) {
                        light.target.position.set(cfg.target.x, cfg.target.y, cfg.target.z);
                        this.scene.add(light.target);
                    }
                    if (cfg.castShadow) {
                        light.castShadow = true;
                        light.shadow.camera.left = -500;
                        light.shadow.camera.right = 500;
                        light.shadow.camera.top = 500;
                        light.shadow.camera.bottom = -500;
                        light.shadow.camera.near = 0.1;
                        light.shadow.camera.far = 200;
                        const mapSize = this._getShadowConfigForEffectiveTier().mapSize;
                        light.shadow.mapSize.width = mapSize;
                        light.shadow.mapSize.height = mapSize;
                    }
                    break;
                }
                case 'point': {
                    light = new THREE.PointLight(color, intensity, cfg.distance ?? 0, cfg.decay ?? 2);
                    if (cfg.position) {
                        light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                    }
                    break;
                }
                case 'spot': {
                    light = new THREE.SpotLight(
                        color,
                        intensity,
                        cfg.distance ?? 0,
                        cfg.angle ?? Math.PI / 6,
                        cfg.penumbra ?? 0,
                        cfg.decay ?? 2
                    );
                    if (cfg.position) {
                        light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
                    }
                    if (cfg.target) {
                        light.target.position.set(cfg.target.x, cfg.target.y, cfg.target.z);
                        this.scene.add(light.target);
                    }
                    if (cfg.castShadow) {
                        light.castShadow = true;
                    }
                    break;
                }
                default:
                    return;
            }

            this.scene.add(light);
            this.worldLights.push(light);
        });

        console.log(`World lights added: ${this.worldLights.length}`);
    }

    clearWorldLights() {
        this.worldLights.forEach((light) => {
            if (light.target) this.scene.remove(light.target);
            this.scene.remove(light);
        });
        this.worldLights = [];
    }

    /**
     * グラデーション SkyDome（環境反射計算には使わない）
     */
    addSkyDome() {
        const skyDome = createGradientSkyDomeMesh(THREE);
        this.scene.add(skyDome);
    }

    addEnvironment() {
        // Ground plane - 10x larger
        const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
        const groundMaterial = new THREE.MeshStandardMaterial({
            color: 0x4a7c59,
            roughness: 0.8,
            metalness: 0.2
        });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        ground.userData.isStatic = true;
        this.environmentGroup.add(ground);
        this.groundMesh = ground;

        // Add environment group to scene
        this.scene.add(this.environmentGroup);

        // Add grid helper - 10x larger
        this.gridHelper = new THREE.GridHelper(1000, 100, 0x000000, 0x2a4a2a);
        this.gridHelper.position.y = 0.01;
        this.scene.add(this.gridHelper);

        this._registerDrawCullTarget(this.groundMesh);
        this._registerDrawCullTarget(this.gridHelper);
    }

    /**
     * Set floor (ground plane and grid) visibility for the current world.
     * @param {boolean} visible
     */
    setFloorVisible(visible) {
        this._floorWantedVisible = !!visible;
        if (this.groundMesh) {
            const inR = this.groundMesh.userData._cullInRange !== false;
            this.groundMesh.visible = this._floorWantedVisible && inR;
        }
        if (this.gridHelper) {
            const inR = this.gridHelper.userData._cullInRange !== false;
            this.gridHelper.visible = this._floorWantedVisible && inR;
        }
    }

    /**
     * ワールドの floorWidth / floorDepth（m）で接地プレーンとグリッドを作り直す。既定 1000×1000。
     * BVH 再生成前に呼ぶこと。
     * @param {{ floorWidth?: unknown, floorDepth?: unknown }} [world]
     */
    applyFloorDimensionsFromWorld(world) {
        const def = 1000;
        const fwRaw = world && typeof world === 'object' ? world.floorWidth : null;
        const fdRaw = world && typeof world === 'object' ? world.floorDepth : null;
        const fw = typeof fwRaw === 'number' && Number.isFinite(fwRaw) && fwRaw > 0 ? fwRaw : def;
        const fd = typeof fdRaw === 'number' && Number.isFinite(fdRaw) && fdRaw > 0 ? fdRaw : def;

        if (this.gridHelper) {
            this._drawCullTargets = this._drawCullTargets.filter((o) => o !== this.gridHelper);
            this.scene.remove(this.gridHelper);
            const gh = this.gridHelper;
            if (gh.geometry) gh.geometry.dispose();
            const mat = gh.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else if (mat) mat.dispose();
            this.gridHelper = null;
        }

        if (this.groundMesh) {
            this._drawCullTargets = this._drawCullTargets.filter((o) => o !== this.groundMesh);
            const oldG = this.groundMesh.geometry;
            if (oldG) oldG.dispose();
            this.groundMesh.geometry = new THREE.PlaneGeometry(fw, fd);
            this._registerDrawCullTarget(this.groundMesh);
            const inRg = this.groundMesh.userData._cullInRange !== false;
            this.groundMesh.visible = this._floorWantedVisible && inRg;
        }

        const gridSize = Math.max(fw, fd);
        const divisions = Math.max(10, Math.round((100 * gridSize) / 1000));
        this.gridHelper = new THREE.GridHelper(gridSize, divisions, 0x000000, 0x2a4a2a);
        this.gridHelper.position.y = 0.01;
        this.scene.add(this.gridHelper);

        this._registerDrawCullTarget(this.gridHelper);
        const inR = this.gridHelper.userData._cullInRange !== false;
        this.gridHelper.visible = this._floorWantedVisible && inR;
    }

    /**
     * Generate BVH collision mesh from environment group
     */
    generateBVH() {
        const staticGenerator = new StaticGeometryGenerator(this.environmentGroup);
        staticGenerator.attributes = ['position'];

        const mergedGeometry = staticGenerator.generate();
        console.log('Merged geometry created (all objects), triangle count:', mergedGeometry.index.count / 3);

        mergedGeometry.boundsTree = new MeshBVH(mergedGeometry, {
            strategy: 0,
            maxDepth: 40,
            maxLeafTris: 10,
            verbose: false
        });

        if (this.collider) {
            this.scene.remove(this.collider);
            if (this.collider.geometry) {
                this.collider.geometry.dispose();
            }
        }

        this.collider = new THREE.Mesh(mergedGeometry);
        this.collider.visible = false;
        this.scene.add(this.collider);

        if (this.physicsManager) {
            this.physicsManager.setCollider(this.collider);
            console.log('BVH collider set in physics manager');
        } else {
            console.warn('PhysicsManager not set. BVH collider not registered.');
        }
    }

    /**
     * Clear current world (remove all objects except ground)
     */
    clearWorld() {
        console.log('Clearing current world...');

        this.clearWorldLights();

        this._drawCullTargets = [];

        // Remove all children from environment group except ground plane
        const ground = this.environmentGroup.children[0]; // Ground is first child
        const childrenToRemove = [...this.environmentGroup.children];

        childrenToRemove.forEach((child) => {
            if (child !== ground) {
                this.environmentGroup.remove(child);
                // Dispose of geometries and materials
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => mat.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            }
        });

        if (this.groundMesh) this._registerDrawCullTarget(this.groundMesh);
        if (this.gridHelper) this._registerDrawCullTarget(this.gridHelper);

        // Remove old collider
        if (this.collider) {
            this.scene.remove(this.collider);
            if (this.collider.geometry) {
                this.collider.geometry.dispose();
            }
            this.collider = null;
        }

        // Clear teleporters, taikos, aircraft, and animations for this world
        this.teleporters = [];
        this.taikos = [];
        this.aircraftSlots = [];
        this.animatedModels = [];
        this._gltfMixers.forEach(({ mixer }) => mixer.stopAllAction());
        this._gltfMixers = [];
        this._glbInteractConfigs = [];

        console.log('World cleared');
    }

    /**
     * ワールド設定の aircraft とシーン上のルートオブジェクトを紐づけて登録する
     * @param {THREE.Object3D} model
     * @param {object} aircraftCfg - models[].aircraft
     * @param {{x:number,y:number,z:number}} position - 設定上の位置（近接ゾーン用）
     * @param {Record<string, unknown>|null|undefined} worldAircraftPhysics - ワールド共通 aircraftPhysics（生）
     */
    _registerAircraftSlot(model, aircraftCfg, position, worldAircraftPhysics) {
        const id = String(aircraftCfg.id || '').trim();
        if (!id) {
            console.warn('  Aircraft: skipped — missing id');
            return;
        }
        model.userData.aircraftId = id;
        const cockpit = aircraftCfg.cockpitOffset || { x: 0, y: 1.2, z: 0 };
        const chase = aircraftCfg.chaseOffset || { x: 0, y: 3, z: 12 };
        const physics = mergeAircraftPhysicsForObject(worldAircraftPhysics, aircraftCfg.aircraftPhysics);
        this.aircraftSlots.push({
            id,
            position: { x: position.x, y: position.y, z: position.z },
            radius: typeof aircraftCfg.radius === 'number' && Number.isFinite(aircraftCfg.radius) ? aircraftCfg.radius : 4,
            label: aircraftCfg.label || '操縦する',
            cockpitOffset: { x: cockpit.x, y: cockpit.y, z: cockpit.z },
            chaseOffset: { x: chase.x, y: chase.y, z: chase.z },
            physics,
            root: model,
            parkedPosition: model.position.clone(),
            parkedQuaternion: model.quaternion.clone(),
            parkedScale: model.scale.clone()
        });
        console.log(`  Aircraft: ID=${id}, radius=${aircraftCfg.radius || 4}`);
    }

    /**
     * Get all teleporters in current world
     */
    getTeleporters() {
        return this.teleporters;
    }

    /**
     * 現在ワールドの飛行機スロット（操縦・同期用）
     */
    getAircraftSlots() {
        return this.aircraftSlots;
    }

    /**
     * Get all taiko drums in current world
     */
    getTaikos() {
        return this.taikos;
    }

    /**
     * TeleportManager に渡す GLB インタラクト登録情報（worldId は呼び出し側で付与）
     * @returns {{ model: THREE.Object3D, clipName: string, radius: number, label: string, access: string }[]}
     */
    getGlbInteractConfigs() {
        return this._glbInteractConfigs.map((c) => ({
            model: c.model,
            clipName: c.clipName,
            radius: c.radius,
            label: c.label,
            access: c.access
        }));
    }

    /**
     * 近接インタラクトで GLB のクリップを再生する
     * @param {THREE.Object3D} model
     * @param {string} clipName
     */
    playGlbInteractAnimation(model, clipName) {
        const mixer = model && model.userData ? model.userData.worldGltfMixer : null;
        const clips = model && model.userData ? model.userData.gltfClips : null;
        if (!mixer || !clips || !clips.length) return;
        const cn = String(clipName || '').trim();
        const clip = clips.find((c) => c.name === cn);
        if (!clip) return;
        mixer.stopAllAction();
        const act = mixer.clipAction(clip);
        act.reset();
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        act.fadeIn(0.12).play();
    }

    /**
     * ワールド GLB の AnimationMixer を進める
     * @param {number} deltaSeconds
     */
    updateGltfAnimationMixers(deltaSeconds) {
        const d = typeof deltaSeconds === 'number' && Number.isFinite(deltaSeconds)
            ? Math.min(0.1, Math.max(0, deltaSeconds))
            : 0;
        this._gltfMixers.forEach(({ mixer }) => mixer.update(d));
    }

    /**
     * glbInteract 設定に応じてミキサーと近接登録用エントリを作る
     * @param {THREE.Object3D} model
     * @param {object} config
     */
    _registerGlbWorldInteract(model, config) {
        const gi = config && config.glbInteract;
        if (!gi) return;
        const clipName = String(gi.clipName || '').trim();
        if (!clipName) return;
        const clips = model.userData.gltfClips;
        if (!clips || !clips.length) {
            console.warn(`[SceneManager] glbInteract がありますが GLB にアニメーションがありません: ${config.path || ''}`);
            return;
        }
        if (!clips.some((c) => c.name === clipName)) {
            console.warn(`[SceneManager] glbInteract.clipName「${clipName}」が GLB に存在しません`);
            return;
        }
        const mixer = new THREE.AnimationMixer(model);
        model.userData.worldGltfMixer = mixer;
        this._gltfMixers.push({ model, mixer });
        const rad = typeof gi.radius === 'number' && Number.isFinite(gi.radius) && gi.radius > 0 ? gi.radius : 3;
        const labelRaw = gi.label != null ? String(gi.label).trim() : '';
        const label = labelRaw || `[E] ${clipName}`;
        this._glbInteractConfigs.push({
            model,
            clipName,
            radius: rad,
            label,
            access: gi.access || 'public'
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(this._getPixelRatio());
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    /**
     * メニューからの描画設定を適用（graphicsTier / toneMappingExposure / pixelRatioCap）
     * @param {Record<string, unknown>} [settings]
     */
    applyGraphicsSettings(settings) {
        const raw = settings && typeof settings === 'object' ? settings : {};
        this._lastGraphicsSettings = { ...this.graphicsOptions, ...raw };
        const migrated = migrateLegacyGraphicsKeys(this._lastGraphicsSettings);
        this.graphicsOptions = {
            graphicsTier: migrated.graphicsTier,
            toneMappingExposure: migrated.toneMappingExposure,
            pixelRatioCap: migrated.pixelRatioCap,
            viewDistanceM: migrated.viewDistanceM
        };

        const tier = this._effectiveGraphicsTier();
        const needAA = getAntialiasForTier(tier);

        if (this.renderer && !this._xrSessionActive && this._rendererAntialias !== needAA) {
            this._recreateRenderer(needAA);
            return;
        }

        if (this.renderer) {
            applyToneMapping(THREE, this.renderer, this.graphicsOptions.toneMappingExposure);
            this.renderer.setPixelRatio(this._getPixelRatio());
            const shadowConfig = this._getShadowConfigForEffectiveTier();
            this.renderer.shadowMap.type = shadowConfig.type;
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
        const shadowMapSize = this._getShadowConfigForEffectiveTier().mapSize;
        this.worldLights.forEach((light) => {
            if (light.castShadow && light.shadow) {
                light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
                if (light.shadow.map) {
                    light.shadow.map.dispose();
                    light.shadow.map = null;
                }
            }
        });
    }

    /**
     * @deprecated applyGraphicsSettings を使用
     * @param {Record<string, unknown>} settings
     */
    applyRenderQuality(settings) {
        this.applyGraphicsSettings(settings);
    }

    /**
     * Update animations for all animated models
     */
    updateAnimations() {
        this.animatedModels.forEach(({ model, animation }) => {
            if (animation.rotation) {
                // Apply rotation animation (degrees per frame to radians)
                if (animation.rotation.x) {
                    model.rotation.x += animation.rotation.x * Math.PI / 180;
                }
                if (animation.rotation.y) {
                    model.rotation.y += animation.rotation.y * Math.PI / 180;
                }
                if (animation.rotation.z) {
                    model.rotation.z += animation.rotation.z * Math.PI / 180;
                }
            }
        });
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }

    getScene() {
        return this.scene;
    }

    getCamera() {
        return this.camera;
    }

    getRenderer() {
        return this.renderer;
    }
}

export default SceneManager;
