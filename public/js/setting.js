/**
 * Setting page: world editor (3D scene, objects, lights, spawn, save)
 * Uses Three.js from CDN (no Vite build required for this page).
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

// --- State ---
let scene, camera, renderer, controls, transformControls;
let editGroup;
let worlds = {};
let selectedWorldId = null;
let selectedObject = null;
let modelList = [];
let selectedModelPath = null; // 左パネル「モデル一覧」で選択中のモデル（models/xxx.glb）
let pdfList = [];
let selectedPdfPath = null; // 左パネル「PDF一覧」で選択中のPDF（pdfs/xxx.pdf）
let vdbList = [];
let selectedVdbPath = null; // 左パネル「VDB一覧」で選択中のVDB（vdbs/xxx.vdb）
let lightHelpers = []; // { light, mesh? } for point/spot position drag
let worldObjectList = []; // 右パネル「オブジェクト一覧」の並び（クリックで選択用）
let objectListExpanded = { lights: false, models: false, pdfs: false, vdbs: false }; // オブジェクト一覧の階層展開状態
let editorGround = null; // 編集プレビュー用の床メッシュ（表示切替用）
let editorGrid = null;   // 編集プレビュー用のグリッド（表示切替用）
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

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

// VDB表示用（エディタ側はCDN importでopenvdb/threeを使用）
let openVdbLib = null;
let vdbLoader = null;
const VDB_FOG_OPTIONS = {
    resolution: 50,
    progressive: false,
    steps: 30,
    absorbance: 0.6,
    opacity: 0.25,
    densityScale: 0.6,
    densityCutoff: 0.06,
    baseColor: 0xdddddd
};

/**
 * Ensure openvdb/three is loaded for editor preview.
 * @returns {Promise<any|null>}
 */
async function ensureOpenVdbLoaded() {
    if (openVdbLib) return openVdbLib;
    try {
        // Filter a noisy warning from openvdb's internal material params on three r160
        if (!console.__vdbWarnFiltered) {
            const origWarn = console.warn.bind(console);
            console.warn = (...args) => {
                const msg = args && args[0] ? String(args[0]) : '';
                if (msg.includes("THREE.Material: '_uniforms' is not a property of THREE.MeshBasicMaterial")) return;
                origWarn(...args);
            };
            console.__vdbWarnFiltered = true;
        }

        // jsDelivr: npm openvdb@0.3.0
        const mod = await import('https://cdn.jsdelivr.net/npm/openvdb@0.3.0/three/index.js');
        openVdbLib = mod;
        vdbLoader = new openVdbLib.VDBLoader();
        return openVdbLib;
    } catch (e) {
        console.warn('Failed to load openvdb/three for editor preview:', e);
        openVdbLib = null;
        vdbLoader = null;
        return null;
    }
}

/**
 * Create an Object3D representing a VDB sequence and start loading its first frame.
 * Falls back to a placeholder box if VDB cannot be loaded.
 * @param {{ framePaths: string[], position?: any, rotation?: any, scale?: any }} vdbConfig
 * @returns {THREE.Object3D}
 */
