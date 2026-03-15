import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import * as OpenVDB from 'openvdb/three';

// Filter a noisy warning from openvdb internals on three r160
if (!console.__vdbWarnFiltered) {
    const origWarn = console.warn.bind(console);
    console.warn = (...args) => {
        const msg = args && args[0] ? String(args[0]) : '';
        if (msg.includes("THREE.Material: '_uniforms' is not a property of THREE.MeshBasicMaterial")) return;
        origWarn(...args);
    };
    console.__vdbWarnFiltered = true;
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
        /** Lights added for current world (removed on clearWorld) */
        this.worldLights = [];
        /** VDB volume instances for smoke playback (cleared on clearWorld) */
        this.vdbInstances = [];
        /** FPS for VDB frame advance (time-based) */
        this.vdbFps = 24;
        /** Ground mesh (first child of environmentGroup). Visibility controlled by setFloorVisible. */
        this.groundMesh = null;
        /** Grid helper. Visibility controlled by setFloorVisible. */
        this.gridHelper = null;
        /** Render quality options (default: low for performance) */
        this.renderQualityOptions = {
            drawQualityLow: true,
            shadowQuality: 'low',
            fogFar: 800,
            pixelRatioCap: 1
        };
    }

    /**
     * Pick a single grid from OpenVDBReader to use as density.
     * density / Density / smoke / Smoke / fog / Fog の順で優先し、無ければ最初のグリッドを返す。
     */
    _pickDensityGrid(vdb) {
        if (!vdb || !vdb.grids) return vdb;
        const keys = Object.keys(vdb.grids);
        if (!keys.length) return vdb;
        console.log('VDB grids:', keys);
        const preferred = ['density', 'Density', 'smoke', 'Smoke', 'fog', 'Fog'];
        for (const name of preferred) {
            if (vdb.grids[name]) {
                console.log('Using VDB grid:', name);
                return vdb.grids[name];
            }
        }
        console.log('Using first VDB grid:', keys[0]);
        return vdb.grids[keys[0]];
    }

    /**
     * Sample grid valuesおおよその min/max を見る（開発用）。
     * グリッドのローカル空間を -0.5〜0.5 でざっくりサンプリングする。
     */
    _sampleGridStats(grid, sampleCount = 64) {
        if (!grid || typeof grid.getValue !== 'function') {
            return null;
        }
        const samples = [];
        for (let i = 0; i < sampleCount; i++) {
            const x = Math.random() - 0.5;
            const y = Math.random() - 0.5;
            const z = Math.random() - 0.5;
            try {
                const v = grid.getValue({ x, y, z });
                if (Number.isFinite(v)) samples.push(v);
            } catch (_) {
                // サンプリングできない座標は無視
            }
        }
        if (!samples.length) return null;
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        console.log('VDB grid sample stats:', { min, max });
        return { min, max };
    }

    /**
     * サンプル統計から FogVolume 用の densityScale / densityCutoff をざっくり決める。
     * （ヒューリスティックなので、必要なら具体的なVDBに合わせて微調整する）
     */
    _createFogOptionsFromStats(stats) {
        const base = {
            resolution: 50,
            progressive: false,
            steps: 30,
            absorbance: 0.6,
            opacity: 0.25,
            baseColor: 0xdddddd,
            lights: OpenVDB.lights?.useDirectionalLights ?? 0,
            densityScale: 0.6,
            densityCutoff: 0.06
        };
        if (!stats) return base;

        const { min, max } = stats;
        const hasNegative = min < 0;
        const absMax = Math.max(Math.abs(min), Math.abs(max), 1e-3);

        if (!hasNegative) {
            // 純粋な密度グリッド（0〜max想定）
            return {
                ...base,
                densityScale: 1 / absMax,
                densityCutoff: absMax * 0.05
            };
        }

        // SDF っぽい場合：0 付近だけを煙として可視化
        return {
            ...base,
            densityScale: 1 / absMax,
            densityCutoff: 0.1
        };
    }

    /**
     * Get shadow map size and type from quality string (low | medium | high | highest; legacy 'normal' → high).
     * @param {string} quality
     * @returns {{ mapSize: number, type: number }}
     */
    _getShadowConfig(quality) {
        switch (quality) {
            case 'low': return { mapSize: 512, type: THREE.BasicShadowMap };
            case 'medium': return { mapSize: 1024, type: THREE.PCFSoftShadowMap };
            case 'high':
            case 'normal': return { mapSize: 2048, type: THREE.PCFSoftShadowMap };
            case 'highest': return { mapSize: 4096, type: THREE.PCFSoftShadowMap };
            default: return { mapSize: 1024, type: THREE.PCFSoftShadowMap };
        }
    }

    /**
     * Compute effective pixel ratio from options
     * @returns {number}
     */
    _getPixelRatio() {
        const cap = this.renderQualityOptions.pixelRatioCap;
        const dpr = window.devicePixelRatio || 1;
        if (cap === 'full') return dpr;
        const n = typeof cap === 'number' ? cap : 1;
        return Math.min(dpr, n);
    }

    init() {
        // Get canvas element
        this.canvas = document.getElementById('canvas');

        // Apply saved settings for initial renderer creation (antialias is fixed at creation)
        const saved = localStorage.getItem('metaverse-settings');
        if (saved) {
            try {
                const s = JSON.parse(saved);
                if (s.drawQualityLow === false) this.renderQualityOptions.drawQualityLow = false;
                if (s.shadowQuality && ['low', 'medium', 'high', 'highest'].includes(s.shadowQuality)) this.renderQualityOptions.shadowQuality = s.shadowQuality;
                else if (s.shadowQuality === 'normal') this.renderQualityOptions.shadowQuality = 'high';
                if (s.fogFar != null) this.renderQualityOptions.fogFar = Number(s.fogFar) || 800;
                if (s.pixelRatioCap !== undefined) this.renderQualityOptions.pixelRatioCap = s.pixelRatioCap;
            } catch (e) { /* ignore */ }
        }

        // Create scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87ceeb); // Sky blue (fallback when shader sky is not visible)
        const fogFar = this.renderQualityOptions.fogFar ?? 800;
        this.scene.fog = new THREE.Fog(0x87ceeb, 100, fogFar);

        // Create camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            5000  // Increased far plane for larger world
        );
        this.camera.position.set(0, 5, 10);

        const antialias = !this.renderQualityOptions.drawQualityLow;
        const renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias
        });
        this.renderer = renderer;
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(this._getPixelRatio());
        this.renderer.shadowMap.enabled = true;
        const shadowConfig = this._getShadowConfig(this.renderQualityOptions.shadowQuality);
        this.renderer.shadowMap.type = shadowConfig.type;

        // Base lights are added per-world via addWorldLights()

        // Add shader-based sky dome (gradient sky)
        this.addSkyDome();

        // Add static environment
        this.addEnvironment();

        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
    }

    /**
     * Load multiple world models
     * @param {Array<Object|string>} modelConfigs - Array of model configs or paths
     * @param {function} onComplete - Callback when all models are loaded
     */
    async loadWorldModels(modelConfigs, onComplete) {
        if (!modelConfigs || modelConfigs.length === 0) {
            console.warn('No models to load');
            if (onComplete) onComplete();
            return;
        }

        console.log(`Loading ${modelConfigs.length} models...`);
        const loader = new GLTFLoader();
        let loadedCount = 0;

        // Load each model
        const loadPromises = modelConfigs.map((config) => {
            // Support both old string format and new object format
            const modelPath = typeof config === 'string' ? config : config.path;
            const position = config.position || { x: 0, y: 0, z: 0 };
            const rotation = config.rotation || { x: 0, y: 0, z: 0 }; // degrees
            const scale = config.scale || { x: 1, y: 1, z: 1 };

            return new Promise((resolve, reject) => {
                loader.load(
                    modelPath,
                    (gltf) => {
                        const model = gltf.scene;

                        // Apply position
                        model.position.set(position.x, position.y, position.z);

                        // Apply rotation (convert degrees to radians)
                        model.rotation.set(
                            rotation.x * Math.PI / 180,
                            rotation.y * Math.PI / 180,
                            rotation.z * Math.PI / 180
                        );

                        // Apply scale
                        model.scale.set(scale.x, scale.y, scale.z);

                        model.updateMatrixWorld(true);

                        // Enable shadows
                        model.traverse((child) => {
                            if (child.isMesh) {
                                child.castShadow = true;
                                child.receiveShadow = true;
                            }
                        });

                        // Add to environment group
                        this.environmentGroup.add(model);

                        // Track animated models
                        if (config.animate) {
                            this.animatedModels.push({
                                model: model,
                                animation: config.animate
                            });
                            console.log(`  Animation: Rotation (${config.animate.rotation.x}°, ${config.animate.rotation.y}°, ${config.animate.rotation.z}°) per frame`);
                        }

                        // Track teleporter models
                        if (config.teleporter) {
                            this.teleporters.push({
                                id: config.teleporter.id,
                                position: position,
                                destinationWorld: config.teleporter.destinationWorld,
                                radius: config.teleporter.radius || 3,
                                label: config.teleporter.label || config.teleporter.destinationWorld,
                                access: config.teleporter.access || 'public'
                            });
                            console.log(`  Teleporter: ID=${config.teleporter.id}, Destination=${config.teleporter.destinationWorld}, access=${config.teleporter.access || 'public'}`);
                        }

                        // Track taiko drum models
                        if (config.taiko) {
                            this.taikos.push({
                                position: position,
                                radius: config.taiko.radius || 3
                            });
                            console.log(`  Taiko: radius=${config.taiko.radius || 3}`);
                        }

                        loadedCount++;
                        console.log(`Loaded model ${loadedCount}/${modelConfigs.length}: ${modelPath}`);
                        console.log(`  Position: (${position.x}, ${position.y}, ${position.z})`);
                        console.log(`  Rotation: (${rotation.x}°, ${rotation.y}°, ${rotation.z}°)`);
                        console.log(`  Scale: (${scale.x}, ${scale.y}, ${scale.z})`);
                        resolve();
                    },
                    (progress) => {
                        const percent = (progress.loaded / progress.total) * 100;
                        console.log(`Loading ${modelPath}: ${percent.toFixed(2)}%`);
                    },
                    (error) => {
                        console.error(`Error loading model ${modelPath}:`, error);
                        reject(error);
                    }
                );
            });
        });

        // Wait for all models to load
        try {
            await Promise.all(loadPromises);
            this.environmentGroup.updateMatrixWorld(true);
            console.log('All models loaded, generating BVH...');

            // Generate BVH for collision detection
            this.generateBVH();

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
     */
    async loadWorldPdfs(pdfConfigs) {
        if (!pdfConfigs || pdfConfigs.length === 0) return;
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
        for (const config of pdfConfigs) {
            const path = config.path || 'pdfs/placeholder.pdf';
            const url = path.startsWith('/') ? path : '/' + path;
            const position = config.position || { x: 0, y: 2, z: -5 };
            const rotation = config.rotation || { x: 0, y: 0, z: 0 };
            const scale = config.scale || { x: 2, y: 2.8, z: 1 };
            try {
                const loadingTask = pdfjsLib.getDocument(url);
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
                        access: config.teleporter.access || 'public'
                    });
                    console.log(`  PDF Teleporter: ID=${config.teleporter.id}, Destination=${config.teleporter.destinationWorld}`);
                }
                this.environmentGroup.add(mesh);
            } catch (err) {
                console.error('Failed to load PDF:', path, err);
                this._addPdfPlaceholderMesh(position, rotation, scale, path, config.teleporter);
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
     * Dispose a FogVolume or Group (traverse and dispose geometry/material). Safe if obj has no dispose.
     * @param {THREE.Object3D} obj
     */
    _disposeVdbVolume(obj) {
        if (!obj) return;
        if (typeof obj.dispose === 'function') {
            obj.dispose();
            return;
        }
        obj.traverse((o) => {
            if (o.geometry) {
                o.geometry.dispose();
                o.geometry = null;
            }
            if (o.material) {
                if (Array.isArray(o.material)) {
                    o.material.forEach((m) => m.dispose());
                } else {
                    o.material.dispose();
                }
                o.material = null;
            }
        });
    }

    /**
     * Load VDB volumetric sequences (e.g. smoke). Each config: { framePaths: string[], position?, rotation?, scale? }.
     * Frame count = framePaths.length; playback loops from last frame to 0. Updates via update(deltaTime).
     * @param {Array<Object>} [vdbConfigs]
     */
    async loadWorldVdbs(vdbConfigs) {
        if (!vdbConfigs || vdbConfigs.length === 0) return;
        const loader = new OpenVDB.VDBLoader();
        const defaultPosition = { x: 0, y: 2, z: -5 };
        const defaultRotation = { x: 0, y: 0, z: 0 };
        const defaultScale = { x: 2, y: 2, z: 2 };

        for (const config of vdbConfigs) {
            const framePaths = config.framePaths && config.framePaths.length > 0 ? config.framePaths : [];
            if (framePaths.length === 0) continue;

            const position = config.position || defaultPosition;
            const rotation = config.rotation || defaultRotation;
            const scale = config.scale || defaultScale;

            const container = new THREE.Group();
            container.position.set(position.x, position.y, position.z);
            container.rotation.set(
                rotation.x * Math.PI / 180,
                rotation.y * Math.PI / 180,
                rotation.z * Math.PI / 180
            );
            container.scale.set(scale.x, scale.y, scale.z);

            const instance = {
                config,
                framePaths,
                elapsed: 0,
                lastFrameIndex: -1,
                container,
                currentFogVolume: null,
                loading: false
            };
            this.vdbInstances.push(instance);
            this.environmentGroup.add(container);

            const url = framePaths[0].startsWith('/') ? framePaths[0] : '/' + framePaths[0];
            instance.loading = true;
            loader.load(
                url,
                (vdb) => {
                    const grid = this._pickDensityGrid(vdb);
                    const stats = this._sampleGridStats(grid);
                    const fogOptions = this._createFogOptionsFromStats(stats);
                    const fogVolume = new OpenVDB.FogVolume(grid, fogOptions);
                    if (instance.currentFogVolume) {
                        this.environmentGroup.remove(instance.currentFogVolume);
                        this._disposeVdbVolume(instance.currentFogVolume);
                    }
                    instance.currentFogVolume = fogVolume;
                    container.add(fogVolume);
                    instance.lastFrameIndex = 0;
                    instance.loading = false;
                },
                undefined,
                (err) => {
                    console.error('VDB load failed:', framePaths[0], err);
                    instance.loading = false;
                }
            );
        }
        console.log(`Loading ${vdbConfigs.length} VDB sequence(s)`);
    }

    /**
     * Update VDB playback (call from game loop with deltaTime). Advances frame by time and loops at end.
     * @param {number} deltaTime - Seconds since last frame
     */
    update(deltaTime) {
        if (!deltaTime || this.vdbInstances.length === 0) return;
        const loader = new OpenVDB.VDBLoader();

        this.vdbInstances.forEach((instance) => {
            if (instance.loading || instance.framePaths.length <= 1) return;
            instance.elapsed += deltaTime;
            const frameCount = instance.framePaths.length;
            const frameIndex = Math.floor(instance.elapsed * this.vdbFps) % frameCount;

            if (frameIndex === instance.lastFrameIndex) return;

            const path = instance.framePaths[frameIndex];
            const url = path.startsWith('/') ? path : '/' + path;
            instance.loading = true;
            loader.load(
                url,
                (vdb) => {
                    const grid = this._pickDensityGrid(vdb);
                    const stats = this._sampleGridStats(grid);
                    const fogOptions = this._createFogOptionsFromStats(stats);
                    const fogVolume = new OpenVDB.FogVolume(grid, fogOptions);
                    if (instance.currentFogVolume) {
                        instance.container.remove(instance.currentFogVolume);
                        this._disposeVdbVolume(instance.currentFogVolume);
                    }
                    instance.currentFogVolume = fogVolume;
                    instance.container.add(fogVolume);
                    instance.lastFrameIndex = frameIndex;
                    instance.loading = false;
                },
                undefined,
                (err) => {
                    console.warn('VDB frame load failed:', path, err);
                    instance.loading = false;
                }
            );
        });
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
                access: teleporterConfig.access || 'public'
            });
        }
        this.environmentGroup.add(mesh);
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
                        const mapSize = this._getShadowConfig(this.renderQualityOptions.shadowQuality).mapSize;
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
     * Create a large sky dome with a vertical color gradient:
     * near the horizon is whitish, higher is blue, and below the horizon is gray.
     */
    addSkyDome() {
        const radius = 2000;
        const geometry = new THREE.SphereGeometry(radius, 32, 16);

        const vertexShader = `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
        `;

        const fragmentShader = `
            precision mediump float;
            varying vec3 vWorldPosition;
            uniform vec3 zenithColor;
            uniform vec3 horizonColor;
            uniform vec3 groundColor;
            uniform vec3 midSkyColor;

            void main() {
                float h = vWorldPosition.y;

                // 地平線(0)〜高さ80までは「白 → 薄い青」のグラデーション
                float tLow = clamp(h / 920.0, 0.0, 1.0);
                vec3 skyLow = mix(horizonColor, midSkyColor, tLow);

                // さらにかなり上空(400〜)でだけ濃い青を少し足す
                float tHigh = smoothstep(400.0, 800.0, h);
                vec3 sky = mix(skyLow, zenithColor, tHigh);

                // y=-50 付近から下をグレーに寄せる
                float blend = smoothstep(-80.0, 0.0, h);
                vec3 color = mix(groundColor, sky, blend);

                gl_FragColor = vec4(color, 1.0);
            }
        `;

        const material = new THREE.ShaderMaterial({
            uniforms: {
                zenithColor: { value: new THREE.Color(0x1e90ff) },   // 一番上の濃い青
                horizonColor: { value: new THREE.Color(0xf5f5f5) },  // 地平線付近の白っぽい色
                groundColor: { value: new THREE.Color(0x666666) },   // 下側のグレー
                midSkyColor: { value: new THREE.Color(0x9acbff) }    // 中間の薄い青
            },
            vertexShader,
            fragmentShader,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false
        });

        const skyDome = new THREE.Mesh(geometry, material);
        skyDome.name = 'SkyDome';
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
    }

    /**
     * Set floor (ground plane and grid) visibility for the current world.
     * @param {boolean} visible
     */
    setFloorVisible(visible) {
        if (this.groundMesh) this.groundMesh.visible = !!visible;
        if (this.gridHelper) this.gridHelper.visible = !!visible;
    }

    /**
     * Generate BVH collision mesh from environment group
     */
    generateBVH() {
        // Generate merged geometry for BVH collision from ALL static objects
        const staticGenerator = new StaticGeometryGenerator(this.environmentGroup);
        staticGenerator.attributes = ['position'];

        const mergedGeometry = staticGenerator.generate();
        console.log('Merged geometry created (all objects), triangle count:', mergedGeometry.index.count / 3);

        // Generate BVH for the merged geometry
        mergedGeometry.boundsTree = new MeshBVH(mergedGeometry, {
            strategy: 0, // CENTER split strategy
            maxDepth: 40,
            maxLeafTris: 10,
            verbose: false
        });

        console.log('BVH generated successfully for all static objects');

        // Remove old collider if exists
        if (this.collider) {
            this.scene.remove(this.collider);
            if (this.collider.geometry) {
                this.collider.geometry.dispose();
            }
        }

        // Create invisible collider mesh with BVH
        this.collider = new THREE.Mesh(mergedGeometry);
        this.collider.visible = false;
        this.scene.add(this.collider);

        // Pass BVH collider to physics manager
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

        // Remove and dispose VDB volume instances
        this.vdbInstances.forEach((instance) => {
            this.environmentGroup.remove(instance.container);
            this._disposeVdbVolume(instance.currentFogVolume);
        });
        this.vdbInstances = [];

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

        // Remove old collider
        if (this.collider) {
            this.scene.remove(this.collider);
            if (this.collider.geometry) {
                this.collider.geometry.dispose();
            }
            this.collider = null;
        }

        // Clear teleporters, taikos, and animations for this world
        this.teleporters = [];
        this.taikos = [];
        this.animatedModels = [];

        console.log('World cleared');
    }

    /**
     * Get all teleporters in current world
     */
    getTeleporters() {
        return this.teleporters;
    }

    /**
     * Get all taiko drums in current world
     */
    getTaikos() {
        return this.taikos;
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(this._getPixelRatio());
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    /**
     * Apply render quality from settings (from MenuManager).
     * When drawQualityLow is true, effective values are: shadow low, fogFar 800, pixelRatioCap 1.
     * @param {{ drawQualityLow?: boolean, shadowQuality?: string, fogFar?: number, pixelRatioCap?: number|string }} settings
     */
    applyRenderQuality(settings) {
        const low = !!settings?.drawQualityLow;
        this.renderQualityOptions = {
            drawQualityLow: low,
            shadowQuality: low ? 'low' : (settings?.shadowQuality || 'low'),
            fogFar: low ? 800 : (Number(settings?.fogFar) || 800),
            pixelRatioCap: low ? 1 : (settings?.pixelRatioCap ?? 1)
        };

        if (this.scene?.fog) {
            this.scene.fog.far = this.renderQualityOptions.fogFar;
        }
        if (this.renderer) {
            this.renderer.setPixelRatio(this._getPixelRatio());
            const shadowConfig = this._getShadowConfig(this.renderQualityOptions.shadowQuality);
            this.renderer.shadowMap.type = shadowConfig.type;
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
        const shadowMapSize = this._getShadowConfig(this.renderQualityOptions.shadowQuality).mapSize;
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
