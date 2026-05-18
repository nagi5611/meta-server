/**
 * Setting page: world editor (3D scene, objects, lights, spawn, save)
 * Uses Three.js from CDN (no Vite build required for this page).
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';
import { DRACO_DECODER_PATH } from './draco-decoder-path.js';
import { OBJLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/MTLLoader.js';
import { RGBELoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/RGBELoader.js';
import {
    loadSceneIBL,
    applyToneMapping,
    createGradientSkyDomeMesh,
    migrateLegacyGraphicsKeys,
    getAntialiasForTier,
    normalizeGraphicsTier,
    getShadowMapTypeConstant,
    DEFAULT_HDR_PATH,
    DEFAULT_WORLD_AMBIENT_INTENSITY,
    DEFAULT_WORLD_DIRECTIONAL_INTENSITY
} from './ibl-setup.js';
import {
    loadPrefabGroupFromManifest,
    normalizePrefabManifest,
    fetchPrefabManifestJson,
    resolvePrefabPartAssetPath
} from './prefab-load-shared.js';
import { normalizeWorldsLod } from './world-lod-normalize.js';
import {
    MODEL_MAX_BYTES_OBJ,
    MODEL_MAX_BYTES_GLTF,
    MODEL_MAX_TRIANGLES_TOTAL,
    MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD,
    fetchModelContentLength,
    countTrianglesInObject
} from './model-load-limits.js';
import { encodeAssetPathToUrlPath, notifyServiceWorkerInvalidate } from './service-worker-register.js';
import { resolveEnvAssetHref } from './asset-resolve.js';
import { resolveModelAssetHref } from './asset-resolve.js';
import {
    mergeAircraftPhysicsFromWorld,
    clipAircraftPhysicsPartialFromUser
} from '../../addons/aircraft/client/aircraft-physics-defaults.js';
import {
    applyAircraftBodyOrientationToObject3D,
    extractConfigRotationDegFromModelWithAircraftBody
} from './aircraft/aircraft-body-orient.js';

/**
 * bodyEulerDeg をワールド JSON 用に aircraft オブジェクトへ付与（全ゼロは省略）
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} base
 */
function appendSerializedBodyEulerDeg(a, base) {
    const be = a.bodyEulerDeg;
    if (!be || typeof be !== 'object' || Array.isArray(be)) return;
    const o = /** @type {Record<string, unknown>} */ (be);
    const nx = (k, d) => {
        const v = o[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : d;
    };
    const bx = nx('x', 0);
    const by = nx('y', 0);
    const bz = nx('z', 0);
    if (bx !== 0 || by !== 0 || bz !== 0) {
        base.bodyEulerDeg = { x: bx, y: by, z: bz };
    }
}

/**
 * オブジェクトパネル「機体メッシュ追加回転（度）」を読む
 * @returns {{ x: number, y: number, z: number }}
 */
function readObjAcBodyEulerDegFromPanel() {
    const elx = document.getElementById('obj-ac-body-x');
    const ely = document.getElementById('obj-ac-body-y');
    const elz = document.getElementById('obj-ac-body-z');
    const px = elx && elx.value !== '' ? parseFloat(elx.value) : 0;
    const py = ely && ely.value !== '' ? parseFloat(ely.value) : 0;
    const pz = elz && elz.value !== '' ? parseFloat(elz.value) : 0;
    return {
        x: Number.isFinite(px) ? px : 0,
        y: Number.isFinite(py) ? py : 0,
        z: Number.isFinite(pz) ? pz : 0
    };
}

/**
 * aircraft レコードに bodyEulerDeg を反映（全ゼロならキー削除）
 * @param {Record<string, unknown>} rec
 */
function mergeBodyEulerIntoAircraftRecord(rec) {
    const { x, y, z } = readObjAcBodyEulerDegFromPanel();
    if (x === 0 && y === 0 && z === 0) delete rec.bodyEulerDeg;
    else rec.bodyEulerDeg = { x, y, z };
}

/**
 * ワールド JSON 用 aircraft。ライブラリ連携時は id / radius / label / aircraftLibraryId（＋任意 bodyEulerDeg）。
 * 未リンクのレガシー機体はカメラ・physics を JSON から引き継ぎ保存する。
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function serializeAircraftForWorldJson(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const a = /** @type {Record<string, unknown>} */ (raw);
    const id = String(a.id || '').trim();
    if (!id) return null;
    const radius = typeof a.radius === 'number' && Number.isFinite(a.radius) ? a.radius : 4;
    const labelRaw = a.label != null ? String(a.label).trim() : '';
    const label = labelRaw || '操縦する';
    const libId = String(a.aircraftLibraryId || '').trim();
    /** @type {Record<string, unknown>} */
    const base = { id, radius, label };
    if (libId) {
        base.aircraftLibraryId = libId;
        appendSerializedBodyEulerDeg(a, base);
        return base;
    }
    const ck = a.cockpitOffset && typeof a.cockpitOffset === 'object' && !Array.isArray(a.cockpitOffset)
        ? /** @type {Record<string, unknown>} */ (a.cockpitOffset)
        : {};
    const ch = a.chaseOffset && typeof a.chaseOffset === 'object' && !Array.isArray(a.chaseOffset)
        ? /** @type {Record<string, unknown>} */ (a.chaseOffset)
        : {};
    const nx = (o, k, d) => {
        const v = o[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : d;
    };
    base.cockpitOffset = { x: nx(ck, 'x', 0), y: nx(ck, 'y', 1.2), z: nx(ck, 'z', 0) };
    base.chaseOffset = { x: nx(ch, 'x', 0), y: nx(ch, 'y', 3), z: nx(ch, 'z', 12) };
    const ce = a.cockpitEulerDeg;
    if (ce && typeof ce === 'object' && !Array.isArray(ce)) {
        const o = /** @type {Record<string, unknown>} */ (ce);
        base.cockpitEulerDeg = { x: nx(o, 'x', 0), y: nx(o, 'y', 0), z: nx(o, 'z', 0) };
    }
    const se = a.chaseEulerDeg;
    if (se && typeof se === 'object' && !Array.isArray(se)) {
        const o = /** @type {Record<string, unknown>} */ (se);
        base.chaseEulerDeg = { x: nx(o, 'x', 0), y: nx(o, 'y', 0), z: nx(o, 'z', 0) };
    }
    const ap = a.aircraftPhysics;
    if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
        const clipped = clipAircraftPhysicsPartialFromUser(ap);
        if (clipped && Object.keys(clipped).length) base.aircraftPhysics = clipped;
    }
    appendSerializedBodyEulerDeg(a, base);
    return base;
}

// --- State ---
let scene, camera, renderer, controls, transformControls;
let editGroup;
let worlds = {};
let selectedWorldId = null;
let selectedObject = null;
let modelList = [];
let mtlList = []; // MTL ファイル名（models/ 配下、ファイル名のみ）
/** @type {string[]} */
let prefabManifestList = []; // models 直下 *-prefab-manifest.json ファイル名のみ（GET /admin/prefab-manifests）
/** @type {string[]} */
let planePrefabManifestList = []; // plane/ 用（GET /admin/plane-prefab-manifests）
/** @type {{ id: string, displayName: string, prefabManifest: string }[]} */
let aircraftLibraryList = [];
let selectedModelPath = null; // 左パネル「モデル一覧」で選択中のモデル（models/xxx.glb または .obj）
let pdfList = [];
let selectedPdfPath = null; // 左パネル「PDF一覧」で選択中のPDF（pdfs/xxx.pdf）
let lightHelpers = []; // { light, mesh? } for point/spot position drag
let worldObjectList = []; // 右パネル「オブジェクト一覧」の並び（クリックで選択用）
/** オブジェクト一覧の階層展開状態＋ prefab 子行用の動的キー（例 pf_m123） */
let objectListExpanded = { lights: false, models: false, pdfs: false };
/** @type {{ kind: 'model'|'pdf'|'light', data: object }|null} Ctrl+C で取り込んだオブジェクトスナップショット */
let worldEditorObjectClipboard = null;
/** 貼り付け時に X 方向へずらす距離（m） */
const WORLD_EDITOR_PASTE_OFFSET_X = 1;
/** エディタ上の GLB プレビュー用 AnimationMixer（dispose / 破棄時に削除） */
const editorGltfPreviewMixers = new Set();
let editorAnimLastT = typeof performance !== 'undefined' ? performance.now() : 0;
/** ワールド切り替えの非同期競合を防ぐ（新しい選択だけ UI を確定させる） */
let worldSelectLoadGen = 0;
let editorGround = null; // 編集プレビュー用の床メッシュ（表示切替用）
let editorGrid = null;   // 編集プレビュー用のグリッド（表示切替用）
let editorDracoLoader = null;
/** サーバー ENABLE_CHART_FEATURES。無効時はワールド編集の太鼓・譜面UIと taiko 同期を行わない */
let worldEditorChartFeaturesEnabled = true;

const DEFAULT_FLOOR_WIDTH_M = 1000;
const DEFAULT_FLOOR_DEPTH_M = 1000;

/**
 * ワールド設定の床寸法（m）を正規化
 * @param {{ floorWidth?: unknown, floorDepth?: unknown }} [w]
 * @returns {{ fw: number, fd: number }}
 */
function normalizedFloorDimensions(w) {
    const fw0 = w && typeof w.floorWidth === 'number' && Number.isFinite(w.floorWidth) && w.floorWidth > 0 ? w.floorWidth : DEFAULT_FLOOR_WIDTH_M;
    const fd0 = w && typeof w.floorDepth === 'number' && Number.isFinite(w.floorDepth) && w.floorDepth > 0 ? w.floorDepth : DEFAULT_FLOOR_DEPTH_M;
    return { fw: fw0, fd: fd0 };
}

/**
 * エディタプレビューの床プレーン・グリッドをワールドの幅・奥行きに合わせる
 * @param {{ floorWidth?: unknown, floorDepth?: unknown, floorEnabled?: unknown }} [world]
 */
function applyEditorFloorMeshFromWorld(world) {
    if (!editorGround || !scene) return;
    const { fw, fd } = normalizedFloorDimensions(world || {});
    editorGround.geometry.dispose();
    editorGround.geometry = new THREE.PlaneGeometry(fw, fd);
    if (editorGrid) {
        scene.remove(editorGrid);
        editorGrid.geometry.dispose();
        const mat = editorGrid.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
    }
    const gridSize = Math.max(fw, fd);
    const divisions = Math.max(10, Math.round((100 * gridSize) / 1000));
    editorGrid = new THREE.GridHelper(gridSize, divisions, 0x000000, 0x2a4a2a);
    editorGrid.position.y = 0.01;
    scene.add(editorGrid);
    editorGrid.visible = world && world.floorEnabled !== false;
    if (editorGround) editorGround.visible = world && world.floorEnabled !== false;
}
const pointer = new THREE.Vector2();

/**
 * ワールド編集プレビュー用の DRACOLoader（Blender Draco 圧縮 GLB 用）
 * @returns {DRACOLoader}
 */
function getEditorDracoLoader() {
    if (!editorDracoLoader) {
        editorDracoLoader = new DRACOLoader();
        editorDracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    }
    return editorDracoLoader;
}

/**
 * prefab / 単体 GLB 読み込み用（Draco 付き GLTFLoader）
 * @returns {InstanceType<typeof GLTFLoader>}
 */
function createEditorGLTFLoader() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getEditorDracoLoader());
    return loader;
}
const raycaster = new THREE.Raycaster();

/**
 * @param {string} path
 * @returns {boolean}
 */
function isObjPath(path) {
    return typeof path === 'string' && path.toLowerCase().endsWith('.obj');
}

/** 単体 GLB/OBJ 等 — 八面体風シルエット */
const MODEL_ICON_3D_ASSET =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20.5 12 12 21.5 3.5 12 12 2.5z"/><path d="M12 2.5v19M3.5 12h17"/></svg>';

/** plane/ プレハブ一覧用（翼風シルエット） */
const MODEL_ICON_PLANE_PREFAB =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18"/><path d="M12 3 9 12h6l-3-9"/><path d="M7 15l-3 5M17 15l3 5"/></svg>';

/** 機体ライブラリ（搭乗可能） */
const MODEL_ICON_AIRCRAFT_LIB =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12 14 9V7l-4-2-4 2v2l-7 3v2l7-2v5l-2 1v2h6v-2l-2-1v-5l7 2v-2z"/></svg>';

/**
 * admin/models の生ファイル名と prefab マニフェスト一覧から、左パネル用エントリを作る。
 * 空間チャンク用の *.chunk_*.glb / *.chunk.json / *.chunks.json は一覧に出さない（レガシー資産用）。
 * @param {string[]} fileNames
 * @param {string[]} [manifestFileNames]
 * @returns {{ displayLabel: string, path: string, isPrefab?: boolean }[]}
 */
function buildModelPrefabEntries(fileNames, manifestFileNames) {
    const names = Array.isArray(fileNames) ? fileNames : [];
    const mans = Array.isArray(manifestFileNames) ? manifestFileNames : [];
    /** @type {{ displayLabel: string, path: string, isPrefab?: boolean }[]} */
    const out = [];
    for (const name of names) {
        const low = name.toLowerCase();
        if (low.endsWith('.chunk.json') || low.endsWith('.chunks.json')) continue;
        if (/\.chunk_\d+\.glb$/i.test(name)) continue;
        if (!low.endsWith('.glb') && !low.endsWith('.obj')) continue;
        out.push({
            displayLabel: name,
            path: 'models/' + name
        });
    }
    for (const name of mans) {
        const low = name.toLowerCase();
        if (!low.endsWith('-prefab-manifest.json')) continue;
        const base = name.replace(/-prefab-manifest\.json$/i, '');
        out.push({
            displayLabel: `${base}（Prefab）`,
            path: 'models/' + name.replace(/^\//, ''),
            isPrefab: true
        });
    }
    out.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, 'ja'));
    return out;
}

/**
 * ワールド編集左パネル用（GLB/OBJ + models/plane prefab + 機体ライブラリ）
 * @returns {{ displayLabel: string, path: string, isPrefab?: boolean, kind?: string, prefabManifest?: string, aircraftLibraryId?: string }[]}
 */
function buildEditorModelPaletteEntries() {
    const base = buildModelPrefabEntries(modelList, prefabManifestList);
    /** @type {{ displayLabel: string, path: string, isPrefab?: boolean, kind?: string, prefabManifest?: string, aircraftLibraryId?: string }[]} */
    const out = base.map((e) => ({
        ...e,
        kind: e.isPrefab ? 'prefab-models' : 'glb',
    }));
    const planes = Array.isArray(planePrefabManifestList) ? planePrefabManifestList : [];
    for (const name of planes) {
        const low = String(name || '').toLowerCase();
        if (!low.endsWith('-prefab-manifest.json')) continue;
        const baseName = String(name).replace(/-prefab-manifest\.json$/i, '');
        out.push({
            displayLabel: `${baseName}（飛行機 Prefab）`,
            path: 'plane/' + String(name).replace(/^\//, ''),
            isPrefab: true,
            kind: 'prefab-plane',
        });
    }
    for (const af of aircraftLibraryList) {
        const id = String(af?.id || '').trim();
        const pm = String(af?.prefabManifest || '').trim();
        if (!id || !pm) continue;
        out.push({
            displayLabel: `${af.displayName || id}（機体ライブラリ）`,
            path: `__aircraft__:${id}`,
            kind: 'aircraft-lib',
            prefabManifest: pm,
            aircraftLibraryId: id,
        });
    }
    out.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, 'ja'));
    return out;
}

/**
 * 現在の選択がパレットに存在するか確認し、無ければ先頭へ寄せる
 */
function syncModelPaletteSelectionAfterListChange() {
    const pal = buildEditorModelPaletteEntries();
    const ok = pal.some((e) => e.path === selectedModelPath);
    if (!ok && pal.length) {
        selectedModelPath = pal[0].path;
    }
    if (!pal.length) {
        selectedModelPath = null;
    }
}

/**
 * メタバースと同じ localStorage から描画オプションを読む（ワールド編集プレビュー用）
 * @returns {{ graphicsTier: string, toneMappingExposure: number, pixelRatioCap: number|string }}
 */
function readEditorGraphicsOptions() {
    try {
        const raw = localStorage.getItem('metaverse-settings');
        if (!raw) return migrateLegacyGraphicsKeys({});
        return migrateLegacyGraphicsKeys(JSON.parse(raw));
    } catch {
        return migrateLegacyGraphicsKeys({});
    }
}

/**
 * @returns {number}
 */
function getEditorPixelRatio() {
    const g = readEditorGraphicsOptions();
    const dpr = window.devicePixelRatio || 1;
    if (g.pixelRatioCap === 'full') return dpr;
    const n = g.pixelRatioCap === 2 ? 2 : 1;
    return Math.min(dpr, n);
}

/**
 * エディタ上で GLB のクリップを試聴再生する
 * @param {THREE.Object3D} model
 * @param {string} clipName
 */
function playEditorGltfClipPreview(model, clipName) {
    if (!model || !model.userData.editorGltfClips) return;
    const clips = model.userData.editorGltfClips;
    const cn = String(clipName || '').trim();
    const clip = clips.find((c) => c.name === cn);
    if (!clip) return;
    let mixer = model.userData.editorGltfMixer;
    if (!mixer) {
        mixer = new THREE.AnimationMixer(model);
        model.userData.editorGltfMixer = mixer;
        editorGltfPreviewMixers.add(mixer);
    }
    mixer.stopAllAction();
    const act = mixer.clipAction(clip);
    act.reset();
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.fadeIn(0.12).play();
}

/**
 * ワールド用モデル 1 件を読み込み（サイズ・ポリゴン上限あり）
 * @param {{ path?: string, mtlPath?: string, prefabManifest?: string }} config
 * @returns {Promise<{ model: THREE.Object3D, triangleCount: number, gltfAnimations?: THREE.AnimationClip[] }>}
 */
async function loadModelFromConfig(config) {
    const pfm = String(config.prefabManifest || '').trim();
    if (pfm) {
        const planeProxy = pfm.startsWith('plane/') ? '/admin/plane-asset' : undefined;
        const { group, totalTris } = await loadPrefabGroupFromManifest({
            THREE,
            manifestPath: pfm,
            createGLTFLoader: createEditorGLTFLoader,
            adminPlaneProxyBase: planeProxy,
        });
        if (totalTris > MODEL_MAX_TRIANGLES_TOTAL) {
            disposeObjectTree(group);
            throw new Error(
                `ポリゴンが多すぎます（約 ${totalTris.toLocaleString()} 三角）。上限約 ${MODEL_MAX_TRIANGLES_TOTAL.toLocaleString()} 三角です。`
            );
        }
        return { model: group, triangleCount: totalTris, gltfAnimations: [] };
    }

    const path = config.path || '';

    const url = await resolveModelAssetHref(path);
    const maxB = isObjPath(path) ? MODEL_MAX_BYTES_OBJ : MODEL_MAX_BYTES_GLTF;
    const len = await fetchModelContentLength(url);
    if (len != null && len > maxB) {
        throw new Error(
            `「${path.split('/').pop()}」が大きすぎます（約 ${Math.round(len / 1024 / 1024)}MB）。上限約 ${Math.round(maxB / 1024 / 1024)}MB です。`
        );
    }

    const mtlPath = (config.mtlPath || '').trim();
    let mtlEncoded = '';
    if (isObjPath(path) && mtlPath) {
        mtlEncoded = await resolveModelAssetHref(mtlPath);
    }

    const model = await new Promise((resolve, reject) => {
        if (!isObjPath(path)) {
            const gltfLoader = createEditorGLTFLoader();
            gltfLoader.load(
                url,
                (gltf) => {
                    const root = gltf.scene;
                    const anims = Array.isArray(gltf.animations) ? gltf.animations : [];
                    if (anims.length) root.userData.editorGltfClips = anims;
                    else delete root.userData.editorGltfClips;
                    resolve(root);
                },
                undefined,
                reject
            );
            return;
        }

        const objLoader = new OBJLoader();
        if (!mtlPath) {
            objLoader.load(url, (obj) => resolve(obj), undefined, reject);
            return;
        }

        const mtlDirUrl = mtlEncoded.slice(0, mtlEncoded.lastIndexOf('/') + 1);
        const mtlFile = mtlPath.split('/').pop();
        const objDirUrl = url.slice(0, url.lastIndexOf('/') + 1);
        const objFile = path.split('/').pop();

        const mtlLoader = new MTLLoader();
        mtlLoader.setPath(mtlDirUrl);
        mtlLoader.load(
            mtlFile,
            (materials) => {
                materials.preload();
                objLoader.setMaterials(materials);
                objLoader.setPath(objDirUrl);
                objLoader.load(objFile, (object) => resolve(object), undefined, reject);
            },
            undefined,
            reject
        );
    });

    const triangleCount = countTrianglesInObject(model);
    if (triangleCount > MODEL_MAX_TRIANGLES_TOTAL) {
        disposeObjectTree(model);
        throw new Error(
            `ポリゴンが多すぎます（約 ${triangleCount.toLocaleString()} 三角）。上限約 ${MODEL_MAX_TRIANGLES_TOTAL.toLocaleString()} 三角です。`
        );
    }
    const gltfAnimations = model.userData.editorGltfClips || [];
    return { model, triangleCount, gltfAnimations };
}

/**
 * ポリゴン数に応じてシャドウを付与（重いモデルはオフ）
 * @param {THREE.Object3D} model
 * @param {number} triangleCount
 */
function applyModelShadowByTriangleCount(model, triangleCount) {
    const disableSh = triangleCount > MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD;
    model.traverse((o) => {
        if (o.isMesh) {
            o.castShadow = !disableSh;
            o.receiveShadow = !disableSh;
        }
    });
}

/**
 * オブジェクトツリーのジオメトリ・マテリアルを破棄
 * @param {THREE.Object3D} obj
 */
function disposeObjectTree(obj) {
    obj.traverse((o) => {
        if (o.userData.editorGltfMixer) {
            o.userData.editorGltfMixer.stopAllAction();
            editorGltfPreviewMixers.delete(o.userData.editorGltfMixer);
            delete o.userData.editorGltfMixer;
        }
        delete o.userData.editorGltfClips;
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
 * MTL 用 select の選択肢を埋める
 * @param {HTMLSelectElement} selectEl
 * @param {string} [currentPath] - models/xxx.mtl
 */
function fillMtlSelectOptions(selectEl, currentPath) {
    const cur = currentPath || '';
    selectEl.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '（なし）';
    selectEl.appendChild(opt0);
    const seen = new Set(mtlList.map((n) => 'models/' + n));
    mtlList.forEach((name) => {
        const p = 'models/' + name;
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = name;
        selectEl.appendChild(opt);
    });
    if (cur && !seen.has(cur)) {
        const opt = document.createElement('option');
        opt.value = cur;
        opt.textContent = cur.split('/').pop() + ' (不在)';
        selectEl.appendChild(opt);
    }
    selectEl.value = '';
    if (cur && Array.from(selectEl.options).some((o) => o.value === cur)) {
        selectEl.value = cur;
    }
}

/**
 * 左パネル: OBJ 選択時のみ MTL 行を表示
 */
function updateAddObjMtlRowVisibility() {
    const row = document.getElementById('add-obj-mtl-row');
    if (!row) return;
    const show = !!(selectedModelPath && isObjPath(selectedModelPath));
    row.style.display = show ? '' : 'none';
    if (show) {
        const sel = document.getElementById('add-obj-mtl');
        if (sel) fillMtlSelectOptions(sel, sel.value || '');
    }
}

// Blender風: G/R/S 押下後のマウス追従変形用
let customTransformMode = null; // 'translate' | 'rotate' | 'scale'
let customTransformAxis = null; // 'x' | 'y' | 'z' | null
const customTransformPlane = new THREE.Plane();
const customTransformIntersect = new THREE.Vector3();
const customTransformPrev = new THREE.Vector3();
const customTransformStartPos = new THREE.Vector3();
const customTransformStartQuat = new THREE.Quaternion();
const customTransformStartScale = new THREE.Vector3();
let customTransformPrevScreen = null; // { x, y } for rotate
let customTransformPrevSet = false;   // 移動の初回のみ前回点をスキップ
let snapTranslateToStartAxis = false; // 移動中にX/Y/Zを押した→次のpointermoveで開始位置の軸にスナップ
let snapRotateToStartAxis = false;   // 回転中にX/Y/Zを押した→次のpointermoveで開始向きにスナップ
let snapScaleToStartAxis = false;    // スケール中にX/Y/Zを押した→次のpointermoveで開始スケールの軸にスナップ
let customTransformPrevScaleDist = null; // スケール: 前フレームのマウス〜オブジェクト(画面上)の距離
const ROTATE_SENSITIVITY = 0.005;
const SCALE_SENSITIVITY = 0.5; // 画面上の距離変化に対する倍率（マウスを遠ざける=拡大）

// PDFプレビュー用（左パネル PDF タブ）
let pdfjsLib = null;
let previewPdfDoc = null;
let previewCurrentPage = 1;

async function ensurePdfJsLoaded() {
    if (pdfjsLib) return;
    const mod = await import('https://cdn.jsdelivr.net/npm/@bundled-es-modules/pdfjs-dist/build/pdf.js');
    pdfjsLib = mod.default || mod;
    if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/@bundled-es-modules/pdfjs-dist/build/pdf.worker.min.js';
    }
}

async function renderPdfPreviewPage(pageNum) {
    if (!previewPdfDoc) return;
    const canvas = document.getElementById('we-pdf-canvas');
    const statusEl = document.getElementById('we-pdf-preview-status');
    const pageNumEl = document.getElementById('we-pdf-page-num');
    const pageCountEl = document.getElementById('we-pdf-page-count');
    if (!canvas) return;
    try {
        const page = await previewPdfDoc.getPage(pageNum);
        const scale = 1.0;
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const renderContext = { canvasContext: ctx, viewport };
        await page.render(renderContext).promise;
        previewCurrentPage = pageNum;
        if (pageNumEl) pageNumEl.textContent = String(pageNum);
        if (pageCountEl) pageCountEl.textContent = String(previewPdfDoc.numPages);
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'status-text';
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = 'プレビュー描画に失敗しました: ' + err.message;
            statusEl.className = 'status-text error';
        }
    }
}

async function loadPdfPreview(path) {
    const statusEl = document.getElementById('we-pdf-preview-status');
    const pageNumEl = document.getElementById('we-pdf-page-num');
    const pageCountEl = document.getElementById('we-pdf-page-count');
    if (statusEl) {
        statusEl.textContent = '読み込み中...';
        statusEl.className = 'status-text';
    }
    try {
        await ensurePdfJsLoaded();
        if (!pdfjsLib) throw new Error('PDFライブラリの初期化に失敗しました');
        const pathStr = path.startsWith('/') ? path.slice(1) : path;
        const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
        const url = '/' + encodedPath;
        const loadingTask = pdfjsLib.getDocument(url);
        previewPdfDoc = await loadingTask.promise;
        previewCurrentPage = 1;
        if (pageCountEl) pageCountEl.textContent = String(previewPdfDoc.numPages);
        await renderPdfPreviewPage(previewCurrentPage);
    } catch (err) {
        previewPdfDoc = null;
        if (statusEl) {
            statusEl.textContent = 'PDFの読み込みに失敗しました: ' + err.message;
            statusEl.className = 'status-text error';
        }
        if (pageNumEl) pageNumEl.textContent = '-';
        if (pageCountEl) pageCountEl.textContent = '-';
    }
}

/**
 * メタバース内のPDFメッシュに、指定PDFの1ページをテクスチャとして描画する。
 * @param {THREE.Mesh} mesh - PDF平面メッシュ（material.map を差し替える）
 * @param {string} pdfPath - 例 'pdfs/xxx.pdf'
 * @param {number} [pageNum=1] - 表示するページ番号
 */
async function loadPdfTextureForMesh(mesh, pdfPath, pageNum = 1) {
    if (!mesh || !mesh.material || !mesh.material.map) return;
    try {
        await ensurePdfJsLoaded();
        if (!pdfjsLib) return;
        const pathStr = pdfPath.startsWith('/') ? pdfPath.slice(1) : pdfPath;
        const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
        const url = '/' + encodedPath;
        const loadingTask = pdfjsLib.getDocument(url);
        const pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(Math.min(pageNum, pdfDoc.numPages));
        const scale = 2;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const oldMap = mesh.material.map;
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        mesh.material.map = tex;
        if (oldMap) oldMap.dispose();
    } catch (err) {
        console.warn('PDF texture load failed:', pdfPath, err);
    }
}

// Undo/Redo: 編集記録 20 回まで
const MAX_UNDO = 20;
let undoStack = [];
let redoStack = [];
let isRestoring = false;

function getState() {
    const built = buildWorldsFromScene();
    return { worlds: JSON.parse(JSON.stringify(built)), selectedWorldId };
}

async function setState(state) {
    isRestoring = true;
    worlds = JSON.parse(JSON.stringify(state.worlds));
    selectedWorldId = state.selectedWorldId;
    const w = worlds[selectedWorldId];
    if (w) {
        document.getElementById('world-name-row').style.display = '';
        document.getElementById('world-name').value = w.name || selectedWorldId;
        setWorldEditLoader(true, '編集履歴を復元しています…');
        try {
            await loadWorldIntoScene(w);
        } finally {
            setWorldEditLoader(false);
        }
    } else {
        document.getElementById('world-name-row').style.display = 'none';
    }
    renderWorldList();
    populateDestWorldSelect();
    document.getElementById('btn-delete-world').disabled = !selectedWorldId;
    isRestoring = false;
}

function pushUndo() {
    if (isRestoring) return;
    const state = getState();
    undoStack.push(state);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
}

function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(getState());
    void setState(undoStack.pop());
}