function createVdbPreviewObject(vdbConfig) {
    const framePaths = vdbConfig?.framePaths?.length ? vdbConfig.framePaths : [];
    const pos = vdbConfig.position || { x: 0, y: 2, z: -5 };
    const rot = vdbConfig.rotation || { x: 0, y: 0, z: 0 };
    const scale = vdbConfig.scale || { x: 2, y: 2, z: 2 };

    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);
    group.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
    group.scale.set(scale.x, scale.y, scale.z);
    group.userData.vdbConfig = { framePaths: [...framePaths], position: { ...pos }, rotation: { ...rot }, scale: { ...scale } };

    // Placeholder while loading / when loading fails
    const placeholderGeom = new THREE.BoxGeometry(1, 1, 1);
    const placeholderMat = new THREE.MeshBasicMaterial({ color: 0x88aacc, transparent: true, opacity: 0.5 });
    const placeholder = new THREE.Mesh(placeholderGeom, placeholderMat);
    placeholder.userData.vdbPlaceholder = true;
    group.add(placeholder);

    if (framePaths.length === 0) return group;

    ensureOpenVdbLoaded().then((lib) => {
        if (!lib || !vdbLoader) return;
        const firstPath = framePaths[0];
        const pathStr = firstPath.startsWith('/') ? firstPath.slice(1) : firstPath;
        const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
        const url = '/' + encodedPath;
        vdbLoader.load(
            url,
            (vdb) => {
                // Remove placeholder
                const ph = group.children.find((c) => c.userData && c.userData.vdbPlaceholder);
                if (ph) {
                    group.remove(ph);
                    if (ph.geometry) ph.geometry.dispose();
                    if (ph.material) ph.material.dispose();
                }
                // Prefer density grid when available (smoke/fog usually exported as density)
                const grid = (vdb && vdb.grids && (vdb.grids.density || vdb.grids.Density))
                    ? (vdb.grids.density || vdb.grids.Density)
                    : vdb;
                const lightsMask = lib.lights?.useDirectionalLights ?? 0;
                const fog = new lib.FogVolume(grid, { ...VDB_FOG_OPTIONS, lights: lightsMask });
                fog.userData.vdbFogVolume = true;
                group.add(fog);
            },
            undefined,
            (err) => {
                console.warn('VDB preview load failed:', firstPath, err);
            }
        );
    });

    return group;
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

function setState(state) {
    isRestoring = true;
    worlds = JSON.parse(JSON.stringify(state.worlds));
    selectedWorldId = state.selectedWorldId;
    const w = worlds[selectedWorldId];
    if (w) {
        loadWorldIntoScene(w);
        document.getElementById('world-name-row').style.display = '';
        document.getElementById('world-name').value = w.name || selectedWorldId;
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
    setState(undoStack.pop());
}

function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(getState());
    setState(redoStack.pop());
}

// --- Three.js setup ---
function initScene() {
    const canvas = document.getElementById('canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 100, 2000);

    camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 5000);
    camera.position.set(0, 10, 20);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

    // Editor-only preview lights (not saved to worlds.json)
    const previewAmbient = new THREE.AmbientLight(0xffffff, 0.9);
    previewAmbient.userData.editorPreview = true;
    scene.add(previewAmbient);
    const previewDir = new THREE.DirectionalLight(0xffffff, 0.8);
    previewDir.position.set(30, 80, 20);
    previewDir.userData.editorPreview = true;
    scene.add(previewDir);

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
    canvas.addEventListener('pointerdown', onPointerDown);
}

