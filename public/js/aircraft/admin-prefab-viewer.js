// public/js/aircraft/admin-prefab-viewer.js — 管理パネル用 prefab プレビュー（Three.js・/js 配下で配信）

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
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
 * @typedef {{ id: string, name?: string, role: string, position: {x:number,y:number,z:number}, eulerDeg?: {x:number,y:number,z:number} }} AcViewpointPayload
 */

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
        /** @type {THREE.Group|null} */
        this._vpParent = null;
        /** @type {string|null} */
        this._vpSelectedId = null;
        /** @type {TransformControls} */
        this._transformControls = new TransformControls(this._camera, this._renderer.domElement);
        this._transformControls.setSpace('local');
        this._transformControls.setSize(0.85);
        this._scene.add(this._transformControls);
        this._transformControls.addEventListener('dragging-changed', (ev) => {
            this._controls.enabled = !ev.value;
        });
        this._transformControls.addEventListener('change', () => this._emitViewpointTransformIfActive());
        /** @type {{ active: boolean, blockPrefabPick: boolean, onUpdate: ((v: AcViewpointPayload[]) => void) | null, onSelectRequest: ((id: string) => void) | null }} */
        this._vpEdit = { active: false, blockPrefabPick: false, onUpdate: null, onSelectRequest: null };
        this._vpGizmoScale = 0.15;
        this._eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');
        container.appendChild(this._renderer.domElement);
        this._renderer.domElement.style.display = 'block';
        this._renderer.domElement.style.width = '100%';
        this._renderer.domElement.style.height = '100%';
        this._renderer.domElement.style.cursor = 'pointer';
        this._renderer.domElement.setAttribute('tabindex', '0');
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
     * 視点編集モード（支店定義タブ）。プレハブ選択クリックを止め、マーカー＋ギズモで編集する。
     * @param {{ active: boolean, blockPrefabPick?: boolean, viewpoints: AcViewpointPayload[], selectedId: string|null, onUpdate: ((v: AcViewpointPayload[]) => void)|null, onSelectRequest?: ((id: string) => void)|null }} opts
     * @returns {void}
     */
    setViewpointEditMode(opts) {
        const active = !!opts.active;
        this._vpEdit.active = active;
        this._vpEdit.blockPrefabPick = active && opts.blockPrefabPick !== false;
        this._vpEdit.onUpdate = opts.onUpdate || null;
        this._vpEdit.onSelectRequest = opts.onSelectRequest || null;
        this._vpSelectedId = opts.selectedId || null;
        if (!active) {
            this._transformControls.detach();
            this._clearViewpointMarkers();
            return;
        }
        if (!this._prefabRoot) {
            this._transformControls.detach();
            return;
        }
        this._rebuildViewpointMarkers(opts.viewpoints || []);
        this._attachTransformToSelected();
    }

    /**
     * @param {'translate'|'rotate'} mode
     */
    setViewpointTransformMode(mode) {
        this._transformControls.setMode(mode === 'rotate' ? 'rotate' : 'translate');
    }

    /**
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     * @returns {void}
     */
    nudgeSelectedViewpoint(dx, dy, dz) {
        if (!this._vpEdit.active || !this._vpParent) return;
        const obj = this._transformControls.object;
        if (!obj) return;
        obj.position.x += dx;
        obj.position.y += dy;
        obj.position.z += dz;
        this._emitViewpointTransformIfActive();
    }

    /**
     * @returns {void}
     */
    _emitViewpointTransformIfActive() {
        if (!this._vpEdit.active || !this._vpEdit.onUpdate || !this._vpParent) return;
        const list = this._collectViewpointsFromMarkers();
        this._vpEdit.onUpdate(list);
    }

    /**
     * @returns {AcViewpointPayload[]}
     */
    _collectViewpointsFromMarkers() {
        if (!this._vpParent) return [];
        /** @type {AcViewpointPayload[]} */
        const out = [];
        const r2d = 180 / Math.PI;
        for (const ch of this._vpParent.children) {
            if (!(ch instanceof THREE.Group) || !ch.userData.acVpMeta) continue;
            const meta = /** @type {AcViewpointPayload} */ (ch.userData.acVpMeta);
            this._eulerScratch.setFromQuaternion(ch.quaternion, 'YXZ');
            out.push({
                id: meta.id,
                name: meta.name,
                role: meta.role,
                position: { x: ch.position.x, y: ch.position.y, z: ch.position.z },
                eulerDeg: {
                    x: this._eulerScratch.x * r2d,
                    y: this._eulerScratch.y * r2d,
                    z: this._eulerScratch.z * r2d,
                },
            });
        }
        return out;
    }

    /**
     * @param {AcViewpointPayload[]} viewpoints
     * @returns {void}
     */
    _rebuildViewpointMarkers(viewpoints) {
        this._transformControls.detach();
        this._clearViewpointMarkers();
        if (!this._prefabRoot || !viewpoints.length) return;
        this._vpParent = new THREE.Group();
        this._vpParent.name = '_ac_camera_viewpoints';
        this._prefabRoot.add(this._vpParent);
        const box = new THREE.Box3().setFromObject(this._prefabRoot);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.5);
        this._vpGizmoScale = maxDim * 0.04;
        const d2r = Math.PI / 180;
        for (const vp of viewpoints) {
            const g = new THREE.Group();
            g.name = `vp_${vp.id}`;
            g.userData.acVpMeta = {
                id: vp.id,
                name: vp.name || vp.id,
                role: vp.role || 'free',
                position: { ...vp.position },
                eulerDeg: { ...(vp.eulerDeg || { x: 0, y: 0, z: 0 }) },
            };
            g.position.set(vp.position.x, vp.position.y, vp.position.z);
            const ed = vp.eulerDeg || { x: 0, y: 0, z: 0 };
            g.quaternion.setFromEuler(
                new THREE.Euler(ed.x * d2r, ed.y * d2r, ed.z * d2r, 'YXZ')
            );
            const geom = new THREE.OctahedronGeometry(this._vpGizmoScale, 0);
            const mat = new THREE.MeshStandardMaterial({
                color: vp.role === 'cockpit' ? 0x48cae4 : vp.role === 'chase' ? 0xffaa00 : 0xadb5bd,
                emissive: 0x111111,
                metalness: 0.2,
                roughness: 0.45,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.userData.acVpGizmo = true;
            mesh.raycast = THREE.Mesh.prototype.raycast;
            g.add(mesh);
            const ax = new THREE.AxesHelper(this._vpGizmoScale * 2.2);
            g.add(ax);
            this._vpParent.add(g);
        }
        this._attachTransformToSelected();
    }

    /**
     * @returns {void}
     */
    _attachTransformToSelected() {
        if (!this._vpParent || !this._vpSelectedId) {
            this._transformControls.detach();
            return;
        }
        const g = this._vpParent.children.find(
            (c) => c instanceof THREE.Group && c.userData.acVpMeta && c.userData.acVpMeta.id === this._vpSelectedId
        );
        if (g) this._transformControls.attach(/** @type {THREE.Object3D} */ (g));
        else this._transformControls.detach();
    }

    /**
     * @param {string|null} id
     * @param {AcViewpointPayload[]} viewpoints
     * @returns {void}
     */
    setSelectedViewpointId(id, viewpoints) {
        this._vpSelectedId = id;
        if (this._vpEdit.active && viewpoints && this._vpParent && this._vpParent.children.length === viewpoints.length) {
            this._attachTransformToSelected();
            return;
        }
        if (this._vpEdit.active && viewpoints && viewpoints.length) {
            this._rebuildViewpointMarkers(viewpoints);
        } else {
            this._attachTransformToSelected();
        }
    }

    /**
     * 数値フォームから位置姿勢だけ更新（ギズモを付け替えずに同期）
     * @param {{ id: string, name?: string, role: string, position: {x:number,y:number,z:number}, eulerDeg?: {x:number,y:number,z:number} }[]} viewpoints
     * @returns {void}
     */
    refreshViewpointMarkersFrom(viewpoints) {
        if (!this._vpParent || !this._vpEdit.active) return;
        const d2r = Math.PI / 180;
        for (const ch of this._vpParent.children) {
            if (!(ch instanceof THREE.Group) || !ch.userData.acVpMeta) continue;
            const id = ch.userData.acVpMeta.id;
            const vp = viewpoints.find((v) => v.id === id);
            if (!vp) continue;
            ch.userData.acVpMeta = {
                id: vp.id,
                name: vp.name || vp.id,
                role: vp.role || 'free',
                position: { ...vp.position },
                eulerDeg: { ...(vp.eulerDeg || { x: 0, y: 0, z: 0 }) },
            };
            ch.position.set(vp.position.x, vp.position.y, vp.position.z);
            const ed = vp.eulerDeg || { x: 0, y: 0, z: 0 };
            ch.quaternion.setFromEuler(new THREE.Euler(ed.x * d2r, ed.y * d2r, ed.z * d2r, 'YXZ'));
        }
        this._attachTransformToSelected();
    }

    /**
     * @returns {void}
     */
    _clearViewpointMarkers() {
        this._transformControls.detach();
        if (this._vpParent && this._prefabRoot) {
            this._prefabRoot.remove(this._vpParent);
            this._vpParent.traverse((ch) => {
                if (ch.isMesh) {
                    ch.geometry?.dispose?.();
                    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                    mats.forEach((m) => m?.dispose?.());
                }
            });
        }
        this._vpParent = null;
    }

    /**
     * @param {MouseEvent} e
     */
    _onClick(e) {
        if (this._vpEdit.active && this._vpEdit.blockPrefabPick && this._vpParent) {
            const rect = this._renderer.domElement.getBoundingClientRect();
            this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            this._raycaster.setFromCamera(this._pointer, this._camera);
            const hits = this._raycaster.intersectObjects(this._vpParent.children, true);
            const gizmoHit = hits.find((h) => h.object && h.object.userData.acVpGizmo);
            if (gizmoHit) {
                let o = gizmoHit.object;
                while (o && o.parent !== this._vpParent) o = o.parent;
                if (o && o.userData.acVpMeta && this._vpEdit.onSelectRequest) {
                    this._vpEdit.onSelectRequest(String(o.userData.acVpMeta.id));
                }
                return;
            }
            return;
        }
        if (!this._prefabRoot) return;
        const rect = this._renderer.domElement.getBoundingClientRect();
        this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._pointer, this._camera);
        const hits = this._raycaster.intersectObject(this._prefabRoot, true);
        const meshHit = hits.find(
            (h) =>
                h.object &&
                (h.object.isMesh || h.object.isSkinnedMesh) &&
                !h.object.userData.acVpGizmo
        );
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
        this._transformControls.detach();
        this._clearViewpointMarkers();
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
        this._transformControls.dispose();
        this._scene.remove(this._transformControls);
        this._controls.dispose();
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
        }
    }
}
