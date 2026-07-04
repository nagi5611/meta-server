// addons/aircraft/client/runtime-prefab-aircraft-anim.js — 機体ライブラリ定義に基づくローカル表示用アニメ（操縦中）

import * as THREE from 'three';

/**
 * @param {THREE.Object3D} obj
 * @returns {string}
 */
function objectDisplayName(obj) {
    return obj.name && obj.name.trim() ? obj.name.trim() : '_unnamed_';
}

/**
 * 同名兄弟がいる場合は `Name#2` 形式で一意化する（管理画面とゲームで同じ規則）
 * @param {THREE.Object3D} obj
 * @param {THREE.Object3D} root
 * @returns {string}
 */
export function objectNamePathFromRoot(obj, root) {
    /** @type {string[]} */
    const parts = [];
    let o = obj;
    while (o && o !== root) {
        const parent = o.parent;
        const base = objectDisplayName(o);
        if (parent) {
            const same = parent.children.filter((c) => objectDisplayName(c) === base);
            if (same.length > 1) {
                const idx = same.indexOf(o);
                parts.unshift(`${base}#${idx + 1}`);
            } else {
                parts.unshift(base);
            }
        } else {
            parts.unshift(base);
        }
        o = parent;
    }
    return parts.join('/');
}

/**
 * @param {THREE.Object3D} parent
 * @param {string} seg
 * @returns {THREE.Object3D[]}
 */
function childrenMatchingSegment(parent, seg) {
    const m = /^(.+)#(\d+)$/.exec(seg);
    const base = m ? m[1] : seg;
    const numbered = m ? Math.max(1, parseInt(m[2], 10)) : 0;
    const matches = parent.children.filter((c) => objectDisplayName(c) === base);
    if (numbered > 0) {
        const pick = matches[numbered - 1];
        return pick ? [pick] : [];
    }
    if (matches.length) return matches;
    return parent.children.filter((c) => objectDisplayName(c) === seg);
}

/**
 * 名前パスで子オブジェクトを取得（管理画面と同じ規則）
 * @param {THREE.Object3D} root
 * @param {string} path
 * @param {Set<string>} [usedUuids] 同一パスを複数割当したとき、未使用の兄弟を選ぶ
 * @returns {THREE.Object3D|null}
 */
export function findObjectByNamePath(root, path, usedUuids) {
    const segments = String(path || '')
        .split('/')
        .filter(Boolean);
    if (!segments.length || !root) return null;
    /** @type {THREE.Object3D} */
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        const candidates = childrenMatchingSegment(cur, seg);
        if (!candidates.length) return null;
        if (isLast) {
            let pick = candidates[0];
            if (usedUuids && usedUuids.size > 0) {
                const fresh = candidates.find((c) => !usedUuids.has(c.uuid));
                if (fresh) pick = fresh;
            }
            return pick;
        }
        if (candidates.length !== 1) return null;
        cur = candidates[0];
    }
    return cur;
}

/**
 * バインドパス配列を順に解決し、各エントリごとに別オブジェクトを優先して返す
 * @param {THREE.Object3D} root
 * @param {string[]} paths
 * @returns {THREE.Object3D[]}
 */
export function findObjectsForBindingPaths(root, paths) {
    const used = new Set();
    /** @type {THREE.Object3D[]} */
    const out = [];
    for (const path of paths) {
        const p = String(path || '').trim();
        if (!p) continue;
        const obj = findObjectByNamePath(root, p, used);
        if (!obj) continue;
        used.add(obj.uuid);
        out.push(obj);
    }
    return out;
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
    stepEngineBladeRotationToTargetOmega(blade, axis, target, maxA, dt, state);
}

/**
 * 目標角速度 (rad/s) へ角加速度制限付きで追従し、ローカル回転を積む。
 * @param {THREE.Object3D} blade
 * @param {'x'|'y'|'z'} axis
 * @param {number} targetOmegaRadPerS
 * @param {number} maxAccelRadPerS2
 * @param {number} dt
 * @param {{ omega: number }} state
 */
export function stepEngineBladeRotationToTargetOmega(blade, axis, targetOmegaRadPerS, maxAccelRadPerS2, dt, state) {
    const maxA = Math.max(0.01, Number(maxAccelRadPerS2) || 5);
    const target = Math.max(0, Number(targetOmegaRadPerS) || 0);
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
