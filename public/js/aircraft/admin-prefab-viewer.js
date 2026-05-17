// public/js/aircraft/admin-prefab-viewer.js — 管理パネル用 prefab プレビュー（Three.js・/js 配下で配信）

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { loadPrefabGroupFromManifest } from '/js/prefab-load-shared.js';

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

/** @type {DRACOLoader|null} */
let sharedDraco = null;

function getDraco() {
    if (!sharedDraco) {
        sharedDraco = new DRACOLoader();
        sharedDraco.setDecoderPath(DRACO_DECODER_PATH);
    }
    return sharedDraco;
}

function createGLTFLoader() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDraco());
    return loader;
}

/**
 * ルートからの名前パス（Blender オブジェクト名の連結）
 * @param {THREE.Object3D} obj
 * @param {THREE.Object3D} root
 * @returns {string}
 */
export function objectNamePathFromRoot(obj, root) {
    const parts = [];
    let o = obj;
    while (o && o !== root) {
        parts.unshift(o.name && o.name.trim() ? o.name.trim() : '_unnamed_');
        o = o.parent;
    }
    return parts.join('/');
}

/**
 * @param {THREE.Object3D} root
 * @param {string} path
 * @returns {THREE.Object3D|null}
 */
export function findObjectByNamePath(root, path) {
    if (!path || !root) return null;
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    /** @type {THREE.Object3D|null} */
    let cur = root;
    for (const seg of segments) {
        const next = cur.children.find((c) => (c.name && c.name.trim() ? c.name.trim() : '_unnamed_') === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

/**
 * @param {THREE.Object3D} root
 * @returns {{ path: string, kind: string }[]}
 */
export function collectNamePaths(root) {
    /** @type {{ path: string, kind: string }[]} */
    const out = [];
    root.traverse((ch) => {
        if (ch === root) return;
        const path = objectNamePathFromRoot(ch, root);
        if (path) out.push({ path, kind: ch.type });
    });
    out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
    return out;
}

/**
 * 管理画面用 prefab ビューア
 */
export class AdminAircraftPrefabViewer {
    /**
     * @param {HTMLElement} container
     */
    constructor(container) {
        this.container = container;
        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x2a2a35);
        this._camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
        this._camera.position.set(8, 6, 12);
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        const amb = new THREE.AmbientLight(0xffffff, 0.55);
        this._scene.add(amb);
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(5, 12, 8);
        this._scene.add(dir);
        const grid = new THREE.GridHelper(40, 40, 0x555555, 0x444444);
        this._scene.add(grid);
        /** @type {THREE.Group|null} */
        this._prefabRoot = null;
        /** @type {THREE.Object3D|null} */
        this._selected = null;
        /** @type {((path: string|null) => void) | null} */
        this.onSelectionChange = null;
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._raf = 0;
        /** @type {boolean} */
        this._disposed = false;
        this._boundResize = () => this._resize();
        this._boundClick = (e) => this._onClick(e);
        container.appendChild(this._renderer.domElement);
        this._renderer.domElement.style.display = 'block';
        this._renderer.domElement.style.width = '100%';
        this._renderer.domElement.style.height = '100%';
        this._renderer.domElement.style.cursor = 'pointer';
        window.addEventListener('resize', this._boundResize);
        this._renderer.domElement.addEventListener('click', this._boundClick);
        this._resize();
        this._loop();
    }

    /**
     * @returns {void}
     */
    _resize() {
        const w = Math.max(1, this.container.clientWidth);
        const h = Math.max(1, this.container.clientHeight);
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h, false);
    }

    /**
     * @returns {void}
     */
    _loop() {
        if (this._disposed) return;
        this._raf = requestAnimationFrame(() => this._loop());
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }

    /**
     * @returns {THREE.Group|null}
     */
    getPrefabRoot() {
        return this._prefabRoot;
    }

    /**
     * @param {MouseEvent} e
     */
    _onClick(e) {
        if (!this._prefabRoot) return;
        const rect = this._renderer.domElement.getBoundingClientRect();
        this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointer, this._camera);
        const hits = this._raycaster.intersectObject(this._prefabRoot, true);
        const meshHit = hits.find((h) => h.object && (h.object.isMesh || h.object.isSkinnedMesh));
        const obj = meshHit ? meshHit.object : null;
        this.setSelected(obj);
    }

    /**
     * @param {THREE.Object3D|null} obj
     */
    setSelected(obj) {
        if (this._selected && this._selected !== obj) {
            this._selected.traverse((ch) => {
                if (ch.isMesh && ch.material) {
                    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                    mats.forEach((m) => {
                        if (m && m.emissive && m.userData._acPrevEmissive) {
                            m.emissive.copy(m.userData._acPrevEmissive);
                            delete m.userData._acPrevEmissive;
                        }
                    });
                }
            });
        }
        this._selected = obj;
        if (this._selected && this._prefabRoot) {
            this._selected.traverse((ch) => {
                if (ch.isMesh && ch.material) {
                    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                    mats.forEach((m) => {
                        if (m && m.emissive && !m.userData._acPrevEmissive) {
                            m.userData._acPrevEmissive = m.emissive.clone();
                            m.emissive.setHex(0x224466);
                        }
                    });
                }
            });
        }
        const path = this._selected && this._prefabRoot ? objectNamePathFromRoot(this._selected, this._prefabRoot) : null;
        this.onSelectionChange?.(path);
    }

    /**
     * @param {string|null} path
     */
    selectByPath(path) {
        if (!this._prefabRoot || !path) {
            this.setSelected(null);
            return;
        }
        const o = findObjectByNamePath(this._prefabRoot, path);
        this.setSelected(o);
    }

    /**
     * @returns {string|null}
     */
    getSelectionPath() {
        if (!this._selected || !this._prefabRoot) return null;
        return objectNamePathFromRoot(this._selected, this._prefabRoot);
    }

    /**
     * @param {string} manifestPath models/ または plane/ からの相対（例 plane/Foo-prefab-manifest.json）
     * @returns {Promise<void>}
     */
    async loadFromManifest(manifestPath) {
        this.disposePrefabOnly();
        const { group, totalTris } = await loadPrefabGroupFromManifest({
            THREE,
            existingGroup: null,
            manifestPath,
            createGLTFLoader: () => createGLTFLoader(),
            onXhrProgress: () => {},
            adminPlaneProxyBase: '/admin/plane-asset',
        });
        void totalTris;
        this._prefabRoot = group;
        this._scene.add(group);
        this._frameObject(group);
        this.setSelected(null);
    }

    /**
     * @param {THREE.Object3D} obj
     */
    _frameObject(obj) {
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const dist = maxDim * 2.2;
        this._controls.target.copy(center);
        this._camera.position.set(center.x + dist * 0.7, center.y + dist * 0.45, center.z + dist * 0.7);
        this._camera.near = Math.max(0.01, maxDim / 200);
        this._camera.far = Math.max(5000, maxDim * 50);
        this._camera.updateProjectionMatrix();
        this._controls.update();
    }

    /**
     * プレハブのみ破棄
     */
    disposePrefabOnly() {
        if (this._prefabRoot) {
            this._scene.remove(this._prefabRoot);
            this._prefabRoot.traverse((ch) => {
                if (ch.isMesh) {
                    ch.geometry?.dispose?.();
                    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                    mats.forEach((m) => m?.dispose?.());
                }
            });
        }
        this._prefabRoot = null;
        this._selected = null;
    }

    /**
     * ビューア全体破棄
     */
    dispose() {
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        window.removeEventListener('resize', this._boundResize);
        this._renderer.domElement.removeEventListener('click', this._boundClick);
        this.disposePrefabOnly();
        this._controls.dispose();
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