function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(getState());
    void setState(redoStack.pop());
}

// --- Three.js setup ---
function initScene() {
    const g = readEditorGraphicsOptions();
    const tier = normalizeGraphicsTier(g.graphicsTier);
    const canvas = document.getElementById('canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = null;

    camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 5000);
    camera.position.set(0, 10, 20);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: getAntialiasForTier(tier) });
    applyToneMapping(THREE, renderer, g.toneMappingExposure);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(getEditorPixelRatio());
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = getShadowMapTypeConstant(THREE, tier);

    // Ground
    const groundGeom = new THREE.PlaneGeometry(1000, 1000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a7c59, roughness: 0.8, metalness: 0.2 });
    editorGround = new THREE.Mesh(groundGeom, groundMat);
    editorGround.rotation.x = -Math.PI / 2;
    editorGround.receiveShadow = true;
    scene.add(editorGround);

    editorGrid = new THREE.GridHelper(1000, 100, 0x000000, 0x2a4a2a);
    editorGrid.position.y = 0.01;
    scene.add(editorGrid);

    editGroup = new THREE.Group();
    scene.add(editGroup);

    scene.add(createGradientSkyDomeMesh(THREE));

    // Editor-only preview lights（メタバース addWorldLights 既定と同スケール）
    const previewAmbient = new THREE.AmbientLight(0xffffff, DEFAULT_WORLD_AMBIENT_INTENSITY);
    previewAmbient.userData.editorPreview = true;
    scene.add(previewAmbient);
    const previewDir = new THREE.DirectionalLight(0xffffff, DEFAULT_WORLD_DIRECTIONAL_INTENSITY);
    previewDir.position.set(30, 80, 20);
    previewDir.userData.editorPreview = true;
    scene.add(previewDir);

    requestAnimationFrame(() => {
        (async () => {
            const hdrUrl = await resolveEnvAssetHref(DEFAULT_HDR_PATH);
            loadSceneIBL(THREE, { scene, renderer, RGBELoader, PMREMGenerator: THREE.PMREMGenerator }, { hdrUrl }).then((r) => {
                if (!r.ok) console.warn('[setting] IBL load skipped; place HDR at', DEFAULT_HDR_PATH);
            });
        })();
    });

    controls = new OrbitControls(camera, canvas);
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    // 左クリック=オブジェクト選択用に無効 / ホイール押し込み=回転、ホイール押し込み+Shift=水平移動
    controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

    transformControls = new TransformControls(camera, canvas);
    transformControls.setSpace('world');
    scene.add(transformControls);
    transformControls.addEventListener('mouseDown', () => { controls.enabled = false; });
    transformControls.addEventListener('mouseUp', () => { controls.enabled = true; });
    transformControls.addEventListener('change', onTransformChange);

    // CTRL 押下時のみグリッドスナップ（移動 0.5m、回転 15°）
    const TRANSLATION_SNAP = 0.5;
    const ROTATION_SNAP_RAD = (15 * Math.PI) / 180;
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Control') {
            transformControls.translationSnap = TRANSLATION_SNAP;
            transformControls.rotationSnap = ROTATION_SNAP_RAD;
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Control') {
            transformControls.translationSnap = null;
            transformControls.rotationSnap = null;
        }
    });

    // Blender風キー操作: G=移動, R=回転, S=スケール / X,Y,Z=軸拘束
    window.addEventListener('keydown', (e) => {
        const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
        const key = e.key.toLowerCase();
        if (key === 'g') {
            e.preventDefault();
            transformControls.setMode('translate');
            transformControls.setSpace('world');
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
            if (transformControls.object) startCustomTransform('translate');
            return;
        }
        if (key === 'r') {
            e.preventDefault();
            transformControls.setMode('rotate');
            transformControls.setSpace('local');
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
            if (transformControls.object) startCustomTransform('rotate');
            return;
        }
        if (key === 's') {
            e.preventDefault();
            transformControls.setMode('scale');
            transformControls.setSpace('local');
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
            if (transformControls.object) startCustomTransform('scale');
            return;
        }
        if (!transformControls.object) return;
        if (key === 'x') {
            e.preventDefault();
            transformControls.showX = true;
            transformControls.showY = false;
            transformControls.showZ = false;
            if (customTransformMode) {
                customTransformAxis = 'x';
                if (customTransformMode === 'translate') snapTranslateToStartAxis = true;
                else if (customTransformMode === 'rotate') snapRotateToStartAxis = true;
                else if (customTransformMode === 'scale') snapScaleToStartAxis = true;
            }
        } else if (key === 'y') {
            e.preventDefault();
            transformControls.showX = false;
            transformControls.showY = true;
            transformControls.showZ = false;
            if (customTransformMode) {
                customTransformAxis = 'y';
                if (customTransformMode === 'translate') snapTranslateToStartAxis = true;
                else if (customTransformMode === 'rotate') snapRotateToStartAxis = true;
                else if (customTransformMode === 'scale') snapScaleToStartAxis = true;
            }
        } else if (key === 'z') {
            e.preventDefault();
            transformControls.showX = false;
            transformControls.showY = false;
            transformControls.showZ = true;
            if (customTransformMode) {
                customTransformAxis = 'z';
                if (customTransformMode === 'translate') snapTranslateToStartAxis = true;
                else if (customTransformMode === 'rotate') snapRotateToStartAxis = true;
                else if (customTransformMode === 'scale') snapScaleToStartAxis = true;
            }
        }
    });

    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onUndoRedoKeyDown);
    window.addEventListener('keydown', onWorldEditorClipboardKeyDown);
    canvas.addEventListener('pointerdown', onPointerDown);
}

function onResize() {
    const canvas = document.getElementById('canvas');
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(getEditorPixelRatio());
}

function setPointerFromEvent(event) {
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function getTransformAxisFromControls() {
    if (transformControls.showX && !transformControls.showY && !transformControls.showZ) return 'x';
    if (!transformControls.showX && transformControls.showY && !transformControls.showZ) return 'y';
    if (!transformControls.showX && !transformControls.showY && transformControls.showZ) return 'z';
    return null;
}

function startCustomTransform(mode) {
    const obj = transformControls.object;
    if (!obj) return;
    pushUndo();
    customTransformMode = mode;
    customTransformAxis = getTransformAxisFromControls();
    obj.getWorldPosition(customTransformStartPos);
    obj.getWorldQuaternion(customTransformStartQuat);
    customTransformStartScale.copy(obj.scale);
    customTransformPrevScreen = null;
    customTransformPrevSet = false;
    customTransformPrevScaleDist = null;
    snapRotateToStartAxis = false;
    snapScaleToStartAxis = false;
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    customTransformPlane.setFromNormalAndCoplanarPoint(normal, customTransformStartPos);
    window.addEventListener('pointermove', onCustomPointerMove);
    window.addEventListener('pointerup', onCustomPointerUp);
    window.addEventListener('keydown', onCustomKeyDown);
}

function endCustomTransform() {
    customTransformMode = null;
    snapTranslateToStartAxis = false;
    snapRotateToStartAxis = false;
    snapScaleToStartAxis = false;
    customTransformPrevScaleDist = null;
    window.removeEventListener('pointermove', onCustomPointerMove);
    window.removeEventListener('pointerup', onCustomPointerUp);
    window.removeEventListener('keydown', onCustomKeyDown);
}

function onCustomPointerMove(event) {
    if (!customTransformMode || !transformControls.object) return;
    setPointerFromEvent(event);
    const obj = transformControls.object;
    raycaster.setFromCamera(pointer, camera);

    if (customTransformMode === 'translate') {
        if (!raycaster.ray.intersectPlane(customTransformPlane, customTransformIntersect)) return;
        if (snapTranslateToStartAxis && customTransformAxis) {
            if (customTransformAxis === 'x') { obj.position.y = customTransformStartPos.y; obj.position.z = customTransformStartPos.z; }
            else if (customTransformAxis === 'y') { obj.position.x = customTransformStartPos.x; obj.position.z = customTransformStartPos.z; }
            else if (customTransformAxis === 'z') { obj.position.x = customTransformStartPos.x; obj.position.y = customTransformStartPos.y; }
            customTransformPrev.copy(customTransformIntersect);
            snapTranslateToStartAxis = false;
            onTransformChange();
            return;
        }
        if (!customTransformPrevSet) {
            customTransformPrev.copy(customTransformIntersect);
            customTransformPrevSet = true;
            return;
        }
        const delta = customTransformIntersect.clone().sub(customTransformPrev);
        if (customTransformAxis === 'x') delta.set(delta.x, 0, 0);
        else if (customTransformAxis === 'y') delta.set(0, delta.y, 0);
        else if (customTransformAxis === 'z') delta.set(0, 0, delta.z);
        obj.position.add(delta);
        customTransformPrev.copy(customTransformIntersect);
    } else if (customTransformMode === 'rotate') {
        if (snapRotateToStartAxis && customTransformAxis) {
            obj.quaternion.copy(customTransformStartQuat);
            snapRotateToStartAxis = false;
        }
        const dx = event.movementX !== undefined ? event.movementX : 0;
        const dy = event.movementY !== undefined ? event.movementY : 0;
        const angle = -(Math.abs(dx) > Math.abs(dy) ? dx : -dy) * ROTATE_SENSITIVITY;
        if (customTransformAxis === 'x') obj.rotateX(angle);
        else if (customTransformAxis === 'y') obj.rotateY(angle);
        else if (customTransformAxis === 'z') obj.rotateZ(angle);
        else {
            const viewAxis = camera.getWorldDirection(new THREE.Vector3());
            obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(viewAxis, angle));
        }
    } else if (customTransformMode === 'scale') {
        const objWorld = obj.getWorldPosition(new THREE.Vector3());
        objWorld.project(camera);
        const dist = Math.hypot(pointer.x - objWorld.x, pointer.y - objWorld.y);
        if (snapScaleToStartAxis && customTransformAxis) {
            if (customTransformAxis === 'x') { obj.scale.y = customTransformStartScale.y; obj.scale.z = customTransformStartScale.z; }
            else if (customTransformAxis === 'y') { obj.scale.x = customTransformStartScale.x; obj.scale.z = customTransformStartScale.z; }
            else if (customTransformAxis === 'z') { obj.scale.x = customTransformStartScale.x; obj.scale.y = customTransformStartScale.y; }
            customTransformPrevScaleDist = dist;
            snapScaleToStartAxis = false;
            onTransformChange();
            return;
        }
        if (customTransformPrevScaleDist != null) {
            const deltaDist = dist - customTransformPrevScaleDist;
            const k = 1 + deltaDist * SCALE_SENSITIVITY;
            if (customTransformAxis === 'x') { obj.scale.x *= k; obj.scale.x = Math.max(0.01, obj.scale.x); }
            else if (customTransformAxis === 'y') { obj.scale.y *= k; obj.scale.y = Math.max(0.01, obj.scale.y); }
            else if (customTransformAxis === 'z') { obj.scale.z *= k; obj.scale.z = Math.max(0.01, obj.scale.z); }
            else obj.scale.multiplyScalar(k);
        }
        customTransformPrevScaleDist = dist;
    }
    onTransformChange();
}

function onCustomPointerUp() {
    endCustomTransform();
}

function onCustomKeyDown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        endCustomTransform();
    }
}

// Ctrl+Z: 戻す / Ctrl+Shift+Z: 進める
function onUndoRedoKeyDown(e) {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    if (!e.ctrlKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z' || key === 'y') {
        if (e.shiftKey) {
            e.preventDefault();
            redo();
        } else {
            e.preventDefault();
            undo();
        }
    }
}

/**
 * 選択中の editGroup 上オブジェクトを buildWorldsFromScene と同じ規則でシリアライズする
 * @returns {{ kind: 'model'|'pdf'|'light', data: object }|null}
 */
function getWorldEditorClipboardPayloadFromSelection() {
    const obj = selectedObject;
    if (!obj || !editGroup || obj.parent !== editGroup) return null;
    if (obj.userData.config && !obj.isLight) {
        const c = JSON.parse(JSON.stringify(obj.userData.config));
        c.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        if (c.aircraft && c.aircraft.id) {
            c.rotation = extractConfigRotationDegFromModelWithAircraftBody(obj, c.aircraft);
        } else {
            c.rotation = {
                x: obj.rotation.x * 180 / Math.PI,
                y: obj.rotation.y * 180 / Math.PI,
                z: obj.rotation.z * 180 / Math.PI
            };
        }
        c.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
        if (c.animate) c.animate = { ...c.animate, rotation: c.animate.rotation ? { ...c.animate.rotation } : {} };
        if (c.teleporter) c.teleporter = { ...c.teleporter };
        if (c.taiko) c.taiko = { ...c.taiko };
        if (c.aircraft) {
            const ser = serializeAircraftForWorldJson(c.aircraft);
            if (ser) c.aircraft = ser;
        }
        if (c.glbInteract) c.glbInteract = { ...c.glbInteract };
        if (!isObjPath(c.path || '')) delete c.mtlPath;
        return { kind: 'model', data: c };
    }
    if (obj.isMesh && obj.userData.pdfConfig) {
        const p = JSON.parse(JSON.stringify(obj.userData.pdfConfig));
        p.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        p.rotation = {
            x: obj.rotation.x * 180 / Math.PI,
            y: obj.rotation.y * 180 / Math.PI,
            z: obj.rotation.z * 180 / Math.PI
        };
        p.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
        if (p.teleporter) p.teleporter = { ...p.teleporter };
        return { kind: 'pdf', data: p };
    }
    if (obj.isLight && obj.userData.lightConfig && (obj.type === 'AmbientLight' || obj.type === 'DirectionalLight')) {
        const cfg = { ...obj.userData.lightConfig };
        cfg.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        return { kind: 'light', data: cfg };
    }
    if (obj.isMesh && obj.userData.lightRef && obj.userData.lightConfig) {
        const cfg = { ...obj.userData.lightConfig };
        cfg.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        return { kind: 'light', data: cfg };
    }
    return null;
}

/**
 * 貼り付け用にモデル設定の位置をずらし、機体ID・テレポーターIDの衝突を避ける
 * @param {object} cfg
 */
function uniquifyPastedModelConfig(cfg) {
    const c = cfg;
    if (c.position) {
        c.position = {
            x: (c.position.x || 0) + WORLD_EDITOR_PASTE_OFFSET_X,
            y: c.position.y || 0,
            z: c.position.z || 0
        };
    }
    if (c.aircraft && c.aircraft.id) {
        const a = { ...c.aircraft, id: `${String(c.aircraft.id)}-paste-${Date.now()}` };
        const ser = serializeAircraftForWorldJson(a);
        if (ser) c.aircraft = ser;
    }
    if (c.teleporter && c.teleporter.id != null && String(c.teleporter.id).length) {
        c.teleporter = { ...c.teleporter, id: `${String(c.teleporter.id)}-paste-${Date.now()}` };
    }
}

/**
 * Ctrl+V: クリップボードのオブジェクトをシーンに複製する
 */
async function pasteWorldEditorClipboard() {
    if (!selectedWorldId || !worldEditorObjectClipboard || !editGroup) return;
    pushUndo();
    const clip = worldEditorObjectClipboard;
    if (clip.kind === 'light') {
        const cfg = JSON.parse(JSON.stringify(clip.data));
        if (cfg.position && typeof cfg.position === 'object') {
            cfg.position = {
                x: (Number(cfg.position.x) || 0) + WORLD_EDITOR_PASTE_OFFSET_X,
                y: Number(cfg.position.y) || 0,
                z: Number(cfg.position.z) || 0
            };
        }
        const sel = appendWorldLightToEditGroup(cfg);
        if (sel) selectObject(sel);
        renderWorldObjectList();
        return;
    }
    if (clip.kind === 'pdf') {
        const p = JSON.parse(JSON.stringify(clip.data));
        p.position = {
            x: (p.position?.x || 0) + WORLD_EDITOR_PASTE_OFFSET_X,
            y: p.position?.y ?? 2,
            z: p.position?.z ?? -5
        };
        if (p.teleporter && p.teleporter.id != null && String(p.teleporter.id).length) {
            p.teleporter = { ...p.teleporter, id: `${String(p.teleporter.id)}-paste-${Date.now()}` };
        }
        const path = p.path || '';
        const pos = p.position;
        const rot = p.rotation || { x: 0, y: 0, z: 0 };
        const scale = p.scale || { x: 2, y: 2.8, z: 1 };
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
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
        mesh.scale.set(scale.x, scale.y, scale.z);
        mesh.userData.pdfConfig = {
            path,
            position: { ...pos },
            rotation: { ...rot },
            scale: { ...scale },
            teleporter: p.teleporter ? { ...p.teleporter } : undefined
        };
        editGroup.add(mesh);
        selectObject(mesh);
        renderWorldObjectList();
        loadPdfTextureForMesh(mesh, path).catch(() => {});
        return;
    }
    if (clip.kind === 'model') {
        const cfg = JSON.parse(JSON.stringify(clip.data));
        uniquifyPastedModelConfig(cfg);
        const path = cfg.path || '';
        const mtlPath = isObjPath(path) ? (cfg.mtlPath || '') : '';
        try {
            const pfe = String(cfg.prefabManifest || '').trim();
            const { model, triangleCount } = pfe
                ? await loadModelFromConfig({ prefabManifest: pfe, path: cfg.path || pfe })
                : await loadModelFromConfig({
                    path,
                    mtlPath
                });
            const pos = cfg.position || { x: 0, y: 0, z: 0 };
            const rot = cfg.rotation || { x: 0, y: 0, z: 0 };
            const sc = cfg.scale || { x: 1, y: 1, z: 1 };
            model.position.set(pos.x, pos.y, pos.z);
            model.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
            model.scale.set(sc.x, sc.y, sc.z);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = 'm' + Date.now();
            model.userData.config = cfg;
            editGroup.add(model);
            selectObject(model);
            renderWorldObjectList();
        } catch (err) {
            console.error('[world-edit] paste model failed:', err);
            alert(err.message || String(err));
        }
    }
}

/**
 * 管理画面でワールド編集タブが前面か
 * @returns {boolean}
 */
function isWorldEditPanelActive() {
    const p = document.getElementById('panel-world-edit');
    return !!(p && p.classList.contains('active'));
}

/**
 * Ctrl+C / Ctrl+V（Mac は Meta も）でオブジェクトのコピー・貼り付け
 * @param {KeyboardEvent} e
 */
function onWorldEditorClipboardKeyDown(e) {
    if (!isWorldEditPanelActive()) return;
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    if (e.code === 'KeyC') {
        if (!selectedWorldId || !selectedObject || !editGroup) return;
        if (selectedObject.parent !== editGroup) return;
        if (selectedObject.userData.lightConfig && (selectedObject.isLight || selectedObject.userData.lightRef)) {
            syncLightFromPanel({ recordUndo: false });
        } else if (selectedObject.userData.config || selectedObject.userData.pdfConfig) {
            syncObjectFromPanel({ recordUndo: false });
        }
        const payload = getWorldEditorClipboardPayloadFromSelection();
        if (!payload) return;
        e.preventDefault();
        worldEditorObjectClipboard = payload;
        return;
    }
    if (e.code === 'KeyV') {
        if (!selectedWorldId || !worldEditorObjectClipboard) return;
        e.preventDefault();
        void pasteWorldEditorClipboard();
    }
}

function onTransformChange() {
    const obj = transformControls.object;
    if (!obj) return;
    if (obj.userData.config) {
        obj.userData.config.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        const c = obj.userData.config;
        if (c.aircraft && c.aircraft.id) {
            obj.userData.config.rotation = extractConfigRotationDegFromModelWithAircraftBody(obj, c.aircraft);
        } else {
            obj.userData.config.rotation = {
                x: obj.rotation.x * 180 / Math.PI,
                y: obj.rotation.y * 180 / Math.PI,
                z: obj.rotation.z * 180 / Math.PI
            };
        }
        obj.userData.config.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
        if (selectedObject === obj) updateObjectPanel(obj);
    }
    if (obj.userData.pdfConfig) {
        obj.userData.pdfConfig.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        obj.userData.pdfConfig.rotation = { x: obj.rotation.x * 180 / Math.PI, y: obj.rotation.y * 180 / Math.PI, z: obj.rotation.z * 180 / Math.PI };
        obj.userData.pdfConfig.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
        if (selectedObject === obj) updateObjectPanel(obj);
    }
    if (obj.userData.lightConfig) {
        if (obj.userData.lightRef) obj.userData.lightRef.position.copy(obj.position);
        if (selectedObject === obj) updateLightPanel(obj);
    }
}

function onPointerDown(event) {
    if (event.button !== 0) return;
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const all = [];
    editGroup.traverse((o) => { if (o.isMesh) all.push(o); });
    const hits = raycaster.intersectObjects(all, true);
    // オブジェクトが選択中の場合のみギズモをチェック（ギズモクリック時は解除しない）
    if (selectedObject) {
        const gizmoHits = raycaster.intersectObject(transformControls, true);
        if (gizmoHits.length > 0 && (hits.length === 0 || gizmoHits[0].distance <= hits[0].distance)) {
            return;
        }
    }
    if (hits.length === 0) {
        selectObject(null);
        return;
    }
    let obj = hits[0].object;
    while (obj.parent && obj.parent !== editGroup) obj = obj.parent;
    selectObject(obj);
}

function selectObject(obj) {
    selectedObject = obj;
    transformControls.detach();
    if (obj) {
        transformControls.attach(obj);
        if (obj.userData.lightRef) {
            document.getElementById('object-hint').style.display = 'block';
            document.getElementById('object-props').style.display = 'none';
            updateLightPanel(obj);
            document.getElementById('light-hint').style.display = 'none';
            document.getElementById('light-props').style.display = 'block';
        } else if (obj.userData.config) {
            if (worldEditorChartFeaturesEnabled) {
                const cid = obj.userData.config.taiko?.multiplayerChartId;
                refreshTaikoChartSelect(cid).then(() => {
                    if (selectedObject === obj) updateObjectPanel(obj);
                });
            }
            updateObjectPanel(obj);
            document.getElementById('object-hint').style.display = 'none';
            document.getElementById('object-props').style.display = 'block';
            document.getElementById('light-hint').style.display = 'block';
            document.getElementById('light-props').style.display = 'none';
            document.getElementById('object-props-animation').style.display = '';
            document.getElementById('object-props-taiko').style.display = worldEditorChartFeaturesEnabled ? '' : 'none';
            document.getElementById('object-props-teleporter').style.display = '';
        } else if (obj.userData.pdfConfig) {
            updateObjectPanel(obj);
            document.getElementById('object-hint').style.display = 'none';
            document.getElementById('object-props').style.display = 'block';
            document.getElementById('light-hint').style.display = 'block';
            document.getElementById('light-props').style.display = 'none';
            document.getElementById('object-props-animation').style.display = 'none';
            document.getElementById('object-props-taiko').style.display = 'none';
            document.getElementById('object-props-teleporter').style.display = '';
        } else {
            document.getElementById('object-hint').style.display = 'block';
            document.getElementById('object-props').style.display = 'none';
            document.getElementById('light-hint').style.display = 'block';
            document.getElementById('light-props').style.display = 'none';
        }
    } else {
        document.getElementById('object-hint').style.display = 'block';
        document.getElementById('object-props').style.display = 'none';
        document.getElementById('light-hint').style.display = 'block';
        document.getElementById('light-props').style.display = 'none';
    }
    renderWorldObjectList();
}

function updateLightPanel(meshOrLight) {
    const cfg = meshOrLight.userData.lightConfig;
    if (!cfg) return;
    const pos = meshOrLight.position;
    document.getElementById('light-type').value = cfg.type || '';
    document.getElementById('light-pos-x').value = pos.x;
    document.getElementById('light-pos-y').value = pos.y;
    document.getElementById('light-pos-z').value = pos.z;
    document.getElementById('light-intensity').value = cfg.intensity ?? 1;
    document.getElementById('light-color').value = (cfg.color != null) ? cfg.color.toString(16).padStart(6, '0') : 'ffffff';
    document.getElementById('light-distance').value = cfg.distance ?? 50;
    document.getElementById('light-position-row').style.display = (cfg.type === 'ambient') ? 'none' : '';
    document.getElementById('light-distance-row').style.display = (cfg.type === 'point' || cfg.type === 'spot') ? '' : 'none';
}

/**
 * ライトパネルの値を選択中オブジェクトに反映する
 * @param {{ recordUndo?: boolean }} [opts] — recordUndo 省略時は true（従来どおり undo に積む）
 */
function syncLightFromPanel(opts) {
    const recordUndo = !opts || opts.recordUndo !== false;
    if (!selectedObject) return;
    const cfg = selectedObject.userData.lightConfig;
    if (!cfg) return;
    if (recordUndo) pushUndo();
    const intensity = parseFloat(document.getElementById('light-intensity').value) || 1;
    const colorHex = document.getElementById('light-color').value.trim() || 'ffffff';
    const color = parseInt(colorHex, 16);
    const distance = parseFloat(document.getElementById('light-distance').value) || 50;
    cfg.intensity = intensity;
    cfg.color = color;
    cfg.distance = distance;
    selectedObject.position.set(
        parseFloat(document.getElementById('light-pos-x').value) || 0,
        parseFloat(document.getElementById('light-pos-y').value) || 0,
        parseFloat(document.getElementById('light-pos-z').value) || 0
    );
    const light = selectedObject.userData.lightRef || selectedObject;
    if (light.isLight) {
        light.intensity = intensity;
        light.color.setHex(color);
        if (light.distance !== undefined) light.distance = distance;
        if (!selectedObject.userData.lightRef) light.position.copy(selectedObject.position);
    }
}

