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
    MODEL_MAX_BYTES_OBJ,
    MODEL_MAX_BYTES_GLTF,
    MODEL_MAX_TRIANGLES_TOTAL,
    MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD,
    fetchModelContentLength,
    countTrianglesInObject
} from './model-load-limits.js';
import { encodeAssetPathToUrlPath, notifyServiceWorkerInvalidate } from './service-worker-register.js';
import {
    mergeAircraftPhysicsFromWorld,
    clipAircraftPhysicsPartialFromUser,
    DEFAULT_AIRCRAFT_PHYSICS
} from './aircraft-physics-defaults.js';

// --- State ---
let scene, camera, renderer, controls, transformControls;
let editGroup;
let worlds = {};
let selectedWorldId = null;
let selectedObject = null;
let modelList = [];
let mtlList = []; // MTL ファイル名（models/ 配下、ファイル名のみ）
let selectedModelPath = null; // 左パネル「モデル一覧」で選択中のモデル（models/xxx.glb または .obj）
/** チャンク分割済み GLB 用。単体モデル時は null */
let selectedModelChunkManifest = null;
let pdfList = [];
let selectedPdfPath = null; // 左パネル「PDF一覧」で選択中のPDF（pdfs/xxx.pdf）
let lightHelpers = []; // { light, mesh? } for point/spot position drag
let worldObjectList = []; // 右パネル「オブジェクト一覧」の並び（クリックで選択用）
let objectListExpanded = { lights: false, models: false, pdfs: false }; // オブジェクト一覧の階層展開状態
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
const raycaster = new THREE.Raycaster();

/**
 * アセットパスを同一オリジンの絶対 URL に変換（セグメントごとに encode）
 * @param {string} assetPath - 例: models/foo.obj
 * @returns {string}
 */
function buildEncodedModelUrl(assetPath) {
    const pathStr = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return '/' + encodedPath;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isObjPath(path) {
    return typeof path === 'string' && path.toLowerCase().endsWith('.obj');
}

const CHUNKS_JSON_SUFFIX = '.chunks.json';

/** 単体 GLB/OBJ 等（チャンクマニフェストなし）— 八面体風シルエット */
const MODEL_ICON_3D_ASSET =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20.5 12 12 21.5 3.5 12 12 2.5z"/><path d="M12 2.5v19M3.5 12h17"/></svg>';

/** プレハブ（チャンク分割済み）— タイル状の複数パーツ */
const MODEL_ICON_PREFAB_CHUNKED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="7.5" height="6.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1"/><path stroke-width="1.25" d="M10.5 7.25h3M10.5 16.75h3M7.25 10.5v3M16.75 10.5v3"/></svg>';

/**
 * admin/models の生ファイル名一覧から、左パネル用エントリを作る。
 * チャンク GLB（*.chunk_*.glb）とマニフェスト（*.chunks.json）は一覧に出さない。
 * エクスプローラーは生一覧のまま。
 * @param {string[]} fileNames
 * @returns {{ displayLabel: string, path: string, chunkManifest?: string, prefabKind: 'prefab'|'model3d' }[]}
 */
function buildModelPrefabEntries(fileNames) {
    const names = Array.isArray(fileNames) ? fileNames : [];
    const set = new Set(names);
    /** @type {Set<string>} basename（拡張子なしパス）で .chunks.json が存在 */
    const basesWithManifest = new Set();
    for (const n of names) {
        const low = n.toLowerCase();
        if (low.endsWith(CHUNKS_JSON_SUFFIX.toLowerCase())) {
            basesWithManifest.add(n.slice(0, -CHUNKS_JSON_SUFFIX.length));
        }
    }
    /** @type {{ displayLabel: string, path: string, chunkManifest?: string, prefabKind: 'prefab'|'model3d' }[]} */
    const out = [];
    /** @type {Set<string>} チャンク付きプレハブとして既に出した basename */
    const usedChunkGroup = new Set();
    for (const name of names) {
        const low = name.toLowerCase();
        if (low.endsWith(CHUNKS_JSON_SUFFIX.toLowerCase())) {
            continue;
        }
        if (/\.chunk_\d+\.glb$/i.test(name)) {
            continue;
        }
        if (low.endsWith('.glb')) {
            const base = name.slice(0, -4);
            const manifestName = base + CHUNKS_JSON_SUFFIX;
            if (basesWithManifest.has(base) && set.has(manifestName)) {
                if (usedChunkGroup.has(base)) {
                    continue;
                }
                usedChunkGroup.add(base);
                const displayLabel = name.replace(/\.glb$/i, '');
                out.push({
                    displayLabel,
                    path: 'models/' + name,
                    chunkManifest: 'models/' + manifestName,
                    prefabKind: 'prefab'
                });
                continue;
            }
        }
        out.push({
            displayLabel: name,
            path: 'models/' + name,
            prefabKind: 'model3d'
        });
    }
    out.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, 'ja'));
    return out;
}

/**
 * パレット選択キー（path + 任意の chunkManifest）
 * @param {string} path
 * @param {string|null|undefined} chunkManifest
 * @returns {string}
 */
function modelPaletteSelectionKey(path, chunkManifest) {
    return String(path || '') + '\0' + String(chunkManifest || '').trim();
}

/**
 * 現在の選択がパレットに存在するか確認し、無ければ先頭へ寄せる
 */
