// addons/aircraft/client/runtime-prefab-aircraft-anim.js — 機体ライブラリ定義に基づくローカル表示用アニメ（操縦中）

import * as THREE from 'three';

/**
 * 名前パスで子オブジェクトを取得（管理画面と同じ規則）
 * @param {THREE.Object3D} root
 * @param {string} path
 * @returns {THREE.Object3D|null}
 */
export function findObjectByNamePath(root, path) {
    const segments = String(path || '')
        .split('/')
        .filter(Boolean);
    if (!segments.length || !root) return null;
    /** @type {THREE.Object3D} */
    let cur = root;
    for (const seg of segments) {
        const next = cur.children.find((c) => {
            const n = c.name && c.name.trim() ? c.name.trim() : '_unnamed_';
            return n === seg;
        });
        if (!next) return null;
        cur = next;
    }
    return cur;
}

/**
 * エンジンブレードの目標角速度へ角加速度制限付きで追従し、ローカル回転を積む。
 * v1.1 はネット同期しない（各クライアントが同じ定義と機体姿勢から再現）。
 * @param {THREE.Object3D} blade
 * @param {'x'|'y'|'z'} axis
 * @param {{ maxAccelRadPerS2: number, maxOmegaRadPerS: number }} params
 * @param {number} throttle01 0..1
 * @param {number} dt
 * @param {{ omega: number }} state
 */
export function stepEngineBladeRotation(blade, axis, params, throttle01, dt, state) {
    const maxA = Math.max(0.01, Number(params.maxAccelRadPerS2) || 24);
    const maxW = Math.max(0, Number(params.maxOmegaRadPerS) || 140);
    const target = THREE.MathUtils.clamp(throttle01, 0, 1) * maxW;
    let w = state.omega;
    const diff = target - w;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), maxA * dt);
    w += step;
    state.omega = w;
    if (axis === 'x') blade.rotation.x += w * dt;
    else if (axis === 'y') blade.rotation.y += w * dt;
    else blade.rotation.z += w * dt;
}

/**
 * フラップメッシュのローカル軸角度を目標へ角速度上限付きで追従する（操縦中ローカル表示用）
 * @param {THREE.Object3D} mesh
 * @param {'x'|'y'|'z'} axis
 * @param {number} targetRad
 * @param {number} maxOmegaRadPerS
 * @param {number} dt
 * @param {{ angle: number }} state — mesh の当該軸上の累積角と同期（初回は mesh から読む想定）
 */
export function stepFlapDeflection(mesh, axis, targetRad, maxOmegaRadPerS, dt, state) {
    const maxW = Math.max(0.01, Number(maxOmegaRadPerS) || 0.8);
    let cur = state.angle;
    if (!Number.isFinite(cur)) {
        if (axis === 'x') cur = mesh.rotation.x;
        else if (axis === 'y') cur = mesh.rotation.y;
        else cur = mesh.rotation.z;
        state.angle = cur;
    }
    const diff = targetRad - cur;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), maxW * dt);
    cur += step;
    state.angle = cur;
    if (axis === 'x') mesh.rotation.x = cur;
    else if (axis === 'y') mesh.rotation.y = cur;
    else mesh.rotation.z = cur;
}