/**
 * オブジェクトパネル「ライブラリ機体 ID」セレクトを aircraftLibraryList で再構築する
 * @returns {void}
 */
function refreshAircraftLibrarySelectOptions() {
    const sel = document.getElementById('obj-ac-library-id');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">（未リンク）</option>';
    for (const af of aircraftLibraryList) {
        const opt = document.createElement('option');
        opt.value = af.id;
        opt.textContent = `${af.displayName} (${af.id})`;
        sel.appendChild(opt);
    }
    if (cur && [...sel.options].some((o) => o.value === cur)) {
        sel.value = cur;
    }
}

function updateVehicleAircraftFieldsVisibility() {
    const sel = document.getElementById('obj-vehicle-type');
    const wrap = document.getElementById('obj-aircraft-fields');
    if (!sel || !wrap) return;
    wrap.style.display = sel.value === 'airplane' ? 'block' : 'none';
}

/**
 * GLB クリップ一覧とインタラクト設定 UI を選択オブジェクトに合わせる
 * @param {THREE.Object3D} obj
 */
function updateGlbAnimInteractPanel(obj) {
    const block = document.getElementById('object-props-glb-anim');
    const listEl = document.getElementById('obj-glb-anim-list');
    const hintEl = document.getElementById('obj-glb-anim-hint');
    const enableEl = document.getElementById('obj-glb-interact-enable');
    const fieldsEl = document.getElementById('obj-glb-interact-fields');
    const clipSel = document.getElementById('obj-glb-interact-clip');
    if (!block || !listEl || !enableEl || !fieldsEl || !clipSel) return;
    if (!obj || !obj.userData.config) {
        block.style.display = 'none';
        return;
    }
    const c = obj.userData.config;
    const path = String(c.path || '');
    const isSingleGlb = path.toLowerCase().endsWith('.glb');
    const clips = obj.userData.editorGltfClips;
    if (!isSingleGlb || !clips || !clips.length) {
        block.style.display = 'none';
        return;
    }
    block.style.display = '';
    if (hintEl) hintEl.style.display = '';
    listEl.innerHTML = '';
    clips.forEach((clip) => {
        const row = document.createElement('div');
        row.className = 'prop-row';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.flexWrap = 'wrap';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'prop-label';
        nameSpan.style.margin = '0';
        nameSpan.style.flex = '1';
        nameSpan.style.minWidth = '120px';
        nameSpan.textContent = clip.name || '(無名)';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'インタラクト相当で再生';
        btn.dataset.glbPreviewClip = clip.name || '';
        row.appendChild(nameSpan);
        row.appendChild(btn);
        listEl.appendChild(row);
    });
    const gi = c.glbInteract;
    enableEl.checked = !!(gi && gi.clipName);
    fieldsEl.style.display = enableEl.checked ? '' : 'none';
    clipSel.innerHTML = '';
    clips.forEach((clip) => {
        const opt = document.createElement('option');
        const nm = clip.name || '';
        opt.value = nm;
        opt.textContent = nm || '(無名)';
        clipSel.appendChild(opt);
    });
    const curClip = gi && gi.clipName ? String(gi.clipName) : (clips[0] ? String(clips[0].name || '') : '');
    if (curClip && Array.from(clipSel.options).some((o) => o.value === curClip)) clipSel.value = curClip;
    else if (clipSel.options.length) clipSel.selectedIndex = 0;
    document.getElementById('obj-glb-interact-radius').value = gi && gi.radius != null ? gi.radius : 3;
    document.getElementById('obj-glb-interact-label').value = gi && gi.label != null ? gi.label : '';
    const accEl = document.getElementById('obj-glb-interact-access');
    if (accEl) accEl.value = gi && gi.access ? gi.access : 'public';
}

function updateObjectPanel(obj) {
    if (!obj) return;
    const c = obj.userData.config || obj.userData.pdfConfig;
    if (!c) return;
    const mtlRow = document.getElementById('obj-mtl-row');
    const mtlSel = document.getElementById('obj-mtl-path');
    if (mtlRow && mtlSel) {
        const op = (obj.userData.config && c.path) || '';
        if (obj.userData.config && isObjPath(op)) {
            mtlRow.style.display = '';
            fillMtlSelectOptions(mtlSel, c.mtlPath || '');
        } else {
            mtlRow.style.display = 'none';
        }
    }
    document.getElementById('obj-path').value =
        (c.path || (c.framePaths && c.framePaths[0])) || '';
    document.getElementById('obj-pos-x').value = obj.position.x;
    document.getElementById('obj-pos-y').value = obj.position.y;
    document.getElementById('obj-pos-z').value = obj.position.z;
    const cfgForRot = obj.userData.config;
    const acForRot = cfgForRot && cfgForRot.aircraft && cfgForRot.aircraft.id ? cfgForRot.aircraft : null;
    if (acForRot && cfgForRot) {
        const rr = cfgForRot.rotation || { x: 0, y: 0, z: 0 };
        document.getElementById('obj-rot-x').value = (Number(rr.x) || 0).toFixed(2);
        document.getElementById('obj-rot-y').value = (Number(rr.y) || 0).toFixed(2);
        document.getElementById('obj-rot-z').value = (Number(rr.z) || 0).toFixed(2);
    } else {
        document.getElementById('obj-rot-x').value = (obj.rotation.x * 180 / Math.PI).toFixed(2);
        document.getElementById('obj-rot-y').value = (obj.rotation.y * 180 / Math.PI).toFixed(2);
        document.getElementById('obj-rot-z').value = (obj.rotation.z * 180 / Math.PI).toFixed(2);
    }
    document.getElementById('obj-scale-x').value = obj.scale.x;
    document.getElementById('obj-scale-y').value = obj.scale.y;
    document.getElementById('obj-scale-z').value = obj.scale.z;
    if (obj.userData.config) {
        const anim = c.animate && c.animate.rotation;
        document.getElementById('obj-animate').checked = !!anim;
        document.getElementById('obj-anim-x').value = anim ? (anim.x || 0) : 0;
        document.getElementById('obj-anim-y').value = anim ? (anim.y || 0) : 0;
        document.getElementById('obj-anim-z').value = anim ? (anim.z || 0) : 0;
        const tp = c.teleporter;
        document.getElementById('obj-teleporter').checked = !!tp;
        document.getElementById('obj-tp-id').value = tp ? (tp.id || '') : '';
        document.getElementById('obj-tp-dest').value = tp ? (tp.destinationWorld || '') : '';
        document.getElementById('obj-tp-radius').value = tp ? (tp.radius ?? 3) : 3;
        document.getElementById('obj-tp-label').value = tp ? (tp.label || '') : '';
        document.getElementById('obj-tp-access').value = tp && tp.access ? tp.access : 'public';
        document.getElementById('obj-tp-auto-teleport').checked = !!(tp && tp.autoTeleport);
        document.getElementById('obj-tp-auto-contact-teleport').checked = !!(tp && tp.autoTeleportOnContact);
        const taiko = c.taiko;
        document.getElementById('obj-taiko').checked = !!taiko;
        document.getElementById('obj-taiko-radius').value = taiko ? (taiko.radius ?? 3) : 3;
        const mp = !!(taiko && taiko.multiplayer);
        document.getElementById('obj-taiko-multiplayer').checked = mp;
        document.getElementById('obj-taiko-group-id').value = mp ? (taiko.groupId || '') : '';
        const chartSel = document.getElementById('obj-taiko-chart-id');
        if (chartSel && taiko && taiko.multiplayerChartId) chartSel.value = taiko.multiplayerChartId;
        else if (chartSel && chartSel.options.length) chartSel.selectedIndex = 0;
        const mpRows = document.getElementById('obj-taiko-multiplayer-rows');
        if (mpRows) mpRows.style.display = taiko && mp ? '' : 'none';
        const ac = c.aircraft;
        const vTypeSel = document.getElementById('obj-vehicle-type');
        if (vTypeSel) {
            vTypeSel.value = ac && ac.id ? 'airplane' : '';
        }
        if (ac && ac.id) {
            document.getElementById('obj-ac-id').value = ac.id || '';
            document.getElementById('obj-ac-radius').value = ac.radius != null ? ac.radius : 4;
            document.getElementById('obj-ac-label').value = ac.label || '操縦する';
            refreshAircraftLibrarySelectOptions();
            const libSel = document.getElementById('obj-ac-library-id');
            const libCur = String(ac.aircraftLibraryId || '').trim();
            if (libSel && 'value' in libSel) {
                if (libCur && [...libSel.options].some((o) => o.value === libCur)) {
                    /** @type {HTMLSelectElement} */ (libSel).value = libCur;
                } else {
                    /** @type {HTMLSelectElement} */ (libSel).value = '';
                }
            }
        } else {
            document.getElementById('obj-ac-id').value = '';
            document.getElementById('obj-ac-radius').value = 4;
            document.getElementById('obj-ac-label').value = '操縦する';
            refreshAircraftLibrarySelectOptions();
            const libSel0 = document.getElementById('obj-ac-library-id');
            if (libSel0 && 'value' in libSel0) /** @type {HTMLSelectElement} */ (libSel0).value = '';
        }
        const bxEl = document.getElementById('obj-ac-body-x');
        const byEl = document.getElementById('obj-ac-body-y');
        const bzEl = document.getElementById('obj-ac-body-z');
        if (bxEl && byEl && bzEl) {
            if (ac && ac.id) {
                const be = ac.bodyEulerDeg && typeof ac.bodyEulerDeg === 'object' && !Array.isArray(ac.bodyEulerDeg)
                    ? /** @type {Record<string, unknown>} */ (ac.bodyEulerDeg)
                    : {};
                const nbe = (k, d) => {
                    const v = be[k];
                    return typeof v === 'number' && Number.isFinite(v) ? v : d;
                };
                bxEl.value = String(nbe('x', 0));
                byEl.value = String(nbe('y', 0));
                bzEl.value = String(nbe('z', 0));
            } else {
                bxEl.value = '0';
                byEl.value = '0';
                bzEl.value = '0';
            }
        }
        updateVehicleAircraftFieldsVisibility();
        updateGlbAnimInteractPanel(obj);
        const lodDet = document.getElementById('object-props-prefab-lod');
        const pfm = String(c.prefabManifest || '').trim();
        if (lodDet) {
            if (pfm) {
                lodDet.style.display = '';
                fillObjectLodPanel(obj, c);
            } else {
                lodDet.style.display = 'none';
            }
        }
    } else if (obj.userData.pdfConfig) {
        const tp = c.teleporter;
        document.getElementById('obj-teleporter').checked = !!tp;
        document.getElementById('obj-tp-id').value = tp ? (tp.id || '') : '';
        document.getElementById('obj-tp-dest').value = tp ? (tp.destinationWorld || '') : '';
        document.getElementById('obj-tp-radius').value = tp ? (tp.radius ?? 3) : 3;
        document.getElementById('obj-tp-label').value = tp ? (tp.label || '') : '';
        document.getElementById('obj-tp-access').value = tp && tp.access ? tp.access : 'public';
        document.getElementById('obj-tp-auto-teleport').checked = !!(tp && tp.autoTeleport);
        document.getElementById('obj-tp-auto-contact-teleport').checked = !!(tp && tp.autoTeleportOnContact);
        const gb = document.getElementById('object-props-glb-anim');
        if (gb) gb.style.display = 'none';
        const lodDet = document.getElementById('object-props-prefab-lod');
        if (lodDet) lodDet.style.display = 'none';
    }
}

/**
 * オブジェクトパネルの値を選択中に反映する
 * @param {{ recordUndo?: boolean }} [opts] — recordUndo 省略時は true
 */
function syncObjectFromPanel(opts) {
    const recordUndo = !opts || opts.recordUndo !== false;
    if (!selectedObject) return;
    const c = selectedObject.userData.config || selectedObject.userData.pdfConfig;
    if (!c) return;
    if (recordUndo) pushUndo();
    selectedObject.position.set(
        parseFloat(document.getElementById('obj-pos-x').value) || 0,
        parseFloat(document.getElementById('obj-pos-y').value) || 0,
        parseFloat(document.getElementById('obj-pos-z').value) || 0
    );
    selectedObject.rotation.set(
        (parseFloat(document.getElementById('obj-rot-x').value) || 0) * Math.PI / 180,
        (parseFloat(document.getElementById('obj-rot-y').value) || 0) * Math.PI / 180,
        (parseFloat(document.getElementById('obj-rot-z').value) || 0) * Math.PI / 180
    );
    selectedObject.scale.set(
        parseFloat(document.getElementById('obj-scale-x').value) || 1,
        parseFloat(document.getElementById('obj-scale-y').value) || 1,
        parseFloat(document.getElementById('obj-scale-z').value) || 1
    );
    c.position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
    c.rotation = {
        x: selectedObject.rotation.x * 180 / Math.PI,
        y: selectedObject.rotation.y * 180 / Math.PI,
        z: selectedObject.rotation.z * 180 / Math.PI
    };
    c.scale = { x: selectedObject.scale.x, y: selectedObject.scale.y, z: selectedObject.scale.z };
    if (selectedObject.userData.config) {
        const p = c.path || '';
        if (isObjPath(p)) {
            const mtlEl = document.getElementById('obj-mtl-path');
            const mv = mtlEl && mtlEl.value ? mtlEl.value.trim() : '';
            if (mv) c.mtlPath = mv;
            else delete c.mtlPath;
        } else {
            delete c.mtlPath;
        }
        if (document.getElementById('obj-animate').checked) {
            c.animate = {
                rotation: {
                    x: parseFloat(document.getElementById('obj-anim-x').value) || 0,
                    y: parseFloat(document.getElementById('obj-anim-y').value) || 0,
                    z: parseFloat(document.getElementById('obj-anim-z').value) || 0
                }
            };
        } else {
            delete c.animate;
        }
        if (document.getElementById('obj-teleporter').checked) {
            const accessEl = document.getElementById('obj-tp-access');
            const accessVal = accessEl && accessEl.value ? accessEl.value : 'public';
            const autoTeleportEl = document.getElementById('obj-tp-auto-teleport');
            const autoTeleport = !!(autoTeleportEl && autoTeleportEl.checked);
            const autoContactTeleportEl = document.getElementById('obj-tp-auto-contact-teleport');
            const autoTeleportOnContact = !!(autoContactTeleportEl && autoContactTeleportEl.checked);
            c.teleporter = {
                id: document.getElementById('obj-tp-id').value.trim() || 'tp1',
                destinationWorld: document.getElementById('obj-tp-dest').value || Object.keys(worlds)[0],
                radius: parseFloat(document.getElementById('obj-tp-radius').value) || 3,
                label: document.getElementById('obj-tp-label').value.trim() || '',
                access: accessVal,
                autoTeleport,
                autoTeleportOnContact
            };
        } else {
            delete c.teleporter;
        }
        if (worldEditorChartFeaturesEnabled) {
            if (document.getElementById('obj-taiko').checked) {
                const radius = parseFloat(document.getElementById('obj-taiko-radius').value) || 3;
                const mp = document.getElementById('obj-taiko-multiplayer').checked;
                const groupId = (document.getElementById('obj-taiko-group-id').value || '').trim();
                const chartEl = document.getElementById('obj-taiko-chart-id');
                const multiplayerChartId = chartEl && chartEl.value ? chartEl.value.trim() : '';
                if (mp) {
                    c.taiko = {
                        radius,
                        multiplayer: true,
                        groupId,
                        multiplayerChartId
                    };
                    if (groupId) {
                        editGroup.children.forEach((child) => {
                            const cfg = child.userData.config;
                            if (!cfg || !cfg.taiko || !cfg.taiko.multiplayer) return;
                            if (String(cfg.taiko.groupId || '').trim() !== groupId) return;
                            cfg.taiko.multiplayerChartId = multiplayerChartId;
                            cfg.taiko.groupId = groupId;
                        });
                    }
                } else {
                    c.taiko = { radius };
                }
            } else {
                delete c.taiko;
            }
        }
        const vType = document.getElementById('obj-vehicle-type')?.value || '';
        if (vType === 'airplane') {
            const idRaw = document.getElementById('obj-ac-id').value.trim();
            const rad = parseFloat(document.getElementById('obj-ac-radius').value);
            const libSel = document.getElementById('obj-ac-library-id');
            const libV = libSel && 'value' in libSel ? String(/** @type {HTMLSelectElement} */ (libSel).value || '').trim() : '';
            /** @type {Record<string, unknown>} */
            const base = {
                id: idRaw || 'plane-1',
                radius: Number.isFinite(rad) && rad > 0 ? rad : 4,
                label: (document.getElementById('obj-ac-label').value || '').trim() || '操縦する',
            };
            if (libV) {
                c.aircraft = { ...base, aircraftLibraryId: libV };
                mergeBodyEulerIntoAircraftRecord(c.aircraft);
            } else {
                const prev = c.aircraft && typeof c.aircraft === 'object' && !Array.isArray(c.aircraft) ? c.aircraft : {};
                const ckPrev = prev.cockpitOffset && typeof prev.cockpitOffset === 'object' && !Array.isArray(prev.cockpitOffset)
                    ? /** @type {Record<string, unknown>} */ (prev.cockpitOffset)
                    : {};
                const chPrev = prev.chaseOffset && typeof prev.chaseOffset === 'object' && !Array.isArray(prev.chaseOffset)
                    ? /** @type {Record<string, unknown>} */ (prev.chaseOffset)
                    : {};
                const nx = (o, k, d) => {
                    const v = o[k];
                    return typeof v === 'number' && Number.isFinite(v) ? v : d;
                };
                /** @type {Record<string, unknown>} */
                const acPayload = {
                    ...base,
                    cockpitOffset: {
                        x: nx(ckPrev, 'x', 0),
                        y: nx(ckPrev, 'y', 1.2),
                        z: nx(ckPrev, 'z', 0),
                    },
                    chaseOffset: {
                        x: nx(chPrev, 'x', 0),
                        y: nx(chPrev, 'y', 3),
                        z: nx(chPrev, 'z', 12),
                    },
                };
                const ce = prev.cockpitEulerDeg;
                if (ce && typeof ce === 'object' && !Array.isArray(ce)) {
                    const o = /** @type {Record<string, unknown>} */ (ce);
                    acPayload.cockpitEulerDeg = { x: nx(o, 'x', 0), y: nx(o, 'y', 0), z: nx(o, 'z', 0) };
                }
                const se = prev.chaseEulerDeg;
                if (se && typeof se === 'object' && !Array.isArray(se)) {
                    const o = /** @type {Record<string, unknown>} */ (se);
                    acPayload.chaseEulerDeg = { x: nx(o, 'x', 0), y: nx(o, 'y', 0), z: nx(o, 'z', 0) };
                }
                const ap = prev.aircraftPhysics;
                if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
                    const clipped = clipAircraftPhysicsPartialFromUser(ap);
                    if (clipped && Object.keys(clipped).length) acPayload.aircraftPhysics = clipped;
                }
                mergeBodyEulerIntoAircraftRecord(acPayload);
                c.aircraft = acPayload;
            }
        } else {
            delete c.aircraft;
        }
        const glbEn = document.getElementById('obj-glb-interact-enable');
        if (glbEn && glbEn.checked) {
            const clipEl = document.getElementById('obj-glb-interact-clip');
            const clipName = clipEl && clipEl.value ? String(clipEl.value).trim() : '';
            if (clipName) {
                const accEl = document.getElementById('obj-glb-interact-access');
                const labelRaw = (document.getElementById('obj-glb-interact-label').value || '').trim();
                c.glbInteract = {
                    clipName,
                    radius: parseFloat(document.getElementById('obj-glb-interact-radius').value) || 3,
                    label: labelRaw,
                    access: accEl && accEl.value ? accEl.value : 'public'
                };
            } else {
                delete c.glbInteract;
            }
        } else {
            delete c.glbInteract;
        }
        const pfmLod = String(c.prefabManifest || '').trim();
        if (pfmLod) {
            const sel = document.getElementById('obj-lod-id');
            const lid = sel && sel.value ? String(sel.value).trim() : '';
            if (lid) {
                c.lodId = lid;
                const drEl = document.getElementById('obj-lod-rank-default');
                const dr = drEl ? parseInt(drEl.value, 10) : 1;
                c.lodRank = Number.isFinite(dr) && dr > 0 ? dr : 1;
                const tbody = document.getElementById('obj-lod-part-tbody');
                const partRanks = {};
                /** @type {number[]} */
                const lodRanks = [];
                if (tbody) {
                    tbody.querySelectorAll('tr[data-part-path]').forEach((row) => {
                        const path = row.getAttribute('data-part-path');
                        const inp = row.querySelector('input[data-part-rank]');
                        if (!path || !inp) return;
                        const r = parseInt(inp.value, 10);
                        if (Number.isFinite(r) && r > 0) partRanks[path] = r;
                        lodRanks.push(Number.isFinite(r) && r > 0 ? r : c.lodRank);
                    });
                }
                if (Object.keys(partRanks).length) c.lodPartRanks = partRanks;
                else delete c.lodPartRanks;
                if (lodRanks.length) c.lodRanks = lodRanks;
                else delete c.lodRanks;
            } else {
                delete c.lodId;
                delete c.lodRank;
                delete c.lodPartRanks;
                delete c.lodRanks;
            }
            renderWorldLodPanel();
        }
    } else if (selectedObject.userData.pdfConfig) {
        if (document.getElementById('obj-teleporter').checked) {
            const accessEl = document.getElementById('obj-tp-access');
            const accessVal = accessEl && accessEl.value ? accessEl.value : 'public';
            const autoTeleportEl = document.getElementById('obj-tp-auto-teleport');
            const autoTeleport = !!(autoTeleportEl && autoTeleportEl.checked);
            const autoContactTeleportEl = document.getElementById('obj-tp-auto-contact-teleport');
            const autoTeleportOnContact = !!(autoContactTeleportEl && autoContactTeleportEl.checked);
            c.teleporter = {
                id: document.getElementById('obj-tp-id').value.trim() || 'tp1',
                destinationWorld: document.getElementById('obj-tp-dest').value || Object.keys(worlds)[0],
                radius: parseFloat(document.getElementById('obj-tp-radius').value) || 3,
                label: document.getElementById('obj-tp-label').value.trim() || '',
                access: accessVal,
                autoTeleport,
                autoTeleportOnContact
            };
        } else {
            delete c.teleporter;
        }
    }
    if (selectedObject.userData.config) {
        const cfg = selectedObject.userData.config;
        if (cfg.aircraft && cfg.aircraft.id) {
            const r = cfg.rotation || { x: 0, y: 0, z: 0 };
            selectedObject.rotation.set(
                (Number(r.x) || 0) * Math.PI / 180,
                (Number(r.y) || 0) * Math.PI / 180,
                (Number(r.z) || 0) * Math.PI / 180
            );
            applyAircraftBodyOrientationToObject3D(selectedObject, cfg.aircraft);
            selectedObject.updateMatrixWorld(true);
        }
    }
}

/** Prefab LOD: スライダー最大倍率（500%） */
const WORLD_LOD_MAX_RATIO = 5;

/**
 * LOD 境界スライダー上に表示する倍率ラベル（描画距離に対する倍）
 * @param {number} ratio
 * @returns {string}
 */
function formatWorldLodRatioLabel(ratio) {
    const r = Number(ratio);
    if (!Number.isFinite(r)) return '×—';
    return `×${r.toFixed(2)}`;
}

/** @type {{ lodId: string, index: number, thumbWrapEl: HTMLElement, trackEl: HTMLElement, valueTipEl?: HTMLElement }|null} */
let worldLodDragState = null;

let worldLodEditorInitialized = false;

/**
 * 選択中ワールドを返す（LOD UI 用）
 * @returns {Record<string, unknown>|null}
 */
function getSelectedWorldForLod() {
    return selectedWorldId && worlds[selectedWorldId] ? worlds[selectedWorldId] : null;
}

/**
 * world.lodSystem の骨格を保証する
 * @param {Record<string, unknown>|null|undefined} w
 */
function ensureWorldLodShape(w) {
    if (!w || typeof w !== 'object') return;
    if (!w.lodSystem || typeof w.lodSystem !== 'object') {
        w.lodSystem = { ids: [], thresholdsById: {} };
    }
    if (!Array.isArray(w.lodSystem.ids)) w.lodSystem.ids = [];
    if (!w.lodSystem.thresholdsById || typeof w.lodSystem.thresholdsById !== 'object') {
        w.lodSystem.thresholdsById = {};
    }
}

/**
 * 新規 LOD ID（ワールド内で重複しない短い名前）
 * @param {Record<string, unknown>} w
 * @returns {string}
 */
function generateUniqueLodId(w) {
    ensureWorldLodShape(w);
    const ids = w.lodSystem.ids;
    let n = ids.length + 1;
    let candidate = `lod-${n}`;
    while (ids.includes(candidate)) {
        n++;
        candidate = `lod-${n}`;
    }
    return candidate;
}

/**
 * LOD ID を変更し、しきい値・モデル参照を追従する
 * @param {Record<string, unknown>} w
 * @param {string} oldId
 * @param {string} rawNew
 */
function applyLodIdRename(w, oldId, rawNew) {
    let newId = String(rawNew || '').trim();
    if (!newId || newId === oldId) return;
    ensureWorldLodShape(w);
    const ids = w.lodSystem.ids;
    if (ids.includes(newId)) {
        const base = newId;
        let k = 2;
        while (ids.includes(newId)) {
            newId = `${base}-${k}`;
            k++;
        }
    }
    const ix = ids.indexOf(oldId);
    if (ix < 0) return;
    ids[ix] = newId;
    const tb = w.lodSystem.thresholdsById;
    if (tb && tb[oldId] !== undefined) {
        tb[newId] = tb[oldId];
        delete tb[oldId];
    }
    editGroup.children.forEach((ch) => {
        const cfg = ch.userData && ch.userData.config;
        if (cfg && String(cfg.lodId || '').trim() === oldId) cfg.lodId = newId;
    });
}

/**
 * LOD ID をワールドから削除し、参照する Prefab の lod フィールドを消す
 * @param {Record<string, unknown>} w
 * @param {string} id
 */
function deleteLodIdFromWorld(w, id) {
    ensureWorldLodShape(w);
    w.lodSystem.ids = w.lodSystem.ids.filter((x) => x !== id);
    delete w.lodSystem.thresholdsById[id];
    editGroup.children.forEach((ch) => {
        const cfg = ch.userData && ch.userData.config;
        if (cfg && String(cfg.lodId || '').trim() === id) {
            delete cfg.lodId;
            delete cfg.lodRank;
            delete cfg.lodPartRanks;
            delete cfg.lodRanks;
        }
    });
}

/**
 * ワールド設定パネルの LOD UI を描画する
 */
