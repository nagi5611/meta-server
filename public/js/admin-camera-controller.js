// public/js/admin-camera-controller.js — 管理者カメラログイン用フリーカメラ
import * as THREE from 'three';
import { getInputGuard } from '../../lib/client-addon-registry.js';

const MAX_YAW_VIEW_DELTA_PER_EVENT_RAD = (10 * Math.PI) / 180;
const MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD = (15 * Math.PI) / 180;

/**
 * @param {number} deltaRad
 * @returns {number}
 */
function clampYawViewDeltaPerEventRad(deltaRad) {
    return THREE.MathUtils.clamp(
        deltaRad,
        -MAX_YAW_VIEW_DELTA_PER_EVENT_RAD,
        MAX_YAW_VIEW_DELTA_PER_EVENT_RAD
    );
}

/**
 * @param {number} deltaRad
 * @returns {number}
 */
function clampPitchViewDeltaPerEventRad(deltaRad) {
    return THREE.MathUtils.clamp(
        deltaRad,
        -MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD,
        MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD
    );
}

/**
 * 管理者ステルスカメラ: WASD・Space・Shift で自由移動、マウスで視点操作
 */
export class AdminCameraController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {{ baseFov?: number, moveSpeed?: number }} [options]
     */
    constructor(camera, options = {}) {
        this.camera = camera;
        this.baseFov = options.baseFov ?? 75;
        this.moveSpeed = options.moveSpeed ?? 10;
        this.zoomFactor = 1;

        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.moveUp = false;
        this.moveDown = false;

        this.yaw = 0;
        this.pitch = 0;
        this.mouseSensitivity = 0.002;
        this.isPointerLocked = false;

        this._forward = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._velocity = new THREE.Vector3();
        this._eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');
        this._quatScratch = new THREE.Quaternion();

        this._syncAnglesFromCamera();
        this.applyZoomToFov();
        this.setupControls();
    }

    /** カメラ姿勢からヨー・ピッチを復元 */
    _syncAnglesFromCamera() {
        this._eulerScratch.setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.yaw = this._eulerScratch.y;
        this.pitch = this._eulerScratch.x;
    }

    setupControls() {
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = document.pointerLockElement != null;
        });

        const canvas = document.getElementById('canvas');
        if (canvas) {
            canvas.addEventListener('click', () => {
                if (this.shouldBlockDesktopInput()) return;
                if (!this.isPointerLocked) {
                    requestAnimationFrame(() => {
                        if (this.shouldBlockDesktopInput() || document.pointerLockElement) return;
                        document.body.requestPointerLock().catch(() => {});
                    });
                }
            });
        }
    }

    /**
     * @returns {boolean}
     */
    shouldBlockDesktopInput() {
        if (getInputGuard()?.()) return true;
        return false;
    }

    /**
     * @returns {boolean}
     */
    isInputActive() {
        const activeElement = document.activeElement;
        if (activeElement && (
            activeElement.tagName === 'INPUT'
            || activeElement.tagName === 'TEXTAREA'
            || activeElement.tagName === 'SELECT'
            || activeElement.isContentEditable
        )) {
            return true;
        }
        return false;
    }

    onKeyDown(event) {
        if (this.isInputActive()) return;
        switch (event.code) {
            case 'KeyW': this.moveForward = true; break;
            case 'KeyS': this.moveBackward = true; break;
            case 'KeyA': this.moveLeft = true; break;
            case 'KeyD': this.moveRight = true; break;
            case 'Space': this.moveUp = true; event.preventDefault(); break;
            case 'ShiftLeft':
            case 'ShiftRight': this.moveDown = true; break;
            default: break;
        }
    }

    onKeyUp(event) {
        switch (event.code) {
            case 'KeyW': this.moveForward = false; break;
            case 'KeyS': this.moveBackward = false; break;
            case 'KeyA': this.moveLeft = false; break;
            case 'KeyD': this.moveRight = false; break;
            case 'Space': this.moveUp = false; break;
            case 'ShiftLeft':
            case 'ShiftRight': this.moveDown = false; break;
            default: break;
        }
    }

    onMouseMove(event) {
        if (this.shouldBlockDesktopInput()) return;
        if (!this.isPointerLocked) return;

        let dYaw = -event.movementX * this.mouseSensitivity;
        let dPitch = -event.movementY * this.mouseSensitivity;
        dYaw = clampYawViewDeltaPerEventRad(dYaw);
        dPitch = clampPitchViewDeltaPerEventRad(dPitch);
        this.yaw += dYaw;
        this.pitch += dPitch;
        this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
    }

    /**
     * ズーム倍率（0.5=広角〜10=望遠）
     * @param {number} factor
     */
    setZoomFactor(factor) {
        if (!Number.isFinite(factor)) return;
        this.zoomFactor = THREE.MathUtils.clamp(factor, 0.5, 10);
        this.applyZoomToFov();
    }

    /** 現在のズーム倍率 */
    getZoomFactor() {
        return this.zoomFactor;
    }

    applyZoomToFov() {
        this.camera.fov = this.baseFov / this.zoomFactor;
        this.camera.updateProjectionMatrix();
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        this._eulerScratch.set(this.pitch, this.yaw, 0);
        this.camera.quaternion.setFromEuler(this._eulerScratch);

        this._velocity.set(0, 0, 0);
        this.camera.getWorldDirection(this._forward);
        this._forward.y = 0;
        if (this._forward.lengthSq() < 1e-8) {
            this._forward.set(0, 0, -1);
        } else {
            this._forward.normalize();
        }
        this._right.crossVectors(this._forward, new THREE.Vector3(0, 1, 0)).normalize();

        if (this.moveForward) this._velocity.add(this._forward);
        if (this.moveBackward) this._velocity.sub(this._forward);
        if (this.moveRight) this._velocity.add(this._right);
        if (this.moveLeft) this._velocity.sub(this._right);
        if (this.moveUp) this._velocity.y += 1;
        if (this.moveDown) this._velocity.y -= 1;

        if (this._velocity.lengthSq() > 0) {
            this._velocity.normalize().multiplyScalar(this.moveSpeed * deltaTime);
            this.camera.position.add(this._velocity);
        }
    }

    /** @returns {THREE.Vector3} */
    getPosition() {
        return this.camera.position;
    }

    /** @returns {THREE.Quaternion} */
    getRotation() {
        return this.camera.quaternion;
    }

    /** @returns {'idle'} */
    getAnimationState() {
        return 'idle';
    }

    /** @returns {{ isMoving: boolean, isDashing: boolean, isGrounded: boolean }} */
    getMovementState() {
        const isMoving = this.moveForward || this.moveBackward || this.moveLeft || this.moveRight
            || this.moveUp || this.moveDown;
        return { isMoving, isDashing: false, isGrounded: true };
    }

    isWalkingCharacter() {
        return false;
    }

    setSuspendPhysicsUntilGameplayInput(_suspended) {
        /* カメラモードでは物理なし */
    }

    notifyGameplayInputIntent() {
        /* no-op */
    }

    resetMovement() {
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.moveUp = false;
        this.moveDown = false;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setPosition(x, y, z) {
        this.camera.position.set(x, y, z);
    }

    resetVelocity() {
        /* no-op */
    }

    setMobileMode(_enabled) {
        /* カメラモードは PC 専用 */
    }

    setViewMode(_mode) {
        /* no-op */
    }

    setHeadPositionProvider(_fn) {
        /* no-op */
    }

    setAircraftPoseProvider(_provider) {
        /* no-op */
    }
}

export default AdminCameraController;