function syncModelPaletteSelectionAfterListChange() {
    const pal = buildModelPrefabEntries(modelList);
    const key = modelPaletteSelectionKey(selectedModelPath, selectedModelChunkManifest);
    const ok = pal.some(
        (e) => modelPaletteSelectionKey(e.path, e.chunkManifest) === key && selectedModelPath
    );
    if (!ok && pal.length) {
        selectedModelPath = pal[0].path;
        selectedModelChunkManifest = pal[0].chunkManifest || null;
    }
    if (!pal.length) {
        selectedModelPath = null;
        selectedModelChunkManifest = null;
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
 * @param {{ path: string, mtlPath?: string, chunkManifest?: string }} config
 * @returns {Promise<{ model: THREE.Object3D, triangleCount: number, gltfAnimations?: THREE.AnimationClip[] }>}
 */
async function loadModelFromConfig(config) {
    const path = config.path || '';
    const chunkManifest = String(config.chunkManifest || '').trim();
    if (chunkManifest) {
        if (!path) {
            throw new Error('チャンクモデルには代表 path（通常は単体 GLB）が必要です');
        }
        const mUrl = buildEncodedModelUrl(chunkManifest);
        const mRes = await fetch(mUrl);
        if (!mRes.ok) {
            throw new Error(`チャンク一覧の取得に失敗しました: ${chunkManifest}（HTTP ${mRes.status}）`);
        }
        /** @type {{ chunks?: { file?: string }[] }} */
        const manifest = await mRes.json();
        const chList = Array.isArray(manifest.chunks) ? manifest.chunks : [];
        if (!chList.length) {
            throw new Error(`チャンクがありません: ${chunkManifest}`);
        }
        const gltfLoader = new GLTFLoader();
        gltfLoader.setDRACOLoader(getEditorDracoLoader());
        const anchor = new THREE.Group();
        let totalTris = 0;
        for (const ch of chList) {
            const fp = String(ch.file || '').replace(/^\//, '');
            if (!fp) continue;
            const chunkUrl = buildEncodedModelUrl(fp);
            const len = await fetchModelContentLength(chunkUrl);
            if (len != null && len > MODEL_MAX_BYTES_GLTF) {
                disposeObjectTree(anchor);
                throw new Error(
                    `チャンク「${fp.split('/').pop()}」が大きすぎます（約 ${Math.round(len / 1024 / 1024)}MB）。上限約 ${Math.round(MODEL_MAX_BYTES_GLTF / 1024 / 1024)}MB です。`
                );
            }
            const scene = await new Promise((resolve, reject) => {
                gltfLoader.load(chunkUrl, (gltf) => resolve(gltf.scene), undefined, reject);
            });
            totalTris += countTrianglesInObject(scene);
            anchor.add(scene);
        }
        if (!anchor.children.length) {
            disposeObjectTree(anchor);
            throw new Error(`有効なチャンクファイルがありません: ${chunkManifest}`);
        }
        if (totalTris > MODEL_MAX_TRIANGLES_TOTAL) {
            disposeObjectTree(anchor);
            throw new Error(
                `ポリゴンが多すぎます（約 ${totalTris.toLocaleString()} 三角）。上限約 ${MODEL_MAX_TRIANGLES_TOTAL.toLocaleString()} 三角です。`
            );
        }
        return { model: anchor, triangleCount: totalTris, gltfAnimations: [] };
    }

    const url = buildEncodedModelUrl(path);
    const maxB = isObjPath(path) ? MODEL_MAX_BYTES_OBJ : MODEL_MAX_BYTES_GLTF;
    const len = await fetchModelContentLength(url);
    if (len != null && len > maxB) {
        throw new Error(
            `「${path.split('/').pop()}」が大きすぎます（約 ${Math.round(len / 1024 / 1024)}MB）。上限約 ${Math.round(maxB / 1024 / 1024)}MB です。`
        );
    }

    const model = await new Promise((resolve, reject) => {
        if (!isObjPath(path)) {
            const gltfLoader = new GLTFLoader();
            gltfLoader.setDRACOLoader(getEditorDracoLoader());
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
        const mtlPath = (config.mtlPath || '').trim();
        if (!mtlPath) {
            objLoader.load(url, (obj) => resolve(obj), undefined, reject);
            return;
        }

        const mtlEncoded = buildEncodedModelUrl(mtlPath);
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
        loadSceneIBL(THREE, { scene, renderer, RGBELoader, PMREMGenerator: THREE.PMREMGenerator }, { hdrUrl: DEFAULT_HDR_PATH }).then((r) => {
            if (!r.ok) console.warn('[setting] IBL load skipped; place HDR at', DEFAULT_HDR_PATH);
        });
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
        c.rotation = {
            x: obj.rotation.x * 180 / Math.PI,
            y: obj.rotation.y * 180 / Math.PI,
            z: obj.rotation.z * 180 / Math.PI
        };
        c.scale = { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
        if (c.animate) c.animate = { ...c.animate, rotation: c.animate.rotation ? { ...c.animate.rotation } : {} };
        if (c.teleporter) c.teleporter = { ...c.teleporter };
        if (c.taiko) c.taiko = { ...c.taiko };
        if (c.aircraft) {
            const a = c.aircraft;
            const ck = a.cockpitOffset || {};
            const ch = a.chaseOffset || {};
            c.aircraft = {
                id: a.id,
                radius: a.radius,
                label: a.label,
                cockpitOffset: { x: ck.x, y: ck.y, z: ck.z },
                chaseOffset: { x: ch.x, y: ch.y, z: ch.z }
            };
            const ap = a.aircraftPhysics;
            if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
                const clipped = clipAircraftPhysicsPartialFromUser(ap);
                if (clipped && Object.keys(clipped).length) c.aircraft.aircraftPhysics = clipped;
            }
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
        c.aircraft = { ...c.aircraft, id: `${String(c.aircraft.id)}-paste-${Date.now()}` };
        const ck = c.aircraft.cockpitOffset || {};
        const ch = c.aircraft.chaseOffset || {};
        c.aircraft.cockpitOffset = { x: ck.x ?? 0, y: ck.y ?? 1.2, z: ck.z ?? 0 };
        c.aircraft.chaseOffset = { x: ch.x ?? 0, y: ch.y ?? 3, z: ch.z ?? 12 };
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
        const cm = String(cfg.chunkManifest || '').trim();
        try {
            const { model, triangleCount } = await loadModelFromConfig({
                path,
                mtlPath,
                chunkManifest: cm || undefined
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
        obj.userData.config.rotation = { x: obj.rotation.x * 180 / Math.PI, y: obj.rotation.y * 180 / Math.PI, z: obj.rotation.z * 180 / Math.PI };
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
    const isSingleGlb = path.toLowerCase().endsWith('.glb') && !String(c.chunkManifest || '').trim();
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
    document.getElementById('obj-path').value = (c.path || (c.framePaths && c.framePaths[0])) || '';
    document.getElementById('obj-pos-x').value = obj.position.x;
    document.getElementById('obj-pos-y').value = obj.position.y;
    document.getElementById('obj-pos-z').value = obj.position.z;
    document.getElementById('obj-rot-x').value = (obj.rotation.x * 180 / Math.PI).toFixed(2);
    document.getElementById('obj-rot-y').value = (obj.rotation.y * 180 / Math.PI).toFixed(2);
    document.getElementById('obj-rot-z').value = (obj.rotation.z * 180 / Math.PI).toFixed(2);
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
            const ck = ac.cockpitOffset || {};
            const ch = ac.chaseOffset || {};
            document.getElementById('obj-ac-cockpit-x').value = ck.x ?? 0;
            document.getElementById('obj-ac-cockpit-y').value = ck.y ?? 1.2;
            document.getElementById('obj-ac-cockpit-z').value = ck.z ?? 0;
            document.getElementById('obj-ac-chase-x').value = ch.x ?? 0;
            document.getElementById('obj-ac-chase-y').value = ch.y ?? 3;
            document.getElementById('obj-ac-chase-z').value = ch.z ?? 12;
        } else {
            document.getElementById('obj-ac-id').value = '';
            document.getElementById('obj-ac-radius').value = 4;
            document.getElementById('obj-ac-label').value = '操縦する';
            document.getElementById('obj-ac-cockpit-x').value = 0;
            document.getElementById('obj-ac-cockpit-y').value = 1.2;
            document.getElementById('obj-ac-cockpit-z').value = 0;
            document.getElementById('obj-ac-chase-x').value = 0;
            document.getElementById('obj-ac-chase-y').value = 3;
            document.getElementById('obj-ac-chase-z').value = 12;
        }
        const ovPh = document.getElementById('obj-ac-phys-override');
        const taPh = document.getElementById('obj-ac-phys-json');
        if (ovPh && taPh) {
            const part = ac && ac.aircraftPhysics && typeof ac.aircraftPhysics === 'object' && !Array.isArray(ac.aircraftPhysics)
                ? ac.aircraftPhysics
                : null;
            const partKeys = part ? Object.keys(part).filter((k) => typeof part[k] === 'number' && Number.isFinite(part[k])) : [];
            ovPh.checked = partKeys.length > 0;
            taPh.disabled = !ovPh.checked;
            taPh.value = partKeys.length ? JSON.stringify(part, null, 2) : '';
        }
        updateVehicleAircraftFieldsVisibility();
        updateGlbAnimInteractPanel(obj);
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
            /** @type {Record<string, unknown>} */
            const acPayload = {
                id: idRaw || 'plane-1',
                radius: Number.isFinite(rad) && rad > 0 ? rad : 4,
                label: (document.getElementById('obj-ac-label').value || '').trim() || '操縦する',
                cockpitOffset: {
                    x: parseFloat(document.getElementById('obj-ac-cockpit-x').value) || 0,
                    y: parseFloat(document.getElementById('obj-ac-cockpit-y').value) || 0,
                    z: parseFloat(document.getElementById('obj-ac-cockpit-z').value) || 0
                },
                chaseOffset: {
                    x: parseFloat(document.getElementById('obj-ac-chase-x').value) || 0,
                    y: parseFloat(document.getElementById('obj-ac-chase-y').value) || 0,
                    z: parseFloat(document.getElementById('obj-ac-chase-z').value) || 0
                }
            };
            const ovPh = document.getElementById('obj-ac-phys-override');
            const taPh = document.getElementById('obj-ac-phys-json');
            if (ovPh?.checked && taPh && !taPh.disabled) {
                const rawStr = (taPh.value || '').trim();
                if (rawStr) {
                    try {
                        const parsed = JSON.parse(rawStr);
                        const phys = clipAircraftPhysicsPartialFromUser(parsed);
                        if (phys && Object.keys(phys).length) acPayload.aircraftPhysics = phys;
                    } catch (_) {
                        window.alert('機体の操縦パラメータJSONが不正のため、aircraftPhysics は更新されませんでした。');
                    }
                }
                taPh.disabled = false;
            } else if (taPh) {
                taPh.value = '';
                taPh.disabled = true;
            }
            c.aircraft = acPayload;
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
                        const a = c.aircraft;
                        const ck = a.cockpitOffset || {};
                        const ch = a.chaseOffset || {};
                        c.aircraft = {
                            id: a.id,
                            radius: a.radius,
                            label: a.label,
                            cockpitOffset: { x: ck.x, y: ck.y, z: ck.z },
                            chaseOffset: { x: ch.x, y: ch.y, z: ch.z }
                        };
                        const ap = a.aircraftPhysics;
                        if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
                            const clipped = clipAircraftPhysicsPartialFromUser(ap);
                            if (clipped && Object.keys(clipped).length) c.aircraft.aircraftPhysics = clipped;
                        }
                    }
                    if (c.glbInteract) c.glbInteract = { ...c.glbInteract };
                    if (!isObjPath(c.path || '')) delete c.mtlPath;
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
            w.aircraftPhysics = readWorldAircraftPhysicsFromForm();
        }
    }
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
 * 飛行機ワールド共通パラメータのフォームを埋める
 * @param {object} [world]
 */
function fillWorldAircraftPhysicsForm(world) {
    const m = mergeAircraftPhysicsFromWorld(world && world.aircraftPhysics);
    const ids = [
        ['world-aircraft-gravity', m.gravity],
        ['world-aircraft-lift-per-speed', m.liftPerHorizontalSpeed],
        ['world-aircraft-sideslip-damping', m.sideslipDamping],
        ['world-aircraft-excess-climb-damping', m.excessClimbDamping],
        ['world-aircraft-max-speed', m.maxSpeed],
        ['world-aircraft-thrust-accel', m.thrustAccel],
        ['world-aircraft-drag', m.drag],
        ['world-aircraft-yaw-accel-ground', m.yawAccelGround],
        ['world-aircraft-yaw-accel-air', m.yawAccelAir],
        ['world-aircraft-yaw-max-rate-ground', m.yawMaxRateGround],
        ['world-aircraft-yaw-max-rate-air', m.yawMaxRateAir],
        ['world-aircraft-pitch-accel-ground', m.pitchAccelGround],
        ['world-aircraft-pitch-accel-air', m.pitchAccelAir],
        ['world-aircraft-pitch-max-rate-ground', m.pitchMaxRateGround],
        ['world-aircraft-pitch-max-rate-air', m.pitchMaxRateAir],
        ['world-aircraft-roll-accel', m.rollAccel],
        ['world-aircraft-roll-max-rate', m.rollMaxRate],
        ['world-aircraft-angular-decel', m.angularDecel],
        ['world-aircraft-yaw-ground-friction-left', m.yawGroundFrictionLeft],
        ['world-aircraft-yaw-ground-friction-right', m.yawGroundFrictionRight],
        ['world-aircraft-ground-tire-lateral-decel', m.groundTireLateralDecel],
        ['world-aircraft-ground-tire-rolling-decel', m.groundTireRollingDecel],
        ['world-aircraft-wheel-brake-decel', m.wheelBrakeDecel]
    ];
    for (const [id, v] of ids) {
        const el = document.getElementById(id);
        if (el) el.value = String(v);
    }
}

/**
 * @returns {ReturnType<typeof mergeAircraftPhysicsFromWorld>}
 */
function readWorldAircraftPhysicsFromForm() {
    const parse = (id, fallback) => {
        const el = document.getElementById(id);
        const n = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(n) ? n : fallback;
    };
    const raw = {
        gravity: parse('world-aircraft-gravity', DEFAULT_AIRCRAFT_PHYSICS.gravity),
        liftPerHorizontalSpeed: parse('world-aircraft-lift-per-speed', DEFAULT_AIRCRAFT_PHYSICS.liftPerHorizontalSpeed),
        sideslipDamping: parse('world-aircraft-sideslip-damping', DEFAULT_AIRCRAFT_PHYSICS.sideslipDamping),
        excessClimbDamping: parse('world-aircraft-excess-climb-damping', DEFAULT_AIRCRAFT_PHYSICS.excessClimbDamping),
        maxSpeed: parse('world-aircraft-max-speed', DEFAULT_AIRCRAFT_PHYSICS.maxSpeed),
        thrustAccel: parse('world-aircraft-thrust-accel', DEFAULT_AIRCRAFT_PHYSICS.thrustAccel),
        drag: parse('world-aircraft-drag', DEFAULT_AIRCRAFT_PHYSICS.drag),
        yawAccelGround: parse('world-aircraft-yaw-accel-ground', DEFAULT_AIRCRAFT_PHYSICS.yawAccelGround),
        yawAccelAir: parse('world-aircraft-yaw-accel-air', DEFAULT_AIRCRAFT_PHYSICS.yawAccelAir),
        yawMaxRateGround: parse('world-aircraft-yaw-max-rate-ground', DEFAULT_AIRCRAFT_PHYSICS.yawMaxRateGround),
        yawMaxRateAir: parse('world-aircraft-yaw-max-rate-air', DEFAULT_AIRCRAFT_PHYSICS.yawMaxRateAir),
        pitchAccelGround: parse('world-aircraft-pitch-accel-ground', DEFAULT_AIRCRAFT_PHYSICS.pitchAccelGround),
        pitchAccelAir: parse('world-aircraft-pitch-accel-air', DEFAULT_AIRCRAFT_PHYSICS.pitchAccelAir),
        pitchMaxRateGround: parse('world-aircraft-pitch-max-rate-ground', DEFAULT_AIRCRAFT_PHYSICS.pitchMaxRateGround),
        pitchMaxRateAir: parse('world-aircraft-pitch-max-rate-air', DEFAULT_AIRCRAFT_PHYSICS.pitchMaxRateAir),
        rollAccel: parse('world-aircraft-roll-accel', DEFAULT_AIRCRAFT_PHYSICS.rollAccel),
        rollMaxRate: parse('world-aircraft-roll-max-rate', DEFAULT_AIRCRAFT_PHYSICS.rollMaxRate),
        angularDecel: parse('world-aircraft-angular-decel', DEFAULT_AIRCRAFT_PHYSICS.angularDecel),
        yawGroundFrictionLeft: parse('world-aircraft-yaw-ground-friction-left', DEFAULT_AIRCRAFT_PHYSICS.yawGroundFrictionLeft),
        yawGroundFrictionRight: parse('world-aircraft-yaw-ground-friction-right', DEFAULT_AIRCRAFT_PHYSICS.yawGroundFrictionRight),
        groundTireLateralDecel: parse('world-aircraft-ground-tire-lateral-decel', DEFAULT_AIRCRAFT_PHYSICS.groundTireLateralDecel),
        groundTireRollingDecel: parse('world-aircraft-ground-tire-rolling-decel', DEFAULT_AIRCRAFT_PHYSICS.groundTireRollingDecel),
        wheelBrakeDecel: parse('world-aircraft-wheel-brake-decel', DEFAULT_AIRCRAFT_PHYSICS.wheelBrakeDecel)
    };
    return mergeAircraftPhysicsFromWorld(raw);
}

/**
 * 選択中ワールドの aircraftPhysics をフォームから worlds に反映
 */
function syncWorldAircraftPhysicsFromForm() {
    if (!selectedWorldId || !worlds[selectedWorldId]) return;
    pushUndo();
    worlds[selectedWorldId].aircraftPhysics = readWorldAircraftPhysicsFromForm();
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

/**
 * ワールド設定をシーンに適用する（3D モデルは順次 await で読み込み）
 * @param {object} world
 * @returns {Promise<void>}
 */
async function loadWorldIntoScene(world) {
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
    fillWorldAircraftPhysicsForm(world);

    const models = world.models || [];
    const errs = [];
    for (let idx = 0; idx < models.length; idx++) {
        const config = models[idx];
        const path = config.path || '';
        const pos = config.position || { x: 0, y: 0, z: 0 };
        const rot = config.rotation || { x: 0, y: 0, z: 0 };
        const scale = config.scale || { x: 1, y: 1, z: 1 };
        const cfgBase = {
            path,
            position: { ...pos },
            rotation: { ...rot },
            scale: { ...scale },
            animate: config.animate ? { ...config.animate } : undefined,
            teleporter: config.teleporter ? { ...config.teleporter } : undefined,
            taiko: config.taiko ? { ...config.taiko } : undefined
        };
        if (config.aircraft && config.aircraft.id) {
            const a = config.aircraft;
            const ck = a.cockpitOffset || {};
            const ch = a.chaseOffset || {};
            cfgBase.aircraft = {
                id: String(a.id || '').trim(),
                radius: typeof a.radius === 'number' && Number.isFinite(a.radius) ? a.radius : 4,
                label: a.label || '操縦する',
                cockpitOffset: {
                    x: ck.x ?? 0,
                    y: ck.y ?? 1.2,
                    z: ck.z ?? 0
                },
                chaseOffset: {
                    x: ch.x ?? 0,
                    y: ch.y ?? 3,
                    z: ch.z ?? 12
                }
            };
            const ap = a.aircraftPhysics;
            if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
                const clipped = clipAircraftPhysicsPartialFromUser(ap);
                if (clipped && Object.keys(clipped).length) cfgBase.aircraft.aircraftPhysics = clipped;
            }
        }
        const cm = String(config.chunkManifest || '').trim();
        if (cm) {
            cfgBase.chunkManifest = cm;
        }
        if (isObjPath(path) && config.mtlPath) {
            cfgBase.mtlPath = config.mtlPath;
        }
        try {
            const { model, triangleCount } = await loadModelFromConfig({
                path,
                mtlPath: isObjPath(path) ? (config.mtlPath || '') : '',
                chunkManifest: cm || undefined
            });
            model.position.set(pos.x, pos.y, pos.z);
            model.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
            model.scale.set(scale.x, scale.y, scale.z);
            applyModelShadowByTriangleCount(model, triangleCount);
            model.userData.editId = 'm' + idx;
            model.userData.config = cfgBase;
            editGroup.add(model);
        } catch (err) {
            console.error('Load model failed:', path, err);
            errs.push(err.message || String(err));
        }
    }
    if (errs.length) {
        const el = document.getElementById('save-status');
        if (el) {
            el.textContent = errs.join(' ');
            el.className = 'error';
        }
    }
    renderWorldObjectList();
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
            selectedObject.userData.config.position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            selectedObject.userData.config.rotation = { x: selectedObject.rotation.x * 180 / Math.PI, y: selectedObject.rotation.y * 180 / Math.PI, z: selectedObject.rotation.z * 180 / Math.PI };
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
    floorDepth: DEFAULT_FLOOR_DEPTH_M
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
 * @param {{ v?: number, worlds?: object, modelList?: string[], mtlList?: string[], pdfList?: string[] }} data
 * @returns {boolean}
 */
function applyWorldEditCacheToState(data) {
    if (!data || data.v !== 1) return false;
    if (typeof data.worlds !== 'object' || data.worlds === null || Array.isArray(data.worlds)) return false;
    worlds = JSON.parse(JSON.stringify(data.worlds));
    modelList = Array.isArray(data.modelList) ? data.modelList.slice() : [];
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
    el.appendChild(createCategory('モデル', 'models', modelsArr, lightsArr.length));
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
    const pal = buildModelPrefabEntries(modelList);
    const selKey = modelPaletteSelectionKey(selectedModelPath, selectedModelChunkManifest);
    pal.forEach((ent) => {
        const path = ent.path;
        const isSel =
            modelPaletteSelectionKey(path, ent.chunkManifest) === selKey && selectedModelPath === path;
        const div = document.createElement('div');
        div.className = 'item model-prefab-item' + (isSel ? ' selected' : '');
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        div.setAttribute(
            'aria-label',
            ent.prefabKind === 'prefab' ? `プレハブ ${ent.displayLabel}` : ent.displayLabel
        );
        div.dataset.path = path;
        if (ent.chunkManifest) {
            div.dataset.chunkManifest = ent.chunkManifest;
        }
        const icon = document.createElement('span');
        icon.className =
            'model-prefab-icon' +
            (ent.prefabKind === 'prefab' ? ' model-prefab-icon--prefab' : ' model-prefab-icon--model3d');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = ent.prefabKind === 'prefab' ? MODEL_ICON_PREFAB_CHUNKED : MODEL_ICON_3D_ASSET;
        const label = document.createElement('span');
        label.className = 'model-prefab-label';
        label.textContent = ent.displayLabel;
        div.appendChild(icon);
        div.appendChild(label);
        const activate = () => {
            selectedModelPath = path;
            selectedModelChunkManifest = ent.chunkManifest || null;
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
 * シーンにモデルを追加（path は models/...）
 * @param {string} path
 * @param {string} [mtlPath] - OBJ 時のみ models/...mtl
 * @param {string} [chunkManifest] - チャンク分割済み時 models/...chunks.json
 */
function addModel(path, mtlPath, chunkManifest) {
    if (!selectedWorldId) return;
    const mtl = isObjPath(path) ? (mtlPath || '').trim() : '';
    const cm = String(chunkManifest || '').trim();
    const cfg = {
        path,
        position: { x: 0, y: 2, z: -5 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
    };
    if (mtl) cfg.mtlPath = mtl;
    if (cm) cfg.chunkManifest = cm;
    void (async () => {
        try {
            const { model, triangleCount } = await loadModelFromConfig({
                path,
                mtlPath: mtl,
                chunkManifest: cm || undefined
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

// --- Event bindings ---
function bindEvents() {
    // 左パネル: ワールド/モデル/PDF/ファイル カテゴリ切り替え（admin 統合時）。カテゴリクリックで展開もする
    const weLayout = document.querySelector('#panel-world-edit .setting-layout');
    const categoryNav = document.querySelector('.we-category-nav');
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
            if (weLayout) weLayout.classList.remove('we-left-collapsed');
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
        'obj-ac-radius',
        'obj-ac-label',
        'obj-ac-cockpit-x',
        'obj-ac-cockpit-y',
        'obj-ac-cockpit-z',
        'obj-ac-chase-x',
        'obj-ac-chase-y',
        'obj-ac-chase-z'
    ]) {
        document.getElementById(acId)?.addEventListener('change', syncObjectFromPanel);
    }
    document.getElementById('obj-ac-phys-json')?.addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-ac-phys-override')?.addEventListener('change', () => {
        const ov = document.getElementById('obj-ac-phys-override');
        const ta = document.getElementById('obj-ac-phys-json');
        if (ta) ta.disabled = !ov?.checked;
        syncObjectFromPanel();
    });
    document.getElementById('obj-ac-phys-export')?.addEventListener('click', async () => {
        const ta = document.getElementById('obj-ac-phys-json');
        const text = (ta?.value || '').trim() || '{}';
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            window.alert('クリップボードへのコピーに失敗しました。');
        }
    });
    document.getElementById('obj-ac-phys-import')?.addEventListener('click', async () => {
        try {
            const clipText = (await navigator.clipboard.readText()).trim();
            const parsed = JSON.parse(clipText);
            const phys = clipAircraftPhysicsPartialFromUser(parsed);
            if (!phys || !Object.keys(phys).length) {
                window.alert('有効なパラメータキーが見つかりませんでした。');
                return;
            }
            const ov = document.getElementById('obj-ac-phys-override');
            const ta = document.getElementById('obj-ac-phys-json');
            if (ov) ov.checked = true;
            if (ta) {
                ta.disabled = false;
                ta.value = JSON.stringify(phys, null, 2);
            }
            syncObjectFromPanel();
        } catch (_) {
            window.alert('クリップボードの読み取りまたはJSONの解析に失敗しました。');
        }
    });

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
            floorDepth: DEFAULT_FLOOR_DEPTH_M
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
        const pal = buildModelPrefabEntries(modelList);
        const first = pal[0];
        const path = selectedModelPath || (first ? first.path : null);
        const match = path ? pal.find((e) => e.path === path) : null;
        const chunkManifest = (match && match.chunkManifest) || '';
        if (!path) {
            alert('モデルをアップロードするか、一覧から選択してください');
            return;
        }
        let mtlPath = '';
        if (isObjPath(path)) {
            const mtlSel = document.getElementById('add-obj-mtl');
            mtlPath = mtlSel && mtlSel.value ? mtlSel.value.trim() : '';
        }
        addModel(path, mtlPath, chunkManifest);
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

    /** GLB オブジェクト分割 ON のときは空間チャンクをスキップ扱いに固定する */
    function syncModelUploadSplitObjectsChunkRow() {
        const splitEl = document.getElementById('model-upload-split-objects');
        const chunkEl = document.getElementById('model-upload-skip-chunk');
        if (!chunkEl) return;
        if (splitEl && splitEl.checked) {
            chunkEl.checked = true;
            chunkEl.disabled = true;
        } else {
            chunkEl.disabled = false;
        }
    }

    /** アップロード種別に応じてモーダル内の説明と 3D 専用ブロックの表示を切り替える */
    function syncModelUploadKindUI() {
        const kind = document.querySelector('input[name="model-upload-kind"]:checked')?.value || 'model';
        const block3d = document.getElementById('model-upload-3d-only');
        const hModel = document.getElementById('model-upload-hint-model');
        const hPdf = document.getElementById('model-upload-hint-pdf');
        const hHdr = document.getElementById('model-upload-hint-hdr');
        const textureEdgeRow = document.querySelector('.model-upload-texture-max-edge-row');
        const show3d = kind === 'model';
        if (block3d) block3d.hidden = !show3d;
        if (hModel) hModel.hidden = kind !== 'model';
        if (hPdf) hPdf.hidden = kind !== 'pdf';
        if (hHdr) hHdr.hidden = kind !== 'hdr';
        if (textureEdgeRow) textureEdgeRow.hidden = kind !== 'model';
        syncModelUploadTextureEdgeControlState();
        syncModelUploadSplitObjectsChunkRow();
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
    document.getElementById('model-upload-split-objects')?.addEventListener('change', () => {
        syncModelUploadSplitObjectsChunkRow();
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

    /** @param {{ waiting?: number, processing?: boolean, spatialChunking?: boolean }|null} q */
    function applyServerQueueToLabel(q) {
        if (!modelUploadServerQueueEl) return;
        if (!q || typeof q.waiting !== 'number') {
            modelUploadServerQueueEl.textContent = '';
            return;
        }
        let proc = 'リサイズ処理待ち';
        if (q.processing) proc = 'リサイズ処理を実行中';
        if (q.spatialChunking) proc = 'チャンク分割処理を実行中';
        modelUploadServerQueueEl.textContent = `サーバ側 GLB: 待ち ${q.waiting} 件、${proc}`;
    }

    /** @param {{ waiting?: number, processing?: boolean, spatialChunking?: boolean }|null} q */
    function applyActiveGlbRowFromQueue(q) {
        if (!activeGlbServerPhaseUi || !q || typeof q.waiting !== 'number') return;
        if (q.processing) {
            activeGlbServerPhaseUi.setStatus('リサイズ中…', 'muted');
        } else if (q.spatialChunking) {
            activeGlbServerPhaseUi.setStatus('チャンク分割中…', 'muted');
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
     * @param {boolean} [skipSpatialChunk] true のとき GLB の空間チャンク分割をサーバで行わない
     * @param {boolean} [skipTextureResize] true のとき GLB のテクスチャ長辺縮小を行わない
     * @param {string} [textureMaxEdgeStr] 縮小する場合の長辺上限（px）の数字文字列
     * @param {boolean} [splitGlbByObjects] true のとき GLB をオブジェクト単位で複数ファイルに分割
     * @returns {Promise<{ status: number, text: string, json: object|null }>}
     */
    function postAdminModelUploadXHR(
        url,
        file,
        onUploadProgress,
        onUploadBytesSent,
        skipSpatialChunk,
        skipTextureResize,
        textureMaxEdgeStr,
        splitGlbByObjects
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
            if (skipSpatialChunk) form.append('skipSpatialChunk', '1');
            if (skipTextureResize) form.append('skipTextureResize', '1');
            else if (textureMaxEdgeStr) form.append('textureMaxEdge', textureMaxEdgeStr);
            if (splitGlbByObjects) form.append('splitGlbByObjects', '1');
            xhr.send(form);
        });
    }

    /**
     * GLB はボディ送信後にサーバでリサイズ→条件によりチャンク分割する。キュー API と行表示を同期する。
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
     * @param {boolean} [skipSpatialChunk]
     * @param {boolean} [skipTextureResize]
     * @param {string} [textureMaxEdgeStr]
     * @param {boolean} [splitGlbByObjects]
     */
    async function postAdminModelUploadWithPhaseCleanup(
        url,
        file,
        onUploadProgress,
        ui,
        fileName,
        skipSpatialChunk,
        skipTextureResize,
        textureMaxEdgeStr,
        splitGlbByObjects
    ) {
        try {
            return await postAdminModelUploadXHR(
                url,
                file,
                onUploadProgress,
                onModelUploadBytesSentIfGlb(ui, fileName, skipTextureResize),
                skipSpatialChunk,
                skipTextureResize,
                textureMaxEdgeStr,
                splitGlbByObjects
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
                    return;
                }
                res = await postHdr(true);
            }
            if (res.status === 409) {
                setDualHdrUploadStatus('上書きには確認が必要です。', 'error');
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (!data.success) throw new Error('アップロード応答が不正です');
            await notifyServiceWorkerInvalidate([encodeAssetPathToUrlPath('env/default.hdr')]);
            if (scene && renderer) {
                const bust = `${DEFAULT_HDR_PATH}?t=${Date.now()}`;
                loadSceneIBL(THREE, { scene, renderer, RGBELoader, PMREMGenerator: THREE.PMREMGenerator }, { hdrUrl: bust }).then((r) => {
                    if (!r.ok) console.warn('[setting] IBL 再読み込みに失敗しました');
                });
            }
            setDualHdrUploadStatus('アップロードしました: default.hdr（プレビューに反映済み）', 'success');
            if (inModal) setModelUploadModalOpen(false);
        } catch (err) {
            setDualHdrUploadStatus('アップロード失敗: ' + err.message, 'error');
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

        const skipChunkEl = document.getElementById('model-upload-skip-chunk');
        const splitObjectsEl = document.getElementById('model-upload-split-objects');
        const splitGlbByObjects = !!(splitObjectsEl && splitObjectsEl.checked);
        const skipSpatialChunkParam =
            !!(skipChunkEl && skipChunkEl.checked) || splitGlbByObjects;
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
            if (uploadData.chunkManifest) {
                msg += ` チャンク: worlds.json の models に chunkManifest「${uploadData.chunkManifest}」を追加してください（単体 GLB も保存済み）。`;
            }
            if (uploadData.objectSplit?.applied && Array.isArray(uploadData.splitFiles)) {
                msg += ` オブジェクト分割: ${uploadData.splitFiles.length} ファイル（${uploadData.splitFiles.join('、')}）。`;
            } else if (uploadData.objectSplit && uploadData.objectSplit.applied === false) {
                const r = uploadData.objectSplit.reason || '';
                msg += ` オブジェクト分割は未実施（${r}）。単体 GLB を保存しました。`;
            }
            if (uploadData.spatialChunkSkipped) {
                msg += ' 空間チャンク分けはスキップしました（単体 GLB のみ。chunkManifest は不要です）。';
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
                    skipSpatialChunkParam,
                    skipTextureResize,
                    textureMaxEdgeStr,
                    splitGlbByObjects
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
                        skipSpatialChunkParam,
                        skipTextureResize,
                        textureMaxEdgeStr,
                        splitGlbByObjects
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
                if (uploadData.chunkManifest) {
                    inv.push(encodeAssetPathToUrlPath(uploadData.chunkManifest));
                }
                if (Array.isArray(uploadData.spatialChunk?.chunkFiles)) {
                    for (const f of uploadData.spatialChunk.chunkFiles) {
                        inv.push(encodeAssetPathToUrlPath(`models/${f}`));
                    }
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
                            skipSpatialChunkParam,
                            skipTextureResize,
                            textureMaxEdgeStr,
                            splitGlbByObjects
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
                        if (uploadDataRetry.chunkManifest) {
                            invR.push(encodeAssetPathToUrlPath(uploadDataRetry.chunkManifest));
                        }
                        if (Array.isArray(uploadDataRetry.spatialChunk?.chunkFiles)) {
                            for (const f of uploadDataRetry.spatialChunk.chunkFiles) {
                                invR.push(encodeAssetPathToUrlPath(`models/${f}`));
                            }
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

    for (const aircraftInputId of [
        'world-aircraft-gravity',
        'world-aircraft-lift-per-speed',
        'world-aircraft-sideslip-damping',
        'world-aircraft-excess-climb-damping',
        'world-aircraft-max-speed',
        'world-aircraft-thrust-accel',
        'world-aircraft-drag',
        'world-aircraft-yaw-accel-ground',
        'world-aircraft-yaw-accel-air',
        'world-aircraft-yaw-max-rate-ground',
        'world-aircraft-yaw-max-rate-air',
        'world-aircraft-pitch-accel-ground',
        'world-aircraft-pitch-accel-air',
        'world-aircraft-pitch-max-rate-ground',
        'world-aircraft-pitch-max-rate-air',
        'world-aircraft-roll-accel',
        'world-aircraft-roll-max-rate',
        'world-aircraft-angular-decel',
        'world-aircraft-yaw-ground-friction-left',
        'world-aircraft-yaw-ground-friction-right',
        'world-aircraft-ground-tire-lateral-decel',
        'world-aircraft-ground-tire-rolling-decel',
        'world-aircraft-wheel-brake-decel'
    ]) {
        document.getElementById(aircraftInputId)?.addEventListener('change', syncWorldAircraftPhysicsFromForm);
    }

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