function renderWorldLodPanel() {
    const w = getSelectedWorldForLod();
    const container = document.getElementById('world-lod-entries');
    if (!container) return;
    if (!w) {
        container.innerHTML = '';
        return;
    }
    ensureWorldLodShape(w);
    const ls = w.lodSystem;
    container.innerHTML = '';

    for (const id of ls.ids) {
        if (!ls.thresholdsById[id] || !Array.isArray(ls.thresholdsById[id]) || ls.thresholdsById[id].length === 0) {
            ls.thresholdsById[id] = [1, 2];
        }
        const ratios = ls.thresholdsById[id];
        const numBands = ratios.length + 1;

        const item = document.createElement('div');
        item.className = 'world-lod-item';
        item.dataset.lodId = id;

        const header = document.createElement('div');
        header.className = 'world-lod-item-header';
        const lab = document.createElement('label');
        lab.className = 'prop-label';
        lab.textContent = 'LOD ID';
        const idInput = document.createElement('input');
        idInput.type = 'text';
        idInput.className = 'prop-input';
        idInput.value = id;
        idInput.setAttribute('data-role', 'lod-id-input');
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '削除';
        delBtn.className = 'btn btn-sm btn-outline-secondary';
        delBtn.setAttribute('data-role', 'lod-delete');
        header.appendChild(lab);
        header.appendChild(idInput);
        header.appendChild(delBtn);

        const bandsHint = document.createElement('p');
        bandsHint.className = 'hint';
        bandsHint.textContent = `ランク段数: ${numBands}（境界 ${ratios.length} 個）。ノブ下の数字がトグル番号（1番・2番…）。小さな表記はランクの区切り。`;

        const trackWrap = document.createElement('div');
        trackWrap.className = 'world-lod-track-wrap';
        const trackLab = document.createElement('div');
        trackLab.className = 'world-lod-track-label';
        trackLab.textContent = '距離境界（描画距離 × 倍率）';
        const track = document.createElement('div');
        track.className = 'world-lod-track';
        track.setAttribute('data-role', 'lod-track');
        const rail = document.createElement('div');
        rail.className = 'world-lod-track-rail';
        rail.setAttribute('aria-hidden', 'true');
        track.appendChild(rail);
        ratios.forEach((ratio, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'world-lod-thumb-wrap';
            const r = Math.min(WORLD_LOD_MAX_RATIO, Math.max(0.05, Number(ratio) || 1));
            const pct = (r / WORLD_LOD_MAX_RATIO) * 100;
            wrap.style.left = `${pct}%`;
            const valueTip = document.createElement('span');
            valueTip.className = 'world-lod-thumb-value-tip';
            valueTip.setAttribute('aria-hidden', 'true');
            valueTip.textContent = formatWorldLodRatioLabel(r);
            const thumb = document.createElement('div');
            thumb.className = 'world-lod-thumb';
            thumb.dataset.thumbIndex = String(idx);
            thumb.title = `トグル ${idx + 1}：ランク ${idx + 1} と ${idx + 2} の境界`;
            const labelNum = document.createElement('span');
            labelNum.className = 'world-lod-thumb-label';
            labelNum.textContent = String(idx + 1);
            const labelSub = document.createElement('span');
            labelSub.className = 'world-lod-thumb-sublabel';
            labelSub.textContent = `${idx + 1}–${idx + 2}`;
            wrap.appendChild(valueTip);
            wrap.appendChild(thumb);
            wrap.appendChild(labelNum);
            wrap.appendChild(labelSub);
            track.appendChild(wrap);
        });
        const ticks = document.createElement('div');
        ticks.className = 'world-lod-track-ticks';
        ticks.innerHTML = '<span>0%</span><span>100%</span><span>200%</span><span>300%</span><span>400%</span><span>500%</span>';

        trackWrap.appendChild(trackLab);
        trackWrap.appendChild(track);
        trackWrap.appendChild(ticks);

        const addBoundaryBtn = document.createElement('button');
        addBoundaryBtn.type = 'button';
        addBoundaryBtn.className = 'btn btn-sm btn-outline-secondary';
        addBoundaryBtn.style.marginTop = '6px';
        addBoundaryBtn.textContent = '境界を追加（ランク +1）';
        addBoundaryBtn.addEventListener('click', () => {
            const last = ratios[ratios.length - 1] || 1;
            ratios.push(Math.min(WORLD_LOD_MAX_RATIO, last + 0.5));
            renderWorldLodPanel();
        });

        const prefList = document.createElement('div');
        prefList.className = 'world-lod-prefab-list';
        const subT = document.createElement('strong');
        subT.textContent = 'この LOD ID を使用している Prefab';
        prefList.appendChild(subT);
        editGroup.children.forEach((ch) => {
            const cfg = ch.userData && ch.userData.config;
            if (!cfg || !String(cfg.prefabManifest || '').trim()) return;
            if (String(cfg.lodId || '').trim() !== id) return;
            const nm = ch.userData.prefabDisplayName || (cfg.prefabManifest || '').split('/').pop() || 'Prefab';
            const row = document.createElement('div');
            row.className = 'world-lod-prefab-row';
            const span = document.createElement('span');
            span.textContent = nm;
            const rankLab = document.createElement('label');
            rankLab.textContent = 'ランク';
            const rankInp = document.createElement('input');
            rankInp.type = 'number';
            rankInp.min = '1';
            rankInp.step = '1';
            rankInp.className = 'prop-input num';
            rankInp.value = String(Number.isFinite(cfg.lodRank) ? cfg.lodRank : 1);
            rankInp.addEventListener('change', () => {
                let r = parseInt(rankInp.value, 10);
                if (!Number.isFinite(r) || r < 1) r = 1;
                r = Math.min(numBands, r);
                cfg.lodRank = r;
                /** @type {number[]} */
                const ranksByChild = [];
                ch.children.forEach((part) => {
                    if (part.userData && part.userData.isPrefabPart) ranksByChild.push(r);
                });
                if (ranksByChild.length) cfg.lodRanks = ranksByChild;
                else delete cfg.lodRanks;
                ch.traverse((part) => {
                    if (part.userData && part.userData.isPrefabPart && part.userData.prefabPartPath) {
                        if (!cfg.lodPartRanks) cfg.lodPartRanks = {};
                        cfg.lodPartRanks[part.userData.prefabPartPath] = r;
                    }
                });
                if (selectedObject === ch) updateObjectPanel(ch);
            });
            row.appendChild(span);
            row.appendChild(rankLab);
            row.appendChild(rankInp);
            prefList.appendChild(row);
        });

        item.appendChild(header);
        item.appendChild(bandsHint);
        item.appendChild(trackWrap);
        item.appendChild(addBoundaryBtn);
        item.appendChild(prefList);
        container.appendChild(item);
    }
}

/**
 * @param {Event} e
 */
function onWorldLodMouseMove(e) {
    if (!worldLodDragState) return;
    const w = getSelectedWorldForLod();
    if (!w) return;
    const ls = w.lodSystem;
    const ratios = ls.thresholdsById[worldLodDragState.lodId];
    if (!Array.isArray(ratios)) return;
    const track = worldLodDragState.trackEl;
    const rect = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    let ratio = (x / Math.max(1e-6, rect.width)) * WORLD_LOD_MAX_RATIO;
    const i = worldLodDragState.index;
    const minB = i === 0 ? 0.05 : ratios[i - 1] + 0.05;
    const maxB = i === ratios.length - 1 ? WORLD_LOD_MAX_RATIO - 0.05 : ratios[i + 1] - 0.05;
    ratio = Math.max(minB, Math.min(maxB, ratio));
    ratios[i] = ratio;
    worldLodDragState.thumbWrapEl.style.left = `${(ratio / WORLD_LOD_MAX_RATIO) * 100}%`;
    if (worldLodDragState.valueTipEl) {
        worldLodDragState.valueTipEl.textContent = formatWorldLodRatioLabel(ratio);
    }
}

function onWorldLodMouseUp() {
    if (worldLodDragState && worldLodDragState.valueTipEl) {
        worldLodDragState.valueTipEl.style.display = 'none';
    }
    worldLodDragState = null;
}

/**
 * LOD パネル用のグローバルイベント（1 回だけ登録）
 */
function bindWorldLodEditorEvents() {
    if (worldLodEditorInitialized) return;
    worldLodEditorInitialized = true;
    document.getElementById('btn-world-lod-add-id')?.addEventListener('click', () => {
        const w = getSelectedWorldForLod();
        if (!w) return;
        const id = generateUniqueLodId(w);
        w.lodSystem.ids.push(id);
        w.lodSystem.thresholdsById[id] = [1, 2];
        renderWorldLodPanel();
    });

    const entries = document.getElementById('world-lod-entries');
    if (entries) {
        entries.addEventListener('click', (e) => {
            const delBtn = e.target.closest('[data-role="lod-delete"]');
            if (!delBtn) return;
            const item = delBtn.closest('.world-lod-item');
            const id = item && item.dataset.lodId;
            const w = getSelectedWorldForLod();
            if (!id || !w) return;
            deleteLodIdFromWorld(w, id);
            renderWorldLodPanel();
            if (selectedObject && selectedObject.userData.config) updateObjectPanel(selectedObject);
        });
        entries.addEventListener('change', (e) => {
            const inp = e.target.closest('[data-role="lod-id-input"]');
            if (!inp) return;
            const item = inp.closest('.world-lod-item');
            const oldId = item && item.dataset.lodId;
            const w = getSelectedWorldForLod();
            if (!oldId || !w) return;
            applyLodIdRename(w, oldId, inp.value);
            renderWorldLodPanel();
            if (selectedObject && selectedObject.userData.config) updateObjectPanel(selectedObject);
        });
        entries.addEventListener('mousedown', (e) => {
            const thumbWrap = e.target.closest('.world-lod-thumb-wrap');
            if (!thumbWrap) return;
            const thumb = thumbWrap.querySelector('.world-lod-thumb');
            if (!thumb) return;
            e.preventDefault();
            const item = thumbWrap.closest('.world-lod-item');
            const lodId = item && item.dataset.lodId;
            const w = getSelectedWorldForLod();
            if (!lodId || !w) return;
            const track = item.querySelector('[data-role="lod-track"]');
            if (!track) return;
            const idx = parseInt(thumb.dataset.thumbIndex, 10);
            const ratios = w.lodSystem.thresholdsById[lodId];
            if (!Array.isArray(ratios) || !Number.isFinite(idx)) return;
            const valueTipEl = thumbWrap.querySelector('.world-lod-thumb-value-tip');
            if (valueTipEl) {
                valueTipEl.textContent = formatWorldLodRatioLabel(ratios[idx]);
                valueTipEl.style.display = 'block';
            }
            worldLodDragState = { lodId, index: idx, thumbWrapEl: thumbWrap, trackEl: track, valueTipEl };
        });
    }

    document.addEventListener('mousemove', onWorldLodMouseMove);
    document.addEventListener('mouseup', onWorldLodMouseUp);
}

/**
 * Prefab 用 LOD オブジェクトパネルを埋める
 * @param {import('three').Object3D} obj
 * @param {Record<string, unknown>} c
 */
