// public/js/aircraft/aircraft-body-orient.js — 飛行機メッシュの前後逆などをワールド側で補正（操縦の前進は -Z 基準）

import * as THREE from 'three';

/**
 * aircraft.bodyEulerDeg からオフセット四元数を返す（未指定は単位）
 * @param {unknown} aircraftCfg - models[].aircraft
 * @returns {THREE.Quaternion}
 */
export function getAircraftBodyOffsetQuaternion(aircraftCfg) {
    const raw = aircraftCfg && typeof aircraftCfg === 'object' && !Array.isArray(aircraftCfg)
        ? /** @type {Record<string, unknown>} */ (aircraftCfg).bodyEulerDeg
        : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return new THREE.Quaternion();
    }
    const o = /** @type {Record<string, unknown>} */ (raw);
    const nx = (k) => {
        const v = o[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const x = nx('x');
    const y = nx('y');
    const z = nx('z');
    if (x === 0 && y === 0 && z === 0) return new THREE.Quaternion();
    const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(x),
        THREE.MathUtils.degToRad(y),
        THREE.MathUtils.degToRad(z),
        'XYZ'
    );
    return new THREE.Quaternion().setFromEuler(euler);
}

/**
 * オブジェクトの姿勢が Qcfg * Qbody であると仮定し、ワールド JSON 用の Qcfg に対応するオイラー（度・XYZ）を返す
 * @param {THREE.Object3D} model
 * @param {unknown} aircraftCfg
 * @returns {{ x: number, y: number, z: number }}
 */
export function extractConfigRotationDegFromModelWithAircraftBody(model, aircraftCfg) {
    const qBody = getAircraftBodyOffsetQuaternion(aircraftCfg);
    const qInv = qBody.clone().invert();
    const qCfg = model.quaternion.clone().multiply(qInv);
    const euler = new THREE.Euler(0, 0, 0, 'XYZ').setFromQuaternion(qCfg, 'XYZ');
    return {
        x: (euler.x * 180) / Math.PI,
        y: (euler.y * 180) / Math.PI,
        z: (euler.z * 180) / Math.PI
    };
}

/**
 * rotation（config.rotation のみ反映済み）のあとに bodyEulerDeg を乗算する
 * @param {THREE.Object3D} model
 * @param {unknown} aircraftCfg
 */
export function applyAircraftBodyOrientationToObject3D(model, aircraftCfg) {
    if (!model) return;
    const qBody = getAircraftBodyOffsetQuaternion(aircraftCfg);
    if (qBody.w === 1 && qBody.x === 0 && qBody.y === 0 && qBody.z === 0) return;
    model.quaternion.multiply(qBody);
}
