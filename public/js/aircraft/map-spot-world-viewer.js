// public/js/aircraft/map-spot-world-viewer.js — Map定義用 3D ワールドビューア（クリックで XZ スポット）

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { loadPrefabGroupFromManifest } from '/js/prefab-load-shared.js';
import { resolveModelAssetHref } from '/js/asset-resolve.js';

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';
const LOAD_CONCURRENCY = 8;

/** @type {DRACOLoader|null} */
let sharedDraco = null;

/**
 * @returns {GLTFLoader}
 */
function createGLTFLoader() {
    if (!sharedDraco) {
        sharedDraco = new DRACOLoader();
        sharedDraco.setDecoderPath(DRACO_DECODER_PATH);
    }
    const loader = new GLTFLoader();
    loader.setDRACOLoader(sharedDraco);
    return loader;
}

/**
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

/**
 * @param {object} config
 * @returns {Promise<THREE.Object3D|null>}
 */
async function loadWorldModelEntry(config) {
    const pfm = String(config.prefabManifest || '').trim();
    const path = String(config.path || '').trim();
    if (!pfm && !path) return null;
    try {
        let model;
        if (pfm) {
            const planeProxy = pfm.startsWith('plane/') ? '/admin/plane-asset' : undefined;
            const { group } = await loadPrefabGroupFromManifest({
                THREE,
                manifestPath: pfm,
                createGLTFLoader,
                adminPlaneProxyBase: planeProxy,
            });
            model = group;
        } else {
            const url = await resolveModelAssetHref(path);
            model = await new Promise((resolve, reject) => {
                createGLTFLoader().load(url, (gltf) => resolve(gltf.scene), undefined, reject);
            });
        }
        const pos = config.position || { x: 0, y: 0, z: 0 };
        const rot = config.rotation || { x: 0, y: 0, z: 0 };
        const scale = config.scale || { x: 1, y: 1, z: 1 };
        model.position.set(pos.x, pos.y, pos.z);
        model.rotation.set(
            (rot.x * Math.PI) / 180,
            (rot.y * Math.PI) / 180,
            (rot.z * Math.PI) / 180
        );
        model.scale.set(scale.x, scale.y, scale.z);
        return model;
    } catch (e) {
        console.warn('[MapSpotViewer] model load failed', pfm || path, e);
        return null;
    }
}

/**
 * prefab パーツに LOD rank を付与する（scene-manager と同等）
 * @param {THREE.Object3D} model
 * @param {object} config
 */
function applyPrefabPartLodRanks(model, config) {
    const defRank = Number.isFinite(config.lodRank) ? Math.max(1, Math.floor(config.lodRank)) : 1;
    const map =
        config.lodPartRanks && typeof config.lodPartRanks === 'object' && !Array.isArray(config.lodPartRanks)
            ? config.lodPartRanks
            : {};
    const byOrder = Array.isArray(config.lodRanks) && config.lodRanks.length > 0;
    if (byOrder) {
        let idx = 0;
        const arr = config.lodRanks;
        for (const ch of model.children) {
            if (!ch.userData || !ch.userData.isPrefabPart) continue;
            let r = idx < arr.length ? Number(arr[idx]) : Number(arr[arr.length - 1]);
            if (!Number.isFinite(r) || r < 1) r = defRank;
            ch.userData.prefabLodRank = Math.max(1, Math.floor(r));
            idx++;
        }
        return;
    }
    model.traverse((ch) => {
        if (!ch.userData || !ch.userData.isPrefabPart) return;
        const path = ch.userData.prefabPartPath || '';
        let r = map[path];
        if (!Number.isFinite(r)) r = defRank;
        ch.userData.prefabLodRank = Math.max(1, Math.floor(r));
    });
}

/**
 * 固定 LOD バンドのみ表示する
 * @param {THREE.Object3D} root
 * @param {number} band
 */
function applyFixedLodBand(root, band) {
    const b = Math.max(1, Math.floor(band));
    root.traverse((ch) => {
        if (!ch.userData?.isPrefabPart) return;
        const pr = ch.userData.prefabLodRank || 1;
        ch.visible = pr === b;
    });
}

/**
 * 正射影カメラを北固定トップダウンに合わせる
 * @param {THREE.OrthographicCamera} camera
 * @param {number} cx
 * @param {number} cz
 * @param {number} groundY
 * @param {number} cameraHeightM
 * @param {{ x: number, z: number }} north
 * @param {number} halfExtentM
 */