function onResize() {
    const canvas = document.getElementById('canvas');
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
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
            updateObjectPanel(obj);
            document.getElementById('object-hint').style.display = 'none';
            document.getElementById('object-props').style.display = 'block';
            document.getElementById('light-hint').style.display = 'block';
            document.getElementById('light-props').style.display = 'none';
            document.getElementById('object-props-animation').style.display = '';
            document.getElementById('object-props-taiko').style.display = '';
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
        } else if (obj.userData.vdbConfig) {
            updateObjectPanel(obj);
            document.getElementById('object-hint').style.display = 'none';
            document.getElementById('object-props').style.display = 'block';
            document.getElementById('light-hint').style.display = 'block';
            document.getElementById('light-props').style.display = 'none';
            document.getElementById('object-props-animation').style.display = 'none';
            document.getElementById('object-props-taiko').style.display = 'none';
            document.getElementById('object-props-teleporter').style.display = 'none';
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

function syncLightFromPanel() {
    if (!selectedObject) return;
    const cfg = selectedObject.userData.lightConfig;
    if (!cfg) return;
    pushUndo();
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

function updateObjectPanel(obj) {
    if (!obj) return;
    const c = obj.userData.config || obj.userData.pdfConfig || obj.userData.vdbConfig;
    if (!c) return;
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
        const taiko = c.taiko;
        document.getElementById('obj-taiko').checked = !!taiko;
        document.getElementById('obj-taiko-radius').value = taiko ? (taiko.radius ?? 3) : 3;
    } else if (obj.userData.pdfConfig) {
        const tp = c.teleporter;
        document.getElementById('obj-teleporter').checked = !!tp;
        document.getElementById('obj-tp-id').value = tp ? (tp.id || '') : '';
        document.getElementById('obj-tp-dest').value = tp ? (tp.destinationWorld || '') : '';
        document.getElementById('obj-tp-radius').value = tp ? (tp.radius ?? 3) : 3;
        document.getElementById('obj-tp-label').value = tp ? (tp.label || '') : '';
        document.getElementById('obj-tp-access').value = tp && tp.access ? tp.access : 'public';
    } else if (obj.userData.vdbConfig) {
        document.getElementById('obj-teleporter').checked = false;
    }
}

function syncObjectFromPanel() {
    if (!selectedObject) return;
    const c = selectedObject.userData.config || selectedObject.userData.pdfConfig || selectedObject.userData.vdbConfig;
    if (!c) return;
    pushUndo();
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
            c.teleporter = {
                id: document.getElementById('obj-tp-id').value.trim() || 'tp1',
                destinationWorld: document.getElementById('obj-tp-dest').value || Object.keys(worlds)[0],
                radius: parseFloat(document.getElementById('obj-tp-radius').value) || 3,
                label: document.getElementById('obj-tp-label').value.trim() || '',
                access: accessVal
            };
        } else {
            delete c.teleporter;
        }
        if (document.getElementById('obj-taiko').checked) {
            c.taiko = {
                radius: parseFloat(document.getElementById('obj-taiko-radius').value) || 3
            };
        } else {
            delete c.taiko;
        }
    } else if (selectedObject.userData.vdbConfig) {
        // VDB: only position/rotation/scale (already set above)
    } else if (selectedObject.userData.pdfConfig) {
        if (document.getElementById('obj-teleporter').checked) {
            const accessEl = document.getElementById('obj-tp-access');
            const accessVal = accessEl && accessEl.value ? accessEl.value : 'public';
            c.teleporter = {
                id: document.getElementById('obj-tp-id').value.trim() || 'tp1',
                destinationWorld: document.getElementById('obj-tp-dest').value || Object.keys(worlds)[0],
                radius: parseFloat(document.getElementById('obj-tp-radius').value) || 3,
                label: document.getElementById('obj-tp-label').value.trim() || '',
                access: accessVal
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
            vdbs: w.vdbs ? w.vdbs.map((v) => ({ ...v, framePaths: v.framePaths ? [...v.framePaths] : [] })) : [],
            floorEnabled: wid === selectedWorldId ? document.getElementById('floor-enabled').checked : (w.floorEnabled !== false)
        };
    }
    if (selectedWorldId) {
        const w = out[selectedWorldId];
        if (w) {
            w.models = [];
            w.lights = [];
            w.pdfs = [];
            w.vdbs = [];
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
                if (child.userData.vdbConfig) {
                    const v = { ...child.userData.vdbConfig };
                    v.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                    v.rotation = { x: child.rotation.x * 180 / Math.PI, y: child.rotation.y * 180 / Math.PI, z: child.rotation.z * 180 / Math.PI };
                    v.scale = { x: child.scale.x, y: child.scale.y, z: child.scale.z };
                    w.vdbs.push(v);
                }
            });
            w.spawnPoint = {
                x: parseFloat(document.getElementById('spawn-x').value) || 0,
                y: parseFloat(document.getElementById('spawn-y').value) || 10,
                z: parseFloat(document.getElementById('spawn-z').value) || 0
            };
            w.floorEnabled = document.getElementById('floor-enabled').checked;
        }
    }
    return out;
}

