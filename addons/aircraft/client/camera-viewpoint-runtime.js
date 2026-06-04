// addons/aircraft/client/camera-viewpoint-runtime.js — 機体視点のカメラ適用（hard/easy 共通）
import * as THREE from 'three';
import {
    resolveSlotCameraViewpoints,
    viewpointAtIndex,
} from '../../../public/js/aircraft/camera-viewpoints.js';

export { resolveSlotCameraViewpoints, viewpointAtIndex };

const _qMouseScratch = new THREE.Quaternion();

/**
 * @param {object|null|undefined} deg
 * @param {THREE.Euler} eulerScratch
 * @param {THREE.Quaternion} qOut
 */
function applyViewpointEulerDeg(deg, eulerScratch, qOut) {
    if (!deg || typeof deg !== 'object') {
        qOut.identity();
        return;
    }
    const rx = THREE.MathUtils.degToRad(Number(deg.x) || 0);
    const ry = THREE.MathUtils.degToRad(Number(deg.y) || 0);
    const rz = THREE.MathUtils.degToRad(Number(deg.z) || 0);
    eulerScratch.set(rx, ry, rz, 'YXZ');
    qOut.setFromEuler(eulerScratch);
}

/**
 * 操縦・同乗カメラを現在の viewpointIndex に合わせる
 * @param {{
 *   camera: THREE.PerspectiveCamera,
 *   root: THREE.Object3D,
 *   slot: object,
 *   viewpointIndex: number,
 *   mode: 'pilot'|'passenger',
 *   lookTarget: THREE.Vector3,
 *   fwd: THREE.Vector3,
 *   worldQuat: THREE.Quaternion,
 *   eulerScratch: THREE.Euler,
 *   qParentWorld: THREE.Quaternion,
 *   passengerBaseObj?: THREE.Object3D,
 *   passengerAimScratch?: THREE.Vector3,
 *   applyPilotLookOffset?: () => void,
 *   passengerLookYaw?: number,
 *   passengerLookPitch?: number,
 * }} ctx
 * @returns {import('../../../public/js/aircraft/camera-viewpoints.js').AircraftViewpoint|null}
 */
export function applyAircraftViewpointCamera(ctx) {
    const vps = resolveSlotCameraViewpoints(ctx.slot);
    const vp = viewpointAtIndex(vps, ctx.viewpointIndex);
    if (!vp) return null;

    const root = ctx.root;
    const pos = vp.position;
    const role = vp.role;

    ctx.lookTarget.set(pos.x, pos.y, pos.z);
    root.localToWorld(ctx.lookTarget);
    ctx.camera.position.copy(ctx.lookTarget);

    const applyVpEuler = () => {
        applyViewpointEulerDeg(vp.eulerDeg, ctx.eulerScratch, ctx.qParentWorld);
        ctx.camera.quaternion.multiply(ctx.qParentWorld);
    };

    if (ctx.mode === 'passenger') {
        ctx.eulerScratch.set(ctx.passengerLookPitch || 0, ctx.passengerLookYaw || 0, 0, 'YXZ');
        _qMouseScratch.setFromEuler(ctx.eulerScratch);

        if (role === 'chase') {
            const aim = ctx.passengerAimScratch;
            const o = ctx.passengerBaseObj;
            if (!aim || !o) return vp;
            root.getWorldPosition(aim);
            aim.y += 1;
            o.position.copy(ctx.camera.position);
            o.quaternion.identity();
            o.lookAt(aim);
            ctx.camera.quaternion.copy(o.quaternion);
            applyViewpointEulerDeg(vp.eulerDeg, ctx.eulerScratch, ctx.qParentWorld);
            ctx.camera.quaternion.multiply(ctx.qParentWorld);
            ctx.camera.quaternion.multiply(_qMouseScratch);
            return vp;
        }

        root.getWorldQuaternion(ctx.worldQuat);
        ctx.camera.quaternion.copy(ctx.worldQuat);
        if (role === 'cockpit') {
            applyVpEuler();
            ctx.camera.quaternion.multiply(_qMouseScratch);
            return vp;
        }

        applyVpEuler();
        ctx.camera.quaternion.multiply(_qMouseScratch);
        return vp;
    }

    if (role === 'chase') {
        root.getWorldPosition(ctx.fwd);
        ctx.fwd.y += 1;
        ctx.camera.lookAt(ctx.fwd);
        applyVpEuler();
        ctx.applyPilotLookOffset?.();
        return vp;
    }

    if (role === 'cockpit') {
        ctx.lookTarget.set(0, 0, -30);
        root.localToWorld(ctx.lookTarget);
        ctx.camera.lookAt(ctx.lookTarget);
        applyVpEuler();
        ctx.applyPilotLookOffset?.();
        return vp;
    }

    root.getWorldQuaternion(ctx.worldQuat);
    ctx.camera.quaternion.copy(ctx.worldQuat);
    applyVpEuler();
    ctx.applyPilotLookOffset?.();
    return vp;
}