function fillObjectLodPanel(obj, c) {
    const sel = document.getElementById('obj-lod-id');
    if (!sel) return;
    const w = getSelectedWorldForLod();
    if (w) ensureWorldLodShape(w);
    const ids = w && w.lodSystem ? w.lodSystem.ids : [];
    sel.innerHTML = '<option value="">（未設定・距離 LOD なし）</option>';
    ids.forEach((id) => {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id;
        sel.appendChild(o);
    });
    const cur = String(c.lodId || '').trim();
    if (cur && ids.includes(cur)) sel.value = cur;
    else sel.value = '';

    const drEl = document.getElementById('obj-lod-rank-default');
    if (drEl) drEl.value = String(Number.isFinite(c.lodRank) ? c.lodRank : 1);

    const tbody = document.getElementById('obj-lod-part-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const map = c.lodPartRanks && typeof c.lodPartRanks === 'object' ? c.lodPartRanks : {};
    const defR = Number.isFinite(c.lodRank) ? c.lodRank : 1;
    const lodArr = Array.isArray(c.lodRanks) && c.lodRanks.length ? c.lodRanks : null;
    let partIdx = 0;
    for (const ch of obj.children) {
        if (!ch.userData || !ch.userData.isPrefabPart || !ch.userData.prefabPartPath) continue;
        const path = ch.userData.prefabPartPath;
        const tr = document.createElement('tr');
        tr.dataset.partPath = path;
        const td1 = document.createElement('td');
        td1.textContent = path.split('/').pop() || path;
        td1.title = path;
        const td2 = document.createElement('td');
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '1';
        inp.step = '1';
        inp.setAttribute('data-part-rank', '1');
        let r;
        if (lodArr) {
            r = partIdx < lodArr.length ? lodArr[partIdx] : lodArr[lodArr.length - 1];
            r = Number(r);
        } else {
            r = map[path];
        }
        inp.value = String(Number.isFinite(r) ? r : defR);
        inp.addEventListener('change', () => syncObjectFromPanel());
        td2.appendChild(inp);
        tr.appendChild(td1);
        tr.appendChild(td2);
        tbody.appendChild(tr);
        partIdx++;
    }
}

function buildWorldsFromScene() {
    const out = {};
    for (const wid of Object.keys(worlds)) {
        const w = worlds[wid];
        out[wid] = {
            id: w.id,
            name: w.name,
            models: w.models ? [...w.models] : [],
            spawnPoint: w.spawnPoint ? { ...w.spawnPoint } : { x: 0, y: 10, z: 0 },
            lights: w.lights ? w.lights.map((l) => ({ ...l })) : [],
            pdfs: w.pdfs ? w.pdfs.map((p) => ({ ...p })) : [],
            vdbs: [],
            floorEnabled: wid === selectedWorldId ? document.getElementById('floor-enabled').checked : (w.floorEnabled !== false),
            floorWidth: wid === selectedWorldId
                ? (parseFloat(document.getElementById('floor-width')?.value) || DEFAULT_FLOOR_WIDTH_M)
                : normalizedFloorDimensions(w).fw,
            floorDepth: wid === selectedWorldId
                ? (parseFloat(document.getElementById('floor-depth')?.value) || DEFAULT_FLOOR_DEPTH_M)
                : normalizedFloorDimensions(w).fd
        };
        if (wid !== selectedWorldId && w.physicsAssist && typeof w.physicsAssist === 'object') {
            const src = w.physicsAssist;
            out[wid].physicsAssist = {
                enabled: src.enabled === true,
                ...(Number.isFinite(src.minFeetY) ? { minFeetY: src.minFeetY } : {}),
                ...(Number.isFinite(src.maxFeetY) ? { maxFeetY: src.maxFeetY } : {})
            };
        }
        if (wid !== selectedWorldId && w.aircraftPhysics && typeof w.aircraftPhysics === 'object' && !Array.isArray(w.aircraftPhysics)) {
            out[wid].aircraftPhysics = { ...mergeAircraftPhysicsFromWorld(w.aircraftPhysics) };
        }
        if (wid !== selectedWorldId && w.lodSystem && typeof w.lodSystem === 'object') {
            out[wid].lodSystem = {
                ids: Array.isArray(w.lodSystem.ids) ? w.lodSystem.ids.slice() : [],
                thresholdsById:
                    w.lodSystem.thresholdsById && typeof w.lodSystem.thresholdsById === 'object'
                        ? JSON.parse(JSON.stringify(w.lodSystem.thresholdsById))
                        : {}
            };
        }
    }
    if (selectedWorldId) {
        const w = out[selectedWorldId];
        if (w) {
            w.models = [];
            w.lights = [];
            w.pdfs = [];
            editGroup.children.forEach((child) => {
                if (child.userData.config && !child.isLight) {
                    const c = { ...child.userData.config };
                    c.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                    c.rotation = {
                        x: child.rotation.x * 180 / Math.PI,
                        y: child.rotation.y * 180 / Math.PI,
                        z: child.rotation.z * 180 / Math.PI
                    };
                    c.scale = { x: child.scale.x, y: child.scale.y, z: child.scale.z };
                    if (c.animate) c.animate = { ...c.animate, rotation: c.animate.rotation ? { ...c.animate.rotation } : {} };
                    if (c.teleporter) c.teleporter = { ...c.teleporter };
                    if (c.taiko) c.taiko = { ...c.taiko };
                    if (c.aircraft) {
                        const ser = serializeAircraftForWorldJson(c.aircraft);
                        if (ser) c.aircraft = ser;
                        else delete c.aircraft;
                    }
                    if (c.glbInteract) c.glbInteract = { ...c.glbInteract };
                    delete c.chunkManifest;
                    if (!isObjPath(c.path || '')) delete c.mtlPath;
                    const hasPfm = !!String(c.prefabManifest || '').trim();
                    if (!hasPfm) {
                        delete c.prefabManifest;
                        delete c.prefabGroupId;
                    }
                    if (!String(c.path || '').trim() && hasPfm) {
                        c.path = c.prefabManifest;
                    }
                    if (!String(c.path || '').trim() && !hasPfm) delete c.path;
                    if (hasPfm) {
                        const lid = String(c.lodId || '').trim();
                        if (lid) {
                            c.lodId = lid;
                            if (Number.isFinite(c.lodRank)) c.lodRank = Math.max(1, Math.floor(c.lodRank));
                            if (c.lodPartRanks && typeof c.lodPartRanks === 'object') {
                                c.lodPartRanks = { ...c.lodPartRanks };
                            }
                            if (Array.isArray(c.lodRanks) && c.lodRanks.length) {
                                c.lodRanks = c.lodRanks.map((x) => Math.max(1, Math.floor(Number(x))));
                            }
                        } else {
                            delete c.lodId;
                            delete c.lodRank;
                            delete c.lodPartRanks;
                            delete c.lodRanks;
                        }
                    }
                    w.models.push(c);
                }
                if (child.isLight && child.userData.lightConfig && (child.type === 'AmbientLight' || child.type === 'DirectionalLight')) {
                    const cfg = { ...child.userData.lightConfig };
                    cfg.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                    w.lights.push(cfg);
                }
                if (child.isMesh && child.userData.lightRef && child.userData.lightConfig) {
                    const cfg = { ...child.userData.lightConfig };
                    cfg.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                    w.lights.push(cfg);
                }
                if (child.isMesh && child.userData.pdfConfig) {
                    const p = { ...child.userData.pdfConfig };
                    p.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                    p.rotation = { x: child.rotation.x * 180 / Math.PI, y: child.rotation.y * 180 / Math.PI, z: child.rotation.z * 180 / Math.PI };
                    p.scale = { x: child.scale.x, y: child.scale.y, z: child.scale.z };
                    w.pdfs.push(p);
                }
            });
            w.spawnPoint = {
                x: parseFloat(document.getElementById('spawn-x').value) || 0,
                y: parseFloat(document.getElementById('spawn-y').value) || 10,
                z: parseFloat(document.getElementById('spawn-z').value) || 0
            };
            w.floorEnabled = document.getElementById('floor-enabled').checked;
            w.floorWidth = parseFloat(document.getElementById('floor-width')?.value) || DEFAULT_FLOOR_WIDTH_M;
            w.floorDepth = parseFloat(document.getElementById('floor-depth')?.value) || DEFAULT_FLOOR_DEPTH_M;
            const paEn = document.getElementById('physics-assist-enabled')?.checked;
            const minRaw = document.getElementById('physics-assist-min-y')?.value?.trim() ?? '';
            const maxRaw = document.getElementById('physics-assist-max-y')?.value?.trim() ?? '';
            if (paEn) {
                w.physicsAssist = { enabled: true };
                if (minRaw !== '') {
                    const n = parseFloat(minRaw);
                    if (Number.isFinite(n)) w.physicsAssist.minFeetY = n;
                }
                if (maxRaw !== '') {
                    const n = parseFloat(maxRaw);
                    if (Number.isFinite(n)) w.physicsAssist.maxFeetY = n;
                }
            } else {
                delete w.physicsAssist;
            }
            const srcLod = worlds[selectedWorldId] && worlds[selectedWorldId].lodSystem;
            if (srcLod && typeof srcLod === 'object') {
                w.lodSystem = {
                    ids: Array.isArray(srcLod.ids) ? srcLod.ids.slice() : [],
                    thresholdsById:
                        srcLod.thresholdsById && typeof srcLod.thresholdsById === 'object'
                            ? JSON.parse(JSON.stringify(srcLod.thresholdsById))
                            : {}
                };
            }
        }
    }
    normalizeWorldsLod(out);
    return out;
}

/**
 * 保存した worlds JSON をメモリと3Dシーンに反映する
 * @param {Record<string, unknown>} parsed
 */
async function applyWorldsStateFromJson(parsed) {
    worlds = JSON.parse(JSON.stringify(parsed));
    renderWorldList();
    populateDestWorldSelect();
    const ids = Object.keys(worlds);
    if (!ids.length) {
        syncSelectWorldChrome(null);
        setWorldEditLoader(true, 'JSONを反映しています…');
        try {
            await loadWorldIntoScene(EMPTY_EDITOR_WORLD);
        } finally {
            setWorldEditLoader(false);
        }
        writeWorldEditCache();
        return;
    }
    const nextId = (selectedWorldId && worlds[selectedWorldId]) ? selectedWorldId : ids[0];
    await selectWorld(nextId);
    writeWorldEditCache();
}

/**
 * 選択ワールドのリスト・名前行のみ更新（シーン読み込みは別途 await loadWorldIntoScene）
 * @param {string|null} id
 */
function syncSelectWorldChrome(id) {
    selectedWorldId = id;
    renderWorldList();
    const w = id ? worlds[id] : null;
    if (w) {
        document.getElementById('world-name-row').style.display = '';
        document.getElementById('world-name').value = w.name || id;
    } else {
        document.getElementById('world-name-row').style.display = 'none';
    }
    document.getElementById('btn-delete-world').disabled = !id;
    populateDestWorldSelect();
}

/**
 * スポーンYと物理補助下限の乖離が大きいときだけヒントを表示する
 */
function updatePhysicsAssistSpawnHint() {
    const hint = document.getElementById('physics-assist-spawn-hint');
    if (!hint) return;
    const spawnEl = document.getElementById('spawn-y');
    const minEl = document.getElementById('physics-assist-min-y');
    const enEl = document.getElementById('physics-assist-enabled');
    if (!spawnEl || !minEl || !enEl) return;
    const spawnY = parseFloat(spawnEl.value);
    const minY = parseFloat(minEl.value);
    if (!enEl.checked || !Number.isFinite(minY) || !Number.isFinite(spawnY)) {
        hint.hidden = true;
        return;
    }
    hint.hidden = Math.abs(spawnY - minY) <= 20;
}

/**
 * worlds[].lights の1要素と同じ形式で editGroup にライトを追加する（loadWorldIntoScene / 貼り付け共用）
 * @param {object} cfg
 * @returns {THREE.Object3D|null} Transform で選択するオブジェクト（point/spot はヘルパーメッシュ）
 */
function appendWorldLightToEditGroup(cfg) {
    if (!cfg || !cfg.type) return null;
    const color = cfg.color !== undefined ? cfg.color : 0xffffff;
    const intensity = cfg.intensity !== undefined ? cfg.intensity : 1;
    let light;
    if (cfg.type === 'ambient') {
        light = new THREE.AmbientLight(color, intensity);
        light.position.set(0, 0, 0);
        light.userData.lightConfig = { type: 'ambient', intensity, color };
        editGroup.add(light);
        lightHelpers.push({ light, mesh: null });
        return light;
    }
    if (cfg.type === 'directional') {
        light = new THREE.DirectionalLight(color, intensity);
        if (cfg.position) light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
        if (cfg.castShadow) { light.castShadow = true; }
        light.userData.lightConfig = { type: 'directional', intensity, color, position: cfg.position ? { ...cfg.position } : { x: 50, y: 100, z: 50 }, castShadow: !!cfg.castShadow };
        editGroup.add(light);
        lightHelpers.push({ light, mesh: null });
        return light;
    }
    if (cfg.type === 'point') {
        light = new THREE.PointLight(color, intensity, cfg.distance ?? 0, 2);
        const pos = cfg.position || { x: 0, y: 5, z: 0 };
        light.position.set(pos.x, pos.y, pos.z);
        light.userData.lightConfig = { type: 'point', intensity, color, distance: cfg.distance ?? 50 };
        editGroup.add(light);
        const geom = new THREE.SphereGeometry(0.5, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.6 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.copy(light.position);
        mesh.userData.lightRef = light;
        mesh.userData.lightConfig = { type: 'point', intensity, color, distance: cfg.distance ?? 50 };
        editGroup.add(mesh);
        lightHelpers.push({ light, mesh });
        return mesh;
    }
    if (cfg.type === 'spot') {
        light = new THREE.SpotLight(color, intensity, cfg.distance ?? 0, Math.PI / 6, 0, 2);
        if (cfg.position) light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
        light.userData.lightConfig = { type: 'spot', intensity, color, position: cfg.position ? { ...cfg.position } : { x: 0, y: 10, z: 0 }, distance: cfg.distance ?? 50 };
        editGroup.add(light);
        const geom = new THREE.SphereGeometry(0.4, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.6 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.copy(light.position);
        mesh.userData.lightRef = light;
        mesh.userData.lightConfig = light.userData.lightConfig;
        editGroup.add(mesh);
        lightHelpers.push({ light, mesh });
        return mesh;
    }
    return null;
}

/** 管理画面ワールド読込時の同時モデル数（クライアント本番の SceneManager とは別上限） */
const ADMIN_WORLD_MODEL_LOAD_CONCURRENCY = 16;

/**
 * 工場を最大 concurrency 本で同時実行し、結果を入力順の配列で返す
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
 * ワールド models[i] の cfg を組み立て、モデルを1件ロードする（失敗は err で返す）
 * @param {object} config
 * @param {number} idx
 * @returns {Promise<{ idx: number, skip?: true, model?: import('three').Object3D, triangleCount?: number, cfgBase?: object, err?: string }>}
 */
async function loadWorldModelEntryForEditor(config, idx) {
    const path = config.path || '';
    const pfm = String(config.prefabManifest || '').trim();
    const pos = config.position || { x: 0, y: 0, z: 0 };
    const rot = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 1, y: 1, z: 1 };
    const cfgBase = {
        position: { ...pos },
        rotation: { ...rot },
        scale: { ...scale },
        animate: config.animate ? { ...config.animate } : undefined,
        teleporter: config.teleporter ? { ...config.teleporter } : undefined,
        taiko: config.taiko ? { ...config.taiko } : undefined
    };
    if (String(path).trim()) cfgBase.path = path;
    if (pfm) {
        cfgBase.prefabManifest = pfm;
        if (String(config.prefabGroupId || '').trim()) cfgBase.prefabGroupId = String(config.prefabGroupId).trim();
        if (String(config.lodId || '').trim()) cfgBase.lodId = String(config.lodId).trim();
        if (Number.isFinite(config.lodRank)) cfgBase.lodRank = Math.max(1, Math.floor(config.lodRank));
        if (config.lodPartRanks && typeof config.lodPartRanks === 'object' && !Array.isArray(config.lodPartRanks)) {
            cfgBase.lodPartRanks = { ...config.lodPartRanks };
        }
        if (Array.isArray(config.lodRanks) && config.lodRanks.length) {
            cfgBase.lodRanks = config.lodRanks.map((x) => Math.max(1, Math.floor(Number(x))));
        }
    }
    if (config.aircraft && config.aircraft.id) {
        const ser = serializeAircraftForWorldJson(config.aircraft);
        if (ser) cfgBase.aircraft = ser;
    }
    if (isObjPath(path) && config.mtlPath) {
        cfgBase.mtlPath = config.mtlPath;
    }
    if (!pfm && !String(path || '').trim()) {
        return { idx, skip: true };
    }
    try {
        let model;
        let triangleCount;
        if (pfm) {
            const res = await loadModelFromConfig({
                prefabManifest: pfm,
                path: String(path || '').trim() || pfm
            });
            model = res.model;
            triangleCount = res.triangleCount;
        } else {
            const res = await loadModelFromConfig({
                path,
                mtlPath: isObjPath(path) ? (config.mtlPath || '') : ''
            });
            model = res.model;
            triangleCount = res.triangleCount;
        }
        return { idx, model, triangleCount, cfgBase };
    } catch (err) {
        console.error('Load model failed:', pfm || path, err);
        return { idx, err: err.message || String(err) };
    }
}

/**
 * ワールド設定をシーンに適用する（3D モデルは最大 16 件ずつバッチ並列で読み込み。GET /models/* は既存の Service Worker により Stale-While-Revalidate される）
 * @param {object} world
 * @returns {Promise<void>}
 */
async function loadWorldIntoScene(world) {
    ensureWorldLodShape(world);
    while (editGroup.children.length) {
        const c = editGroup.children[0];
        editGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
            else c.material.dispose();
        }
    }
    lightHelpers = [];
    selectedObject = null;
    transformControls.detach();
    document.getElementById('object-hint').style.display = 'block';
    document.getElementById('object-props').style.display = 'none';

    const lights = world.lights || [];
    lights.forEach((lc) => {
        appendWorldLightToEditGroup(lc);
    });

    const pdfs = world.pdfs || [];
    pdfs.forEach((config) => {
        const path = config.path || '';
        const pos = config.position || { x: 0, y: 2, z: -5 };
        const rot = config.rotation || { x: 0, y: 0, z: 0 };
        const scale = config.scale || { x: 2, y: 2.8, z: 1 };
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
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
        mesh.scale.set(scale.x, scale.y, scale.z);
        mesh.userData.pdfConfig = { path, position: { ...pos }, rotation: { ...rot }, scale: { ...scale }, teleporter: config.teleporter ? { ...config.teleporter } : undefined };
        editGroup.add(mesh);
        loadPdfTextureForMesh(mesh, path).catch(() => {});
    });

    document.getElementById('spawn-x').value = (world.spawnPoint && world.spawnPoint.x) ?? 0;
    document.getElementById('spawn-y').value = (world.spawnPoint && world.spawnPoint.y) ?? 10;
    document.getElementById('spawn-z').value = (world.spawnPoint && world.spawnPoint.z) ?? 0;
    const floorEl = document.getElementById('floor-enabled');
    if (floorEl) floorEl.checked = world.floorEnabled !== false;
    const { fw, fd } = normalizedFloorDimensions(world);
    const floorWEl = document.getElementById('floor-width');
    const floorDEl = document.getElementById('floor-depth');
    if (floorWEl) floorWEl.value = String(fw);
    if (floorDEl) floorDEl.value = String(fd);
    applyEditorFloorMeshFromWorld(world);

    const paEn = document.getElementById('physics-assist-enabled');
    const paMin = document.getElementById('physics-assist-min-y');
    const paMax = document.getElementById('physics-assist-max-y');
    const pa = world.physicsAssist;
    if (paEn && paMin && paMax) {
        if (pa && pa.enabled === true) {
            paEn.checked = true;
            paMin.value = Number.isFinite(pa.minFeetY) ? String(pa.minFeetY) : '';
            paMax.value = Number.isFinite(pa.maxFeetY) ? String(pa.maxFeetY) : '';
        } else {
            paEn.checked = false;
            paMin.value = '';
            paMax.value = '';
        }
    }
    updatePhysicsAssistSpawnHint();

    const models = world.models || [];
    const factories = models.map((config, idx) => () => loadWorldModelEntryForEditor(config, idx));
    const slots = await runWithConcurrency(ADMIN_WORLD_MODEL_LOAD_CONCURRENCY, factories);
    const errs = [];
    for (const slot of slots) {
        if (!slot || slot.skip) continue;
        if (slot.err) {
            errs.push(slot.err);
            continue;
        }
        const { model, triangleCount, cfgBase, idx: slotIdx } = slot;
        const pos = cfgBase.position || { x: 0, y: 0, z: 0 };
        const rot = cfgBase.rotation || { x: 0, y: 0, z: 0 };
        const scale = cfgBase.scale || { x: 1, y: 1, z: 1 };
        model.position.set(pos.x, pos.y, pos.z);
        model.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
        model.scale.set(scale.x, scale.y, scale.z);
        if (cfgBase.aircraft && cfgBase.aircraft.id) {
            applyAircraftBodyOrientationToObject3D(model, cfgBase.aircraft);
        }
        applyModelShadowByTriangleCount(model, triangleCount);
        model.userData.editId = 'm' + slotIdx;
        model.userData.config = cfgBase;
        editGroup.add(model);
    }
    if (errs.length) {
        const el = document.getElementById('save-status');
        if (el) {
            el.textContent = errs.join(' ');
            el.className = 'error';
        }
    }
    const wCur = getSelectedWorldForLod();
    if (wCur) ensureWorldLodShape(wCur);
    renderWorldObjectList();
    renderWorldLodPanel();
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    let dt = (now - editorAnimLastT) / 1000;
    editorAnimLastT = now;
    if (dt > 0.1) dt = 0.1;
    editorGltfPreviewMixers.forEach((m) => m.update(dt));
    lightHelpers.forEach(({ light, mesh }) => {
        if (mesh) light.position.copy(mesh.position);
    });
    if (transformControls.dragging) {
        if (selectedObject && selectedObject.userData.config) {
            const cfg = selectedObject.userData.config;
            selectedObject.userData.config.position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            if (cfg.aircraft && cfg.aircraft.id) {
                selectedObject.userData.config.rotation = extractConfigRotationDegFromModelWithAircraftBody(
                    selectedObject,
                    cfg.aircraft
                );
            } else {
                selectedObject.userData.config.rotation = {
                    x: selectedObject.rotation.x * 180 / Math.PI,
                    y: selectedObject.rotation.y * 180 / Math.PI,
                    z: selectedObject.rotation.z * 180 / Math.PI
                };
            }
            selectedObject.userData.config.scale = { x: selectedObject.scale.x, y: selectedObject.scale.y, z: selectedObject.scale.z };
        }
        if (selectedObject && selectedObject.userData.pdfConfig) {
            selectedObject.userData.pdfConfig.position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            selectedObject.userData.pdfConfig.rotation = { x: selectedObject.rotation.x * 180 / Math.PI, y: selectedObject.rotation.y * 180 / Math.PI, z: selectedObject.rotation.z * 180 / Math.PI };
            selectedObject.userData.pdfConfig.scale = { x: selectedObject.scale.x, y: selectedObject.scale.y, z: selectedObject.scale.z };
        }
    }
    controls.update();
    renderer.render(scene, camera);
}

// --- API ---

/** ワールド編集パネル用 localStorage キャッシュ（一覧の速い再表示・オフライン時のフォールバック用） */
const WORLD_EDIT_CACHE_STORAGE_KEY = 'metaverse-admin-world-edit-cache-v1';

/** シーンを空にするときのワールド断片 */
const EMPTY_EDITOR_WORLD = {
    models: [],
    lights: [],
    pdfs: [],
    spawnPoint: { x: 0, y: 10, z: 0 },
    floorEnabled: true,
    floorWidth: DEFAULT_FLOOR_WIDTH_M,
    floorDepth: DEFAULT_FLOOR_DEPTH_M,
    lodSystem: { ids: [], thresholdsById: {} }
};

/**
 * モデル読み込みなどの間、ワールド編集 UI 全体をブロックするオーバーレイ
 * @param {boolean} show
 * @param {string} [message]
 */
function setWorldEditLoader(show, message) {
    const ov = document.getElementById('world-edit-loading-overlay');
    if (!ov) return;
    const msgEl = ov.querySelector('.world-edit-loading-message');
    if (message != null && msgEl) msgEl.textContent = message;
    if (show) {
        ov.classList.add('show');
        ov.setAttribute('aria-hidden', 'false');
    } else {
        ov.classList.remove('show');
        ov.setAttribute('aria-hidden', 'true');
    }
}

/** @returns {{ v: number, savedAt: number, worlds: object, modelList: string[], mtlList: string[], pdfList: string[] }|null} */
function readWorldEditCache() {
    try {
        const raw = localStorage.getItem(WORLD_EDIT_CACHE_STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || data.v !== 1 || typeof data.worlds !== 'object' || data.worlds === null || Array.isArray(data.worlds)) {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

/** 現在の worlds / 一覧をストレージに保存する */
function writeWorldEditCache() {
    try {
        const payload = {
            v: 1,
            savedAt: Date.now(),
            worlds: JSON.parse(JSON.stringify(worlds)),
            modelList: modelList.slice(),
            prefabManifestList: prefabManifestList.slice(),
            mtlList: mtlList.slice(),
            pdfList: pdfList.slice()
        };
        localStorage.setItem(WORLD_EDIT_CACHE_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('[world-edit] cache write failed:', e);
    }
}

/**
 * キャッシュをメモリに適用する
 * @param {{ v?: number, worlds?: object, modelList?: string[], prefabManifestList?: string[], mtlList?: string[], pdfList?: string[] }} data
 * @returns {boolean}
 */
function applyWorldEditCacheToState(data) {
    if (!data || data.v !== 1) return false;
    if (typeof data.worlds !== 'object' || data.worlds === null || Array.isArray(data.worlds)) return false;
    worlds = JSON.parse(JSON.stringify(data.worlds));
    modelList = Array.isArray(data.modelList) ? data.modelList.slice() : [];
    prefabManifestList = Array.isArray(data.prefabManifestList) ? data.prefabManifestList.slice() : [];
    mtlList = Array.isArray(data.mtlList) ? data.mtlList.slice() : [];
    pdfList = Array.isArray(data.pdfList) ? data.pdfList.slice() : [];
    return true;
}

async function fetchWorlds() {
    const res = await fetch('/admin/worlds', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load worlds');
    worlds = await res.json();
}

async function fetchModels() {
    const res = await fetch('/admin/models', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load models');
    modelList = await res.json();
    try {
        const r2 = await fetch('/admin/prefab-manifests', { credentials: 'include' });
        if (r2.ok) {
            prefabManifestList = await r2.json();
        } else {
            prefabManifestList = [];
        }
    } catch {
        prefabManifestList = [];
    }
    try {
        const rPlane = await fetch('/admin/plane-prefab-manifests', { credentials: 'include' });
        if (rPlane.ok) {
            planePrefabManifestList = await rPlane.json();
            if (!Array.isArray(planePrefabManifestList)) planePrefabManifestList = [];
        } else {
            planePrefabManifestList = [];
        }
    } catch {
        planePrefabManifestList = [];
    }
    try {
        const ra = await fetch('/admin/addons/aircraft/airframes', { credentials: 'include' });
        if (ra.ok) {
            const ja = await ra.json();
            const rows = Array.isArray(ja.airframes) ? ja.airframes : [];
            aircraftLibraryList = rows
                .map((r) => ({
                    id: String(r.id || '').trim(),
                    displayName: String(r.displayName || r.id || ''),
                    prefabManifest: String(r.prefabManifest || '').trim(),
                }))
                .filter((x) => x.id && x.prefabManifest);
        } else {
            aircraftLibraryList = [];
        }
    } catch {
        aircraftLibraryList = [];
    }
    refreshAircraftLibrarySelectOptions();
}

async function fetchMtls() {
    const res = await fetch('/admin/model-mtls', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load MTL list');
    mtlList = await res.json();
}

async function fetchPdfs() {
    const res = await fetch('/admin/pdfs', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load PDFs');
    pdfList = await res.json();
}

/** マルチ太鼓用・譜面セレクトを /admin/charts から埋める */
async function refreshTaikoChartSelect(preserveChartId) {
    if (!worldEditorChartFeaturesEnabled) return;
    const sel = document.getElementById('obj-taiko-chart-id');
    if (!sel) return;
    const prev = preserveChartId != null ? preserveChartId : sel.value;
    sel.innerHTML = '';
    try {
        const res = await fetch('/admin/charts', { credentials: 'include' });
        if (!res.ok) throw new Error('fetch failed');
        const charts = await res.json();
        const ids = Object.keys(charts || {}).sort();
        ids.forEach((id) => {
            const opt = document.createElement('option');
            opt.value = id;
            const c = charts[id];
            opt.textContent = `${c && c.name ? c.name : id} (${id})`;
            sel.appendChild(opt);
        });
        if (prev && charts[prev]) sel.value = prev;
        else if (ids.length) sel.selectedIndex = 0;
    } catch (e) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（譜面を取得できません）';
        sel.appendChild(opt);
    }
}

function renderPdfList() {
    const el = document.getElementById('pdf-list');
    if (!el) return;
    el.innerHTML = '';
    pdfList.forEach((name) => {
        const path = 'pdfs/' + name;
        const div = document.createElement('div');
        div.className = 'item' + (selectedPdfPath === path ? ' selected' : '');
        div.textContent = name;
        div.dataset.path = path;
        div.addEventListener('click', () => {
            selectedPdfPath = path;
            renderPdfList();
            loadPdfPreview(path);
        });
        el.appendChild(div);
    });
}

function addPdf(path) {
    if (!selectedWorldId) return;
    pushUndo();
    const pos = { x: 0, y: 2, z: -5 };
    const rot = { x: 0, y: 0, z: 0 };
    const scale = { x: 2, y: 2.8, z: 1 };
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
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.userData.pdfConfig = { path, position: { ...pos }, rotation: { ...rot }, scale: { ...scale } };
    editGroup.add(mesh);
    renderWorldObjectList();
    loadPdfTextureForMesh(mesh, path).catch(() => {});
}

// --- UI ---

/**
 * オブジェクト一覧の「モデル」カテゴリ（prefab は親行＋折りたたみ子パーツ行。子クリックも親を選択）
 * @param {string} key
 * @param {THREE.Object3D[]} modelChildren
 * @param {number} startIndex worldObjectList 上の開始インデックス
 * @returns {HTMLDivElement}
 */
function createModelObjectListCategory(key, modelChildren, startIndex) {
    const wrap = document.createElement('div');
    wrap.className = 'object-list-category';
    wrap.dataset.category = key;

    const header = document.createElement('div');
    header.className = 'object-list-category-header';
    const isExpanded = objectListExpanded[key];
    header.innerHTML = `<span class="object-list-arrow">${isExpanded ? '▼' : '▶'}</span><span>モデル</span>`;
    header.addEventListener('click', (e) => {
        e.stopPropagation();
        objectListExpanded[key] = !objectListExpanded[key];
        renderWorldObjectList();
    });
    wrap.appendChild(header);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'object-list-children';
    childrenWrap.style.display = isExpanded ? '' : 'none';

    modelChildren.forEach((child, i) => {
        const idx = startIndex + i;
        const cfg = child.userData.config;
        const isPf = cfg && String(cfg.prefabManifest || '').trim();
        if (!isPf) {
            const div = document.createElement('div');
            div.className = 'item object-list-item' + (selectedObject === child ? ' selected' : '');
            div.dataset.index = String(idx);
            const path = (cfg && cfg.path) || '';
            const label = path.split('/').pop() || 'モデル';
            div.innerHTML = `<span title="${label}">${label}</span>`;
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                if (worldObjectList[idx]) selectObject(worldObjectList[idx]);
            });
            childrenWrap.appendChild(div);
            return;
        }
        const eid = String(child.userData.editId != null ? child.userData.editId : idx);
        const exKey = 'pf_' + eid;
        const subEx = objectListExpanded[exKey] === true;
        const displayName = child.userData.prefabDisplayName || (cfg.prefabManifest || '').split('/').pop() || 'Prefab';
        const block = document.createElement('div');
        block.className = 'object-list-prefab-block';
        const head = document.createElement('div');
        head.className = 'item object-list-item object-list-prefab-head' + (selectedObject === child ? ' selected' : '');
        const arr = document.createElement('span');
        arr.className = 'object-list-arrow';
        arr.textContent = subEx ? '▼' : '▶';
        arr.addEventListener('click', (e) => {
            e.stopPropagation();
            objectListExpanded[exKey] = !subEx;
            renderWorldObjectList();
        });
        const title = document.createElement('span');
        title.textContent = displayName;
        head.appendChild(arr);
        head.appendChild(title);
        head.addEventListener('click', (e) => {
            if (e.target === arr) return;
            e.stopPropagation();
            selectObject(child);
        });
        block.appendChild(head);
        const sub = document.createElement('div');
        sub.className = 'object-list-prefab-parts';
        sub.style.display = subEx ? '' : 'none';
        sub.style.paddingLeft = '1.25em';
        child.children.forEach((partRoot) => {
            if (!partRoot.userData || !partRoot.userData.isPrefabPart) return;
            const pl = (partRoot.userData.prefabPartPath || '').split('/').pop() || 'part';
            const pr = document.createElement('div');
            pr.className = 'item object-list-item object-list-prefab-part' + (selectedObject === child ? ' selected' : '');
            pr.textContent = pl;
            pr.addEventListener('click', (e) => {
                e.stopPropagation();
                selectObject(child);
            });
            sub.appendChild(pr);
        });
        block.appendChild(sub);
        childrenWrap.appendChild(block);
    });
    wrap.appendChild(childrenWrap);
    return wrap;
}

function renderWorldObjectList() {
    const el = document.getElementById('world-object-list');
    if (!el) return;
    el.innerHTML = '';
    worldObjectList = [];
    if (!editGroup) return;

    const lightsArr = [];
    const modelsArr = [];
    const pdfsArr = [];
    editGroup.children.forEach((child) => {
        if (child.userData.pdfConfig) {
            pdfsArr.push(child);
        } else if (child.userData.config) {
            modelsArr.push(child);
        } else if (child.isLight && child.userData.lightConfig) {
            lightsArr.push(child);
        } else if (child.isMesh && child.userData.lightRef) {
            lightsArr.push(child);
        }
    });
    worldObjectList = [...lightsArr, ...modelsArr, ...pdfsArr];
    if (selectedObject) {
        if (lightsArr.includes(selectedObject)) objectListExpanded.lights = true;
        if (modelsArr.includes(selectedObject)) objectListExpanded.models = true;
        if (pdfsArr.includes(selectedObject)) objectListExpanded.pdfs = true;
        if (
            selectedObject.userData.config
            && String(selectedObject.userData.config.prefabManifest || '').trim()
        ) {
            const eid = String(selectedObject.userData.editId != null ? selectedObject.userData.editId : 'x');
            objectListExpanded['pf_' + eid] = true;
        }
    }

    function makeItemLabel(child) {
        if (child.userData.pdfConfig) {
            const path = child.userData.pdfConfig.path || '';
            return path.split('/').pop() || 'PDF';
        }
        if (child.userData.config) {
            const path = child.userData.config.path || '';
            return path.split('/').pop() || 'モデル';
        }
        return (child.userData.lightConfig && child.userData.lightConfig.type) || 'light';
    }

    function createCategory(name, key, children, startIndex) {
        const wrap = document.createElement('div');
        wrap.className = 'object-list-category';
        wrap.dataset.category = key;

        const header = document.createElement('div');
        header.className = 'object-list-category-header';
        const isExpanded = objectListExpanded[key];
        header.innerHTML = `<span class="object-list-arrow">${isExpanded ? '▼' : '▶'}</span><span>${name}</span>`;
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            objectListExpanded[key] = !objectListExpanded[key];
            renderWorldObjectList();
        });
        wrap.appendChild(header);

        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'object-list-children';
        childrenWrap.style.display = isExpanded ? '' : 'none';
        children.forEach((child, i) => {
            const idx = startIndex + i;
            const div = document.createElement('div');
            div.className = 'item object-list-item' + (selectedObject === child ? ' selected' : '');
            div.dataset.index = String(idx);
            const label = makeItemLabel(child);
            div.innerHTML = `<span title="${label}">${label}</span>`;
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                if (worldObjectList[idx]) selectObject(worldObjectList[idx]);
            });
            childrenWrap.appendChild(div);
        });
        wrap.appendChild(childrenWrap);
        return wrap;
    }

    el.appendChild(createCategory('ライト', 'lights', lightsArr, 0));
    el.appendChild(createModelObjectListCategory('models', modelsArr, lightsArr.length));
    el.appendChild(createCategory('PDF', 'pdfs', pdfsArr, lightsArr.length + modelsArr.length));
}

function renderWorldList() {
    const el = document.getElementById('world-list');
    el.innerHTML = '';
    Object.keys(worlds).forEach((id) => {
        const w = worlds[id];
        const div = document.createElement('div');
        div.className = 'item' + (id === selectedWorldId ? ' selected' : '');
        div.textContent = w.name || id;
        div.dataset.id = id;
        div.addEventListener('click', () => void selectWorld(id));
        el.appendChild(div);
    });
}

function renderModelList() {
    syncModelPaletteSelectionAfterListChange();
    const el = document.getElementById('model-list');
    el.innerHTML = '';
    const pal = buildEditorModelPaletteEntries();
    pal.forEach((ent) => {
        const path = ent.path;
        const isSel = path === selectedModelPath;
        const div = document.createElement('div');
        div.className = 'item model-prefab-item' + (isSel ? ' selected' : '');
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        div.setAttribute('aria-label', ent.displayLabel);
        div.dataset.path = path;
        const icon = document.createElement('span');
        let iconClass = 'model-prefab-icon model-prefab-icon--model3d';
        let svg = MODEL_ICON_3D_ASSET;
        if (ent.kind === 'aircraft-lib') {
            iconClass = 'model-prefab-icon model-prefab-icon--aircraft-lib';
            svg = MODEL_ICON_AIRCRAFT_LIB;
        } else if (ent.kind === 'prefab-plane') {
            iconClass = 'model-prefab-icon model-prefab-icon--plane-prefab';
            svg = MODEL_ICON_PLANE_PREFAB;
        } else if (ent.kind === 'prefab-models') {
            iconClass = 'model-prefab-icon model-prefab-icon--prefab';
            svg = MODEL_ICON_3D_ASSET;
        }
        icon.className = iconClass;
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = svg;
        const label = document.createElement('span');
        label.className = 'model-prefab-label';
        label.textContent = ent.displayLabel;
        div.appendChild(icon);
        div.appendChild(label);
        const activate = () => {
            selectedModelPath = path;
            renderModelList();
        };
        div.addEventListener('click', activate);
        div.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
            }
        });
        el.appendChild(div);
    });
    updateAddObjMtlRowVisibility();
}

async function selectWorld(id) {
    const gen = ++worldSelectLoadGen;
    syncSelectWorldChrome(id);
    const w = worlds[id];
    if (!w) return;
    setWorldEditLoader(true, '3Dモデルを読み込んでいます…');
    try {
        await loadWorldIntoScene(w);
    } finally {
        if (gen === worldSelectLoadGen) setWorldEditLoader(false);
    }
    if (gen !== worldSelectLoadGen) return;
    const taiko = selectedObject && selectedObject.userData.config && selectedObject.userData.config.taiko;
    const cid = taiko && taiko.multiplayerChartId;
    await refreshTaikoChartSelect(cid);
    if (gen !== worldSelectLoadGen) return;
    if (selectedObject && selectedObject.userData.config) updateObjectPanel(selectedObject);
}

/**
 * 機体ライブラリ定義をワールドに配置（prefab + aircraft + aircraftLibraryId）
 * @param {string} aircraftLibraryId
 * @param {string} prefabManifest
 */