function loadWorldIntoScene(world) {
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

    const loader = new GLTFLoader();
    const models = world.models || [];
    models.forEach((config, idx) => {
        const path = config.path || '';
    loader.load(path, (gltf) => {
        const model = gltf.scene;
        const pos = config.position || { x: 0, y: 0, z: 0 };
        const rot = config.rotation || { x: 0, y: 0, z: 0 };
        const scale = config.scale || { x: 1, y: 1, z: 1 };
        model.position.set(pos.x, pos.y, pos.z);
        model.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);
        model.scale.set(scale.x, scale.y, scale.z);
        model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        model.userData.editId = 'm' + idx;
        model.userData.config = { path, position: { ...pos }, rotation: { ...rot }, scale: { ...scale }, animate: config.animate ? { ...config.animate } : undefined, teleporter: config.teleporter ? { ...config.teleporter } : undefined, taiko: config.taiko ? { ...config.taiko } : undefined };
        editGroup.add(model);
    }, undefined, (err) => console.error('Load model failed:', path, err));
    });

    const lights = world.lights || [];
    lights.forEach((cfg, idx) => {
        const color = cfg.color !== undefined ? cfg.color : 0xffffff;
        const intensity = cfg.intensity !== undefined ? cfg.intensity : 1;
        let light;
        if (cfg.type === 'ambient') {
            light = new THREE.AmbientLight(color, intensity);
            light.position.set(0, 0, 0);
            light.userData.lightConfig = { type: 'ambient', intensity, color };
            editGroup.add(light);
            lightHelpers.push({ light, mesh: null });
            return;
        }
        if (cfg.type === 'directional') {
            light = new THREE.DirectionalLight(color, intensity);
            if (cfg.position) light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
            if (cfg.castShadow) { light.castShadow = true; }
            light.userData.lightConfig = { type: 'directional', intensity, color, position: cfg.position ? { ...cfg.position } : { x: 50, y: 100, z: 50 }, castShadow: !!cfg.castShadow };
            editGroup.add(light);
            lightHelpers.push({ light, mesh: null });
            return;
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
            return;
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
            return;
        }
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

    const vdbs = world.vdbs || [];
    vdbs.forEach((config) => {
        const framePaths = config.framePaths && config.framePaths.length > 0 ? config.framePaths : [];
        if (framePaths.length === 0) return;
        const pos = config.position || { x: 0, y: 2, z: -5 };
        const rot = config.rotation || { x: 0, y: 0, z: 0 };
        const scale = config.scale || { x: 2, y: 2, z: 2 };
        const obj = createVdbPreviewObject({ framePaths: [...framePaths], position: { ...pos }, rotation: { ...rot }, scale: { ...scale } });
        editGroup.add(obj);
    });

    document.getElementById('spawn-x').value = (world.spawnPoint && world.spawnPoint.x) ?? 0;
    document.getElementById('spawn-y').value = (world.spawnPoint && world.spawnPoint.y) ?? 10;
    document.getElementById('spawn-z').value = (world.spawnPoint && world.spawnPoint.z) ?? 0;
    const floorEl = document.getElementById('floor-enabled');
    if (floorEl) floorEl.checked = world.floorEnabled !== false;
    if (editorGround) editorGround.visible = world.floorEnabled !== false;
    if (editorGrid) editorGrid.visible = world.floorEnabled !== false;
    renderWorldObjectList();
}

function animate() {
    requestAnimationFrame(animate);
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
        if (selectedObject && selectedObject.userData.vdbConfig) {
            selectedObject.userData.vdbConfig.position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
            selectedObject.userData.vdbConfig.rotation = { x: selectedObject.rotation.x * 180 / Math.PI, y: selectedObject.rotation.y * 180 / Math.PI, z: selectedObject.rotation.z * 180 / Math.PI };
            selectedObject.userData.vdbConfig.scale = { x: selectedObject.scale.x, y: selectedObject.scale.y, z: selectedObject.scale.z };
        }
    }
    controls.update();
    renderer.render(scene, camera);
}

// --- API ---
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

