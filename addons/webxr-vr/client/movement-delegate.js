// addons/webxr-vr/client/movement-delegate.js — WebXR 用移動委譲（character-controller から分離）

import * as THREE from 'three';

/**
 * WebXR 没入中の歩行移動を character-controller に委譲する。
 */
export class WebXrMovementDelegate {
    constructor(camera) {
        this.camera = camera;
        this.presenting = false;
        this.moveVector = { x: 0, y: 0 };
        this.moveForce = 0;
        this.rigYaw = 0;
        this._speedScale = 0.72;
        this._up = new THREE.Vector3(0, 1, 0);
        this._headFwd = new THREE.Vector3();
        this._moveFwd = new THREE.Vector3();
        this._moveRight = new THREE.Vector3();
        this._rigQuat = new THREE.Quaternion();
        this.direction = new THREE.Vector3();
    }

    /** @returns {boolean} */
    isActive() {
        return this.presenting;
    }

    /** @returns {boolean} */
    blocksDesktopInput() {
        return this.presenting;
    }

    /** @returns {boolean} */
    isMoving() {
        return this.presenting && (this.moveVector.x !== 0 || this.moveVector.y !== 0);
    }

    /** @returns {number} */
    getRigYaw() {
        return this.rigYaw;
    }

    /**
     * @param {boolean} presenting
     */
    setPresenting(presenting) {
        const next = !!presenting;
        if (this.presenting === next) return;
        this.presenting = next;
        if (!next) {
            this.rigYaw = 0;
            this.moveVector.x = 0;
            this.moveVector.y = 0;
            this.moveForce = 0;
        }
    }

    /**
     * @param {{ x: number, y: number, force?: number }} v
     */
    setMoveVector(v) {
        this.moveVector.x = v.x;
        this.moveVector.y = v.y;
        this.moveForce = typeof v.force === 'number' ? Math.min(1, Math.max(0, v.force)) : 1;
    }

    /**
     * @param {number} deltaYaw
     */
    applySnapTurn(deltaYaw) {
        if (!Number.isFinite(deltaYaw)) return;
        this.rigYaw += deltaYaw;
    }

    /**
     * @param {number} deltaTime
     * @param {import('../../../public/js/character-controller.js').default} characterController
     */
    update(deltaTime, characterController) {
        this.direction.set(0, 0, 0);

        const headFwd = this._headFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        headFwd.y = 0;
        if (headFwd.lengthSq() < 1e-8) {
            headFwd.set(0, 0, -1);
        } else {
            headFwd.normalize();
        }

        this._rigQuat.setFromAxisAngle(this._up, this.rigYaw);
        const moveFwd = this._moveFwd.copy(headFwd).applyQuaternion(this._rigQuat);
        const moveRight = this._moveRight.crossVectors(moveFwd, this._up).normalize();

        const useMove = this.moveVector.x !== 0 || this.moveVector.y !== 0;
        if (useMove) {
            this.direction.add(moveFwd.clone().multiplyScalar(this.moveVector.y));
            this.direction.add(moveRight.clone().multiplyScalar(this.moveVector.x));
        }

        if (this.direction.length() > 0) {
            this.direction.normalize();
            characterController.playerYaw = Math.atan2(this.direction.x, this.direction.z);
            characterController.playerQuaternion.setFromAxisAngle(this._up, characterController.playerYaw);
        }

        const moveDirection = new THREE.Vector3();
        if (this.direction.length() > 0) {
            const speed = characterController.moveSpeed
                * characterController.adminSpeedMultiplier
                * this._speedScale
                * this.moveForce;
            moveDirection.copy(this.direction).multiplyScalar(speed * deltaTime);
        }

        const physicsManager = characterController.physicsManager;
        if (characterController.isFlyMode) {
            const pos = physicsManager.getCharacterPosition().clone();
            pos.add(moveDirection);
            const flySpeed = characterController.moveSpeed * characterController.adminSpeedMultiplier * 2;
            if (characterController.flyUp) pos.y += flySpeed * deltaTime;
            if (characterController.flyDown) pos.y -= flySpeed * deltaTime;
            physicsManager.setCharacterPosition(pos.x, pos.y, pos.z);
            physicsManager.resetVelocity();
        } else if (characterController.isPhysicsSuspended?.()) {
            physicsManager.playerVelocity.set(0, 0, 0);
        } else {
            physicsManager.updatePlayer(deltaTime, moveDirection);
        }
    }
}
