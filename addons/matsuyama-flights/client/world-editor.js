// addons/matsuyama-flights/client/world-editor.js — ワールド編集用発着パネル
import * as THREE from 'three';
import { drawFlightBoardCanvas } from './flight-board-mesh.js';

const DEFAULT_POS = { x: 0, y: 2, z: -5 };
const DEFAULT_ROT = { x: 0, y: 0, z: 0 };
const DEFAULT_SCALE = { x: 2, y: 3.5, z: 1 };

/**
 * エディタ用プレースホルダ発着板を editGroup に追加する
 * @param {THREE.Group} editGroup
 * @returns {THREE.Mesh}
 */
export function addFlightBoardToEditor(editGroup) {
    const geom = new THREE.PlaneGeometry(1, 1);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, '松山空港 発着情報\n（保存後メタバースで表示）');

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

    const geom = new THREE.PlaneGeometry(1, 1);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, '松山空港 発着情報');

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
    };
    editGroup.add(mesh);
    return mesh;
}
