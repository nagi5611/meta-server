// public/js/aircraft-controller.js — キネマティック飛行（四元数・-Z 前進・BVH 下向きレイ接地）

import * as THREE from 'three';

const MAX_SPEED = 45;
const THRUST_ACCEL = 18;
const DRAG = 0.985;
const YAW_RATE = 1.1;
const PITCH_RATE = 0.9;
const ROLL_RATE = 1.2;
const LANDING_RAY_MAX = 500;
const CLEARANCE_ABOVE_GROUND = 0.5;

/**
 * 共有 GLB ルートに推力・姿勢入力を適用し、カメラを更新する
 */
export default class AircraftController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {import('./physics-manager.js').default} physicsManager
     */
    constructor(camera, physicsManager) {
        this.camera = camera;
        this.physicsManager = physicsManager;
        /** @type {object|null} scene-manager 由来スロット */
        this.slot = null;
        this.velocity = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._worldQuat = new THREE.Quaternion();
        this._worldPos = new THREE.Vector3();
        this._lookTarget = new THREE.Vector3();
        this.keys = {
            forward: false,
            back: false,
            yawL: false,
            yawR: false,
            pitchUp: false,
            pitchDn: false,
            rollL: false,
            rollR: false
        };
        /** @type {'cockpit'|'chase'} */
        this.cameraMode = 'cockpit';
        this._onKeyDown = (e) => this._handleKey(e, true);
        this._onKeyUp = (e) => this._handleKey(e, false);
        this._bound = false;
    }

    /**
     * @param {'cockpit'|'chase'} mode
     */
    setCameraMode(mode) {
        this.cameraMode = mode === 'chase' ? 'chase' : 'cockpit';
    }

    /**
     * @param {object} slot — getAircraftSlots() の要素
     */
    bindSlot(slot) {
        this.unbind();
        this.slot = slot;
        this.velocity.set(0, 0, 0);
        this._attachKeys();
    }

    unbind() {
        this._detachKeys();
        this.slot = null;
        this.velocity.set(0, 0, 0);
    }

    _attachKeys() {
        if (this._bound) return;
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        this._bound = true;
    }

    _detachKeys() {
        if (!this._bound) return;
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        this._bound = false;
        Object.keys(this.keys).forEach((k) => {
            this.keys[k] = false;
        });
    }

    /**
     * @param {KeyboardEvent} e
     * @param {boolean} down
     */
    _handleKey(e, down) {
        if (!this.slot) return;
        if (this._isInputActive()) return;
        const c = e.code;
        /** @type {[string, keyof AircraftController['keys']][]} */
        const map = [
            ['KeyW', 'forward'],
            ['KeyS', 'back'],
            ['KeyA', 'yawL'],
            ['KeyD', 'yawR'],
            ['ArrowUp', 'pitchUp'],
            ['ArrowDown', 'pitchDn'],
            ['ArrowLeft', 'rollL'],
            ['ArrowRight', 'rollR']
        ];
        for (const [code, key] of map) {
            if (c === code) {
                if (down && e.repeat) return;
                this.keys[key] = down;
                e.preventDefault();
                return;
            }
        }
    }

    /**
     * CharacterController と同様の入力抑止
     * @returns {boolean}
     */
    _isInputActive() {
        const activeElement = document.activeElement;
        if (activeElement && (
            activeElement.tagName === 'INPUT'
            || activeElement.tagName === 'TEXTAREA'
            || activeElement.id === 'chat-input'
        )) {
            return true;
        }
        if (document.querySelectorAll('.modal.visible').length > 0) return true;
        if (document.body.dataset.pdfViewerOpen === '1') return true;
        return false;
    }

    /**
     * アバター同期用の足元相当（ヒット時は地面）
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3|null}
     */
    getAvatarFeetWorld(out) {
        const root = this.slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        const o = out || new THREE.Vector3();
        root.getWorldPosition(o);
        const collider = this.physicsManager?.collider;
        if (collider?.geometry?.boundsTree) {
            const hit = this.physicsManager.raycastStaticWorld(o, new THREE.Vector3(0, -1, 0), LANDING_RAY_MAX);
            if (hit) {
                o.set(hit.point.x, hit.point.y, hit.point.z);
                return o;
            }
        }
        o.y -= 1;
        return o;
    }

    /**
     * @param {THREE.Quaternion} [out]
     * @returns {THREE.Quaternion|null}
     */
    getAvatarQuaternion(out) {
        const root = this.slot?.root;
        if (!root) return null;
        const q = out || new THREE.Quaternion();
        root.getWorldQuaternion(q);
        return q;
    }

    /**
     * player-update に同梱する機体姿勢
     * @returns {{ slotId: string, position: {x,y,z}, quaternion: {x,y,z,w} }|null}
     */
    getPoseForNetwork() {
        const root = this.slot?.root;
        if (!root || !this.slot.id) return null;
        root.updateMatrixWorld(true);
        const p = this._worldPos;
        const q = this._worldQuat;
        root.getWorldPosition(p);
        root.getWorldQuaternion(q);
        return {
            slotId: this.slot.id,
            position: { x: p.x, y: p.y, z: p.z },
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w }
        };
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        if (!this.slot) return;
        const root = this.slot.root;
        const dt = Math.min(0.1, deltaTime);

        const yawIn = (this.keys.yawR ? 1 : 0) - (this.keys.yawL ? 1 : 0);
        const pitchIn = (this.keys.pitchUp ? 1 : 0) - (this.keys.pitchDn ? 1 : 0);
        const rollIn = (this.keys.rollL ? 1 : 0) - (this.keys.rollR ? 1 : 0);

        root.rotateOnAxis(new THREE.Vector3(0, 1, 0), -yawIn * YAW_RATE * dt);
        root.rotateOnAxis(new THREE.Vector3(1, 0, 0), pitchIn * PITCH_RATE * dt);
        root.rotateOnAxis(new THREE.Vector3(0, 0, 1), -rollIn * ROLL_RATE * dt);
        root.updateMatrixWorld(true);

        const thrust = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        this.velocity.addScaledVector(this._fwd, thrust * THRUST_ACCEL * dt);
        this.velocity.multiplyScalar(DRAG);
        const sp = this.velocity.length();
        if (sp > MAX_SPEED) this.velocity.multiplyScalar(MAX_SPEED / sp);

        root.getWorldPosition(this._worldPos);
        this._worldPos.addScaledVector(this.velocity, dt);
        if (root.parent) {
            root.parent.updateMatrixWorld(true);
            root.parent.worldToLocal(this._worldPos);
            root.position.copy(this._worldPos);
        } else {
            root.position.copy(this._worldPos);
        }
        root.updateMatrixWorld(true);

        const collider = this.physicsManager?.collider;
        if (collider?.geometry?.boundsTree) {
            root.getWorldPosition(this._worldPos);
            const hit = this.physicsManager.raycastStaticWorld(
                this._worldPos,
                new THREE.Vector3(0, -1, 0),
                LANDING_RAY_MAX
            );
            if (hit) {
                const minY = hit.point.y + CLEARANCE_ABOVE_GROUND;
                if (this._worldPos.y < minY) {
                    this._worldPos.y = minY;
                    if (root.parent) {
                        root.parent.updateMatrixWorld(true);
                        root.parent.worldToLocal(this._worldPos);
                        root.position.copy(this._worldPos);
                    } else {
                        root.position.copy(this._worldPos);
                    }
                    if (this.velocity.y < 0) this.velocity.y *= 0.3;
                    root.updateMatrixWorld(true);
                }
            }
        }

        this._updateCamera();
    }

    _updateCamera() {
        const root = this.slot?.root;
        if (!root) return;
        const cockpit = this.slot.cockpitOffset;
        const chase = this.slot.chaseOffset;

        if (this.cameraMode === 'cockpit') {
            this._lookTarget.set(cockpit.x, cockpit.y, cockpit.z);
            root.localToWorld(this._lookTarget);
            this.camera.position.copy(this._lookTarget);
            this._lookTarget.set(0, 0, -30);
            root.localToWorld(this._lookTarget);
            this.camera.lookAt(this._lookTarget);
        } else {
            this._lookTarget.set(chase.x, chase.y, chase.z);
            root.localToWorld(this._lookTarget);
            this.camera.position.copy(this._lookTarget);
            root.getWorldPosition(this._fwd);
            this._fwd.y += 1;
            this.camera.lookAt(this._fwd);
        }
    }
}
