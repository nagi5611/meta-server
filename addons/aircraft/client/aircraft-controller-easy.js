// addons/aircraft/client/aircraft-controller-easy.js — easy 操縦（W/S 推力・A/D ヨー・矢印ピッチ/ロール）
import * as THREE from 'three';
import { mergeEasyAircraftPhysicsFromWorld } from './aircraft-physics-easy-defaults.js';
import {
    highSpeedAngularRateScale,
    clampEngineHorizontalSpeedIfLevel,
    pitchFromHorizonDeg,
    updateGroundedHysteresis,
    AIRCRAFT_GROUND_FRICTION_MIN_FORWARD_HORIZ,
} from './aircraft-physics-defaults.js';
import { findObjectByNamePath, stepEngineBladeRotation } from './runtime-prefab-aircraft-anim.js';
import {
    applyAircraftViewpointCamera,
    resolveSlotCameraViewpoints,
    viewpointAtIndex,
} from './camera-viewpoint-runtime.js';
import { viewpointIndexFromLegacyMode } from '../../../public/js/aircraft/camera-viewpoints.js';

const LANDING_RAY_MAX = 500;
const CLEARANCE_ABOVE_GROUND = 0.5;
const GROUNDED_Y_TOLERANCE = 0.15;
/** 床レイ原点をルートより少し上にずらす（メッシュ内原点での取りこぼし緩和） */
const GROUND_PROBE_ORIGIN_LIFT = 2;
/** 1 フレームで下げられる余裕（m）— 連続衝突の代わりに垂直移動だけ制限 */
const VERTICAL_MOVE_MARGIN = 0.02;
const MAX_BANK_RAD = Math.PI / 6;
/** この角度以上の機首上げで推力減衰・対気速度キャップ・上昇減速を適用 (°) */
const EASY_STEEP_CLIMB_PITCH_DEG = 22;

/**
 * easy 操縦: 共有 GLB ルートに推力・姿勢入力を適用し、カメラを更新する
 */