function applyTopDownCamera(camera, cx, cz, groundY, cameraHeightM, north, halfExtentM) {
    const half = Math.max(halfExtentM, 50);
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 0.5;
    camera.far = Math.max(cameraHeightM + 10000, 15000);
    camera.position.set(cx, groundY + cameraHeightM, cz);
    camera.up.set(north.x, 0, north.z);
    camera.lookAt(cx, groundY, cz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
}

/**
 * Map定義 — ワールド上クリックでスポット XZ を取得するビューア
 */
export class AdminMapSpotWorldViewer {
    /**
     * @param {HTMLElement} container
     */
    constructor(container) {
        this.container = container;
        this._cameraHeightM = 500;
        this._groundY = 0;
        this._north = { x: 0, z: -1 };
        this._viewHalfExtentM = 425;
        this._overlayMode = false;
        this._layerOpacity = 1;
        this._pickingEnabled = true;
        this._lodBand = 1;
        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x87ceeb);
        this._camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.5, 20000);
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.enableRotate = true;
        this._controls.maxPolarAngle = Math.PI / 2 - 0.02;
        this._controls.minPolarAngle = 0.05;
        this._scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(120, 300, 80);
        this._scene.add(dir);
        /** @type {THREE.Group} */
        this._worldRoot = new THREE.Group();
        this._scene.add(this._worldRoot);
        /** @type {THREE.Group} */
        this._spotMarkers = new THREE.Group();
        this._scene.add(this._spotMarkers);
        /** @type {THREE.GridHelper|null} */
        this._grid = null;
        this._pickPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(50000, 50000),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        this._pickPlane.rotation.x = -Math.PI / 2;
        this._scene.add(this._pickPlane);
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._raf = 0;
        this._disposed = false;
        this._pointerDown = null;
        /** @type {((x: number, z: number) => void)|null} */
        this.onSpotPick = null;
        this._boundResize = () => this._resize();
        this._boundPointerDown = (e) => {
            this._pointerDown = { x: e.clientX, y: e.clientY };
        };
        this._boundPointerUp = (e) => this._onPointerUp(e);
        container.appendChild(this._renderer.domElement);
        const canvas = this._renderer.domElement;
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.cursor = 'crosshair';
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(container);
        window.addEventListener('resize', this._boundResize);
        canvas.addEventListener('pointerdown', this._boundPointerDown);
        canvas.addEventListener('pointerup', this._boundPointerUp);
        requestAnimationFrame(() => this._resize());
        this._tick();
    }

    /**
     * @param {{ cameraHeightM?: number, groundRefY?: number, northDirection?: { x: number, z: number } }} opts
     */
    setViewOptions(opts = {}) {
        if (typeof opts.cameraHeightM === 'number' && opts.cameraHeightM > 0) {
            this._cameraHeightM = opts.cameraHeightM;
        }
        if (typeof opts.groundRefY === 'number' && Number.isFinite(opts.groundRefY)) {
            this._groundY = opts.groundRefY;
        }
        if (opts.northDirection) {
            const n = opts.northDirection;
            const len = Math.hypot(n.x, n.z);
            if (len > 1e-9) this._north = { x: n.x / len, z: n.z / len };
        }
        this._viewHalfExtentM = this._cameraHeightM * 0.85;
        this._updateGrid();
    }

    _updateGrid() {
        if (this._grid) {
            this._scene.remove(this._grid);
            this._grid.geometry.dispose();
            this._grid.material.dispose();
            this._grid = null;
        }
        const span = Math.max(this._viewHalfExtentM * 4, 2000);
        const divisions = Math.min(200, Math.max(20, Math.round(span / 100)));
        this._grid = new THREE.GridHelper(span, divisions, 0x333333, 0x555555);
        this._grid.position.y = this._groundY + 0.05;
        this._scene.add(this._grid);
        this._pickPlane.position.y = this._groundY;
    }

    _resize() {
        const w = Math.max(this.container.clientWidth, 320);
        const h = Math.max(this.container.clientHeight, 240);
        const half = this._viewHalfExtentM;
        const aspect = w / h;
        if (aspect >= 1) {
            this._camera.left = -half * aspect;
            this._camera.right = half * aspect;
            this._camera.top = half;
            this._camera.bottom = -half;
        } else {
            this._camera.left = -half;
            this._camera.right = half;
            this._camera.top = half / aspect;
            this._camera.bottom = -half / aspect;
        }
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h, false);
    }

    _tick() {
        if (this._disposed) return;
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
        this._raf = requestAnimationFrame(() => this._tick());
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
        if (!this._pointerDown || !this.onSpotPick || !this._pickingEnabled) return;
        const dx = e.clientX - this._pointerDown.x;
        const dy = e.clientY - this._pointerDown.y;
        this._pointerDown = null;
        if (Math.hypot(dx, dy) > 6) return;

        const rect = this._renderer.domElement.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._worldRoot.updateMatrixWorld(true);
        this._pickPlane.updateMatrixWorld(true);
        this._raycaster.setFromCamera(this._pointer, this._camera);
        const hits = this._raycaster.intersectObjects(
            [...this._worldRoot.children, this._pickPlane],
            true
        );
        if (!hits.length) return;
        const p = hits[0].point;
        this.onSpotPick(
            Math.round(p.x * 100) / 100,
            Math.round(p.z * 100) / 100
        );
    }

    /**
     * ワールド内容の中心へカメラを合わせる
     */
    _frameWorldContent() {
        const box = new THREE.Box3();
        if (this._worldRoot.children.length) {
            box.setFromObject(this._worldRoot);
        }
        let cx = 0;
        let cz = 0;
        let gy = this._groundY;
        if (!box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3());
            cx = center.x;
            cz = center.z;
            gy = box.min.y;
            this._groundY = gy;
            this._updateGrid();
        }
        applyTopDownCamera(
            this._camera,
            cx,
            cz,
            gy,
            this._cameraHeightM,
            this._north,
            this._viewHalfExtentM
        );
        this._controls.target.set(cx, gy, cz);
        this._controls.update();
    }

    /**
     * 統合表示用にスポット群の中心へカメラを合わせる
     * @param {{ x: number, z: number }[]} spots
     * @param {number} [halfExtentM]
     */
    frameSpots(spots, halfExtentM) {
        if (!spots.length) return;
        let cx = 0;
        let cz = 0;
        for (const s of spots) {
            cx += s.x;
            cz += s.z;
        }
        cx /= spots.length;
        cz /= spots.length;
        if (typeof halfExtentM === 'number' && halfExtentM > 0) {
            this._viewHalfExtentM = halfExtentM;
        }
        applyTopDownCamera(
            this._camera,
            cx,
            cz,
            this._groundY,
            this._cameraHeightM,
            this._north,
            this._viewHalfExtentM
        );
        this._controls.target.set(cx, this._groundY, cz);
        this._controls.update();
        this._resize();
    }

    /**
     * オーバーレイ表示（統合モード）の見た目を切り替える
     * @param {boolean} overlay
     * @param {number} [opacity]
     */
    setOverlayMode(overlay, opacity = 1) {
        this._overlayMode = overlay;
        this._layerOpacity = Math.min(1, Math.max(0.05, opacity));
        if (overlay) {
            this._scene.background = null;
            this._renderer.setClearColor(0x000000, 0);
            if (this._grid) this._grid.visible = false;
        } else {
            this._scene.background = new THREE.Color(0x87ceeb);
            this._renderer.setClearColor(0x87ceeb, 1);
            if (this._grid) this._grid.visible = true;
        }
        this._renderer.domElement.style.opacity = String(this._layerOpacity);
    }

    /**
     * クリックによるスポット取得の有効/無効
     * @param {boolean} enabled
     */
    setPickingEnabled(enabled) {
        this._pickingEnabled = enabled;
        this._renderer.domElement.style.cursor = enabled ? 'crosshair' : 'grab';
    }

    /**
     * @param {object} world
     * @param {{ lodSystem?: object, lodBand?: number }} [opts]
     * @returns {Promise<{ loaded: number, total: number }>}
     */
    async loadWorld(world, opts = {}) {
        this._clearWorldRoot();
        const lodBand = Math.max(1, Math.floor(opts.lodBand || this._lodBand || 1));
        this._lodBand = lodBand;
        const models = Array.isArray(world?.models) ? world.models : [];
        const factories = models.map((cfg) => () => loadWorldModelEntry(cfg));
        const loaded = await runWithConcurrency(LOAD_CONCURRENCY, factories);
        let count = 0;
        for (let i = 0; i < loaded.length; i++) {
            const m = loaded[i];
            const cfg = models[i];
            if (!m) continue;
            applyPrefabPartLodRanks(m, cfg);
            if (String(cfg.lodId || '').trim()) {
                m.userData.prefabLodRootMeta = { lodId: String(cfg.lodId).trim() };
            }
            applyFixedLodBand(m, lodBand);
            this._worldRoot.add(m);
            count += 1;
        }
        const sp = world?.spawnPoint;
        if (typeof sp?.y === 'number' && Number.isFinite(sp.y)) {
            this._groundY = sp.y;
            this._updateGrid();
        }
        this._frameWorldContent();
        this._resize();
        return { loaded: count, total: models.length };
    }

    _clearWorldRoot() {
        while (this._worldRoot.children.length) {
            const c = this._worldRoot.children[0];
            this._worldRoot.remove(c);
            c.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
            });
        }
    }

    /**
     * @param {{ id: string, name: string, x: number, z: number }[]} spots
     */
    setSpotMarkers(spots) {
        while (this._spotMarkers.children.length) {
            const c = this._spotMarkers.children[0];
            this._spotMarkers.remove(c);
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        }
        for (const spot of spots) {
            const geom = new THREE.CylinderGeometry(12, 12, 50, 16);
            const mat = new THREE.MeshStandardMaterial({ color: 0xf57c00, emissive: 0x442200 });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(spot.x, this._groundY + 25, spot.z);
            mesh.userData.spotId = spot.id;
            this._spotMarkers.add(mesh);
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        this._resizeObserver?.disconnect();
        window.removeEventListener('resize', this._boundResize);
        this._renderer.domElement.removeEventListener('pointerdown', this._boundPointerDown);
        this._renderer.domElement.removeEventListener('pointerup', this._boundPointerUp);
        this._clearWorldRoot();
        if (this._grid) {
            this._grid.geometry.dispose();
            this._grid.material.dispose();
        }
        this._controls.dispose();
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