function addAircraftFromLibrary(aircraftLibraryId, prefabManifest) {
    if (!selectedWorldId) return;
    const libId = String(aircraftLibraryId || '').trim();
    const pfm = String(prefabManifest || '').trim();
    if (!libId || !pfm) return;
    void (async () => {
        try {
            const raw = await fetchPrefabManifestJson(pfm, {
                adminPlaneProxyBase: pfm.startsWith('plane/') ? '/admin/plane-asset' : undefined,
            });
            const man = normalizePrefabManifest(raw);
            const firstPart = man.parts[0] ? resolvePrefabPartAssetPath(man.parts[0].file) : pfm;
            const safe = libId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const cfg = {
                position: { x: 0, y: 2, z: -5 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                path: firstPart,
                prefabManifest: pfm,
                prefabGroupId: man.prefabGroupId,
                aircraft: {
                    id: `ac-${safe}-${Date.now()}`,
                    aircraftLibraryId: libId,
                    radius: 6,
                    label: '操縦する',
                    cockpitOffset: { x: 0, y: 1.2, z: 0 },
                    chaseOffset: { x: 0, y: 3, z: 12 },
                },
            };
            const { model, triangleCount } = await loadModelFromConfig(cfg);
            pushUndo();
            model.position.set(0, 2, -5);
            model.rotation.set(0, 0, 0);
            model.scale.set(1, 1, 1);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = 'm' + Date.now();
            model.userData.config = cfg;
            editGroup.add(model);
            renderWorldObjectList();
        } catch (err) {
            console.error('Load aircraft library failed:', libId, err);
            alert(err.message || String(err));
        }
    })();
}

/**
 * prefab マニフェスト（models/...-prefab-manifest.json）からグループを追加する
 * @param {string} manifestPath
 */
function addPrefabFromManifest(manifestPath) {
    if (!selectedWorldId) return;
    void (async () => {
        try {
            const raw = await fetchPrefabManifestJson(manifestPath, {
                adminPlaneProxyBase: String(manifestPath || '').startsWith('plane/')
                    ? '/admin/plane-asset'
                    : undefined,
            });
            const man = normalizePrefabManifest(raw);
            const firstPart = man.parts[0] ? resolvePrefabPartAssetPath(man.parts[0].file) : manifestPath;
            const cfg = {
                position: { x: 0, y: 2, z: -5 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                path: firstPart,
                prefabManifest: manifestPath,
                prefabGroupId: man.prefabGroupId
            };
            const { model, triangleCount } = await loadModelFromConfig(cfg);
            pushUndo();
            model.position.set(0, 2, -5);
            model.rotation.set(0, 0, 0);
            model.scale.set(1, 1, 1);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = 'm' + Date.now();
            model.userData.config = cfg;
            editGroup.add(model);
            renderWorldObjectList();
        } catch (err) {
            console.error('Load prefab failed:', manifestPath, err);
            alert(err.message || String(err));
        }
    })();
}

/**
 * シーンにモデルを追加（path は models/...）
 * @param {string} path
 * @param {string} [mtlPath] - OBJ 時のみ models/...mtl
 */
function addModel(path, mtlPath) {
    if (!selectedWorldId) return;
    if (String(path || '').toLowerCase().endsWith('-prefab-manifest.json')) {
        addPrefabFromManifest(path);
        return;
    }
    const mtl = isObjPath(path) ? (mtlPath || '').trim() : '';
    const cfg = {
        position: { x: 0, y: 2, z: -5 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
    };
    if (String(path || '').trim()) cfg.path = path;
    if (mtl) cfg.mtlPath = mtl;
    void (async () => {
        try {
            const { model, triangleCount } = await loadModelFromConfig({
                path,
                mtlPath: mtl
            });
            pushUndo();
            model.position.set(0, 2, -5);
            model.rotation.set(0, 0, 0);
            model.scale.set(1, 1, 1);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = 'm' + Date.now();
            model.userData.config = cfg;
            editGroup.add(model);
            renderWorldObjectList();
        } catch (err) {
            console.error('Load model failed:', path, err);
            alert(err.message || String(err));
        }
    })();
}

/**
 * オブジェクトパネルで MTL を変更したとき、選択中の OBJ を再読込する
 */
function reloadSelectedObjModelFromMtlChange() {
    if (!selectedObject || !selectedObject.userData.config) return;
    const c = selectedObject.userData.config;
    if (!isObjPath(c.path || '')) return;
    const mtlEl = document.getElementById('obj-mtl-path');
    const mv = mtlEl && mtlEl.value ? mtlEl.value.trim() : '';
    if (mv) c.mtlPath = mv;
    else delete c.mtlPath;

    const pos = selectedObject.position.clone();
    const rot = selectedObject.rotation.clone();
    const scale = selectedObject.scale.clone();
    const editId = selectedObject.userData.editId;
    const fullCfg = JSON.parse(JSON.stringify(c));

    void (async () => {
        try {
            const { model, triangleCount } = await loadModelFromConfig({
                path: fullCfg.path,
                mtlPath: fullCfg.mtlPath || ''
            });
            pushUndo();
            transformControls.detach();
            editGroup.remove(selectedObject);
            disposeObjectTree(selectedObject);
            model.position.copy(pos);
            model.rotation.copy(rot);
            model.scale.copy(scale);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = editId;
            model.userData.config = fullCfg;
            editGroup.add(model);
            selectedObject = model;
            transformControls.attach(selectedObject);
            updateObjectPanel(selectedObject);
            renderWorldObjectList();
        } catch (err) {
            console.error('Reload OBJ failed:', err);
            alert(err.message || String(err));
        }
    })();
}

function populateDestWorldSelect() {
    const sel = document.getElementById('obj-tp-dest');
    sel.innerHTML = '';
    Object.keys(worlds).forEach((id) => {
        if (id === selectedWorldId) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = worlds[id].name || id;
        sel.appendChild(opt);
    });
}

/**
 * ストレージ相対パスを結合する（/ 区切り、先頭スラッシュなし）
 * @param {string} prefix
 * @param {string} name
 * @returns {string}
 */
function joinStorageRelativePath(prefix, name) {
    const p = String(prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const n = String(name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!n) return p;
    return p ? `${p}/${n}` : n;
}

/**
 * ファイルサイズ表示用
 * @param {number | null | undefined} n
 * @returns {string}
 */
function formatStorageBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** ファイル管理モーダル用 UI 状態 */
const storageFilesUi = {
    store: 'models',
    currentRelative: '',
    /** @type {Set<string>} */
    selectedFileRelatives: new Set(),
    /** Shift 範囲選択の基準となる entries 内のインデックス（ファイル行でもフォルダ行でも可） */
    anchorListIndex: -1,
    entries: [],
};

/**
 * 削除ボタンの有効・表示を選択件数に合わせる
 */
function syncStorageFilesDeleteButton() {
    const delBtn = document.getElementById('storage-files-delete-btn');
    if (!delBtn) return;
    const n = storageFilesUi.selectedFileRelatives.size;
    delBtn.disabled = n === 0;
    delBtn.textContent = n > 1 ? `削除 (${n})` : '削除';
}

/**
 * ストア移動・フォルダ移動時に選択状態を消す
 */
function clearStorageFilesSelection() {
    storageFilesUi.selectedFileRelatives.clear();
    storageFilesUi.anchorListIndex = -1;
    syncStorageFilesDeleteButton();
}

/**
 * チェックボックスまたはファイル行クリックで選択を更新する（Shift で範囲）
 * @param {MouseEvent} e
 * @param {number} rowIndex
 * @param {string} rel
 */
function applyStorageFileSelectionClick(e, rowIndex, rel) {
    const ent = storageFilesUi.entries[rowIndex];
    if (!ent || ent.isDirectory) return;
    if (e.shiftKey && storageFilesUi.anchorListIndex >= 0) {
        const lo = Math.min(storageFilesUi.anchorListIndex, rowIndex);
        const hi = Math.max(storageFilesUi.anchorListIndex, rowIndex);
        storageFilesUi.selectedFileRelatives.clear();
        for (let k = lo; k <= hi; k++) {
            const row = storageFilesUi.entries[k];
            if (row && !row.isDirectory) {
                const r = joinStorageRelativePath(storageFilesUi.currentRelative, row.name);
                storageFilesUi.selectedFileRelatives.add(r);
            }
        }
    } else {
        if (storageFilesUi.selectedFileRelatives.has(rel)) {
            storageFilesUi.selectedFileRelatives.delete(rel);
        } else {
            storageFilesUi.selectedFileRelatives.add(rel);
        }
        storageFilesUi.anchorListIndex = rowIndex;
    }
    syncStorageFilesDeleteButton();
    renderStorageFilesList();
}

/**
 * パンくずを描画する
 */
function renderStorageFilesBreadcrumb() {
    const nav = document.getElementById('storage-files-breadcrumb');
    if (!nav) return;
    nav.innerHTML = '';
    const rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.textContent = 'ルート';
    rootBtn.addEventListener('click', () => {
        storageFilesUi.currentRelative = '';
        clearStorageFilesSelection();
        void loadStorageFilesFromServer();
    });
    nav.appendChild(rootBtn);
    const parts = storageFilesUi.currentRelative.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        const sep = document.createElement('span');
        sep.className = 'storage-files-bc-sep';
        sep.textContent = '/';
        nav.appendChild(sep);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = parts[i];
        const pathUpTo = acc;
        btn.addEventListener('click', () => {
            storageFilesUi.currentRelative = pathUpTo;
            clearStorageFilesSelection();
            void loadStorageFilesFromServer();
        });
        nav.appendChild(btn);
    }
}

/**
 * 一覧行を描画する（storageFilesUi.entries を参照）
 */
function renderStorageFilesList() {
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    storageFilesUi.entries.forEach((ent, rowIndex) => {
        const li = document.createElement('li');
        li.dataset.rowIndex = String(rowIndex);
        const rel = joinStorageRelativePath(storageFilesUi.currentRelative, ent.name);
        const cbCell = document.createElement('span');
        cbCell.className = 'storage-files-cb-cell';
        if (!ent.isDirectory) {
            const checked = storageFilesUi.selectedFileRelatives.has(rel);
            if (checked) li.classList.add('storage-files-row-checked');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'storage-files-row-cb';
            cb.checked = checked;
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                applyStorageFileSelectionClick(e, rowIndex, rel);
            });
            cbCell.appendChild(cb);
        }
        const nameSpan = document.createElement('span');
        nameSpan.textContent = ent.name;
        const kindSpan = document.createElement('span');
        kindSpan.className = 'storage-files-kind';
        kindSpan.textContent = ent.isDirectory ? 'フォルダ' : 'ファイル';
        const metaSpan = document.createElement('span');
        metaSpan.className = 'storage-files-meta';
        if (ent.isDirectory) {
            metaSpan.textContent = '—';
        } else {
            const dateStr = ent.mtimeMs != null ? new Date(ent.mtimeMs).toLocaleString() : '—';
            metaSpan.textContent = `${formatStorageBytes(ent.size)} · ${dateStr}`;
        }
        li.append(cbCell, nameSpan, kindSpan, metaSpan);
        li.addEventListener('click', (e) => {
            if (e.target.closest('.storage-files-cb-cell')) return;
            if (ent.isDirectory) {
                storageFilesUi.currentRelative = rel;
                clearStorageFilesSelection();
                void loadStorageFilesFromServer();
            } else {
                applyStorageFileSelectionClick(e, rowIndex, rel);
            }
        });
        listEl.appendChild(li);
    });
}

/**
 * GET /admin/storage-files で一覧を読み込み UI を更新する
 */
async function loadStorageFilesFromServer() {
    const statusEl = document.getElementById('storage-files-modal-status');
    const listEl = document.getElementById('storage-files-list');
    if (!listEl) return;
    if (statusEl) {
        statusEl.textContent = '読み込み中…';
        statusEl.className = '';
    }
    try {
        const params = new URLSearchParams({
            store: storageFilesUi.store,
            path: storageFilesUi.currentRelative,
        });
        const res = await fetch('/admin/storage-files?' + params.toString(), { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || res.statusText || 'list failed');
        }
        storageFilesUi.entries = Array.isArray(data.entries) ? data.entries : [];
        if (typeof data.currentRelative === 'string') {
            storageFilesUi.currentRelative = data.currentRelative;
        }
        const stillHere = new Set(
            storageFilesUi.entries
                .filter((row) => !row.isDirectory)
                .map((row) => joinStorageRelativePath(storageFilesUi.currentRelative, row.name))
        );
        for (const r of [...storageFilesUi.selectedFileRelatives]) {
            if (!stillHere.has(r)) storageFilesUi.selectedFileRelatives.delete(r);
        }
        syncStorageFilesDeleteButton();
        renderStorageFilesBreadcrumb();
        renderStorageFilesList();
        if (statusEl) statusEl.textContent = '';
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = '一覧の取得に失敗: ' + (e.message || String(e));
            statusEl.className = 'error';
        }
        storageFilesUi.entries = [];
        syncStorageFilesDeleteButton();
        renderStorageFilesBreadcrumb();
        renderStorageFilesList();
    }
}

/**
 * 削除後にモデル・PDF など左パネル一覧を再取得する
 */
async function refreshWorldEditListsAfterStorageDelete(store) {
    try {
        if (store === 'models') {
            await fetchModels();
            await fetchMtls();
            renderModelList();
        } else if (store === 'pdfs') {
            await fetchPdfs();
            renderPdfList();
        }
    } catch (err) {
        console.warn('[storage-files] list refresh:', err);
    }
}

/**
 * IBL 用 default.hdr を POST /admin/upload-hdr で送り、エディタの scene.environment を再構築する
 * @param {File} file
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, message?: string }>}
 */
async function uploadDefaultHdrForWorldEditor(file) {
    /** @param {boolean} confirmOverwrite */
    const postHdr = async (confirmOverwrite) => {
        const form = new FormData();
        form.append('hdr', file);
        form.append('filename_b64', btoa(unescape(encodeURIComponent(file.name))));
        let url = '/admin/upload-hdr';
        if (confirmOverwrite) url += '?confirm=1';
        return fetch(url, { method: 'POST', credentials: 'include', body: form });
    };
    let res = await postHdr(false);
    if (res.status === 409) {
        if (!confirm('default.hdr が既にあります。上書きしますか？')) {
            return { ok: false, cancelled: true };
        }
        res = await postHdr(true);
    }
    if (res.status === 409) {
        return { ok: false, message: '上書きには確認が必要です。' };
    }
    if (!res.ok) {
        const t = await res.text();
        let msg = t;
        try {
            const j = JSON.parse(t);
            if (j && typeof j.error === 'string') msg = j.error;
            else if (j && typeof j.detail === 'string') msg = j.detail;
        } catch {
            /* use raw text */
        }
        return { ok: false, message: msg || `失敗 (${res.status})` };
    }
    const data = await res.json();
    if (!data.success) return { ok: false, message: 'アップロード応答が不正です' };
    await notifyServiceWorkerInvalidate([encodeAssetPathToUrlPath('env/default.hdr')]);
    if (scene && renderer) {
        const bust = `${DEFAULT_HDR_PATH}?t=${Date.now()}`;
        const hdrUrl = await resolveEnvAssetHref(bust);
        loadSceneIBL(THREE, { scene, renderer, RGBELoader, PMREMGenerator: THREE.PMREMGenerator }, { hdrUrl }).then((r) => {
            if (!r.ok) console.warn('[setting] IBL 再読み込みに失敗しました');
        });
    }
    return { ok: true };
}