async function fetchPdfs() {
    const res = await fetch('/admin/pdfs', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load PDFs');
    pdfList = await res.json();
}

async function fetchVdbs() {
    const res = await fetch('/admin/vdbs', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load VDBs');
    vdbList = await res.json();
}

/**
 * Build framePaths for a VDB sequence from a selected file. Finds same-prefix .vdb files and sorts them.
 * @param {string} selectedPath - e.g. 'vdbs/smoke_001.vdb'
 * @returns {string[]}
 */
function buildFramePathsFromSelected(selectedPath) {
    if (!selectedPath || !vdbList.length) return selectedPath ? [selectedPath] : [];
    const base = selectedPath.replace(/^vdbs\//i, '');
    const baseLower = base.toLowerCase();
    const prefix = baseLower.replace(/\d+\.vdb$/i, ''); // e.g. smoke_
    const samePrefix = vdbList.filter((name) => {
        const n = name.toLowerCase();
        return n.endsWith('.vdb') && n.startsWith(prefix);
    });
    if (samePrefix.length <= 1) return [selectedPath];
    samePrefix.sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)/)?.[1] ?? '0', 10);
        const numB = parseInt(b.match(/(\d+)/)?.[1] ?? '0', 10);
        return numA - numB;
    });
    return samePrefix.map((name) => 'vdbs/' + name);
}

function renderVdbList() {
    const el = document.getElementById('vdb-list');
    if (!el) return;
    el.innerHTML = '';
    vdbList.forEach((name) => {
        const path = 'vdbs/' + name;
        const div = document.createElement('div');
        div.className = 'item' + (selectedVdbPath === path ? ' selected' : '');
        div.textContent = name;
        div.dataset.path = path;
        div.addEventListener('click', () => {
            selectedVdbPath = path;
            renderVdbList();
        });
        el.appendChild(div);
    });
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

function addVdb(framePaths) {
    if (!selectedWorldId || !framePaths || framePaths.length === 0) return;
    pushUndo();
    const pos = { x: 0, y: 2, z: -5 };
    const rot = { x: 0, y: 0, z: 0 };
    const scale = { x: 2, y: 2, z: 2 };
    const obj = createVdbPreviewObject({ framePaths: [...framePaths], position: { ...pos }, rotation: { ...rot }, scale: { ...scale } });
    editGroup.add(obj);
    renderWorldObjectList();
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
    const vdbsArr = [];
    editGroup.children.forEach((child) => {
        if (child.userData.vdbConfig) {
            vdbsArr.push(child);
        } else if (child.userData.pdfConfig) {
            pdfsArr.push(child);
        } else if (child.userData.config) {
            modelsArr.push(child);
        } else if (child.isLight && child.userData.lightConfig) {
            lightsArr.push(child);
        } else if (child.isMesh && child.userData.lightRef) {
            lightsArr.push(child);
        }
    });
    worldObjectList = [...lightsArr, ...modelsArr, ...pdfsArr, ...vdbsArr];
    if (selectedObject) {
        if (lightsArr.includes(selectedObject)) objectListExpanded.lights = true;
        if (modelsArr.includes(selectedObject)) objectListExpanded.models = true;
        if (pdfsArr.includes(selectedObject)) objectListExpanded.pdfs = true;
        if (vdbsArr.includes(selectedObject)) objectListExpanded.vdbs = true;
    }

    function makeItemLabel(child) {
        if (child.userData.vdbConfig) {
            const paths = child.userData.vdbConfig.framePaths || [];
            const first = paths[0] || '';
            return first.split('/').pop() || 'VDB';
        }
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
    el.appendChild(createCategory('VDB', 'vdbs', vdbsArr, lightsArr.length + modelsArr.length + pdfsArr.length));
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
        div.addEventListener('click', () => selectWorld(id));
        el.appendChild(div);
    });
}

function renderModelList() {
    const el = document.getElementById('model-list');
    el.innerHTML = '';
    modelList.forEach((name) => {
        const path = 'models/' + name;
        const div = document.createElement('div');
        div.className = 'item' + (selectedModelPath === path ? ' selected' : '');
        div.textContent = name;
        div.dataset.path = path;
        div.addEventListener('click', () => {
            selectedModelPath = path;
            renderModelList();
        });
        el.appendChild(div);
    });
}

function selectWorld(id) {
    selectedWorldId = id;
    renderWorldList();
    const w = worlds[id];
    if (w) {
        loadWorldIntoScene(w);
        document.getElementById('world-name-row').style.display = '';
        document.getElementById('world-name').value = w.name || id;
    } else {
        document.getElementById('world-name-row').style.display = 'none';
    }
    document.getElementById('btn-delete-world').disabled = !id;
    populateDestWorldSelect();
}