export default class AircraftControllerEasy {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {import('./physics-manager.js').default} physicsManager
     */
    constructor(camera, physicsManager) {
        this.camera = camera;
        this.physicsManager = physicsManager;
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
            rollR: false,
            brake: false,
        };
        this.cameraMode = 'cockpit';
        this.viewpointIndex = 0;
        this._onKeyDown = (e) => this._handleKey(e, true);
        this._onKeyUp = (e) => this._handleKey(e, false);
        this._bound = false;
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');
        this._qClampWorld = new THREE.Quaternion();
        this._qParentWorld = new THREE.Quaternion();
        this._aircraftGrounded = false;
        this._worldAircraftPhysicsRaw = null;
        this.physics = mergeEasyAircraftPhysicsFromWorld(null);
        this.passengerViewSlot = null;
        this.passengerLookYaw = 0;
        this.passengerLookPitch = 0;
        this._passengerMouseSensitivity = 0.002;
        this._onPassengerMouseMove = null;
        this._passengerMouseBound = false;
        this._passengerAimScratch = new THREE.Vector3();
        this._passengerBaseObj = new THREE.Object3D();
        this.pilotLookYaw = 0;
        this.pilotLookPitch = 0;
        this._pilotMouseSensitivity = 0.002;
        this._onPilotMouseMove = null;
        this._pilotMouseBound = false;
        this._qPilotLook = new THREE.Quaternion();
        this._rayDown = new THREE.Vector3(0, -1, 0);
        this._lastGroundMinY = null;
        this._libAnim = null;
        this._libAnimLoadingFor = null;
    }

    /**
     * @param {Record<string, unknown>|null|undefined} raw
     */
    applyWorldPhysics(raw) {
        this._worldAircraftPhysicsRaw = raw;
        this.physics = mergeEasyAircraftPhysicsFromWorld(raw);
    }

    /**
     * @param {'cockpit'|'chase'} mode
     */
    setCameraMode(mode) {
        const slot = this.slot || this.passengerViewSlot;
        this.setViewpointIndex(viewpointIndexFromLegacyMode(mode === 'chase' ? 'chase' : 'cockpit', resolveSlotCameraViewpoints(slot)));
    }

    /**
     * @param {number} index
     */
    setViewpointIndex(index) {
        const slot = this.slot || this.passengerViewSlot;
        const vps = resolveSlotCameraViewpoints(slot);
        const n = Math.max(1, vps.length);
        const next = ((index % n) + n) % n;
        const vp = viewpointAtIndex(vps, next);
        const legacyMode = vp?.role === 'chase' ? 'chase' : 'cockpit';
        if (next !== this.viewpointIndex || legacyMode !== this.cameraMode) {
            this.pilotLookYaw = 0;
            this.pilotLookPitch = 0;
            this.passengerLookYaw = 0;
            this.passengerLookPitch = 0;
        }
        this.viewpointIndex = next;
        this.cameraMode = legacyMode;
    }

    /**
     * @param {object} slot
     */
    bindSlot(slot) {
        this.unbind();
        this.slot = slot;
        this.velocity.set(0, 0, 0);
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._aircraftGrounded = false;
        this._lastGroundMinY = null;
        this.physics = mergeEasyAircraftPhysicsFromWorld(
            slot?.physics && typeof slot.physics === 'object' ? slot.physics : this._worldAircraftPhysicsRaw
        );
        this._attachKeys();
        this._bindPilotMouseLook();
        this._scheduleLibraryAnim();
    }

    unbind() {
        this._detachKeys();
        this._detachPilotMouseLook();
        this.slot = null;
        this.velocity.set(0, 0, 0);
        this._omegaYaw = 0;
        this._omegaPitch = 0;
        this._omegaRoll = 0;
        this._aircraftGrounded = false;
        this._lastGroundMinY = null;
        this._libAnim = null;
        this._libAnimLoadingFor = null;
    }

    /**
     * ルート直下の床面を 1 本レイでサンプル（CCD なし・移動前クランプ用）
     * @param {THREE.Vector3} worldPos
     * @returns {{ minY: number, headroom: number } | null}
     */
    _sampleGroundBelow(worldPos) {
        const collider = this.physicsManager?.collider;
        if (!collider?.geometry?.boundsTree) return null;

        this._lookTarget.set(
            worldPos.x,
            worldPos.y + GROUND_PROBE_ORIGIN_LIFT,
            worldPos.z
        );
        const hit = this.physicsManager.raycastStaticWorld(
            this._lookTarget,
            this._rayDown,
            LANDING_RAY_MAX + GROUND_PROBE_ORIGIN_LIFT
        );
        if (!hit) return null;

        const minY = hit.point.y + CLEARANCE_ABOVE_GROUND;
        return { minY, headroom: worldPos.y - minY };
    }

    /**
     * @param {THREE.Object3D} root
     * @param {THREE.Vector3} worldPos
     */
    _writeRootWorldPosition(root, worldPos) {
        if (root.parent) {
            root.parent.updateMatrixWorld(true);
            this._fwd.copy(worldPos);
            root.parent.worldToLocal(this._fwd);
            root.position.copy(this._fwd);
        } else {
            root.position.copy(worldPos);
        }
        root.updateMatrixWorld(true);
    }

    /**
     * @param {THREE.Object3D} root
     * @param {number} minY
     */
    _snapRootWorldY(root, minY) {
        root.getWorldPosition(this._worldPos);
        if (this._worldPos.y >= minY) return false;
        this._worldPos.y = minY;
        this._writeRootWorldPosition(root, this._worldPos);
        return true;
    }

    /**
     * @param {unknown} rawBindings
     * @param {string} role
     * @returns {string[]}
     */
    _bindingPathsForRole(rawBindings, role) {
        const r = String(role || '').trim();
        if (!r || !rawBindings || typeof rawBindings !== 'object') return [];
        const v = /** @type {Record<string, unknown>} */ (rawBindings)[r];
        /** @type {string[]} */
        const paths = [];
        if (Array.isArray(v)) {
            for (const x of v) {
                const s = typeof x === 'string' ? x.trim() : '';
                if (s) paths.push(s);
            }
        } else if (typeof v === 'string' && v.trim()) {
            paths.push(v.trim());
        }
        return paths;
    }

    /**
     * エンジンブレードのみ（推力入力で回転）
     */
    _scheduleLibraryAnim() {
        this._libAnim = null;
        this._libAnimLoadingFor = null;
        const slot = this.slot;
        const libId = slot?.aircraftLibraryId ? String(slot.aircraftLibraryId).trim() : '';
        if (!libId || !slot?.root) return;
        this._libAnimLoadingFor = libId;
        const root = slot.root;
        const loadingFor = libId;
        fetch(`/api/addons/aircraft/airframes/${encodeURIComponent(libId)}`, { credentials: 'same-origin' })
            .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
            .then(({ ok, j }) => {
                if (this._libAnimLoadingFor !== loadingFor || this.slot?.aircraftLibraryId !== loadingFor) return;
                if (!ok || !j?.ok || !j.airframe) return;
                const ebPaths = this._bindingPathsForRole(j.airframe.bindings, 'engineBlade');
                const eb = j.airframe.animation?.engineBlade;
                const ax = String(eb?.spinAxis || 'z').toLowerCase();
                const axis = ax === 'x' || ax === 'y' || ax === 'z' ? ax : 'z';
                const params = {
                    maxAccelRadPerS2: typeof eb?.maxAccelRadPerS2 === 'number' ? eb.maxAccelRadPerS2 : 24,
                    maxOmegaRadPerS: typeof eb?.maxOmegaRadPerS === 'number' ? eb.maxOmegaRadPerS : 140,
                };
                /** @type {{ blade: THREE.Object3D, axis: 'x'|'y'|'z', params: typeof params, state: { omega: number } }[]} */
                const blades = [];
                for (const path of ebPaths) {
                    const blade = findObjectByNamePath(root, path);
                    if (!blade) continue;
                    blades.push({ blade, axis, params, state: { omega: 0 } });
                }
                if (blades.length) this._libAnim = { blades };
            })
            .catch(() => {});
    }

    bindPassengerView(slot) {
        this.unbindPassengerView();
        this.passengerViewSlot = slot;
        this.passengerLookYaw = 0;
        this.passengerLookPitch = 0;
        this._onPassengerMouseMove = (e) => {
            if (!this.passengerViewSlot) return;
            if (!document.pointerLockElement) return;
            if (this._isInputActive()) return;
            this.passengerLookYaw -= e.movementX * this._passengerMouseSensitivity;
            this.passengerLookPitch -= e.movementY * this._passengerMouseSensitivity;
            const lim = Math.PI / 2 - 0.08;
            this.passengerLookPitch = THREE.MathUtils.clamp(this.passengerLookPitch, -lim, lim);
        };
        document.addEventListener('mousemove', this._onPassengerMouseMove);
        this._passengerMouseBound = true;
    }

    unbindPassengerView() {
        if (this._onPassengerMouseMove && this._passengerMouseBound) {
            document.removeEventListener('mousemove', this._onPassengerMouseMove);
        }
        this._onPassengerMouseMove = null;
        this._passengerMouseBound = false;
        this.passengerViewSlot = null;
        this.passengerLookYaw = 0;
        this.passengerLookPitch = 0;
    }

    _bindPilotMouseLook() {
        this._detachPilotMouseLook();
        this.pilotLookYaw = 0;
        this.pilotLookPitch = 0;
        this._onPilotMouseMove = (e) => {
            if (!this.slot) return;
            if (!document.pointerLockElement) return;
            if (this._isInputActive()) return;
            this.pilotLookYaw -= e.movementX * this._pilotMouseSensitivity;
            this.pilotLookPitch -= e.movementY * this._pilotMouseSensitivity;
            const lim = Math.PI / 2 - 0.08;
            this.pilotLookPitch = THREE.MathUtils.clamp(this.pilotLookPitch, -lim, lim);
        };
        document.addEventListener('mousemove', this._onPilotMouseMove);
        this._pilotMouseBound = true;
    }

    _detachPilotMouseLook() {
        if (this._onPilotMouseMove && this._pilotMouseBound) {
            document.removeEventListener('mousemove', this._onPilotMouseMove);
        }
        this._onPilotMouseMove = null;
        this._pilotMouseBound = false;
        this.pilotLookYaw = 0;
        this.pilotLookPitch = 0;
    }

    _applyPilotLookOffset() {
        this._eulerScratch.set(this.pilotLookPitch, this.pilotLookYaw, 0, 'YXZ');
        this._qPilotLook.setFromEuler(this._eulerScratch);
        this.camera.quaternion.multiply(this._qPilotLook);
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
            this.keys[/** @type {keyof AircraftControllerEasy['keys']} */ (k)] = false;
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
        /** @type {[string, keyof AircraftControllerEasy['keys']][]} */
        const map = [
            ['KeyW', 'forward'],
            ['KeyS', 'back'],
            ['KeyA', 'yawL'],
            ['KeyD', 'yawR'],
            ['ArrowUp', 'pitchDn'],
            ['ArrowDown', 'pitchUp'],
            ['ArrowLeft', 'rollR'],
            ['ArrowRight', 'rollL'],
            ['Space', 'brake'],
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
     * @returns {boolean}
     */
    _isInputActive() {
        const activeElement = document.activeElement;
        if (
            activeElement &&
            (activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.id === 'chat-input')
        ) {
            return true;
        }
        if (document.querySelectorAll('.modal.visible').length > 0) return true;
        if (document.body.dataset.pdfViewerOpen === '1') return true;
        return false;
    }

    /**
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3|null}
     */
    getAvatarFeetWorld(out) {
        return AircraftControllerEasy.getAvatarFeetWorldForSlot(this.slot, out);
    }

    /**
     * @param {object|null|undefined} slot
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3|null}
     */
    static getAvatarFeetWorldForSlot(slot, out) {
        const root = slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        const ck = slot.cockpitOffset || { x: 0, y: 1.2, z: 0 };
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
        return AircraftControllerEasy.getAvatarQuaternionForSlot(this.slot, out);
    }

    /**
     * @param {object|null|undefined} slot
     * @param {THREE.Quaternion} [out]
     * @returns {THREE.Quaternion|null}
     */
    static getAvatarQuaternionForSlot(slot, out) {
        const root = slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        const q = out || new THREE.Quaternion();
        root.getWorldQuaternion(q);
        return q;
    }

    /**
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
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
        };
    }

    /**
     * @returns {{ position: {x:number,y:number,z:number}, quaternion: {x:number,y:number,z:number,w:number} }|null}
     */
    getNetworkCameraPose() {
        const cam = this.camera;
        if (!cam) return null;
        const p = cam.position;
        const q = cam.quaternion;
        return {
            position: { x: p.x, y: p.y, z: p.z },
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
        };
    }

    /**
     * @param {number} input
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
     * @param {THREE.Object3D} root
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
     * @param {number} dt
     */
    _updateLibraryVisuals(dt) {
        if (!this._libAnim?.blades?.length) return;
        const ph = this.physics;
        const thrust = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
        let t01 = thrust > 0 ? 1 : thrust < 0 ? 0.35 : 0;
        if (ph.maxSpeed > 0) {
            t01 = Math.max(t01, THREE.MathUtils.clamp(this.velocity.length() / ph.maxSpeed, 0, 1));
        }
        for (const b of this._libAnim.blades) {
            stepEngineBladeRotation(b.blade, b.axis, b.params, t01, dt, b.state);
        }
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
        const rateScale = highSpeedAngularRateScale(this.velocity.length(), ph.maxSpeed);
        const yawAccel = this._aircraftGrounded ? ph.yawAccelGround : ph.yawAccelAir;
        this._omegaYaw = this._integrateOmega(
            yawIn, this._omegaYaw, yawAccel, ph.yawMaxRate * rateScale, yawDecel, dt
        );
        const pitchAccel = this._aircraftGrounded ? ph.pitchAccelGround : ph.pitchAccelAir;
        const pitchMaxRate = this._aircraftGrounded ? ph.pitchMaxRateGround : ph.pitchMaxRateAir;
        this._omegaPitch = this._integrateOmega(
            pitchIn, this._omegaPitch, pitchAccel, pitchMaxRate * rateScale, dec, dt
        );
        this._omegaRoll = this._integrateOmega(
            rollInEff, this._omegaRoll, ph.rollAccel, ph.rollMaxRate * rateScale, dec, dt
        );

        root.rotateOnAxis(new THREE.Vector3(0, 1, 0), -this._omegaYaw * dt);
        root.rotateOnAxis(new THREE.Vector3(1, 0, 0), this._omegaPitch * dt);
        root.rotateOnAxis(new THREE.Vector3(0, 0, 1), -this._omegaRoll * dt);
        root.updateMatrixWorld(true);
        this._clampWorldBank(root);

        const thrust = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        let thrustDelta = thrust * ph.thrustAccel * dt;
        if (thrustDelta > 0) {
            const pitchH = pitchFromHorizonDeg(this._fwd);
            if (pitchH < -EASY_STEEP_CLIMB_PITCH_DEG) {
                const pitchUpRad = (-pitchH) * (Math.PI / 180);
                thrustDelta *= Math.max(0, Math.cos(pitchUpRad));
            }
        }
        this.velocity.addScaledVector(this._fwd, thrustDelta);
        this.velocity.multiplyScalar(ph.drag);

        root.getWorldPosition(this._worldPos);
        const groundBeforeMove = this._sampleGroundBelow(this._worldPos);
        const headroomBefore = groundBeforeMove?.headroom ?? Infinity;
        const onGroundNow = updateGroundedHysteresis(this._aircraftGrounded, headroomBefore);

        const vH = Math.hypot(this.velocity.x, this.velocity.z);
        const liftAccel = ph.liftPerHorizontalSpeed * vH;
        const netVertAccel = liftAccel - ph.gravity;
        if (onGroundNow) {
            if (this.velocity.y < 0) this.velocity.y = 0;
            if (netVertAccel > 0) this.velocity.y += netVertAccel * dt;
        } else {
            this.velocity.y += netVertAccel * dt;
        }

        const pitchH = pitchFromHorizonDeg(this._fwd);
        if (pitchH >= -EASY_STEEP_CLIMB_PITCH_DEG) {
            clampEngineHorizontalSpeedIfLevel(this.velocity, ph.maxSpeed, this._fwd);
        } else if (!onGroundNow) {
            const airFwd = this.velocity.dot(this._fwd);
            if (airFwd > ph.maxSpeed) {
                this.velocity.addScaledVector(this._fwd, ph.maxSpeed - airFwd);
            }
            const pitchUpRad = (-pitchH) * (Math.PI / 180);
            const speed = this.velocity.length();
            if (speed > 1e-6) {
                const bleed = ph.gravity * Math.sin(pitchUpRad) * dt;
                const newSpeed = Math.max(0, speed - bleed);
                this.velocity.multiplyScalar(newSpeed / speed);
            }
        }

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
        let dy = this.velocity.y * dt;
        if (groundBeforeMove && dy < 0) {
            const maxDrop = Math.max(0, groundBeforeMove.headroom - VERTICAL_MOVE_MARGIN);
            dy = -Math.min(-dy, maxDrop);
        }
        this._worldPos.x += this.velocity.x * dt;
        this._worldPos.y += dy;
        this._worldPos.z += this.velocity.z * dt;
        this._writeRootWorldPosition(root, this._worldPos);

        const groundAfterMove = this._sampleGroundBelow(this._worldPos);
        let minY = groundAfterMove?.minY ?? null;
        if (minY != null) {
            this._lastGroundMinY = minY;
        } else if (
            this._lastGroundMinY != null &&
            this.velocity.y < 0 &&
            this._worldPos.y < this._lastGroundMinY
        ) {
            minY = this._lastGroundMinY;
        }

        if (minY != null) {
            if (this._snapRootWorldY(root, minY) && this.velocity.y < 0) {
                this.velocity.y *= 0.3;
            }
            root.getWorldPosition(this._worldPos);
            const headroom = this._worldPos.y - minY;
            const onGround = updateGroundedHysteresis(this._aircraftGrounded, headroom);
            this._aircraftGrounded = onGround;
            if (onGround) {
                root.getWorldQuaternion(this._worldQuat);
                this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
                let hx = this._fwd.x;
                let hz = this._fwd.z;
                const lenH = Math.hypot(hx, hz);
                if (lenH > AIRCRAFT_GROUND_FRICTION_MIN_FORWARD_HORIZ) {
                    hx /= lenH;
                    hz /= lenH;
                    let fwdSpeed = this.velocity.x * hx + this.velocity.z * hz;
                    if (this.keys.brake) {
                        const step = ph.wheelBrakeDecel * dt;
                        const mag = Math.abs(fwdSpeed);
                        if (mag > 0) {
                            const ds = Math.min(mag, step);
                            fwdSpeed -= Math.sign(fwdSpeed) * ds;
                        }
                    }
                    this.velocity.x = hx * fwdSpeed;
                    this.velocity.z = hz * fwdSpeed;
                }
            }
        } else {
            this._aircraftGrounded = false;
        }

        this._updateLibraryVisuals(dt);
        this._updateCamera();
    }

    updatePassengerCamera() {
        const slot = this.passengerViewSlot;
        if (!slot?.root) return;
        applyAircraftViewpointCamera({
            camera: this.camera,
            root: slot.root,
            slot,
            viewpointIndex: this.viewpointIndex,
            mode: 'passenger',
            lookTarget: this._lookTarget,
            fwd: this._fwd,
            worldQuat: this._worldQuat,
            eulerScratch: this._eulerScratch,
            qParentWorld: this._qParentWorld,
            passengerBaseObj: this._passengerBaseObj,
            passengerAimScratch: this._passengerAimScratch,
            passengerLookYaw: this.passengerLookYaw,
            passengerLookPitch: this.passengerLookPitch,
        });
    }

    /**
     * @returns {{
     *   controlMode: 'easy',
     *   worldX: number, worldY: number, worldZ: number,
     *   speedMs: number,
     *   pitchDeg: number, yawDeg: number, rollDeg: number,
     *   omegaYaw: number, omegaPitch: number, omegaRoll: number,
     *   viewpointName: string,
     *   grounded: boolean
     * }|null}
     */
    getHudSnapshot() {
        const root = this.slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        root.getWorldPosition(this._worldPos);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const r2d = 180 / Math.PI;
        const vps = resolveSlotCameraViewpoints(this.slot);
        const vp = viewpointAtIndex(vps, this.viewpointIndex);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        const speedMs = Math.max(0, this.velocity.dot(this._fwd));
        return {
            controlMode: 'easy',
            worldX: this._worldPos.x,
            worldY: this._worldPos.y,
            worldZ: this._worldPos.z,
            speedMs,
            pitchDeg: this._eulerScratch.x * r2d,
            yawDeg: this._eulerScratch.y * r2d,
            rollDeg: this._eulerScratch.z * r2d,
            omegaYaw: this._omegaYaw,
            omegaPitch: this._omegaPitch,
            omegaRoll: this._omegaRoll,
            viewpointName: vp?.name || vp?.id || '',
            grounded: this._aircraftGrounded,
        };
    }

    snapPilotCamera() {
        this._updateCamera();
    }

    _updateCamera() {
        const slot = this.slot;
        const root = slot?.root;
        if (!root) return;
        applyAircraftViewpointCamera({
            camera: this.camera,
            root,
            slot,
            viewpointIndex: this.viewpointIndex,
            mode: 'pilot',
            lookTarget: this._lookTarget,
            fwd: this._fwd,
            worldQuat: this._worldQuat,
            eulerScratch: this._eulerScratch,
            qParentWorld: this._qParentWorld,
            applyPilotLookOffset: () => this._applyPilotLookOffset(),
        });
    }
}
