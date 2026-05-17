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
