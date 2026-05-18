// public/js/aircraft/mesh-visual-pivot.js — 機体ライブラリの「メッシュ見た目だけ」回転（推力・同期姿勢は root のまま）

import * as THREE from 'three';

/** 推力・物理と同一の root の直下に置くビジュアル用グループ名 */
export const AIRCRAFT_VISUAL_MESH_PIVOT_NAME = 'AircraftVisualMeshPivot';

/** 管理ビューアの視点マーカー親（ピボットに巻き込まない） */
const SKIP_CHILD_NAMES = new Set([AIRCRAFT_VISUAL_MESH_PIVOT_NAME, '_ac_camera_viewpoints']);

/**
 * @param {unknown} eulerDeg
 * @returns {{ x: number, y: number, z: number }}
 */
export function normalizeMeshVisualEulerDeg(eulerDeg) {
    if (!eulerDeg || typeof eulerDeg !== 'object' || Array.isArray(eulerDeg)) {
        return { x: 0, y: 0, z: 0 };
    }
    const o = /** @type {Record<string, unknown>} */ (eulerDeg);
    const ax = typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : 0;
    const ay = typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : 0;
    const az = typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : 0;
    return { x: ax, y: ay, z: az };
}

/**
 * GLB ルート直下のメッシュ群だけを回す。親 root の quaternion は飛行力学・同期の基準のまま。
 * @param {THREE.Object3D} model
 * @param {{ x?: number, y?: number, z?: number }|null|undefined} eulerDeg — 度・ローカル YXZ（コックピット euler と同順）
 * @returns {void}
 */
export function applyMeshVisualEulerDegToModel(model, eulerDeg) {
    const e = normalizeMeshVisualEulerDeg(eulerDeg);
    const hasAny = e.x !== 0 || e.y !== 0 || e.z !== 0;
    const pivot = model.getObjectByName(AIRCRAFT_VISUAL_MESH_PIVOT_NAME);

    if (!hasAny) {
        if (pivot) {
            const toReparent = [...pivot.children];
            for (const c of toReparent) {
                model.attach(c);
            }
            model.remove(pivot);
        }
        model.updateMatrixWorld(true);
        return;
    }

    let p = pivot;
    if (!p) {
        p = new THREE.Group();
        p.name = AIRCRAFT_VISUAL_MESH_PIVOT_NAME;
        model.add(p);
        const kids = model.children.filter((c) => c !== p && !SKIP_CHILD_NAMES.has(c.name));
        for (const c of kids) {
            p.attach(c);
        }
    }

    const rx = THREE.MathUtils.degToRad(e.x);
    const ry = THREE.MathUtils.degToRad(e.y);
    const rz = THREE.MathUtils.degToRad(e.z);
    p.rotation.order = 'YXZ';
    p.rotation.set(rx, ry, rz);
    p.updateMatrixWorld(true);
}