// --- Event bindings ---
function bindEvents() {
    // 左パネル: ワールド/モデル/PDF/ファイル カテゴリ切り替え（admin 統合時）。カテゴリクリックで展開もする
    const weLayout = document.querySelector('#panel-world-edit .setting-layout');
    const categoryNav = document.querySelector('.we-category-nav');
    /**
     * ワールド編集・左「アバター」パネルに現在のアクティブ GLB を表示する
     */
    async function refreshWeAvatarPanel() {
        const fnEl = document.getElementById('we-avatar-current-filename');
        const statusEl = document.getElementById('we-avatar-status');
        if (!fnEl) return;
        try {
            const r = await fetch('/api/active-avatar', { credentials: 'include' });
            const j = await r.json();
            fnEl.textContent = typeof j.path === 'string' && j.path.length > 0 ? j.path : '(未設定)';
        } catch {
            fnEl.textContent = '(取得に失敗しました)';
        }
        if (statusEl) statusEl.textContent = '';
    }
    /**
     * ワールド編集・左「アバター」パネルに IBL 用 default.hdr の有無を表示する
     */
    async function refreshWeHdrPanel() {
        const fnEl = document.getElementById('we-hdr-current-filename');
        const statusEl = document.getElementById('we-hdr-status');
        if (!fnEl) return;
        try {
            const r = await fetch('/api/env-ibl-hdr', { credentials: 'include' });
            const j = await r.json().catch(() => ({}));
            if (typeof j.present === 'boolean' && typeof j.path === 'string') {
                fnEl.textContent = j.present ? j.path : '(未設定)';
            } else {
                fnEl.textContent = '(取得に失敗しました)';
            }
        } catch {
            fnEl.textContent = '(取得に失敗しました)';
        }
        if (statusEl) statusEl.textContent = '';
    }
    if (categoryNav) {
        categoryNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.we-category-btn');
            if (!btn) return;
            const cat = btn.getAttribute('data-we-category');
            document.querySelectorAll('.we-category-btn').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.we-category-pane').forEach((p) => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById('we-cat-' + cat);
            if (pane) pane.classList.add('active');
            if (cat === 'avatar') {
                refreshWeAvatarPanel().catch(() => {});
                refreshWeHdrPanel().catch(() => {});
            }
            if (weLayout) weLayout.classList.remove('we-left-collapsed');
        });
    }

    const btnWeAvatarUpload = document.getElementById('btn-we-avatar-upload');
    const weAvatarFile = document.getElementById('we-avatar-file');
    const weAvatarStatus = document.getElementById('we-avatar-status');
    if (btnWeAvatarUpload && weAvatarFile) {
        btnWeAvatarUpload.addEventListener('click', async () => {
            const f = weAvatarFile.files?.[0];
            if (!f) {
                if (weAvatarStatus) weAvatarStatus.textContent = 'ファイルを選択してください。';
                return;
            }
            if (!String(f.name).toLowerCase().endsWith('.glb')) {
                if (weAvatarStatus) weAvatarStatus.textContent = '.glb のみ対応です。';
                return;
            }
            if (weAvatarStatus) weAvatarStatus.textContent = 'アップロード中…';
            const fd = new FormData();
            fd.append('avatar', f);
            try {
                const r = await fetch('/admin/upload-avatar', { method: 'POST', body: fd, credentials: 'include' });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (weAvatarStatus) {
                        weAvatarStatus.textContent =
                            typeof j.error === 'string' ? j.error : `失敗 (${r.status})`;
                    }
                    return;
                }
                if (weAvatarStatus) {
                    weAvatarStatus.textContent = j.filename ? `適用しました: ${j.filename}` : '適用しました。';
                }
                await refreshWeAvatarPanel();
                weAvatarFile.value = '';
            } catch {
                if (weAvatarStatus) weAvatarStatus.textContent = '通信エラー';
            }
        });
    }

    const btnWeHdrUpload = document.getElementById('btn-we-hdr-upload');
    const weHdrFile = document.getElementById('we-hdr-file');
    const weHdrStatus = document.getElementById('we-hdr-status');
    if (btnWeHdrUpload && weHdrFile) {
        btnWeHdrUpload.addEventListener('click', async () => {
            const f = weHdrFile.files?.[0];
            if (!f) {
                if (weHdrStatus) weHdrStatus.textContent = 'ファイルを選択してください。';
                return;
            }
            if (!String(f.name).toLowerCase().endsWith('.hdr')) {
                if (weHdrStatus) weHdrStatus.textContent = '.hdr（Radiance RGBE）のみ対応です。';
                return;
            }
            if (weHdrStatus) weHdrStatus.textContent = 'アップロード中…';
            try {
                const result = await uploadDefaultHdrForWorldEditor(f);
                if (result.cancelled) {
                    if (weHdrStatus) weHdrStatus.textContent = '';
                    return;
                }
                if (!result.ok) {
                    if (weHdrStatus) weHdrStatus.textContent = result.message || 'アップロードに失敗しました。';
                    return;
                }
                if (weHdrStatus) weHdrStatus.textContent = '適用しました: default.hdr（プレビューに反映済み）';
                await refreshWeHdrPanel();
                weHdrFile.value = '';
            } catch {
                if (weHdrStatus) weHdrStatus.textContent = '通信エラー';
            }
        });
    }

    // viewer 操作開始で左パネルを収納（カテゴリナビのみ表示）
    const weCanvas = document.getElementById('canvas');
    if (weLayout && weCanvas) {
        weCanvas.addEventListener('pointerdown', () => {
            weLayout.classList.add('we-left-collapsed');
            weLayout.classList.add('we-right-collapsed');
        });
    }

    // 右パネル: モデル/ライト/設定 カテゴリ切り替え、クリックで展開
    const rightCategoryNav = document.querySelector('.we-right-category-nav');
    bindWorldLodEditorEvents();

    if (rightCategoryNav) {
        rightCategoryNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.we-right-category-btn');
            if (!btn) return;
            const cat = btn.getAttribute('data-we-right-category');
            document.querySelectorAll('.we-right-category-btn').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.we-right-pane').forEach((p) => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById('we-cat-right-' + cat);
            if (pane) pane.classList.add('active');
            if (weLayout) weLayout.classList.remove('we-right-collapsed');
        });
    }

    document.querySelector('.we-right-content')?.addEventListener('focusin', (e) => {
        if (e.target.matches('input[type="number"], input[type="text"]') && !e.target.readOnly) {
            e.target.select();
        }
    });

    document.getElementById('obj-pos-x').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-pos-y').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-pos-z').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-rot-x').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-rot-y').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-rot-z').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-scale-x').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-scale-y').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-scale-z').addEventListener('change', syncObjectFromPanel);
    const objMtlPathEl = document.getElementById('obj-mtl-path');
    if (objMtlPathEl) {
        objMtlPathEl.addEventListener('change', () => {
            if (!selectedObject || !selectedObject.userData.config) return;
            if (!isObjPath(selectedObject.userData.config.path || '')) return;
            reloadSelectedObjModelFromMtlChange();
        });
    }
    document.getElementById('obj-lod-id')?.addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-lod-rank-default')?.addEventListener('change', syncObjectFromPanel);

    document.getElementById('obj-animate').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-anim-x').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-anim-y').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-anim-z').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-teleporter').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-id').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-dest').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-radius').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-label').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-access').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-auto-teleport').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-tp-auto-contact-teleport').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-taiko').addEventListener('change', () => {
        if (!document.getElementById('obj-taiko').checked) {
            document.getElementById('obj-taiko-multiplayer').checked = false;
            const mpRows = document.getElementById('obj-taiko-multiplayer-rows');
            if (mpRows) mpRows.style.display = 'none';
        } else {
            const mp = document.getElementById('obj-taiko-multiplayer').checked;
            const mpRows = document.getElementById('obj-taiko-multiplayer-rows');
            if (mpRows) mpRows.style.display = mp ? '' : 'none';
        }
        syncObjectFromPanel();
    });
    document.getElementById('obj-taiko-radius').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-taiko-multiplayer').addEventListener('change', () => {
        const show = document.getElementById('obj-taiko').checked && document.getElementById('obj-taiko-multiplayer').checked;
        const mpRows = document.getElementById('obj-taiko-multiplayer-rows');
        if (mpRows) mpRows.style.display = show ? '' : 'none';
        syncObjectFromPanel();
    });
    document.getElementById('obj-taiko-group-id').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-taiko-chart-id').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-vehicle-type')?.addEventListener('change', () => {
        updateVehicleAircraftFieldsVisibility();
        syncObjectFromPanel();
    });
    for (const acId of [
        'obj-ac-id',
        'obj-ac-library-id',
        'obj-ac-radius',
        'obj-ac-label',
        'obj-ac-body-x',
        'obj-ac-body-y',
        'obj-ac-body-z',
    ]) {
        document.getElementById(acId)?.addEventListener('change', syncObjectFromPanel);
    }

    document.getElementById('object-props')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-glb-preview-clip]');
        if (!btn || !selectedObject || !selectedObject.userData.config) return;
        const name = btn.getAttribute('data-glb-preview-clip');
        playEditorGltfClipPreview(selectedObject, name);
    });
    document.getElementById('obj-glb-interact-enable')?.addEventListener('change', () => {
        const fields = document.getElementById('obj-glb-interact-fields');
        const en = document.getElementById('obj-glb-interact-enable');
        if (fields && en) fields.style.display = en.checked ? '' : 'none';
        syncObjectFromPanel();
    });
    document.getElementById('obj-glb-interact-clip')?.addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-glb-interact-radius')?.addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-glb-interact-label')?.addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-glb-interact-access')?.addEventListener('change', syncObjectFromPanel);

    document.getElementById('btn-save').addEventListener('click', async () => {
        const status = document.getElementById('save-status');
        status.textContent = '';
        status.className = '';
        try {
            syncObjectFromPanel();
            const payload = buildWorldsFromScene();
            const res = await fetch('/admin/worlds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(await res.text());
            status.textContent = '保存しました。反映にはサーバー再起動が必要です。';
            writeWorldEditCache();
        } catch (e) {
            status.textContent = '保存に失敗: ' + e.message;
            status.className = 'error';
        }
    });

    const btnExport = document.getElementById('btn-export-worlds');
    if (btnExport) {
        btnExport.addEventListener('click', () => {
            const statusEl = document.getElementById('export-status');
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.className = '';
            }
            syncObjectFromPanel();
            const payload = buildWorldsFromScene();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'worlds.json';
            a.click();
            URL.revokeObjectURL(url);
            if (statusEl) statusEl.textContent = 'エクスポートしました';
        });
    }

    const worldJsonModal = document.getElementById('world-json-modal');
    const worldJsonTextarea = document.getElementById('world-json-editor-textarea');
    const worldJsonModalStatus = document.getElementById('world-json-modal-status');
    const btnEditWorldsJson = document.getElementById('btn-edit-worlds-json');
    const worldJsonSaveBtn = document.getElementById('world-json-save-btn');
    const worldJsonCancelBtn = document.getElementById('world-json-cancel-btn');
    const worldJsonFindInput = document.getElementById('world-json-find-input');
    const worldJsonReplaceInput = document.getElementById('world-json-replace-input');
    const worldJsonFindNextBtn = document.getElementById('world-json-find-next');
    const worldJsonReplaceOneBtn = document.getElementById('world-json-replace-one');
    const worldJsonReplaceAllBtn = document.getElementById('world-json-replace-all');
    const worldJsonFindCase = document.getElementById('world-json-find-case');
    const worldJsonFindHitStatus = document.getElementById('world-json-find-hit-status');

    /** 正規表現メタ文字をエスケープ（リテラル検索・置換用） */
    function escapeRegExpWorldJson(s) {
        return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }

    /** worlds.json モーダル内の検索コンテキスト（needle 空なら null） */
    function worldJsonFindContext() {
        if (!worldJsonTextarea || !worldJsonFindInput) return null;
        const needle = worldJsonFindInput.value;
        if (!needle) return null;
        const caseSens = !!(worldJsonFindCase && worldJsonFindCase.checked);
        const text = worldJsonTextarea.value;
        const hay = caseSens ? text : text.toLowerCase();
        const sub = caseSens ? needle : needle.toLowerCase();
        return { needle, caseSens, text, hay, sub };
    }

    /** hay 内の sub の出現回数 */
    function worldJsonCountSubstr(hay, sub) {
        let n = 0;
        let p = 0;
        while (p < hay.length) {
            const i = hay.indexOf(sub, p);
            if (i === -1) break;
            n++;
            p = i + Math.max(1, sub.length);
        }
        return n;
    }

    /** idx 位置で始まる一致が hay 内で何番目か（1-based） */
    function worldJsonMatchOrdinalAt(hay, sub, idx) {
        let n = 0;
        let p = 0;
        while (p < hay.length) {
            const i = hay.indexOf(sub, p);
            if (i === -1) break;
            n++;
            if (i === idx) return n;
            p = i + Math.max(1, sub.length);
        }
        return n;
    }

    /** 次の一致を選択。見つからなければメッセージのみ */
    function findWorldJsonNext() {
        const ctx = worldJsonFindContext();
        if (!ctx || !worldJsonTextarea) {
            if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '検索文字列を入力してください';
            return;
        }
        const { needle, hay, sub } = ctx;
        const ta = worldJsonTextarea;
        let from = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : 0;
        if (from < 0) from = 0;
        let idx = hay.indexOf(sub, from);
        let wrapped = false;
        if (idx === -1) {
            idx = hay.indexOf(sub, 0);
            wrapped = idx !== -1;
        }
        if (idx === -1) {
            if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '見つかりません';
            return;
        }
        const total = worldJsonCountSubstr(hay, sub);
        const ord = worldJsonMatchOrdinalAt(hay, sub, idx);
        ta.focus();
        ta.setSelectionRange(idx, idx + needle.length);
        if (worldJsonFindHitStatus) {
            const wrapNote = wrapped ? ' · 先頭から再検索' : '';
            worldJsonFindHitStatus.textContent = `一致 ${total} 件 · ${ord} 件目${wrapNote}`;
        }
    }

    /** 選択範囲が検索文字列と一致すれば 1 件だけ置換。しなければ次を検索して一致すれば置換 */
    function replaceWorldJsonOne() {
        const ctx = worldJsonFindContext();
        if (!ctx || !worldJsonTextarea) {
            if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '検索文字列を入力してください';
            return;
        }
        const { needle, caseSens, text } = ctx;
        const ta = worldJsonTextarea;
        const rep = worldJsonReplaceInput ? worldJsonReplaceInput.value : '';
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const sel = text.slice(start, end);
        const matches = caseSens ? sel === needle : sel.toLowerCase() === needle.toLowerCase();
        if (matches) {
            ta.setRangeText(rep, start, end, 'end');
            ta.setSelectionRange(start + rep.length, start + rep.length);
            findWorldJsonNext();
            return;
        }
        findWorldJsonNext();
        const nstart = ta.selectionStart;
        const nend = ta.selectionEnd;
        const nsel = ta.value.slice(nstart, nend);
        const nmatches = caseSens ? nsel === needle : nsel.toLowerCase() === needle.toLowerCase();
        if (nmatches) {
            ta.setRangeText(rep, nstart, nend, 'end');
            ta.setSelectionRange(nstart + rep.length, nstart + rep.length);
            const ctx2 = worldJsonFindContext();
            if (ctx2 && worldJsonFindHitStatus) {
                const rest = worldJsonCountSubstr(ctx2.hay, ctx2.sub);
                worldJsonFindHitStatus.textContent = `置換しました · 残り一致 ${rest} 件`;
            }
        }
    }

    /** すべて置換（リテラル文字列、オプションで大文字小文字無視） */
    function replaceWorldJsonAll() {
        const ctx = worldJsonFindContext();
        if (!ctx || !worldJsonTextarea) {
            if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '検索文字列を入力してください';
            return;
        }
        const { needle, caseSens, text } = ctx;
        const rep = worldJsonReplaceInput ? worldJsonReplaceInput.value : '';
        const re = new RegExp(escapeRegExpWorldJson(needle), caseSens ? 'g' : 'gi');
        const matches = text.match(re);
        const count = matches ? matches.length : 0;
        if (!count) {
            if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '見つかりません';
            return;
        }
        worldJsonTextarea.value = text.replace(re, rep);
        worldJsonTextarea.setSelectionRange(0, 0);
        if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = `${count} 件を置換しました`;
    }

    /** worlds.json モーダルを閉じる */
    function closeWorldJsonModal() {
        if (!worldJsonModal) return;
        worldJsonModal.classList.remove('show');
        worldJsonModal.setAttribute('aria-hidden', 'true');
    }

    /** エクスポートと同じソースでテキストを埋めてモーダルを開く */
    function openWorldJsonModal() {
        if (!worldJsonModal || !worldJsonTextarea) return;
        if (worldJsonModalStatus) {
            worldJsonModalStatus.textContent = '';
            worldJsonModalStatus.className = '';
        }
        if (worldJsonFindInput) worldJsonFindInput.value = '';
        if (worldJsonReplaceInput) worldJsonReplaceInput.value = '';
        if (worldJsonFindCase) worldJsonFindCase.checked = false;
        if (worldJsonFindHitStatus) worldJsonFindHitStatus.textContent = '';
        syncObjectFromPanel();
        worldJsonTextarea.value = JSON.stringify(buildWorldsFromScene(), null, 2);
        worldJsonModal.classList.add('show');
        worldJsonModal.setAttribute('aria-hidden', 'false');
        worldJsonTextarea.focus();
    }

    if (btnEditWorldsJson) {
        btnEditWorldsJson.addEventListener('click', openWorldJsonModal);
    }
    if (worldJsonCancelBtn) {
        worldJsonCancelBtn.addEventListener('click', closeWorldJsonModal);
    }
    if (worldJsonModal) {
        worldJsonModal.addEventListener('click', (e) => {
            if (e.target === worldJsonModal) closeWorldJsonModal();
        });
        worldJsonModal.addEventListener('keydown', (e) => {
            if (!worldJsonModal.classList.contains('show')) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                worldJsonFindInput?.focus();
                worldJsonFindInput?.select();
            }
        });
    }
    worldJsonFindNextBtn?.addEventListener('click', () => findWorldJsonNext());
    worldJsonReplaceOneBtn?.addEventListener('click', () => replaceWorldJsonOne());
    worldJsonReplaceAllBtn?.addEventListener('click', () => replaceWorldJsonAll());
    worldJsonFindInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            findWorldJsonNext();
        }
    });
    if (worldJsonSaveBtn && worldJsonTextarea) {
        worldJsonSaveBtn.addEventListener('click', async () => {
            if (worldJsonModalStatus) {
                worldJsonModalStatus.textContent = '';
                worldJsonModalStatus.className = '';
            }
            let parsed;
            try {
                parsed = JSON.parse(worldJsonTextarea.value);
            } catch (err) {
                if (worldJsonModalStatus) {
                    worldJsonModalStatus.textContent = 'JSONの解析に失敗しました: ' + (err.message || String(err));
                    worldJsonModalStatus.className = 'error';
                }
                return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                if (worldJsonModalStatus) {
                    worldJsonModalStatus.textContent = 'ルートはオブジェクト（ワールドID → 設定）である必要があります';
                    worldJsonModalStatus.className = 'error';
                }
                return;
            }
            worldJsonSaveBtn.disabled = true;
            try {
                const res = await fetch('/admin/worlds', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(parsed)
                });
                const errText = await res.text();
                if (!res.ok) {
                    let msg = errText;
                    try {
                        const j = JSON.parse(errText);
                        if (j && j.error) msg = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
                    } catch {
                        /* use errText */
                    }
                    throw new Error(msg || res.statusText);
                }
                await applyWorldsStateFromJson(parsed);
                const saveStatus = document.getElementById('save-status');
                if (saveStatus) {
                    saveStatus.textContent = '保存しました。反映にはサーバー再起動が必要です。';
                    saveStatus.className = '';
                }
                closeWorldJsonModal();
            } catch (e) {
                if (worldJsonModalStatus) {
                    worldJsonModalStatus.textContent = '保存に失敗: ' + e.message;
                    worldJsonModalStatus.className = 'error';
                }
            } finally {
                worldJsonSaveBtn.disabled = false;
            }
        });
    }

    const storageFilesModal = document.getElementById('storage-files-modal');
    const btnStorageFilesOpen = document.getElementById('btn-storage-files-open');
    const storageFilesCloseBtn = document.getElementById('storage-files-close-btn');
    const storageFilesDeleteBtn = document.getElementById('storage-files-delete-btn');

    /** ファイル管理モーダルを閉じる */
    function closeStorageFilesModal() {
        if (!storageFilesModal) return;
        storageFilesModal.classList.remove('show');
        storageFilesModal.setAttribute('aria-hidden', 'true');
    }

    /** ファイル管理モーダルを開き一覧を読み込む */
    function openStorageFilesModal() {
        if (!storageFilesModal) return;
        const statusEl = document.getElementById('storage-files-modal-status');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = '';
        }
        storageFilesUi.store = 'models';
        storageFilesUi.currentRelative = '';
        storageFilesUi.selectedFileRelatives.clear();
        storageFilesUi.anchorListIndex = -1;
        storageFilesUi.entries = [];
        document.querySelectorAll('.storage-files-store-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-storage-store') === 'models');
        });
        syncStorageFilesDeleteButton();
        storageFilesModal.classList.add('show');
        storageFilesModal.setAttribute('aria-hidden', 'false');
        void loadStorageFilesFromServer();
    }

    btnStorageFilesOpen?.addEventListener('click', openStorageFilesModal);
    storageFilesCloseBtn?.addEventListener('click', closeStorageFilesModal);
    storageFilesModal?.addEventListener('click', (e) => {
        if (e.target === storageFilesModal) closeStorageFilesModal();
    });

    document.querySelector('.storage-files-stores')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.storage-files-store-btn');
        if (!btn) return;
        const store = btn.getAttribute('data-storage-store');
        if (!store) return;
        storageFilesUi.store = store;
        storageFilesUi.currentRelative = '';
        storageFilesUi.selectedFileRelatives.clear();
        storageFilesUi.anchorListIndex = -1;
        syncStorageFilesDeleteButton();
        document.querySelectorAll('.storage-files-store-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        void loadStorageFilesFromServer();
    });

    storageFilesDeleteBtn?.addEventListener('click', async () => {
        const relativePaths = [...storageFilesUi.selectedFileRelatives];
        if (relativePaths.length === 0) return;
        const store = storageFilesUi.store;
        const msg =
            relativePaths.length === 1
                ? `次のファイルを削除しますか？\n${relativePaths[0].split('/').pop()}`
                : `${relativePaths.length} 件のファイルを削除しますか？`;
        if (!confirm(msg)) return;
        const statusEl = document.getElementById('storage-files-modal-status');
        if (statusEl) {
            statusEl.textContent = '削除中…';
            statusEl.className = '';
        }
        try {
            const res = await fetch('/admin/storage-files/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ store, relativePaths }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || res.statusText || 'delete failed');
            }
            storageFilesUi.selectedFileRelatives.clear();
            storageFilesUi.anchorListIndex = -1;
            syncStorageFilesDeleteButton();
            if (statusEl) {
                if (Array.isArray(data.errors) && data.errors.length > 0) {
                    const detail = data.errors
                        .map((x) => `${x.relativePath || '?'}: ${x.error || 'error'}`)
                        .join(' / ');
                    statusEl.textContent = `一部失敗（${data.deletedCount ?? 0} 件削除）: ${detail}`;
                    statusEl.className = 'error';
                } else {
                    statusEl.textContent =
                        relativePaths.length === 1 ? '削除しました' : `${data.deletedCount ?? relativePaths.length} 件削除しました`;
                    statusEl.className = '';
                }
            }
            await loadStorageFilesFromServer();
            await refreshWorldEditListsAfterStorageDelete(store);
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '削除に失敗: ' + (err.message || String(err));
                statusEl.className = 'error';
            }
        }
    });

    document.getElementById('btn-add-world').addEventListener('click', () => {
        const id = prompt('ワールドID（英数字・アンダースコア）', 'world_' + Date.now());
        if (!id || /[^a-zA-Z0-9_]/.test(id)) return;
        if (worlds[id]) { alert('そのIDは既に存在します'); return; }
        const name = prompt('表示名', id);
        worlds[id] = {
            id,
            name: name || id,
            models: [],
            spawnPoint: { x: 0, y: 10, z: 0 },
            lights: [],
            pdfs: [],
            vdbs: [],
            floorEnabled: true,
            floorWidth: DEFAULT_FLOOR_WIDTH_M,
            floorDepth: DEFAULT_FLOOR_DEPTH_M,
            lodSystem: { ids: [], thresholdsById: {} }
        };
        renderWorldList();
        void selectWorld(id);
    });

    document.getElementById('btn-delete-world').addEventListener('click', () => {
        if (!selectedWorldId) return;
        let refs = 0;
        Object.values(worlds).forEach((w) => {
            (w.models || []).forEach((m) => { if (m.teleporter && m.teleporter.destinationWorld === selectedWorldId) refs++; });
        });
        if (refs > 0 && !confirm('このワールドへのテレポーターが他にあります。削除しますか？')) return;
        pushUndo();
        delete worlds[selectedWorldId];
        const next = Object.keys(worlds)[0] || null;
        selectedWorldId = next;
        renderWorldList();
        if (next) {
            void selectWorld(next);
        } else {
            syncSelectWorldChrome(null);
            void (async () => {
                setWorldEditLoader(true, 'シーンを空にしています…');
                try {
                    await loadWorldIntoScene(EMPTY_EDITOR_WORLD);
                } finally {
                    setWorldEditLoader(false);
                }
            })();
        }
    });

    document.getElementById('btn-delete-object').addEventListener('click', () => {
        if (!selectedObject) return;
        pushUndo();
        const obj = selectedObject;
        editGroup.remove(obj);
        obj.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
                else { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
            }
        });
        selectedObject = null;
        transformControls.detach();
        document.getElementById('object-hint').style.display = 'block';
        document.getElementById('object-props').style.display = 'none';
        renderWorldObjectList();
    });

    document.getElementById('btn-add-model').addEventListener('click', () => {
        const pal = buildEditorModelPaletteEntries();
        if (!pal.length) {
            alert('モデルをアップロードするか、一覧から選択してください');
            return;
        }
        const match = pal.find((e) => e.path === selectedModelPath) || pal[0];
        const path = match.path || '';
        if (!path) {
            alert('モデルをアップロードするか、一覧から選択してください');
            return;
        }
        if (match.kind === 'aircraft-lib' && match.aircraftLibraryId && match.prefabManifest) {
            addAircraftFromLibrary(match.aircraftLibraryId, match.prefabManifest);
            return;
        }
        if (match.isPrefab) {
            addPrefabFromManifest(path);
            return;
        }
        let mtlPath = '';
        if (path && isObjPath(path)) {
            const mtlSel = document.getElementById('add-obj-mtl');
            mtlPath = mtlSel && mtlSel.value ? mtlSel.value.trim() : '';
        }
        addModel(path, mtlPath);
    });

    document.getElementById('btn-add-pdf').addEventListener('click', () => {
        const path = selectedPdfPath || (pdfList.length ? 'pdfs/' + pdfList[0] : null);
        if (path) addPdf(path);
        else alert('PDFをアップロードするか、一覧から選択してください');
    });

    let modelUploadModalBusy = false;
    let modelUploadQueuePollId = null;
    /** GLB: ボディ送信後、キューポーリングでステータス文言を合わせる行 UI */
    let activeGlbServerPhaseUi = null;
    const modelUploadModal = document.getElementById('model-upload-modal');
    const modelUploadInput = document.getElementById('model-upload-input');
    const modelUploadFileList = document.getElementById('model-upload-file-list');
    const modelUploadServerQueueEl = document.getElementById('model-upload-server-queue');
    const modelUploadOverallProgress = document.getElementById('model-upload-overall-progress');
    const modelUploadOverallFill = document.getElementById('model-upload-overall-fill');
    const modelUploadOverallLabel = document.getElementById('model-upload-overall-label');
    const modelUploadFooterStatus = document.getElementById('model-upload-modal-footer-status');
    const modelUploadCloseBtn = document.getElementById('model-upload-close');

    /** 処理中は閉じるボタンを非表示にする */
    function syncModelUploadCloseButtonVisibility() {
        if (!modelUploadCloseBtn) return;
        modelUploadCloseBtn.style.display = modelUploadModalBusy ? 'none' : '';
    }

    /** 「リサイズしない」チェック時は長辺上限セレクトを無効化する */
    function syncModelUploadTextureEdgeControlState() {
        const skipTexEl = document.getElementById('model-upload-skip-texture-resize');
        const edgeEl = document.getElementById('model-upload-texture-max-edge');
        if (!edgeEl) return;
        edgeEl.disabled = !!(skipTexEl && skipTexEl.checked);
    }

    /** アップロード種別に応じてモーダル内の説明と 3D 専用ブロックの表示を切り替える */
    function syncModelUploadKindUI() {
        const kind = document.querySelector('input[name="model-upload-kind"]:checked')?.value || 'model';
        const block3d = document.getElementById('model-upload-3d-only');
        const hModel = document.getElementById('model-upload-hint-model');
        const hPref = document.getElementById('model-upload-hint-prefab');
        const hPdf = document.getElementById('model-upload-hint-pdf');
        const hHdr = document.getElementById('model-upload-hint-hdr');
        const textureEdgeRow = document.querySelector('.model-upload-texture-max-edge-row');
        const skipTexRow = document.querySelector('.model-upload-skip-texture-row');
        const isModel = kind === 'model';
        const isPrefab = kind === 'prefab';
        const show3d = isModel || isPrefab;
        if (block3d) block3d.hidden = !show3d;
        if (hModel) hModel.hidden = !isModel;
        if (hPref) hPref.hidden = !isPrefab;
        if (hPdf) hPdf.hidden = kind !== 'pdf';
        if (hHdr) hHdr.hidden = kind !== 'hdr';
        if (textureEdgeRow) textureEdgeRow.hidden = !show3d;
        if (skipTexRow) skipTexRow.hidden = !show3d;
        syncModelUploadTextureEdgeControlState();
    }

    /** PDF アップロード結果をパネルと（モーダル表示中なら）モーダル下部にも出す */
    function setDualPdfUploadStatus(msg, cls) {
        const panelStatus = document.getElementById('upload-pdf-status');
        if (panelStatus) {
            panelStatus.textContent = msg;
            panelStatus.className = cls || '';
        }
        if (modelUploadFooterStatus && modelUploadModal?.classList.contains('show')) {
            modelUploadFooterStatus.textContent = msg;
            modelUploadFooterStatus.className = cls || '';
        }
    }

    /** HDR アップロード結果をパネルと（モーダル表示中なら）モーダル下部にも出す */
    function setDualHdrUploadStatus(msg, cls) {
        const panelStatus = document.getElementById('upload-hdr-status');
        if (panelStatus) {
            panelStatus.textContent = msg;
            panelStatus.className = cls || '';
        }
        if (modelUploadFooterStatus && modelUploadModal?.classList.contains('show')) {
            modelUploadFooterStatus.textContent = msg;
            modelUploadFooterStatus.className = cls || '';
        }
    }

    for (const el of document.querySelectorAll('input[name="model-upload-kind"]')) {
        el.addEventListener('change', () => syncModelUploadKindUI());
    }
    document.getElementById('model-upload-skip-texture-resize')?.addEventListener('change', () => {
        syncModelUploadTextureEdgeControlState();
    });
    syncModelUploadKindUI();

    /** サーバ側 GLB キュー表示のポーリングを止める */
    function stopModelUploadQueuePoll() {
        if (modelUploadQueuePollId) {
            clearInterval(modelUploadQueuePollId);
            modelUploadQueuePollId = null;
        }
        activeGlbServerPhaseUi = null;
    }

    /** @param {{ waiting?: number, processing?: boolean }|null} q */
    function applyServerQueueToLabel(q) {
        if (!modelUploadServerQueueEl) return;
        if (!q || typeof q.waiting !== 'number') {
            modelUploadServerQueueEl.textContent = '';
            return;
        }
        let proc = 'リサイズ処理待ち';
        if (q.processing) proc = 'リサイズ処理を実行中';
        modelUploadServerQueueEl.textContent = `サーバ側 GLB: 待ち ${q.waiting} 件、${proc}`;
    }

    /** @param {{ waiting?: number, processing?: boolean }|null} q */
    function applyActiveGlbRowFromQueue(q) {
        if (!activeGlbServerPhaseUi || !q || typeof q.waiting !== 'number') return;
        if (q.processing) {
            activeGlbServerPhaseUi.setStatus('リサイズ中…', 'muted');
        } else {
            activeGlbServerPhaseUi.setStatus('サーバで処理中…', 'muted');
        }
    }

    function startModelUploadQueuePoll() {
        stopModelUploadQueuePoll();
        modelUploadQueuePollId = setInterval(async () => {
            try {
                const res = await fetch('/admin/model-upload-queue', { credentials: 'include' });
                if (!res.ok) return;
                const q = await res.json();
                applyServerQueueToLabel(q);
                applyActiveGlbRowFromQueue(q);
            } catch (_) {
                /* ignore */
            }
        }, 500);
    }

    /**
     * アップロード進捗付きで /admin/upload に POST する。
     * @param {string} url
     * @param {File} file
     * @param {(ratio: number) => void} [onUploadProgress]
     * @param {() => void} [onUploadBytesSent] リクエストボディの送信完了後（サーバ処理待ち）。GLB のテクスチャリサイズ中など。
     * @param {boolean} [skipTextureResize] true のとき GLB のテクスチャ長辺縮小を行わない
     * @param {string} [textureMaxEdgeStr] 縮小する場合の長辺上限（px）の数字文字列
     * @returns {Promise<{ status: number, text: string, json: object|null }>}
     */
    function postAdminModelUploadXHR(
        url,
        file,
        onUploadProgress,
        onUploadBytesSent,
        skipTextureResize,
        textureMaxEdgeStr
    ) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.withCredentials = true;
            xhr.addEventListener('load', () => {
                let json = null;
                const text = xhr.responseText || '';
                try {
                    json = text ? JSON.parse(text) : null;
                } catch (_) {
                    json = null;
                }
                resolve({ status: xhr.status, text, json });
            });
            xhr.addEventListener('error', () => reject(new Error('ネットワークエラー（XHR）')));
            xhr.upload.addEventListener('progress', (ev) => {
                if (ev.lengthComputable && typeof onUploadProgress === 'function') {
                    onUploadProgress(ev.loaded / ev.total);
                }
            });
            xhr.upload.addEventListener('load', () => {
                if (typeof onUploadBytesSent === 'function') onUploadBytesSent();
            });
            const form = new FormData();
            form.append('model', file);
            form.append('filename_b64', btoa(unescape(encodeURIComponent(file.name))));
            if (skipTextureResize) form.append('skipTextureResize', '1');
            else if (textureMaxEdgeStr) form.append('textureMaxEdge', textureMaxEdgeStr);
            xhr.send(form);
        });
    }

    /**
     * GLB はボディ送信後にサーバでテクスチャリサイズ等を行う。キュー API と行表示を同期する。
     * @param {{ setStatus: (t: string, c?: string) => void }} ui
     * @param {string} fileName
     */
    /**
     * @param {boolean} [skipTextureResize]
     */
    function onModelUploadBytesSentIfGlb(ui, fileName, skipTextureResize) {
        if (!fileName.toLowerCase().endsWith('.glb')) return undefined;
        return () => {
            activeGlbServerPhaseUi = ui;
            ui.setStatus(skipTextureResize ? 'サーバで保存中…' : 'リサイズ中…', 'muted');
        };
    }

    /**
     * アップロード完了時に activeGlbServerPhaseUi を外すラッパー。
     * @param {string} url
     * @param {File} file
     * @param {(ratio: number) => void} [onUploadProgress]
     * @param {{ setStatus: (t: string, c?: string) => void }} ui
     * @param {string} fileName
     * @param {boolean} [skipTextureResize]
     * @param {string} [textureMaxEdgeStr]
     */
    async function postAdminModelUploadWithPhaseCleanup(
        url,
        file,
        onUploadProgress,
        ui,
        fileName,
        skipTextureResize,
        textureMaxEdgeStr
    ) {
        try {
            return await postAdminModelUploadXHR(
                url,
                file,
                onUploadProgress,
                onModelUploadBytesSentIfGlb(ui, fileName, skipTextureResize),
                skipTextureResize,
                textureMaxEdgeStr
            );
        } finally {
            if (activeGlbServerPhaseUi === ui) activeGlbServerPhaseUi = null;
        }
    }

    function setModelUploadModalOpen(open) {
        if (!modelUploadModal) return;
        if (open) modelUploadModal.classList.add('show');
        else modelUploadModal.classList.remove('show');
    }

    /**
     * @param {string} fileName
     * @returns {{ row: HTMLElement, setStatus: (t: string, c?: string) => void, setProgress: (r: number) => void, setErrorDetail: (t: string) => void }}
     */
    function createModelUploadRow(fileName) {
        const row = document.createElement('div');
        row.className = 'model-upload-row';
        const nameEl = document.createElement('div');
        nameEl.className = 'model-upload-row-name';
        nameEl.textContent = fileName;
        const statusEl = document.createElement('div');
        statusEl.className = 'model-upload-row-status muted';
        statusEl.textContent = '待機中';
        const barWrap = document.createElement('div');
        barWrap.className = 'model-upload-row-bar';
        const barFill = document.createElement('div');
        barFill.className = 'model-upload-row-bar-fill';
        barWrap.appendChild(barFill);
        let detailEl = null;
        row.appendChild(nameEl);
        row.appendChild(statusEl);
        row.appendChild(barWrap);
        return {
            row,
            setStatus(text, cls) {
                statusEl.textContent = text;
                statusEl.className = 'model-upload-row-status' + (cls ? ` ${cls}` : '');
            },
            setProgress(ratio) {
                const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
                barFill.style.width = `${pct}%`;
            },
            setErrorDetail(text) {
                if (!text) return;
                if (!detailEl) {
                    detailEl = document.createElement('details');
                    detailEl.className = 'model-upload-row-detail';
                    const sum = document.createElement('summary');
                    sum.textContent = '技術詳細';
                    detailEl.appendChild(sum);
                    row.appendChild(detailEl);
                }
                detailEl.querySelectorAll('pre').forEach((n) => n.remove());
                const pre = document.createElement('pre');
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.wordBreak = 'break-all';
                pre.textContent = text;
                detailEl.appendChild(pre);
            },
        };
    }

    function updateOverallProgress(doneCount, total, currentRatio) {
        if (!modelUploadOverallProgress || !modelUploadOverallFill || !modelUploadOverallLabel) return;
        if (total <= 0) {
            modelUploadOverallProgress.style.display = 'none';
            return;
        }
        modelUploadOverallProgress.style.display = 'block';
        const base = doneCount / total;
        const slice = currentRatio / total;
        const pct = Math.round(Math.min(1, base + slice) * 100);
        modelUploadOverallFill.style.width = `${pct}%`;
        modelUploadOverallLabel.textContent = `全体 ${doneCount} / ${total} 件（${pct}%）`;
    }

    document.getElementById('btn-model-upload-open')?.addEventListener('click', () => {
        if (!modelUploadModal) return;
        if (modelUploadFooterStatus) {
            modelUploadFooterStatus.textContent = '';
            modelUploadFooterStatus.className = '';
        }
        if (modelUploadFileList) modelUploadFileList.innerHTML = '';
        applyServerQueueToLabel(null);
        const modelKindRadio = document.querySelector('input[name="model-upload-kind"][value="model"]');
        if (modelKindRadio) modelKindRadio.checked = true;
        syncModelUploadKindUI();
        syncModelUploadTextureEdgeControlState();
        modelUploadModalBusy = false;
        syncModelUploadCloseButtonVisibility();
        setModelUploadModalOpen(true);
    });

    document.getElementById('model-upload-pick')?.addEventListener('click', () => {
        const kind = document.querySelector('input[name="model-upload-kind"]:checked')?.value || 'model';
        if (kind === 'model') modelUploadInput?.click();
        else if (kind === 'prefab') document.getElementById('model-upload-zip-input')?.click();
        else if (kind === 'pdf') document.getElementById('upload-pdf-input')?.click();
        else if (kind === 'hdr') document.getElementById('upload-hdr-input')?.click();
    });

    document.getElementById('model-upload-close')?.addEventListener('click', () => {
        if (modelUploadModalBusy) return;
        setModelUploadModalOpen(false);
    });

    if (modelUploadModal) {
        modelUploadModal.addEventListener('click', (ev) => {
            if (ev.target !== modelUploadModal) return;
            if (modelUploadModalBusy) return;
            setModelUploadModalOpen(false);
        });
    }

    const showOverwriteSelectionCard = (targetNames) => new Promise((resolve) => {
        const modal = document.getElementById('overwrite-select-modal');
        const listEl = document.getElementById('overwrite-select-list');
        const applyBtn = document.getElementById('overwrite-select-apply');
        const cancelBtn = document.getElementById('overwrite-select-cancel');
        const checkAllBtn = document.getElementById('overwrite-select-check-all');
        const uncheckAllBtn = document.getElementById('overwrite-select-uncheck-all');
        if (!modal || !listEl || !applyBtn || !cancelBtn || !checkAllBtn || !uncheckAllBtn) {
            resolve(new Set(targetNames));
            return;
        }

        const uniqueNames = [...new Set(targetNames)];
        listEl.innerHTML = '';
        for (const name of uniqueNames) {
            const row = document.createElement('label');
            row.className = 'overwrite-select-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = name;
            checkbox.checked = true;
            const nameEl = document.createElement('span');
            nameEl.className = 'overwrite-select-item-name';
            nameEl.textContent = name;
            row.appendChild(checkbox);
            row.appendChild(nameEl);
            listEl.appendChild(row);
        }

        const getCheckedNames = () => new Set(
            Array.from(listEl.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value)
        );

        const cleanup = () => {
            applyBtn.removeEventListener('click', handleApply);
            cancelBtn.removeEventListener('click', handleCancel);
            checkAllBtn.removeEventListener('click', handleCheckAll);
            uncheckAllBtn.removeEventListener('click', handleUncheckAll);
            modal.removeEventListener('click', handleBackdropClick);
            modal.classList.remove('show');
        };

        const handleApply = () => {
            const selected = getCheckedNames();
            cleanup();
            resolve(selected);
        };
        const handleCancel = () => {
            cleanup();
            resolve(null);
        };
        const handleCheckAll = () => {
            for (const el of listEl.querySelectorAll('input[type="checkbox"]')) el.checked = true;
        };
        const handleUncheckAll = () => {
            for (const el of listEl.querySelectorAll('input[type="checkbox"]')) el.checked = false;
        };
        const handleBackdropClick = (event) => {
            if (event.target !== modal) return;
            cleanup();
            resolve(null);
        };

        applyBtn.addEventListener('click', handleApply);
        cancelBtn.addEventListener('click', handleCancel);
        checkAllBtn.addEventListener('click', handleCheckAll);
        uncheckAllBtn.addEventListener('click', handleUncheckAll);
        modal.addEventListener('click', handleBackdropClick);
        modal.classList.add('show');
    });
    document.getElementById('upload-pdf-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const inModal = modelUploadModal?.classList.contains('show');
        let didSetBusy = false;
        try {
            if (inModal) {
                modelUploadModalBusy = true;
                didSetBusy = true;
                syncModelUploadCloseButtonVisibility();
            }
            setDualPdfUploadStatus('', '');
            const name = file.name.toLowerCase().endsWith('.pdf') ? file.name : file.name + '.pdf';
            const exists = pdfList.some((n) => n.toLowerCase() === name.toLowerCase());
            let url = '/admin/upload-pdf';
            if (exists && !confirm('同名ファイルがあります。上書きしますか？')) {
                return;
            }
            if (exists) url += '?confirm=1';
            const form = new FormData();
            form.append('pdf', file);
            // サーバー側の文字化けを防ぐためファイル名を UTF-8 → base64 で送る
            form.append('filename_b64', btoa(unescape(encodeURIComponent(file.name))));
            const res = await fetch(url, { method: 'POST', credentials: 'include', body: form });
            if (res.status === 409) {
                setDualPdfUploadStatus('同名ファイルがあります。上書きするには確認して再送信してください。', 'error');
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            const pdfData = await res.json();
            if (!pdfData.success || !pdfData.filename) throw new Error('アップロード応答が不正です');
            await notifyServiceWorkerInvalidate([encodeAssetPathToUrlPath('pdfs/' + pdfData.filename)]);
            await fetchPdfs();
            renderPdfList();
            const newPath = 'pdfs/' + pdfData.filename;
            selectedPdfPath = newPath;
            loadPdfPreview(newPath);
            setDualPdfUploadStatus('アップロードしました: ' + pdfData.filename, 'success');
            if (inModal) setModelUploadModalOpen(false);
        } catch (err) {
            setDualPdfUploadStatus('アップロード失敗: ' + err.message, 'error');
        } finally {
            if (didSetBusy) {
                modelUploadModalBusy = false;
                syncModelUploadCloseButtonVisibility();
            }
            e.target.value = '';
        }
    });

    document.getElementById('upload-hdr-input')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const inModal = modelUploadModal?.classList.contains('show');
        let didSetBusy = false;
        try {
            if (inModal) {
                modelUploadModalBusy = true;
                didSetBusy = true;
                syncModelUploadCloseButtonVisibility();
            }
            setDualHdrUploadStatus('', '');
            const result = await uploadDefaultHdrForWorldEditor(file);
            if (result.cancelled) {
                return;
            }
            if (!result.ok) {
                setDualHdrUploadStatus(result.message || 'アップロード失敗', 'error');
                return;
            }
            setDualHdrUploadStatus('アップロードしました: default.hdr（プレビューに反映済み）', 'success');
            await refreshWeHdrPanel();
            if (inModal) setModelUploadModalOpen(false);
        } catch (err) {
            setDualHdrUploadStatus('アップロード失敗: ' + (err instanceof Error ? err.message : String(err)), 'error');
        } finally {
            if (didSetBusy) {
                modelUploadModalBusy = false;
                syncModelUploadCloseButtonVisibility();
            }
            e.target.value = '';
        }
    });

    modelUploadInput?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        const status = document.getElementById('upload-status');
        if (status) {
            status.textContent = '';
            status.className = '';
        }
        if (modelUploadFooterStatus) {
            modelUploadFooterStatus.textContent = '';
            modelUploadFooterStatus.className = '';
        }
        if (!modelUploadFileList) return;

        modelUploadModalBusy = true;
        syncModelUploadCloseButtonVisibility();
        startModelUploadQueuePoll();

        const isMultipleUpload = files.length > 1;
        const entries = files.map((file) => ({ file, name: file.name.replace(/^.*[/\\]/, '') }));
        const rowUi = entries.map((en) => {
            const ui = createModelUploadRow(en.name);
            modelUploadFileList.appendChild(ui.row);
            return { ...en, ui };
        });
        const total = entries.length;
        let completedFiles = 0;

        const lowerModelNames = new Set(modelList.map((n) => n.toLowerCase()));
        const overwriteTargets = entries
            .map((entry) => entry.name)
            .filter((name) => lowerModelNames.has(name.toLowerCase()));

        let approvedOverwriteNames = new Set();
        if (isMultipleUpload && overwriteTargets.length > 0) {
            const selectedNames = await showOverwriteSelectionCard(overwriteTargets);
            if (selectedNames === null) {
                if (modelUploadFooterStatus) modelUploadFooterStatus.textContent = 'アップロードをキャンセルしました';
                modelUploadModalBusy = false;
                syncModelUploadCloseButtonVisibility();
                stopModelUploadQueuePoll();
                return;
            }
            approvedOverwriteNames = selectedNames;
        }

        const skipTexEl = document.getElementById('model-upload-skip-texture-resize');
        const skipTextureResize = !!(skipTexEl && skipTexEl.checked);
        const textureMaxEdgeEl = document.getElementById('model-upload-texture-max-edge');
        const textureMaxEdgeStr =
            !skipTextureResize && textureMaxEdgeEl && !textureMaxEdgeEl.disabled
                ? String(textureMaxEdgeEl.value).trim()
                : '';

        let ok = 0;
        let skipped = 0;
        let failed = 0;
        let lastErr = '';
        let needMtlRefresh = false;
        const conflictEntries = [];

        /**
         * @param {object} uploadData
         * @param {{ setStatus: Function, setProgress: Function, setErrorDetail: Function }} ui
         */
        function applyTextureResizeStatus(uploadData, ui) {
            let msg = '保存しました';
            let cls = 'ok';
            if (uploadData.textureResize) {
                const tr = uploadData.textureResize;
                if (tr.skippedByClient && tr.message) {
                    msg = tr.message;
                } else if (tr.applied) {
                    msg = tr.message || 'テクスチャを縮小して保存しました';
                } else if (tr.error) {
                    msg = tr.error;
                    cls = 'warn';
                    if (tr.errorDetail) ui.setErrorDetail(tr.errorDetail);
                }
            }
            if (uploadData.objectSplit?.applied && Array.isArray(uploadData.splitFiles)) {
                msg += ` オブジェクト分割: ${uploadData.splitFiles.length} ファイル（${uploadData.splitFiles.join('、')}）。`;
            } else if (uploadData.objectSplit && uploadData.objectSplit.applied === false) {
                const r = uploadData.objectSplit.reason || '';
                msg += ` オブジェクト分割は未実施（${r}）。単体 GLB を保存しました。`;
            }
            ui.setStatus(msg, cls);
            ui.setProgress(1);
        }

        for (const { file, name, ui } of rowUi) {
            updateOverallProgress(completedFiles, total, 0);
            const exists = lowerModelNames.has(name.toLowerCase());
            let url = '/admin/upload';
            if (exists) {
                if (isMultipleUpload) {
                    if (!approvedOverwriteNames.has(name)) {
                        ui.setStatus('スキップ（上書き対象外）', 'muted');
                        ui.setProgress(1);
                        skipped++;
                        completedFiles++;
                        updateOverallProgress(completedFiles, total, 0);
                        continue;
                    }
                    url += '?confirm=1';
                } else if (!confirm(`「${name}」は既にあります。上書きしますか？`)) {
                    ui.setStatus('スキップ', 'muted');
                    ui.setProgress(1);
                    skipped++;
                    completedFiles++;
                    updateOverallProgress(completedFiles, total, 0);
                    continue;
                } else {
                    url += '?confirm=1';
                }
            }

            ui.setStatus('アップロード中…', 'muted');
            ui.setProgress(0);

            try {
                let xhrRes = await postAdminModelUploadWithPhaseCleanup(
                    url,
                    file,
                    (r) => {
                        ui.setProgress(r);
                        updateOverallProgress(completedFiles, total, r);
                    },
                    ui,
                    name,
                    skipTextureResize,
                    textureMaxEdgeStr
                );

                if (xhrRes.status === 409) {
                    if (isMultipleUpload) {
                        conflictEntries.push({ file, name, ui });
                        ui.setStatus('同名あり（確認待ち）', 'muted');
                        ui.setProgress(0);
                        completedFiles++;
                        updateOverallProgress(completedFiles, total, 0);
                        continue;
                    }
                    const shouldConfirmConflictOverwrite = confirm(`「${name}」は既にあります。上書きしますか？`);
                    if (!shouldConfirmConflictOverwrite) {
                        ui.setStatus('スキップ', 'muted');
                        ui.setProgress(1);
                        skipped++;
                        completedFiles++;
                        updateOverallProgress(completedFiles, total, 0);
                        continue;
                    }
                    xhrRes = await postAdminModelUploadWithPhaseCleanup(
                        '/admin/upload?confirm=1',
                        file,
                        (r) => {
                            ui.setProgress(r);
                            updateOverallProgress(completedFiles, total, r);
                        },
                        ui,
                        name,
                        skipTextureResize,
                        textureMaxEdgeStr
                    );
                    if (xhrRes.status === 409) {
                        lastErr = '同名の上書き確認が必要: ' + name;
                        ui.setStatus(lastErr, 'warn');
                        failed++;
                        completedFiles++;
                        updateOverallProgress(completedFiles, total, 0);
                        continue;
                    }
                }

                if (xhrRes.status !== 200 || !xhrRes.json) {
                    throw new Error(xhrRes.text || `HTTP ${xhrRes.status}`);
                }
                const uploadData = xhrRes.json;
                if (!uploadData.success || !uploadData.filename) throw new Error('アップロード応答が不正です');
                /** @type {string[]} */
                const inv = [];
                if (uploadData.objectSplit?.applied && Array.isArray(uploadData.splitFiles)) {
                    for (const f of uploadData.splitFiles) {
                        inv.push(encodeAssetPathToUrlPath(`models/${f}`));
                    }
                } else {
                    inv.push(encodeAssetPathToUrlPath('models/' + uploadData.filename));
                }
                await notifyServiceWorkerInvalidate(inv);
                await fetchModels();
                if (name.toLowerCase().endsWith('.mtl')) needMtlRefresh = true;
                applyTextureResizeStatus(uploadData, ui);
                ok++;
            } catch (err) {
                lastErr = err.message || String(err);
                ui.setStatus('失敗: ' + lastErr, 'warn');
                ui.setProgress(1);
                failed++;
            }

            completedFiles++;
            updateOverallProgress(completedFiles, total, 0);
        }

        if (conflictEntries.length > 0) {
            const conflictNames = conflictEntries.map((entry) => entry.name);
            const selectedConflictNames = await showOverwriteSelectionCard(conflictNames);
            if (selectedConflictNames === null) {
                skipped += conflictEntries.length;
                for (const { ui } of conflictEntries) {
                    ui.setStatus('キャンセル（同名未解決）', 'muted');
                }
            } else {
                for (const { file, name, ui } of conflictEntries) {
                    if (!selectedConflictNames.has(name)) {
                        skipped++;
                        ui.setStatus('スキップ', 'muted');
                        ui.setProgress(1);
                        continue;
                    }
                    ui.setStatus('アップロード中…', 'muted');
                    ui.setProgress(0);
                    try {
                        const xhrRes = await postAdminModelUploadWithPhaseCleanup(
                            '/admin/upload?confirm=1',
                            file,
                            (r) => {
                                ui.setProgress(r);
                            },
                            ui,
                            name,
                            skipTextureResize,
                            textureMaxEdgeStr
                        );
                        if (xhrRes.status === 409) {
                            lastErr = '同名の上書き確認が必要: ' + name;
                            ui.setStatus(lastErr, 'warn');
                            failed++;
                            continue;
                        }
                        if (xhrRes.status !== 200 || !xhrRes.json) {
                            throw new Error(xhrRes.text || `HTTP ${xhrRes.status}`);
                        }
                        const uploadDataRetry = xhrRes.json;
                        if (!uploadDataRetry.success || !uploadDataRetry.filename) {
                            throw new Error('アップロード応答が不正です');
                        }
                        /** @type {string[]} */
                        const invR = [];
                        if (uploadDataRetry.objectSplit?.applied && Array.isArray(uploadDataRetry.splitFiles)) {
                            for (const f of uploadDataRetry.splitFiles) {
                                invR.push(encodeAssetPathToUrlPath(`models/${f}`));
                            }
                        } else {
                            invR.push(encodeAssetPathToUrlPath('models/' + uploadDataRetry.filename));
                        }
                        await notifyServiceWorkerInvalidate(invR);
                        await fetchModels();
                        if (name.toLowerCase().endsWith('.mtl')) needMtlRefresh = true;
                        applyTextureResizeStatus(uploadDataRetry, ui);
                        ok++;
                    } catch (err) {
                        lastErr = err.message || String(err);
                        ui.setStatus('失敗: ' + lastErr, 'warn');
                        ui.setProgress(1);
                        failed++;
                    }
                }
            }
        }

        stopModelUploadQueuePoll();
        applyServerQueueToLabel(null);
        modelUploadModalBusy = false;
        const autoCloseModelUpload =
            ok > 0 && failed === 0 && modelUploadModal?.classList.contains('show');
        if (!autoCloseModelUpload) syncModelUploadCloseButtonVisibility();

        if (needMtlRefresh) await fetchMtls();
        renderModelList();
        const parts = [];
        if (ok) parts.push(`成功 ${ok} 件`);
        if (skipped) parts.push(`スキップ ${skipped} 件`);
        if (failed) parts.push(`失敗 ${failed} 件`);
        const summary = parts.length ? parts.join('、') : 'ファイルがありませんでした';
        if (status) status.textContent = summary;
        if (modelUploadFooterStatus) {
            modelUploadFooterStatus.textContent = summary;
            if (failed || (skipped === files.length && !ok)) modelUploadFooterStatus.className = 'error';
            else if (ok) modelUploadFooterStatus.className = 'success';
        }
        if (failed || (skipped === files.length && !ok)) {
            if (status) status.className = 'error';
            if (lastErr && failed && status) status.textContent += ' — ' + lastErr;
            if (lastErr && failed && modelUploadFooterStatus && !modelUploadFooterStatus.textContent.includes(lastErr)) {
                modelUploadFooterStatus.textContent += ' — ' + lastErr;
            }
        }
        if (autoCloseModelUpload) setModelUploadModalOpen(false);
    });

    document.getElementById('model-upload-zip-input')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (!String(file.name || '').toLowerCase().endsWith('.zip')) {
            window.alert('Prefab 用には拡張子 .zip のファイルを選んでください。');
            return;
        }
        const status = document.getElementById('upload-status');
        if (status) {
            status.textContent = '';
            status.className = '';
        }
        if (modelUploadFooterStatus) {
            modelUploadFooterStatus.textContent = '';
            modelUploadFooterStatus.className = '';
        }
        if (!modelUploadFileList) return;

        modelUploadModalBusy = true;
        syncModelUploadCloseButtonVisibility();

        const ui = createModelUploadRow(file.name);
        modelUploadFileList.appendChild(ui.row);
        ui.setStatus('ZIP をアップロード中…', 'muted');
        ui.setProgress(0);

        const skipTexEl = document.getElementById('model-upload-skip-texture-resize');
        const skipTextureResize = !!(skipTexEl && skipTexEl.checked);
        const textureMaxEdgeEl = document.getElementById('model-upload-texture-max-edge');
        const textureMaxEdgeStr =
            !skipTextureResize && textureMaxEdgeEl && !textureMaxEdgeEl.disabled
                ? String(textureMaxEdgeEl.value).trim()
                : '';

        const postZip = (confirmFlag) =>
            new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                const url = '/admin/upload-prefab-zip' + (confirmFlag ? '?confirm=1' : '');
                xhr.open('POST', url);
                xhr.withCredentials = true;
                xhr.addEventListener('load', () => {
                    let json = null;
                    const text = xhr.responseText || '';
                    try {
                        json = text ? JSON.parse(text) : null;
                    } catch {
                        json = null;
                    }
                    resolve({ status: xhr.status, text, json });
                });
                xhr.addEventListener('error', () => reject(new Error('ネットワークエラー（XHR）')));
                xhr.upload.addEventListener('progress', (ev) => {
                    if (ev.lengthComputable) {
                        ui.setProgress(ev.loaded / ev.total);
                    }
                });
                const form = new FormData();
                form.append('zip', file, file.name);
                if (skipTextureResize) form.append('skipTextureResize', '1');
                else if (textureMaxEdgeStr) form.append('textureMaxEdge', textureMaxEdgeStr);
                xhr.send(form);
            });

        try {
            let xhrRes = await postZip(false);
            if (xhrRes.status === 409 && xhrRes.json && Array.isArray(xhrRes.json.conflictingFiles)) {
                const names = xhrRes.json.conflictingFiles;
                const head = names.slice(0, 25).join('\n');
                const more = names.length > 25 ? `\n…他 ${names.length - 25} 件` : '';
                if (
                    !confirm(
                        `次のファイルが既に存在します。上書きしますか？\n\n${head}${more}`
                    )
                ) {
                    ui.setStatus('キャンセル', 'muted');
                    ui.setProgress(1);
                    modelUploadModalBusy = false;
                    syncModelUploadCloseButtonVisibility();
                    if (modelUploadFooterStatus) modelUploadFooterStatus.textContent = 'キャンセルしました';
                    return;
                }
                xhrRes = await postZip(true);
            }
            if (xhrRes.status !== 200 || !xhrRes.json || !xhrRes.json.success) {
                const errMsg = xhrRes.json?.error || xhrRes.text || `HTTP ${xhrRes.status}`;
                throw new Error(errMsg);
            }
            const data = xhrRes.json;
            const inv = (data.writtenFiles || []).map((rel) =>
                encodeAssetPathToUrlPath('models/' + String(rel).replace(/^\/+/, ''))
            );
            if (inv.length) await notifyServiceWorkerInvalidate(inv);
            await fetchModels();
            renderModelList();
            const pm = data.prefabManifest || '';
            ui.setStatus(`保存しました${pm ? `（${pm}）` : ''}`, 'ok');
            ui.setProgress(1);
            if (modelUploadFooterStatus) {
                modelUploadFooterStatus.textContent = 'Prefab ZIP の処理が完了しました';
                modelUploadFooterStatus.className = 'success';
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ui.setStatus('失敗: ' + msg, 'warn');
            ui.setProgress(1);
            if (modelUploadFooterStatus) {
                modelUploadFooterStatus.textContent = msg;
                modelUploadFooterStatus.className = 'error';
            }
        } finally {
            modelUploadModalBusy = false;
            syncModelUploadCloseButtonVisibility();
        }
    });

    document.getElementById('btn-add-light').addEventListener('click', () => {
        if (!selectedWorldId) return;
        const type = prompt('種類: ambient / directional / point / spot', 'point');
        if (!['ambient', 'directional', 'point', 'spot'].includes(type)) return;
        pushUndo();
        const world = worlds[selectedWorldId];
        if (!world.lights) world.lights = [];
        const cfg = { type, intensity: 1, color: 0xffffff };
        if (type !== 'ambient') cfg.position = { x: 0, y: 5, z: 5 };
        if (type === 'point' || type === 'spot') cfg.distance = 50;
        world.lights.push(cfg);
        void (async () => {
            setWorldEditLoader(true, 'ライトを反映しています…');
            try {
                await loadWorldIntoScene(world);
            } finally {
                setWorldEditLoader(false);
            }
        })();
    });

    document.getElementById('world-name').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        worlds[selectedWorldId].name = document.getElementById('world-name').value.trim() || selectedWorldId;
    });

    document.getElementById('spawn-x').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.x = parseFloat(document.getElementById('spawn-x').value) || 0; } });
    document.getElementById('spawn-y').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.y = parseFloat(document.getElementById('spawn-y').value) || 10; updatePhysicsAssistSpawnHint(); } });
    document.getElementById('spawn-z').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.z = parseFloat(document.getElementById('spawn-z').value) || 0; } });
    document.getElementById('floor-enabled').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        worlds[selectedWorldId].floorEnabled = document.getElementById('floor-enabled').checked;
        if (editorGround) editorGround.visible = worlds[selectedWorldId].floorEnabled;
        if (editorGrid) editorGrid.visible = worlds[selectedWorldId].floorEnabled;
    });

    function applyFloorDimsFromInputs() {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        const w = worlds[selectedWorldId];
        w.floorWidth = parseFloat(document.getElementById('floor-width')?.value) || DEFAULT_FLOOR_WIDTH_M;
        w.floorDepth = parseFloat(document.getElementById('floor-depth')?.value) || DEFAULT_FLOOR_DEPTH_M;
        applyEditorFloorMeshFromWorld(w);
    }

    document.getElementById('floor-width').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        applyFloorDimsFromInputs();
    });
    document.getElementById('floor-depth').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        applyFloorDimsFromInputs();
    });

    function applyPhysicsAssistPanelToSelectedWorld() {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        const w = worlds[selectedWorldId];
        const paEn = document.getElementById('physics-assist-enabled')?.checked;
        const minRaw = document.getElementById('physics-assist-min-y')?.value?.trim() ?? '';
        const maxRaw = document.getElementById('physics-assist-max-y')?.value?.trim() ?? '';
        if (paEn) {
            w.physicsAssist = { enabled: true };
            if (minRaw !== '') {
                const n = parseFloat(minRaw);
                if (Number.isFinite(n)) w.physicsAssist.minFeetY = n;
            }
            if (maxRaw !== '') {
                const n = parseFloat(maxRaw);
                if (Number.isFinite(n)) w.physicsAssist.maxFeetY = n;
            }
        } else {
            delete w.physicsAssist;
        }
        updatePhysicsAssistSpawnHint();
    }

    document.getElementById('physics-assist-enabled')?.addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        applyPhysicsAssistPanelToSelectedWorld();
    });
    document.getElementById('physics-assist-min-y')?.addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        applyPhysicsAssistPanelToSelectedWorld();
    });
    document.getElementById('physics-assist-max-y')?.addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        applyPhysicsAssistPanelToSelectedWorld();
    });

    document.getElementById('light-pos-x').addEventListener('change', syncLightFromPanel);
    document.getElementById('light-pos-y').addEventListener('change', syncLightFromPanel);
    document.getElementById('light-pos-z').addEventListener('change', syncLightFromPanel);
    document.getElementById('light-intensity').addEventListener('change', syncLightFromPanel);
    document.getElementById('light-color').addEventListener('change', syncLightFromPanel);
    document.getElementById('light-distance').addEventListener('change', syncLightFromPanel);

    document.getElementById('btn-delete-light').addEventListener('click', () => {
        if (!selectedObject) return;
        pushUndo();
        const obj = selectedObject;
        if (obj.userData.lightRef) {
            const light = obj.userData.lightRef;
            editGroup.remove(light);
            editGroup.remove(obj);
            lightHelpers = lightHelpers.filter((h) => h.mesh !== obj && h.light !== light);
        } else if (obj.isLight) {
            editGroup.remove(obj);
            lightHelpers = lightHelpers.filter((h) => h.light !== obj);
        }
        selectedObject = null;
        transformControls.detach();
        document.getElementById('light-hint').style.display = 'block';
        document.getElementById('light-props').style.display = 'none';
        renderWorldObjectList();
    });

    const pdfPrevBtn = document.getElementById('we-pdf-prev');
    const pdfNextBtn = document.getElementById('we-pdf-next');
    if (pdfPrevBtn) {
        pdfPrevBtn.addEventListener('click', async () => {
            if (!previewPdfDoc || previewCurrentPage <= 1) return;
            await renderPdfPreviewPage(previewCurrentPage - 1);
        });
    }
    if (pdfNextBtn) {
        pdfNextBtn.addEventListener('click', async () => {
            if (!previewPdfDoc) return;
            if (previewCurrentPage >= previewPdfDoc.numPages) return;
            await renderPdfPreviewPage(previewCurrentPage + 1);
        });
    }

    // Transform mode
    const modeTranslate = document.createElement('button');
    modeTranslate.textContent = '移動';
    const modeRotate = document.createElement('button');
    modeRotate.textContent = '回転';
    const modeScale = document.createElement('button');
    modeScale.textContent = 'スケール';
    modeTranslate.addEventListener('click', () => { transformControls.setMode('translate'); transformControls.setSpace('world'); setTransformAxisAll(); });
    modeRotate.addEventListener('click', () => { transformControls.setMode('rotate'); transformControls.setSpace('local'); setTransformAxisAll(); });
    modeScale.addEventListener('click', () => { transformControls.setMode('scale'); transformControls.setSpace('local'); setTransformAxisAll(); });
    const panelObject = document.getElementById('panel-object');
    panelObject.insertBefore(modeTranslate, panelObject.firstChild.nextSibling);
    panelObject.insertBefore(modeRotate, modeTranslate.nextSibling);
    panelObject.insertBefore(modeScale, modeRotate.nextSibling);
}

