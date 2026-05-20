// addons/matsuyama-flights/client/world-editor.js — ワールド編集用発着パネル
import * as THREE from 'three';
import {
    boardFilterCanvasTag,
    normalizeBoardFilter,
} from './flight-board-filter.js';
import {
    BOARD_ASPECT_H,
    BOARD_ASPECT_W,
    CANVAS_H,
    CANVAS_W,
    drawFlightBoardCanvas,
} from './flight-board-mesh.js';

const DEFAULT_POS = { x: 0, y: 2, z: -5 };
const DEFAULT_ROT = { x: 0, y: 0, z: 0 };
/** 平面が 5:4 のため、横長の既定スケール */
const DEFAULT_SCALE = { x: 2, y: 2, z: 1 };

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
 * エディタ用プレースホルダ発着板を editGroup に追加する
 * @param {THREE.Group} editGroup
 * @param {import('./flight-board-filter.js').FlightBoardFilter} [filter]
 * @returns {THREE.Mesh}
 */
export function addFlightBoardToEditor(editGroup, filter = 'all') {
    const boardFilter = normalizeBoardFilter(filter);
    const tag = boardFilterCanvasTag(boardFilter);
    const previewMsg = tag
        ? `松山空港 ${tag}（保存後に表示）`
        : '松山空港 運行状況（保存後に表示）';

    const geom = new THREE.PlaneGeometry(BOARD_ASPECT_W, BOARD_ASPECT_H);
    const canvas = createEditorPreviewCanvas();
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, previewMsg, boardFilter);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(DEFAULT_POS.x, DEFAULT_POS.y, DEFAULT_POS.z);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(DEFAULT_SCALE.x, DEFAULT_SCALE.y, DEFAULT_SCALE.z);
    mesh.userData.flightBoardConfig = {
        position: { ...DEFAULT_POS },
        rotation: { ...DEFAULT_ROT },
        scale: { ...DEFAULT_SCALE },
        filter: boardFilter,
    };
    editGroup.add(mesh);
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
    const tag = boardFilterCanvasTag(boardFilter);
    const previewMsg = tag ? `松山空港 ${tag}` : '松山空港 運行状況';

    const geom = new THREE.PlaneGeometry(BOARD_ASPECT_W, BOARD_ASPECT_H);
    const canvas = createEditorPreviewCanvas();
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, previewMsg, boardFilter);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.set(
        rot.x * Math.PI / 180,
        rot.y * Math.PI / 180,
        rot.z * Math.PI / 180
    );
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.userData.flightBoardConfig = {
        position: { ...pos },
        rotation: { ...rot },
        scale: { ...scale },
        filter: boardFilter,
    };
    editGroup.add(mesh);
    return mesh;
}
