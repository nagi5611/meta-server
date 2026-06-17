// public/pre_xr/js/locomotion.js — 簡易 VR ロコモーション（検証用）

import * as THREE from 'three';
import { readSessionInputs } from './input-utils.js';

const SNAP_RAD = (Math.PI / 180) * 30;
const SNAP_COOLDOWN_SEC = 0.38;
const TELEPORT_COOLDOWN_SEC = 0.45;
const SNAP_THRESHOLD = 0.72;
const TELEPORT_MAX_DIST = 24;
const STICK_DEADZONE = 0.14;
const MOVE_SPEED = 2.4;
const JUMP_VELOCITY = 5.5;
const GRAVITY = 14;

/**
 * プレイヤーリグ + スムーズ移動・スナップ・テレポート・ジャンプ。
 */
export class PreXrLocomotion {
    /**
     * @param {object} opts
     * @param {THREE.Scene} opts.scene
     * @param {THREE.PerspectiveCamera} opts.camera
     * @param {THREE.WebGLRenderer} opts.renderer
     * @param {THREE.Raycaster} opts.raycaster
     * @param {THREE.Object3D} opts.floorMesh
     * @param {(msg: string) => void} [opts.onLog]
     */
    constructor({ scene, camera, renderer, raycaster, floorMesh, onLog = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.raycaster = raycaster;
        this.floorMesh = floorMesh;
        this.onLog = typeof onLog === 'function' ? onLog : () => {};

        /** @type {'both'|'smooth'|'teleport'} */
        this.mode = 'both';
        this.rigYaw = 0;
        this.velocityY = 0;
        this._snapCooldown = 0;
        this._teleportCooldown = 0;
        this._prevLeftGrip = false;
        this._groundY = 1.6;

        this.rig = new THREE.Group();
        this.rig.name = 'preXrPlayerRig';
        this._attached = false;

        this._up = new THREE.Vector3(0, 1, 0);
        this._headFwd = new THREE.Vector3();
        this._moveFwd = new THREE.Vector3();
        this._moveRight = new THREE.Vector3();
        this._rigQuat = new THREE.Quaternion();
        this._tmpOrigin = new THREE.Vector3();
        this._tmpDir = new THREE.Vector3();
        this._tmpDown = new THREE.Vector3(0, -1, 0);

        for (let i = 0; i < 2; i++) {
            const c = this.renderer.xr.getController(i);
            c.addEventListener('selectstart', () => this.onLog(`controller[${i}] selectstart`));
            c.addEventListener('selectend', () => {
                this.onLog(`controller[${i}] selectend`);
                this._tryTeleport(i);
            });
            c.addEventListener('squeezestart', () => this.onLog(`controller[${i}] squeezestart`));
            c.addEventListener('squeezeend', () => this.onLog(`controller[${i}] squeezeend`));
        }
    }

    /** @param {'both'|'smooth'|'teleport'} mode */
    setMode(mode) {
        if (mode === 'both' || mode === 'smooth' || mode === 'teleport') {
            this.mode = mode;
        }
    }

    attach() {
        if (this._attached) return;
        this.scene.add(this.rig);
        this.rig.add(this.camera);
        this.rig.position.set(0, this._groundY, 0);
        this._attached = true;
    }

    detach() {
        if (!this._attached) return;
        if (this.camera.parent === this.rig) {
            this.rig.remove(this.camera);
        }
        if (this.rig.parent === this.scene) {
            this.scene.remove(this.rig);
        }
        this._attached = false;
        this.rigYaw = 0;
        this.velocityY = 0;
    }

    /**
     * @param {number} deltaTime
     * @returns {ReturnType<typeof readSessionInputs>|null}
     */
    update(deltaTime) {
        if (!this.renderer.xr.isPresenting || !this._attached) return null;

        const session = this.renderer.xr.getSession();
        if (!session) return null;

        this._snapCooldown = Math.max(0, this._snapCooldown - deltaTime);
        this._teleportCooldown = Math.max(0, this._teleportCooldown - deltaTime);

        const inp = readSessionInputs(session, STICK_DEADZONE);

        const headFwd = this._headFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        headFwd.y = 0;
        if (headFwd.lengthSq() < 1e-8) {
            headFwd.set(0, 0, -1);
        } else {
            headFwd.normalize();
        }

        this._rigQuat.setFromAxisAngle(this._up, this.rigYaw);
        const moveFwd = this._moveFwd.copy(headFwd).applyQuaternion(this._rigQuat);
        const moveRight = this._moveRight.crossVectors(this._up, moveFwd).normalize();

        const dir = new THREE.Vector3();
        if (inp.moveMag > 0 && this.mode !== 'teleport') {
            dir.add(moveFwd.clone().multiplyScalar(inp.moveY));
            dir.add(moveRight.clone().multiplyScalar(inp.moveX));
            if (dir.lengthSq() > 0) {
                dir.normalize().multiplyScalar(MOVE_SPEED * inp.moveMag * deltaTime);
                this.rig.position.add(dir);
            }
        }

        this._maybeSnapTurn(inp.snapX);

        if (inp.leftGrip && !this._prevLeftGrip) {
            this.velocityY = JUMP_VELOCITY;
            this.onLog('jump (left grip)');
        }
        this._prevLeftGrip = inp.leftGrip;

        this.velocityY -= GRAVITY * deltaTime;
        this.rig.position.y += this.velocityY * deltaTime;
        if (this.rig.position.y < this._groundY) {
            this.rig.position.y = this._groundY;
            this.velocityY = 0;
        }

        this.rig.rotation.set(0, 0, 0);
        this.rig.updateMatrixWorld(true);

        return inp;
    }

    /**
     * @param {number} snapX
     */
    _maybeSnapTurn(snapX) {
        if (this._snapCooldown > 0) return;
        if (Math.abs(snapX) < SNAP_THRESHOLD) return;
        const sign = snapX > 0 ? -1 : 1;
        this.rigYaw += sign * SNAP_RAD;
        this._snapCooldown = SNAP_COOLDOWN_SEC;
        this.onLog(`snap turn ${sign > 0 ? 'left' : 'right'}`);
    }

    /**
     * @param {number} controllerIndex
     */
    _tryTeleport(controllerIndex) {
        if (this.mode === 'smooth') return;
        if (this._teleportCooldown > 0) return;

        const session = this.renderer.xr.getSession();
        if (session) {
            let hasRight = false;
            for (const s of session.inputSources) {
                if (s.handedness === 'right') hasRight = true;
            }
            if (!hasRight) {
                let count = 0;
                for (const s of session.inputSources) {
                    if (s.gamepad?.axes?.length >= 2) count++;
                }
                if (count >= 2 && controllerIndex === 0) hasRight = true;
            }
            if (hasRight && controllerIndex === 0) return;
        }

        const ctrl = this.renderer.xr.getController(controllerIndex);
        const m = new THREE.Matrix4().copy(ctrl.matrixWorld);
        this._tmpOrigin.setFromMatrixPosition(m);
        this._tmpDir.set(0, 0, -1).transformDirection(m).normalize();

        this.raycaster.set(this._tmpOrigin, this._tmpDir);
        const hits = this.raycaster.intersectObject(this.floorMesh, false);
        if (!hits.length || hits[0].distance > TELEPORT_MAX_DIST) return;

        const land = hits[0].point;
        this.rig.position.set(land.x, this._groundY, land.z);
        this.velocityY = 0;
        this._teleportCooldown = TELEPORT_COOLDOWN_SEC;
        this.onLog(`teleport → (${land.x.toFixed(1)}, ${land.z.toFixed(1)})`);
    }

    /** @returns {{ x: number, y: number, z: number, yawDeg: number }} */
    getRigState() {
        return {
            x: this.rig.position.x,
            y: this.rig.position.y,
            z: this.rig.position.z,
            yawDeg: (this.rigYaw * 180 / Math.PI).toFixed(1)
        };
    }
}