function setTransformAxisAll() {
    if (!transformControls) return;
    transformControls.showX = true;
    transformControls.showY = true;
    transformControls.showZ = true;
}

// --- Init (export して admin から初回表示時に呼び出す) ---
async function init() {
    const canvas = document.getElementById('canvas');
    if (!canvas) {
        setWorldEditLoader(false);
        return;
    }
    try {
        const r = await fetch('/api/client-config');
        if (r.ok) {
            const j = await r.json();
            if (typeof j.chartFeaturesEnabled === 'boolean') {
                worldEditorChartFeaturesEnabled = j.chartFeaturesEnabled;
            }
        }
    } catch (_) {
        /* 既定 true */
    }
    setWorldEditLoader(true, 'ワールド編集を初期化しています…');
    try {
        initScene();
        bindEvents();
        const cached = readWorldEditCache();
        if (cached && applyWorldEditCacheToState(cached)) {
            renderWorldList();
            renderModelList();
            renderPdfList();
            populateDestWorldSelect();
        }
        setWorldEditLoader(true, 'サーバーからデータを取得しています…');
        try {
            await fetchWorlds();
            await fetchModels();
            await fetchMtls();
            await fetchPdfs();
            writeWorldEditCache();
        } catch (e) {
            console.error('Init fetch error:', e);
            const statusEl = document.getElementById('save-status');
            if (cached) {
                applyWorldEditCacheToState(cached);
                renderWorldList();
                renderModelList();
                renderPdfList();
                populateDestWorldSelect();
                if (statusEl) {
                    statusEl.textContent = 'サーバー取得に失敗しました。キャッシュを表示しています。';
                    statusEl.className = '';
                }
            } else if (statusEl) {
                statusEl.textContent = 'ワールド読み込み失敗: ' + e.message;
                statusEl.className = 'error';
            }
        }
        renderWorldList();
        renderModelList();
        renderPdfList();
        populateDestWorldSelect();
        setWorldEditLoader(true, '3Dモデルを読み込んでいます…');
        const ids = Object.keys(worlds);
        if (ids.length) {
            syncSelectWorldChrome(ids[0]);
            await loadWorldIntoScene(worlds[ids[0]]);
            if (worldEditorChartFeaturesEnabled) {
                await refreshTaikoChartSelect(null);
            }
        } else {
            syncSelectWorldChrome(null);
            await loadWorldIntoScene(EMPTY_EDITOR_WORLD);
        }
    } finally {
        setWorldEditLoader(false);
    }
    animate();
}

/** ワールド編集エディタを初期化する。admin パネル初表示時に 1 回だけ呼ぶ。 */
export async function initSettingEditor() {
    return init();
}
