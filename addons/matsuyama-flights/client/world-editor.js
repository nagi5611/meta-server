// addons/matsuyama-flights/client/world-editor.js — ワールド編集用発着パネル
import * as THREE from 'three';
import { t } from '/js/metaverse-i18n.js';
import { normalizeBoardFilter } from './flight-board-filter.js';
import {
    BOARD_ASPECT_H,
    BOARD_ASPECT_W,
    CANVAS_H,
    CANVAS_W,
    drawFlightBoardCanvas,
    fetchFlightBoardData,
    paintFlightBoardMesh,
} from './flight-board-mesh.js';

const DEFAULT_POS = { x: 0, y: 2, z: -5 };
const DEFAULT_ROT = { x: 0, y: 0, z: 0 };
/** 平面が 6.5:4 のため、横長の既定スケール */
const DEFAULT_SCALE = { x: 2, y: 2, z: 1 };
const EDITOR_POLL_MS = 60_000;

/** @type {(() => void)|null} */
let editorPollStop = null;
/** @type {THREE.Group|null} */
let editorPollGroup = null;
/** @type {object|null} */
let editorLastBoardData = null;

/**
 * エディタ用プレビューキャンバス（本番と同じ縦横比）
 * @returns {HTMLCanvasElement}
 */
function createEditorPreviewCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    return canvas;
}

/**
 * editGroup 内の発着板メッシュ一覧
 * @param {THREE.Group} editGroup
 * @returns {THREE.Mesh[]}
 */
function collectEditorFlightBoardMeshes(editGroup) {
    return editGroup.children.filter(
        (c) => c.isMesh && c.userData?.flightBoardCanvas && c.userData?.flightBoardConfig
    );
}

/**
 * 発着板メッシュを生成（キャンバス・テクスチャ付き）
 * @param {import('./flight-board-filter.js').FlightBoardFilter} boardFilter
 * @param {{ x: number, y: number, z: number }} pos
 * @param {{ x: number, y: number, z: number }} rotDeg
 * @param {{ x: number, y: number, z: number }} scale
 * @returns {THREE.Mesh}
 */
function createEditorFlightBoardMesh(boardFilter, pos, rotDeg, scale) {
    const geom = new THREE.PlaneGeometry(BOARD_ASPECT_W, BOARD_ASPECT_H);
    const canvas = createEditorPreviewCanvas();
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, t('flightBoard.loading'), boardFilter);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.set(
        rotDeg.x * Math.PI / 180,
        rotDeg.y * Math.PI / 180,
        rotDeg.z * Math.PI / 180
    );
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.userData.flightBoardConfig = {
        position: { ...pos },
        rotation: { ...rotDeg },
        scale: { ...scale },
        filter: boardFilter,
    };
    mesh.userData.flightBoardCanvas = canvas;
    mesh.userData.flightBoardTexture = tex;
    return mesh;
}

/**
 * エディタ内の全発着板を API データで描画する
 * @param {THREE.Group} editGroup
 */
async function refreshEditorFlightBoards(editGroup) {
    const meshes = collectEditorFlightBoardMeshes(editGroup);
    if (!meshes.length) return;

    try {
        const data = await fetchFlightBoardData();
        editorLastBoardData = data;
        for (const m of meshes) {
            paintFlightBoardMesh(m, data);
        }
    } catch (e) {
        editorLastBoardData = null;
        const msg = e instanceof Error ? e.message : t('flightBoard.fetchFailed');
        for (const m of meshes) {
            const canvas = m.userData.flightBoardCanvas;
            const tex = m.userData.flightBoardTexture;
            if (!canvas || !tex) continue;
            const ctx = canvas.getContext('2d');
            const filter = normalizeBoardFilter(m.userData.flightBoardConfig?.filter);
            drawFlightBoardCanvas(ctx, null, msg, filter);
            tex.needsUpdate = true;
        }
    }
}

/**
 * エディタ用ポーリングを停止する
 */
export function stopFlightBoardEditorPolling() {
    if (editorPollStop) {
        editorPollStop();
        editorPollStop = null;
    }
    editorPollGroup = null;
    editorLastBoardData = null;
}

/**
 * エディタ内の発着板を定期更新する
 * @param {THREE.Group} editGroup
 */
export function startFlightBoardEditorPolling(editGroup) {
    stopFlightBoardEditorPolling();
    editorPollGroup = editGroup;

    const tick = () => {
        if (!editorPollGroup) return;
        const list = collectEditorFlightBoardMeshes(editorPollGroup);
        if (!list.length) return;
        refreshEditorFlightBoards(editorPollGroup).catch(() => {});
    };

    tick();
    const id = setInterval(tick, EDITOR_POLL_MS);
    editorPollStop = () => {
        clearInterval(id);
        editorPollGroup = null;
        editorLastBoardData = null;
    };
}

/**
 * 発着板を1枚追加したあと即時反映する
 * @param {THREE.Group} editGroup
 */
export function refreshEditorFlightBoardsNow(editGroup) {
    refreshEditorFlightBoards(editGroup).catch(() => {});
}

/**
 * 言語変更時にエディタ板を再描画（admin で i18n を同期している場合）
 */
export function repaintEditorFlightBoardsForLocale() {
    if (!editorPollGroup || !editorLastBoardData) return;
    for (const m of collectEditorFlightBoardMeshes(editorPollGroup)) {
        paintFlightBoardMesh(m, editorLastBoardData);
    }
}

/**
 * エディタ用プレースホルダ発着板を editGroup に追加する
 * @param {THREE.Group} editGroup
 * @param {import('./flight-board-filter.js').FlightBoardFilter} [filter]
 * @returns {THREE.Mesh}
 */
export function addFlightBoardToEditor(editGroup, filter = 'all') {
    const boardFilter = normalizeBoardFilter(filter);
    const mesh = createEditorFlightBoardMesh(
        boardFilter,
        DEFAULT_POS,
        DEFAULT_ROT,
        DEFAULT_SCALE
    );
    editGroup.add(mesh);
    if (editorPollGroup !== editGroup) {
        startFlightBoardEditorPolling(editGroup);
    } else {
        refreshEditorFlightBoardsNow(editGroup);
    }
    return mesh;
}

/**
 * worlds.json の flightBoard 設定からエディタに復元する
 * @param {THREE.Group} editGroup
 * @param {object} config
 * @returns {THREE.Mesh}
 */
export function loadFlightBoardIntoEditor(editGroup, config) {
    const pos = config.position || DEFAULT_POS;
    const rot = config.rotation || DEFAULT_ROT;
    const scale = config.scale || DEFAULT_SCALE;
    const boardFilter = normalizeBoardFilter(config.filter);

    const mesh = createEditorFlightBoardMesh(boardFilter, pos, rot, scale);
    editGroup.add(mesh);
    return mesh;
}
