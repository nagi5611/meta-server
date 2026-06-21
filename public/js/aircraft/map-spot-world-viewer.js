// public/js/aircraft/map-spot-world-viewer.js — Map定義用 3D ワールドビューア（クリックで XZ スポット）

import * as THREE from 'three';
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
 * @param {{ isStale?: () => boolean }} [opts]
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(concurrency, factories, opts = {}) {
    const isStale = opts.isStale;
    const n = factories.length;
    const results = new Array(n);
    let cursor = 0;
    async function worker() {
        while (true) {
            if (isStale?.()) break;
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
 * Object3D 配下の GPU リソースを破棄する
 * @param {THREE.Object3D} root
 */
function disposeObject3D(root) {
    root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                m.map?.dispose();
                m.dispose();
            }
        }
    });
}

/**
 * @param {string} resolved
 * @returns {'include' | 'omit'}
 */
function fetchCredentialsForUrl(resolved) {
    let credentials = 'omit';
    if (typeof window !== 'undefined') {
        try {
            const abs = resolved.startsWith('http://') || resolved.startsWith('https://')
                ? new URL(resolved)
                : new URL(resolved, window.location.origin);
            if (abs.origin === window.location.origin) {
                credentials = 'include';
            }
        } catch {
            credentials = 'omit';
        }
    }
    return credentials;
}

/**
 * @param {string} url
 * @param {() => GLTFLoader} createGLTFLoader
 * @param {AbortSignal} signal
 * @returns {Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF>}
 */
async function loadGltfViaFetch(url, createGLTFLoader, signal) {
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
    const res = await fetch(url, { credentials: fetchCredentialsForUrl(url), signal });
    if (!res.ok) {
        throw new Error(`GLB fetch failed: ${url} (${res.status})`);
    }
    const buffer = await res.arrayBuffer();
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
    const loader = createGLTFLoader();
    const isHttpsAbs = /^https:\/\//i.test(url);
    const last = url.lastIndexOf('/');
    const resourcePath = isHttpsAbs ? url : last >= 0 ? url.slice(0, last + 1) : '/';
    return loader.parseAsync(buffer, resourcePath);
}

/**
 * @param {object} config
 * @param {{ signal: AbortSignal, isStale: () => boolean }} ctx
 * @returns {Promise<THREE.Object3D|null>}
 */
