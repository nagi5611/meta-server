// addons/nfc-spawn/client/world-placer-viewer.js — 管理画面用ワールド＋NFCスポーンマーカー
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
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
        console.warn('[nfc-spawn viewer] model load failed', pfm || path, e);
        return null;
    }
}

/**
 * NFC スポーン位置マーカーを生成
 * @param {number} colorHex
 * @returns {THREE.Group}
 */
function createSpawnMarkerGroup(colorHex) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.5, 1.2, 12),
        new THREE.MeshStandardMaterial({ color: colorHex, emissive: (colorHex >> 4) & 0x111111, metalness: 0.2, roughness: 0.5 })
    );
    body.position.y = 0.6;
    g.add(body);
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.75, 0.08, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);
    const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.7, 8),
        new THREE.MeshStandardMaterial({ color: 0xffee88 })
    );
    arrow.position.set(0, 0.35, -0.9);
    arrow.rotation.x = -Math.PI / 2;
    arrow.name = 'yawArrow';
    g.add(arrow);
    return g;
}

/**
 * 管理画面 — ワールド 3D プレビューと NFC スポーン配置
 */
export class NfcSpawnWorldPlacer {
    /**
     * @param {HTMLElement} container
     */
    constructor(container) {
        this.container = container;
        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._renderer.shadowMap.enabled = true;
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x87ceeb);
        this._camera = new THREE.PerspectiveCamera(60, 1, 0.1, 8000);
        this._camera.position.set(12, 14, 18);
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.target.set(0, 2, 0);
        this._scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(40, 80, 30);
        dir.castShadow = true;
        this._scene.add(dir);
        /** @type {THREE.Group} */
        this._worldRoot = new THREE.Group();
        this._scene.add(this._worldRoot);
        /** @type {THREE.Group} */
        this._tagMarkers = new THREE.Group();
        this._scene.add(this._tagMarkers);
        /** @type {THREE.Group} */
        this._placementMarker = createSpawnMarkerGroup(0x22cc66);
        this._placementMarker.visible = false;
        this._scene.add(this._placementMarker);
        const sphereGeo = new THREE.SphereGeometry(1, 28, 18);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: 0x4488ff,
            transparent: true,
            opacity: 0.12,
            depthWrite: false,
        });
        this._loadSphere = new THREE.Mesh(sphereGeo, sphereMat);
        this._loadSphere.visible = false;
        this._scene.add(this._loadSphere);
        const wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(sphereGeo),
            new THREE.LineBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.35 })
        );
        this._loadSphere.add(wire);
        this._loadRadius = 15;
        this._grid = new THREE.GridHelper(400, 80, 0x333333, 0x4a6a4a);
        this._grid.position.y = 0;
        this._scene.add(this._grid);
        this._transform = new TransformControls(this._camera, this._renderer.domElement);
        this._transform.setMode('translate');
        this._transform.addEventListener('dragging-changed', (e) => {
            this._controls.enabled = !e.value;
        });
        this._transform.addEventListener('objectChange', () => this._emitPlacementChange());
        this._scene.add(this._transform);
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._raf = 0;
        this._disposed = false;
        /** @type {number|null} */
        this._selectedTagId = null;
        /** @type {((payload: { x: number, y: number, z: number, yaw: number }) => void)|null} */
        this.onPlacementChange = null;
        /** @type {((tagId: number) => void)|null} */
        this.onTagMarkerPick = null;
        this._boundResize = () => this._resize();
        this._boundClick = (e) => this._onClick(e);
        container.appendChild(this._renderer.domElement);
        const canvas = this._renderer.domElement;
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.borderRadius = '6px';
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(container);
        window.addEventListener('resize', this._boundResize);
        canvas.addEventListener('click', this._boundClick);
        requestAnimationFrame(() => this._resize());
        this._tick();
    }

    _emitPlacementChange() {
        if (!this.onPlacementChange || !this._placementMarker.visible) return;
        const p = this._placementMarker.position;
        const yaw = (this._placementMarker.rotation.y * 180) / Math.PI;
        this.updateLoadSphereAt(p);
        this.onPlacementChange({
            x: Math.round(p.x * 1000) / 1000,
            y: Math.round(p.y * 1000) / 1000,
            z: Math.round(p.z * 1000) / 1000,
            yaw: Math.round(yaw * 10) / 10,
        });
    }

    /**
     * @param {PointerEvent} e
     */
    _onClick(e) {
        if (this._transform.dragging || !this.onTagMarkerPick) return;
        const rect = this._renderer.domElement.getBoundingClientRect();
        if (rect.width < 1) return;
        this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointer, this._camera);
        const hits = this._raycaster.intersectObjects(this._tagMarkers.children, true);
        if (!hits.length) return;
        let o = hits[0].object;
        while (o.parent && o.parent !== this._tagMarkers) o = o.parent;
        const id = o.userData?.nfcSpawnId;
        if (typeof id === 'number') this.onTagMarkerPick(id);
    }

    _resize() {
        const w = Math.max(this.container.clientWidth, 200);
        const h = Math.max(this.container.clientHeight, 200);
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h, false);
    }

    _tick() {
        if (this._disposed) return;
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
        this._raf = requestAnimationFrame(() => this._tick());
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

    _frameWorldContent() {
        const box = new THREE.Box3();
        if (this._worldRoot.children.length) box.setFromObject(this._worldRoot);
        if (box.isEmpty()) {
            this._controls.target.set(0, 2, 0);
            this._camera.position.set(12, 14, 18);
            this._controls.update();
            return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const dist = Math.max(size.x, size.y, size.z) * 1.2 + 8;
        this._controls.target.copy(center);
        this._camera.position.set(center.x + dist * 0.6, center.y + dist * 0.45, center.z + dist * 0.6);
        this._controls.update();
        this._grid.position.y = box.min.y;
    }

    /**
     * @param {object} world
     */
    async loadWorld(world) {
        this._clearWorldRoot();
        const models = Array.isArray(world?.models) ? world.models : [];
        const factories = models.map((cfg) => () => loadWorldModelEntry(cfg));
        const loaded = await runWithConcurrency(LOAD_CONCURRENCY, factories);
        for (const m of loaded) {
            if (m) this._worldRoot.add(m);
        }
        const sp = world?.spawnPoint;
        if (sp && Number.isFinite(sp.y)) {
            this._grid.position.y = sp.y;
        }
        this._frameWorldContent();
        this._resize();
    }

    /**
     * @param {object[]} spawns
     * @param {number|null} [activeId]
     */
    setTagMarkers(spawns, activeId = null) {
        while (this._tagMarkers.children.length) {
            const c = this._tagMarkers.children[0];
            this._tagMarkers.remove(c);
            c.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
            });
        }
        for (const row of spawns) {
            const isActive = row.id === activeId;
            const color = isActive ? 0x44aaff : 0xf57c00;
            const g = createSpawnMarkerGroup(color);
            g.position.set(row.x, row.y, row.z);
            g.rotation.y = ((Number(row.yaw) || 0) * Math.PI) / 180;
            g.userData.nfcSpawnId = row.id;
            g.scale.setScalar(0.85);
            this._tagMarkers.add(g);
        }
    }

    /**
     * 編集中の配置マーカーを表示
     * @param {{ x: number, y: number, z: number, yaw?: number }} pos
     */
    showPlacementMarker(pos) {
        this._placementMarker.visible = true;
        this._placementMarker.position.set(pos.x, pos.y, pos.z);
        this._placementMarker.rotation.y = ((Number(pos.yaw) || 0) * Math.PI) / 180;
        this._transform.attach(this._placementMarker);
        this._controls.target.set(pos.x, pos.y, pos.z);
        this.updateLoadSphereAt(this._placementMarker.position);
    }

    /**
     * @param {boolean} visible
     */
    setLoadSphereVisible(visible) {
        this._loadSphere.visible = visible;
    }

    /**
     * @param {number} radiusM
     */
    setLoadRadius(radiusM) {
        const r = Math.max(0.5, Number(radiusM) || 15);
        this._loadRadius = r;
        this._loadSphere.scale.setScalar(r);
    }

    /**
     * @param {{ x: number, y: number, z: number }} pos
     */
    updateLoadSphereAt(pos) {
        if (!this._loadSphere.visible) return;
        this._loadSphere.position.set(pos.x, pos.y, pos.z);
    }

    /**
     * @returns {number}
     */
    getLoadRadius() {
        return this._loadRadius;
    }

    hidePlacementMarker() {
        this._placementMarker.visible = false;
        this._transform.detach();
    }

    /**
     * @param {number} yawDeg
     */
    setPlacementYaw(yawDeg) {
        if (!this._placementMarker.visible) return;
        this._placementMarker.rotation.y = (yawDeg * Math.PI) / 180;
        this._emitPlacementChange();
    }

    /**
     * @param {object|null} world
     */
    focusDefaultSpawn(world) {
        const sp = world?.spawnPoint || { x: 0, y: 10, z: 0 };
        this.showPlacementMarker({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 });
        this._emitPlacementChange();
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        this._resizeObserver?.disconnect();
        window.removeEventListener('resize', this._boundResize);
        this._renderer.domElement.removeEventListener('click', this._boundClick);
        this._transform.dispose();
        this._clearWorldRoot();
        this._controls.dispose();
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
