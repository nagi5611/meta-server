// public/js/aircraft-controller.js — キネマティック飛行（四元数・-Z 前進・BVH 下向きレイ接地）

import * as THREE from 'three';
import { mergeAircraftPhysicsFromWorld } from './aircraft-physics-defaults.js';

const LANDING_RAY_MAX = 500;
const CLEARANCE_ABOVE_GROUND = 0.5;
/** 地上判定の Y 余裕（この範囲なら接地扱いで横スリップのみ除去） */
const GROUNDED_Y_TOLERANCE = 0.15;
/** ワールド YXZ オイラー Z（ロール）の上限 ±30° */
const MAX_BANK_RAD = Math.PI / 6;

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
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');
        this._qClampWorld = new THREE.Quaternion();
        this._qParentWorld = new THREE.Quaternion();
        /** 直前フレーム終了時の接地（レイ判定・接地用ヨー摩擦・ピッチパラメータ切替に使用） */
        this._aircraftGrounded = false;
        this.physics = mergeAircraftPhysicsFromWorld(null);
    }

    /**
     * ワールドの aircraftPhysics（worlds.json）を反映。未指定キーは既定値。
     * @param {Record<string, unknown>|null|undefined} raw
     */
    applyWorldPhysics(raw) {
        this.physics = mergeAircraftPhysicsFromWorld(raw);
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
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._aircraftGrounded = false;
        this._attachKeys();
    }

    unbind() {
        this._detachKeys();
        this.slot = null;
        this.velocity.set(0, 0, 0);
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._aircraftGrounded = false;
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
            ['ArrowUp', 'pitchDn'],
            ['ArrowDown', 'pitchUp'],
            ['ArrowLeft', 'rollR'],
            ['ArrowRight', 'rollL']
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
     * 操縦中アバター・ネットワーク同期用の足元（機体ローカル：コックピット付近を基準に機体に追従）
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3|null}
     */
    getAvatarFeetWorld(out) {
        const root = this.slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        const ck = this.slot.cockpitOffset || { x: 0, y: 1.2, z: 0 };
        const o = out || new THREE.Vector3();
        const localFeetY = Math.max(0, ck.y - 1.0);
        o.set(ck.x, localFeetY, ck.z);
        root.localToWorld(o);
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
     * 角速度 1 軸: 入力ありは角加速度、なしは angularDecel で減速し ±maxRate でクリップ
     * @param {number} input -1 | 0 | 1
     * @param {number} omega
     * @param {number} accel
     * @param {number} maxRate
     * @param {number} decel
     * @param {number} dt
     * @returns {number}
     */
    _integrateOmega(input, omega, accel, maxRate, decel, dt) {
        let w = omega;
        if (input !== 0) {
            w += input * accel * dt;
        } else if (decel > 0) {
            const step = decel * dt;
            if (Math.abs(w) <= step) w = 0;
            else w -= Math.sign(w) * step;
        }
        return THREE.MathUtils.clamp(w, -maxRate, maxRate);
    }

    /**
     * ワールド YXZ のロール角を ±MAX_BANK_RAD に収め、必要ならローカル姿勢を書き換える
     * @param {import('three').Object3D} root
     */
    _clampWorldBank(root) {
        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const z = this._eulerScratch.z;
        if (z <= MAX_BANK_RAD && z >= -MAX_BANK_RAD) return;
        this._eulerScratch.z = THREE.MathUtils.clamp(z, -MAX_BANK_RAD, MAX_BANK_RAD);
        this._qClampWorld.setFromEuler(this._eulerScratch);
        if (root.parent) {
            root.parent.updateMatrixWorld(true);
            root.parent.getWorldQuaternion(this._qParentWorld);
            const qLocal = this._qParentWorld.clone().invert().multiply(this._qClampWorld);
            root.quaternion.copy(qLocal);
        } else {
            root.quaternion.copy(this._qClampWorld);
        }
        this._omegaRoll = 0;
        root.updateMatrixWorld(true);
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        if (!this.slot) return;
        const root = this.slot.root;
        const dt = Math.min(0.1, deltaTime);

        const yawIn = (this.keys.yawR ? 1 : 0) - (this.keys.yawL ? 1 : 0);
        let pitchIn = (this.keys.pitchUp ? 1 : 0) - (this.keys.pitchDn ? 1 : 0);
        const rollIn = (this.keys.rollL ? 1 : 0) - (this.keys.rollR ? 1 : 0);

        const ph = this.physics;
        const dec = ph.angularDecel;

        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const bank = this._eulerScratch.z;
        let rollInEff = rollIn;
        if (bank >= MAX_BANK_RAD - 0.02 && rollIn > 0) rollInEff = 0;
        if (bank <= -MAX_BANK_RAD + 0.02 && rollIn < 0) rollInEff = 0;

        let yawDecel = dec;
        if (this._aircraftGrounded) {
            if (this._omegaYaw > 0) yawDecel += ph.yawGroundFrictionRight;
            else if (this._omegaYaw < 0) yawDecel += ph.yawGroundFrictionLeft;
        }
        this._omegaYaw = this._integrateOmega(yawIn, this._omegaYaw, ph.yawAccel, ph.yawMaxRate, yawDecel, dt);
        const pitchAccel = this._aircraftGrounded ? ph.pitchAccelGround : ph.pitchAccelAir;
        const pitchMaxRate = this._aircraftGrounded ? ph.pitchMaxRateGround : ph.pitchMaxRateAir;
        this._omegaPitch = this._integrateOmega(pitchIn, this._omegaPitch, pitchAccel, pitchMaxRate, dec, dt);
        this._omegaRoll = this._integrateOmega(rollInEff, this._omegaRoll, ph.rollAccel, ph.rollMaxRate, dec, dt);

        root.rotateOnAxis(new THREE.Vector3(0, 1, 0), -this._omegaYaw * dt);
        root.rotateOnAxis(new THREE.Vector3(1, 0, 0), this._omegaPitch * dt);
        root.rotateOnAxis(new THREE.Vector3(0, 0, 1), -this._omegaRoll * dt);
        root.updateMatrixWorld(true);
        this._clampWorldBank(root);

        const thrust = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        this.velocity.addScaledVector(this._fwd, thrust * ph.thrustAccel * dt);
        this.velocity.multiplyScalar(ph.drag);
        const vH = Math.hypot(this.velocity.x, this.velocity.z);
        const liftAccel = ph.liftPerHorizontalSpeed * vH;
        this.velocity.y += (liftAccel - ph.gravity) * dt;
        const sp = this.velocity.length();
        if (sp > ph.maxSpeed) this.velocity.multiplyScalar(ph.maxSpeed / sp);

        const climbK = ph.excessClimbDamping;
        if (climbK > 0 && !this._aircraftGrounded && this.velocity.y > 0) {
            this.velocity.y *= Math.exp(-climbK * dt);
        }

        const slipK = ph.sideslipDamping;
        if (slipK > 0 && !this._aircraftGrounded && this._fwd.lengthSq() > 1e-12) {
            this._lookTarget.copy(this._fwd).normalize();
            const vParallel = this.velocity.dot(this._lookTarget);
            this._worldPos.copy(this._lookTarget).multiplyScalar(vParallel);
            const slipFactor = Math.exp(-slipK * dt);
            this.velocity.sub(this._worldPos);
            this.velocity.multiplyScalar(slipFactor);
            this.velocity.add(this._worldPos);
        }

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
                root.getWorldPosition(this._worldPos);
                const onGround = this._worldPos.y <= minY + GROUNDED_Y_TOLERANCE;
                this._aircraftGrounded = onGround;
                if (onGround) {
                    root.getWorldQuaternion(this._worldQuat);
                    this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
                    let hx = this._fwd.x;
                    let hz = this._fwd.z;
                    const lenH = Math.hypot(hx, hz);
                    if (lenH > 1e-6) {
                        hx /= lenH;
                        hz /= lenH;
                        const fwdSpeed = this.velocity.x * hx + this.velocity.z * hz;
                        this.velocity.x = hx * fwdSpeed;
                        this.velocity.z = hz * fwdSpeed;
                    } else {
                        this.velocity.x = 0;
                        this.velocity.z = 0;
                    }
                }
            } else {
                this._aircraftGrounded = false;
            }
        } else {
            this._aircraftGrounded = false;
        }

        this._updateCamera();
    }

    /**
     * 操縦 HUD 用。毎フレーム update の直後に呼ぶ。
     * @returns {{ speedMs: number, pitchDeg: number, yawDeg: number, rollDeg: number, omegaYaw: number, omegaPitch: number, omegaRoll: number, grounded: boolean }|null}
     */
    getHudSnapshot() {
        const root = this.slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const r2d = 180 / Math.PI;
        return {
            speedMs: this.velocity.length(),
            pitchDeg: this._eulerScratch.x * r2d,
            yawDeg: this._eulerScratch.y * r2d,
            rollDeg: this._eulerScratch.z * r2d,
            omegaYaw: this._omegaYaw,
            omegaPitch: this._omegaPitch,
            omegaRoll: this._omegaRoll,
            grounded: this._aircraftGrounded
        };
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
