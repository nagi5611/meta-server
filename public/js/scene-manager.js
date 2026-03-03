import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';

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
        /** Render quality options (default: low for performance) */
        this.renderQualityOptions = {
            drawQualityLow: true,
            shadowQuality: 'low',
            fogFar: 800,
            pixelRatioCap: 1
        };
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
                if (s.shadowQuality === 'normal') this.renderQualityOptions.shadowQuality = 'normal';
                if (s.fogFar != null) this.renderQualityOptions.fogFar = Number(s.fogFar) || 800;
                if (s.pixelRatioCap !== undefined) this.renderQualityOptions.pixelRatioCap = s.pixelRatioCap;
            } catch (e) { /* ignore */ }
        }

        // Create scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87ceeb); // Sky blue
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
        const shadowType = this.renderQualityOptions.shadowQuality === 'low' ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
        this.renderer.shadowMap.type = shadowType;

        // Base lights are added per-world via addWorldLights()

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
                const scaleRatio = 2;
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
                this.environmentGroup.add(mesh);
            } catch (err) {
                console.error('Failed to load PDF:', path, err);
                this._addPdfPlaceholderMesh(position, rotation, scale, path);
            }
        }
        console.log(`Loaded ${pdfConfigs.length} PDF poster(s)`);
    }

    /**
     * Get the closest PDF mesh within radius of the given position (for E-key viewer).
     * @param {THREE.Vector3} position - World position (e.g. player)
     * @param {number} radius - Max distance
     * @returns {{ mesh: THREE.Mesh, pdfPath: string } | null}
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
                closest = { mesh: obj, pdfPath: obj.userData.pdfPath };
            }
        });
        return closest;
    }

    /**
     * Add a single placeholder plane when PDF load fails.
     */
    _addPdfPlaceholderMesh(position, rotation, scale, pdfPath) {
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
            this._addPdfPlaceholderMesh(position, rotation, scale, pdfPath);
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
                        const mapSize = this.renderQualityOptions.shadowQuality === 'low' ? 1024 : 2048;
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

        // Add environment group to scene
        this.scene.add(this.environmentGroup);

        // Add grid helper - 10x larger
        const gridHelper = new THREE.GridHelper(1000, 100, 0x000000, 0x2a4a2a);
        gridHelper.position.y = 0.01;
        this.scene.add(gridHelper);
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
            this.renderer.shadowMap.type = this.renderQualityOptions.shadowQuality === 'low' ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
        this.worldLights.forEach((light) => {
            if (light.castShadow && light.shadow) {
                const mapSize = this.renderQualityOptions.shadowQuality === 'low' ? 1024 : 2048;
                light.shadow.mapSize.width = mapSize;
                light.shadow.mapSize.height = mapSize;
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