function addModel(path) {
    if (!selectedWorldId) return;
    const loader = new GLTFLoader();
    loader.load(path, (gltf) => {
        pushUndo();
        const model = gltf.scene;
        model.position.set(0, 2, -5);
        model.rotation.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        model.userData.editId = 'm' + Date.now();
        model.userData.config = { path, position: { x: 0, y: 2, z: -5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
        editGroup.add(model);
        renderWorldObjectList();
    }, undefined, (err) => console.error('Load model failed:', path, err));
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
    document.getElementById('obj-taiko').addEventListener('change', syncObjectFromPanel);
    document.getElementById('obj-taiko-radius').addEventListener('change', syncObjectFromPanel);

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

    document.getElementById('btn-add-world').addEventListener('click', () => {
        const id = prompt('ワールドID（英数字・アンダースコア）', 'world_' + Date.now());
        if (!id || /[^a-zA-Z0-9_]/.test(id)) return;
        if (worlds[id]) { alert('そのIDは既に存在します'); return; }
        const name = prompt('表示名', id);
        worlds[id] = { id, name: name || id, models: [], spawnPoint: { x: 0, y: 10, z: 0 }, lights: [], pdfs: [], vdbs: [], floorEnabled: true };
        renderWorldList();
        selectWorld(id);
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
        if (next) selectWorld(next);
        else {
            while (editGroup.children.length) editGroup.remove(editGroup.children[0]);
            document.getElementById('btn-delete-world').disabled = true;
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
        const path = selectedModelPath || (modelList.length ? 'models/' + modelList[0] : null);
        if (path) addModel(path);
        else alert('モデルをアップロードするか、一覧から選択してください');
    });

    document.getElementById('btn-add-pdf').addEventListener('click', () => {
        const path = selectedPdfPath || (pdfList.length ? 'pdfs/' + pdfList[0] : null);
        if (path) addPdf(path);
        else alert('PDFをアップロードするか、一覧から選択してください');
    });

    document.getElementById('btn-add-vdb').addEventListener('click', () => {
        const path = selectedVdbPath || (vdbList.length ? 'vdbs/' + vdbList[0] : null);
        if (path) {
            const framePaths = buildFramePathsFromSelected(path);
            addVdb(framePaths);
        } else {
            alert('VDBをアップロードするか、一覧から選択してください');
        }
    });

    document.getElementById('btn-upload').addEventListener('click', () => document.getElementById('upload-input').click());
    document.getElementById('btn-upload-pdf').addEventListener('click', () => document.getElementById('upload-pdf-input').click());
    document.getElementById('upload-pdf-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const status = document.getElementById('upload-pdf-status');
        status.textContent = '';
        status.className = '';
        const name = file.name.toLowerCase().endsWith('.pdf') ? file.name : file.name + '.pdf';
        const exists = pdfList.some((n) => n.toLowerCase() === name.toLowerCase());
        let url = '/admin/upload-pdf';
        if (exists && !confirm('同名ファイルがあります。上書きしますか？')) {
            e.target.value = '';
            return;
        }
        if (exists) url += '?confirm=1';
        const form = new FormData();
        form.append('pdf', file);
        // サーバー側の文字化けを防ぐためファイル名を UTF-8 → base64 で送る
        form.append('filename_b64', btoa(unescape(encodeURIComponent(file.name))));
        try {
            const res = await fetch(url, { method: 'POST', credentials: 'include', body: form });
            if (res.status === 409) {
                status.textContent = '同名ファイルがあります。上書きするには確認して再送信してください。';
                status.className = 'error';
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            await fetchPdfs();
            renderPdfList();
            const newPath = 'pdfs/' + name;
            selectedPdfPath = newPath;
            loadPdfPreview(newPath);
            status.textContent = 'アップロードしました: ' + name;
        } catch (err) {
            status.textContent = 'アップロード失敗: ' + err.message;
            status.className = 'error';
        }
        e.target.value = '';
    });
    document.getElementById('btn-upload-vdb').addEventListener('click', () => document.getElementById('upload-vdb-input').click());
    document.getElementById('upload-vdb-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const status = document.getElementById('upload-vdb-status');
        status.textContent = '';
        status.className = '';
        const name = file.name.toLowerCase().endsWith('.vdb') ? file.name : file.name + '.vdb';
        const exists = vdbList.some((n) => n.toLowerCase() === name.toLowerCase());
        let url = '/admin/upload-vdb';
        if (exists && !confirm('同名ファイルがあります。上書きしますか？')) {
            e.target.value = '';
            return;
        }
        if (exists) url += '?confirm=1';
        const form = new FormData();
        form.append('vdb', file);
        try {
            const res = await fetch(url, { method: 'POST', credentials: 'include', body: form });
            if (res.status === 409) {
                status.textContent = '同名ファイルがあります。上書きするには確認して再送信してください。';
                status.className = 'error';
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            await fetchVdbs();
            renderVdbList();
            selectedVdbPath = 'vdbs/' + name;
            status.textContent = 'アップロードしました: ' + name;
        } catch (err) {
            status.textContent = 'アップロード失敗: ' + err.message;
            status.className = 'error';
        }
        e.target.value = '';
    });
    document.getElementById('upload-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const status = document.getElementById('upload-status');
        status.textContent = '';
        status.className = '';
        const name = file.name.toLowerCase().endsWith('.glb') ? file.name : file.name + '.glb';
        const exists = modelList.some((n) => n.toLowerCase() === name.toLowerCase());
        let url = '/admin/upload';
        if (exists && !confirm('同名ファイルがあります。上書きしますか？')) {
            e.target.value = '';
            return;
        }
        if (exists) url += '?confirm=1';
        const form = new FormData();
        form.append('model', file);
        try {
            const res = await fetch(url, { method: 'POST', credentials: 'include', body: form });
            if (res.status === 409) {
                status.textContent = '同名ファイルがあります。上書きするには確認して再送信してください。';
                status.className = 'error';
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            await fetchModels();
            renderModelList();
            status.textContent = 'アップロードしました: ' + name;
        } catch (err) {
            status.textContent = 'アップロード失敗: ' + err.message;
            status.className = 'error';
        }
        e.target.value = '';
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
        loadWorldIntoScene(world);
    });

    document.getElementById('world-name').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        worlds[selectedWorldId].name = document.getElementById('world-name').value.trim() || selectedWorldId;
    });

    document.getElementById('spawn-x').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.x = parseFloat(document.getElementById('spawn-x').value) || 0; } });
    document.getElementById('spawn-y').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.y = parseFloat(document.getElementById('spawn-y').value) || 10; } });
    document.getElementById('spawn-z').addEventListener('change', () => { if (selectedWorldId && worlds[selectedWorldId]) { pushUndo(); worlds[selectedWorldId].spawnPoint = worlds[selectedWorldId].spawnPoint || {}; worlds[selectedWorldId].spawnPoint.z = parseFloat(document.getElementById('spawn-z').value) || 0; } });
    document.getElementById('floor-enabled').addEventListener('change', () => {
        if (!selectedWorldId || !worlds[selectedWorldId]) return;
        pushUndo();
        worlds[selectedWorldId].floorEnabled = document.getElementById('floor-enabled').checked;
        if (editorGround) editorGround.visible = worlds[selectedWorldId].floorEnabled;
        if (editorGrid) editorGrid.visible = worlds[selectedWorldId].floorEnabled;
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
    if (!canvas) return;
    initScene();
    bindEvents();
    try {
        await fetchWorlds();
        await fetchModels();
        await fetchPdfs();
        await fetchVdbs();
    } catch (e) {
        console.error('Init fetch error:', e);
        document.getElementById('save-status').textContent = 'ワールド読み込み失敗: ' + e.message;
        document.getElementById('save-status').className = 'error';
    }
    renderWorldList();
    renderModelList();
    renderPdfList();
    renderVdbList();
    populateDestWorldSelect();
    if (Object.keys(worlds).length) selectWorld(Object.keys(worlds)[0]);
    animate();
}

/** ワールド編集エディタを初期化する。admin パネル初表示時に 1 回だけ呼ぶ。 */
export async function initSettingEditor() {
    return init();
}
