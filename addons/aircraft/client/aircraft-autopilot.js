// addons/aircraft/client/aircraft-autopilot.js — オートパイロット状態と慣性運動
import * as THREE from 'three';

const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

/**
 * オートパイロット用の状態オブジェクトを生成する
 * @returns {{ enabled: boolean, velocity: THREE.Vector3, omegaYaw: number, omegaPitch: number, omegaRoll: number }}
 */
export function createAircraftAutopilotState() {
    return {
        enabled: false,
        velocity: new THREE.Vector3(),
        omegaYaw: 0,
        omegaPitch: 0,
        omegaRoll: 0,
    };
}

/**
 * オートパイロットを無効化する
 * @param {{ enabled: boolean }} state
 */
export function resetAircraftAutopilot(state) {
    state.enabled = false;
}

/**
 * 現在の速度・角速度をオートパイロット用に記録する
 * @param {{ velocity: THREE.Vector3, omegaYaw: number, omegaPitch: number, omegaRoll: number }} state
 * @param {THREE.Vector3} velocity
 * @param {number} omegaYaw
 * @param {number} omegaPitch
 * @param {number} omegaRoll
 */
export function snapshotAircraftAutopilot(state, velocity, omegaYaw, omegaPitch, omegaRoll) {
    state.velocity.copy(velocity);
    state.omegaYaw = omegaYaw;
    state.omegaPitch = omegaPitch;
    state.omegaRoll = omegaRoll;
}

/**
 * 記録済み角速度で機体ルートを回転する
 * @param {THREE.Object3D} root
 * @param {number} omegaYaw
 * @param {number} omegaPitch
 * @param {number} omegaRoll
 * @param {number} dt
 */
export function rotateAircraftRootByOmega(root, omegaYaw, omegaPitch, omegaRoll, dt) {
    root.rotateOnAxis(_axisY, -omegaYaw * dt);
    root.rotateOnAxis(_axisX, omegaPitch * dt);
    root.rotateOnAxis(_axisZ, -omegaRoll * dt);
}

/**
 * 記録済み速度で機体ルートを平行移動する
 * @param {THREE.Object3D} root
 * @param {THREE.Vector3} velocity
 * @param {number} dt
 * @param {THREE.Vector3} worldPosScratch
 */
export function moveAircraftRootByVelocity(root, velocity, dt, worldPosScratch) {
    root.updateMatrixWorld(true);
    root.getWorldPosition(worldPosScratch);
    worldPosScratch.addScaledVector(velocity, dt);
    if (root.parent) {
        root.parent.updateMatrixWorld(true);
        root.parent.worldToLocal(worldPosScratch);
        root.position.copy(worldPosScratch);
    } else {
        root.position.copy(worldPosScratch);
    }
    root.updateMatrixWorld(true);
}
