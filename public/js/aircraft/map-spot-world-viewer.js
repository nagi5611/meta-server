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
 * Map定義 — ワールド上クリックでスポット XZ を取得するビューア
 */
export class AdminMapSpotWorldViewer {
    /**
     * @param {HTMLElement} container
     */
    constructor(container) {
        this.container = container;
        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x87ceeb);
        this._camera = new THREE.PerspectiveCamera(55, 1, 0.5, 20000);
        this._camera.position.set(0, 400, 400);
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.maxPolarAngle = Math.PI / 2 - 0.05;
        this._scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(80, 200, 60);
        this._scene.add(dir);
        /** @type {THREE.Group} */
        this._worldRoot = new THREE.Group();
        this._scene.add(this._worldRoot);
        /** @type {THREE.Group} */
        this._spotMarkers = new THREE.Group();
        this._scene.add(this._spotMarkers);
        this._pickPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(20000, 20000),
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
        this._renderer.domElement.style.display = 'block';
        this._renderer.domElement.style.width = '100%';
        this._renderer.domElement.style.height = '100%';
        this._renderer.domElement.style.cursor = 'crosshair';
        window.addEventListener('resize', this._boundResize);
        this._renderer.domElement.addEventListener('pointerdown', this._boundPointerDown);
        this._renderer.domElement.addEventListener('pointerup', this._boundPointerUp);
        this._resize();
        this._tick();
    }

    _resize() {
        const w = this.container.clientWidth || 640;
        const h = this.container.clientHeight || 480;
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

    /**
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
        if (!this._pointerDown || !this.onSpotPick) return;
        const dx = e.clientX - this._pointerDown.x;
        const dy = e.clientY - this._pointerDown.y;
        this._pointerDown = null;
        if (Math.hypot(dx, dy) > 6) return;

        const rect = this._renderer.domElement.getBoundingClientRect();
        this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointer, this._camera);
        const hits = this._raycaster.intersectObjects(
            [...this._worldRoot.children, this._pickPlane],
            true
        );
        if (!hits.length) return;
        const p = hits[0].point;
        this.onSpotPick(p.x, p.z);
    }

    /**
     * @param {object} world
     * @returns {Promise<void>}
     */
    async loadWorld(world) {
        this._clearWorldRoot();
        const models = Array.isArray(world?.models) ? world.models : [];
        const factories = models.map((cfg) => () => loadWorldModelEntry(cfg));
        const loaded = await runWithConcurrency(LOAD_CONCURRENCY, factories);
        for (const m of loaded) {
            if (m) this._worldRoot.add(m);
        }
        const sp = world?.spawnPoint || { x: 0, y: 10, z: 0 };
        this._controls.target.set(sp.x, sp.y, sp.z);
        this._camera.position.set(sp.x + 200, sp.y + 350, sp.z + 200);
        this._controls.update();
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
            const geom = new THREE.CylinderGeometry(8, 8, 40, 16);
            const mat = new THREE.MeshStandardMaterial({ color: 0xf57c00, emissive: 0x442200 });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(spot.x, 20, spot.z);
            mesh.userData.spotId = spot.id;
            this._spotMarkers.add(mesh);
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        window.removeEventListener('resize', this._boundResize);
        this._renderer.domElement.removeEventListener('pointerdown', this._boundPointerDown);
        this._renderer.domElement.removeEventListener('pointerup', this._boundPointerUp);
        this._clearWorldRoot();
        this._controls.dispose();
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