async function loadWorldModelEntry(config, ctx) {
    const { signal, isStale } = ctx;
    if (signal.aborted || isStale()) return null;
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
                signal,
            });
            if (isStale()) {
                disposeObject3D(group);
                return null;
            }
            model = group;
        } else {
            const url = await resolveModelAssetHref(path);
            if (isStale()) return null;
            const gltf = await loadGltfViaFetch(url, createGLTFLoader, signal);
            if (isStale()) {
                disposeObject3D(gltf.scene);
                return null;
            }
            model = gltf.scene;
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
        if (signal.aborted || isStale() || (e instanceof DOMException && e.name === 'AbortError')) {
            return null;
        }
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
        this._centerX = 0;
        this._centerZ = 0;
        this._mapOverlayActive = false;
        this._pointerPassthrough = false;
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
        /** @type {THREE.LineLoop|null} */
        this._triangleLine = null;
        /** @type {THREE.Group} */
        this._spotLabels = new THREE.Group();
        this._scene.add(this._spotLabels);
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
        /** @type {number} */
        this._worldLoadToken = 0;
        /** @type {AbortController|null} */
        this._loadAbortController = null;
        this._pointerDown = null;
        /** @type {boolean} */
        this._didPan = false;
        /** @type {((x: number, z: number) => void)|null} */
        this.onSpotPick = null;
        this._boundResize = () => this._resize();
        this._boundPointerDown = (e) => {
            if (e.button !== 0) return;
            this._pointerDown = {
                x: e.clientX,
                y: e.clientY,
                centerX: this._centerX,
                centerZ: this._centerZ,
            };
            this._didPan = false;
        };
        this._boundPointerMove = (e) => this._onPointerMove(e);
        this._boundPointerUp = (e) => this._onPointerUp(e);
        this._boundWheel = (e) => this._onWheel(e);
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
        canvas.addEventListener('pointermove', this._boundPointerMove);
        canvas.addEventListener('pointerup', this._boundPointerUp);
        canvas.addEventListener('pointercancel', this._boundPointerUp);
        canvas.addEventListener('wheel', this._boundWheel, { passive: false });
        this._applyTopDownView();
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
        const zoom = Math.max(this._camera.zoom, 0.01);
        const half = this._viewHalfExtentM / zoom;
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
        this._applyTopDownView();
        this._renderer.render(this._scene, this._camera);
        this._raf = requestAnimationFrame(() => this._tick());
    }

    /** 北固定・真上俯瞰のカメラ姿勢を適用する（正射影範囲は _resize が担当） */
    _applyTopDownView() {
        const cx = this._centerX;
        const cz = this._centerZ;
        const gy = this._groundY;
        this._camera.position.set(cx, gy + this._cameraHeightM, cz);
        this._camera.up.set(this._north.x, 0, this._north.z);
        this._camera.lookAt(cx, gy, cz);
        this._camera.near = 0.5;
        this._camera.far = Math.max(this._cameraHeightM + 10000, 15000);
        this._camera.updateMatrixWorld(true);
    }

    /**
     * 画面ピクセル移動量をワールド XZ 移動量へ変換する
     * @param {number} dxPx
     * @param {number} dyPx
     * @param {number} viewWidthPx
     * @param {number} viewHeightPx
     * @returns {{ dx: number, dz: number }}
     */
    _screenDeltaToWorldXZ(dxPx, dyPx, viewWidthPx, viewHeightPx) {
        const zoom = Math.max(this._camera.zoom, 0.01);
        const halfY = this._viewHalfExtentM / zoom;
        const aspect = viewWidthPx / Math.max(viewHeightPx, 1);
        const halfX = aspect >= 1 ? halfY * aspect : halfY;
        const scaleX = (2 * halfX) / Math.max(viewWidthPx, 1);
        const scaleY = (2 * halfY) / Math.max(viewHeightPx, 1);
        const east = { x: this._north.z, z: -this._north.x };
        const worldDx = dxPx * scaleX;
        const worldDy = dyPx * scaleY;
        return {
            dx: east.x * worldDx - this._north.x * worldDy,
            dz: east.z * worldDx - this._north.z * worldDy,
        };
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerMove(e) {
        if (!this._pointerDown) return;
        const dx = e.clientX - this._pointerDown.x;
        const dy = e.clientY - this._pointerDown.y;
        if (Math.hypot(dx, dy) <= 6) return;
        this._didPan = true;
        const rect = this._renderer.domElement.getBoundingClientRect();
        const delta = this._screenDeltaToWorldXZ(-dx, -dy, rect.width, rect.height);
        this._centerX = this._pointerDown.centerX + delta.dx;
        this._centerZ = this._pointerDown.centerZ + delta.dz;
    }

    /**
     * @param {WheelEvent} e
     */
    _onWheel(e) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const next = this._viewHalfExtentM * factor;
        this._viewHalfExtentM = Math.min(8000, Math.max(50, next));
        this._resize();
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
        if (!this._pointerDown) return;
        if (this._didPan) {
            this._pointerDown = null;
            this._didPan = false;
            return;
        }
        this._pointerDown = null;
        if (!this.onSpotPick || !this._pickingEnabled) return;

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
        this._centerX = cx;
        this._centerZ = cz;
        this._applyTopDownView();
        this._resize();
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
        this._centerX = cx;
        this._centerZ = cz;
        this._applyTopDownView();
        this._resize();
    }

    /**
     * @deprecated タブ切替に移行したため no-op
     * @param {boolean} _active
     */
    setMapOverlayActive(_active) {}

    /**
     * @deprecated タブ切替に移行したため no-op
     * @param {boolean} _passthrough
     */
    setPointerPassthrough(_passthrough) {}

    /**
     * @deprecated setMapOverlayActive を使用
     */
    setOverlayMode(overlay, opacity = 1) {
        this.setMapOverlayActive(overlay);
        if (overlay) {
            this._renderer.domElement.style.opacity = String(opacity);
        }
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
     * 進行中のワールド読込を中断し、シーン上のモデルを破棄する
     */
    abortWorldLoad() {
        if (this._loadAbortController) {
            this._loadAbortController.abort();
            this._loadAbortController = null;
        }
        this._worldLoadToken++;
        this._clearWorldRoot();
    }

    /**
     * @param {object} world
     * @param {{ lodSystem?: object, lodBand?: number }} [opts]
     * @returns {Promise<{ loaded: number, total: number, cancelled?: boolean }>}
     */
    async loadWorld(world, opts = {}) {
        this.abortWorldLoad();
        const token = this._worldLoadToken;
        const ac = new AbortController();
        this._loadAbortController = ac;
        const signal = ac.signal;
        const isStale = () => this._disposed || token !== this._worldLoadToken || signal.aborted;

        const lodBand = Math.max(1, Math.floor(opts.lodBand || this._lodBand || 1));
        this._lodBand = lodBand;
        const models = Array.isArray(world?.models) ? world.models : [];
        const ctx = { signal, isStale };
        const factories = models.map(
            (cfg) => () => (isStale() ? Promise.resolve(null) : loadWorldModelEntry(cfg, ctx))
        );
        const loaded = await runWithConcurrency(LOAD_CONCURRENCY, factories, { isStale });

        if (isStale()) {
            for (const m of loaded) {
                if (m) disposeObject3D(m);
            }
            this._loadAbortController = null;
            return { loaded: 0, total: models.length, cancelled: true };
        }

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
        this._loadAbortController = null;
        return { loaded: count, total: models.length };
    }

    _clearWorldRoot() {
        while (this._worldRoot.children.length) {
            const c = this._worldRoot.children[0];
            this._worldRoot.remove(c);
            disposeObject3D(c);
        }
    }

    /**
     * スポットラベル用スプライトを生成する
     * @param {string} text
     * @returns {THREE.Sprite}
     */
    _makeLabelSprite(text) {
        const canvas = document.createElement('canvas');
        const size = 128;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, size, size);
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, 44, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 42px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, size / 2, size / 2);
        }
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(48, 48, 1);
        return sprite;
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
        while (this._spotLabels.children.length) {
            const c = this._spotLabels.children[0];
            this._spotLabels.remove(c);
            if (c.material) {
                c.material.map?.dispose();
                c.material.dispose();
            }
        }
        if (this._triangleLine) {
            this._scene.remove(this._triangleLine);
            this._triangleLine.geometry.dispose();
            /** @type {THREE.Material} */ (this._triangleLine.material).dispose();
            this._triangleLine = null;
        }

        for (let i = 0; i < spots.length; i++) {
            const spot = spots[i];
            const geom = new THREE.CylinderGeometry(12, 12, 50, 16);
            const mat = new THREE.MeshStandardMaterial({ color: 0xf57c00, emissive: 0x442200 });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(spot.x, this._groundY + 25, spot.z);
            mesh.userData.spotId = spot.id;
            this._spotMarkers.add(mesh);

            if (i < 3) {
                const label = this._makeLabelSprite(`A${i + 1}`);
                label.position.set(spot.x, this._groundY + 65, spot.z);
                this._spotLabels.add(label);
            }
        }

        if (spots.length >= 3) {
            const pts = spots.slice(0, 3).map(
                (s) => new THREE.Vector3(s.x, this._groundY + 8, s.z)
            );
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({ color: 0xe53935, linewidth: 2 });
            this._triangleLine = new THREE.LineLoop(geom, mat);
            this._scene.add(this._triangleLine);
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.abortWorldLoad();
        cancelAnimationFrame(this._raf);
        this._resizeObserver?.disconnect();
        window.removeEventListener('resize', this._boundResize);
        const canvas = this._renderer.domElement;
        canvas.removeEventListener('pointerdown', this._boundPointerDown);
        canvas.removeEventListener('pointermove', this._boundPointerMove);
        canvas.removeEventListener('pointerup', this._boundPointerUp);
        canvas.removeEventListener('pointercancel', this._boundPointerUp);
        canvas.removeEventListener('wheel', this._boundWheel);
        this._clearWorldRoot();
        if (this._grid) {
            this._grid.geometry.dispose();
            this._grid.material.dispose();
        }
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
