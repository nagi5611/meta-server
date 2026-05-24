// addons/aircraft/client/aircraft-controller.js — キネマティック飛行（四元数・-Z 前進・BVH 下向きレイ接地）
// 入力: 矢印=スロットル/フラップ、W/S=ピッチ、A/D=ロール、Q/E=ラダー、Space=ブレーキ
// 直線運動は AIRCRAFT_PHYSICS_INTERNAL.linearWorldScale（既定 0.4）でワールド移動のみ縮小。パラメータ・HUD は名目 m/s。
// FBW 風は簡易モデル（一般向け航空解説ベースのゲイン・Vfe 近似。実機 FCOM 非根拠）

import * as THREE from 'three';
import {
    mergeAircraftPhysicsFromWorld,
    flapAuthorityMultipliers,
    flapLiftCoeff,
    flapVfeMs,
    thrustAccelFromEngineRpm,
    AIRCRAFT_PHYSICS_INTERNAL
} from './aircraft-physics-defaults.js';
import { findObjectByNamePath, stepEngineBladeRotation, stepFlapDeflection } from './runtime-prefab-aircraft-anim.js';

const LANDING_RAY_MAX = 500;
const CLEARANCE_ABOVE_GROUND = 0.5;
/** 地上判定の Y 余裕（この範囲なら接地扱いで横スリップのみ除去） */
const GROUNDED_Y_TOLERANCE = 0.15;
/** 前後速度がこの値未満なら静止摩擦（横滑り抑制に tireStaticFriction を使用） */
const FWD_SPEED_STATIC_FRICTION_EPS = 0.05;

/** レバー表記（右矢印でインデックス増＝展開大） */
export const AIRCRAFT_FLAP_LABELS = Object.freeze(['UP', '1', '5', '15', '20', '25', '30']);

const THROTTLE_MIN = -0.3;
const THROTTLE_MAX = 1;
/** 荷重解放: 連続収納の間隔 (s) */
const FLAP_RELIEF_COOLDOWN_S = 0.22;

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
        /** 揚力計算用: ローカル +Y をワールドへ（翼面の法線） */
        this._bodyUp = new THREE.Vector3();
        this._worldQuat = new THREE.Quaternion();
        this._worldPos = new THREE.Vector3();
        this._lookTarget = new THREE.Vector3();
        this.keys = {
            throttleUp: false,
            throttleDown: false,
            yawL: false,
            yawR: false,
            pitchUp: false,
            pitchDn: false,
            rollL: false,
            rollR: false,
            brake: false
        };
        /** 無次元スロットル THROTTLE_MIN..THROTTLE_MAX */
        this._throttle = 0;
        this._prevThrottle = 0;
        /** エンジン回転数 (RPM)。スロットル目標に engineRpmAccel で追従 */
        this._engineRpm = 0;
        /** 0..6 = UP..30 */
        this._flapIndex = 0;
        this._flapReliefCooldown = 0;
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
        /** @type {Record<string, unknown>|null|undefined} applyWorldPhysics に渡した直近の生データ */
        this._worldAircraftPhysicsRaw = null;
        this.physics = mergeAircraftPhysicsFromWorld(null);
        /** 乗客モード: 操縦入力なしでカメラのみ。機体姿勢はネット同期 */
        this.passengerViewSlot = null;
        this.passengerLookYaw = 0;
        this.passengerLookPitch = 0;
        this._passengerMouseSensitivity = 0.002;
        /** @type {((e: MouseEvent) => void)|null} */
        this._onPassengerMouseMove = null;
        this._passengerMouseBound = false;
        this._passengerAimScratch = new THREE.Vector3();
        this._passengerBaseObj = new THREE.Object3D();
        /** 操縦中: ポインターロック時のヘッドムーブ（機体基準カメラに上乗せ） */
        this.pilotLookYaw = 0;
        this.pilotLookPitch = 0;
        this._pilotMouseSensitivity = 0.002;
        /** @type {((e: MouseEvent) => void)|null} */
        this._onPilotMouseMove = null;
        this._pilotMouseBound = false;
        this._qPilotLook = new THREE.Quaternion();
        /**
         * @type {{
         *   blades: { blade: THREE.Object3D, axis: 'x'|'y'|'z', params: { maxAccelRadPerS2: number, maxOmegaRadPerS: number }, state: { omega: number } }[],
         *   flaps: { mesh: THREE.Object3D, axis: 'x'|'y'|'z', sign: number, maxAngleRad: number, maxOmegaRadPerS: number, state: { angle: number } }[]
         * }|null}
         */
        this._libAnim = null;
        /** @type {string|null} */
        this._libAnimLoadingFor = null;
    }

    /**
     * ワールドの aircraftPhysics（worlds.json）を反映。未指定キーは既定値。
     * @param {Record<string, unknown>|null|undefined} raw
     */
    applyWorldPhysics(raw) {
        this._worldAircraftPhysicsRaw = raw;
        this.physics = mergeAircraftPhysicsFromWorld(raw);
    }

    /**
     * @param {'cockpit'|'chase'} mode
     */
    setCameraMode(mode) {
        const next = mode === 'chase' ? 'chase' : 'cockpit';
        if (next !== this.cameraMode) {
            this.pilotLookYaw = 0;
            this.pilotLookPitch = 0;
        }
        this.cameraMode = next;
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
        this._throttle = 0;
        this._prevThrottle = 0;
        this._engineRpm = 0;
        this._flapIndex = 0;
        this._flapReliefCooldown = 0;
        this.physics = mergeAircraftPhysicsFromWorld(
            slot?.physics && typeof slot.physics === 'object' ? slot.physics : this._worldAircraftPhysicsRaw
        );
        this._attachKeys();
        this._bindPilotMouseLook();
        this._scheduleLibraryAnim();
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
     * aircraftLibraryId があれば定義を取得しエンジンブレード・フラップ参照を解決する
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
                const bindings = j.airframe.bindings;
                const ebRaw = bindings?.engineBlade;
                /** @type {string[]} */
                const ebPaths = [];
                if (Array.isArray(ebRaw)) {
                    for (const x of ebRaw) {
                        const s = typeof x === 'string' ? x.trim() : '';
                        if (s) ebPaths.push(s);
                    }
                } else if (typeof ebRaw === 'string' && ebRaw.trim()) {
                    ebPaths.push(ebRaw.trim());
                }
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
                    if (!blade) {
                        console.warn('[AircraftController] engineBlade path not found:', path);
                        continue;
                    }
                    blades.push({ blade, axis, params, state: { omega: 0 } });
                }

                const fa = j.airframe.animation?.flap;
                const fAxisRaw = String(fa?.hingeAxis || fa?.axis || 'x').toLowerCase();
                const fAxis = fAxisRaw === 'x' || fAxisRaw === 'y' || fAxisRaw === 'z' ? fAxisRaw : 'x';
                const maxAngleRad = typeof fa?.maxAngleRad === 'number' && Number.isFinite(fa.maxAngleRad) ? fa.maxAngleRad : 0.52;
                const maxOmegaRadPerS = typeof fa?.maxOmegaRadPerS === 'number' && Number.isFinite(fa.maxOmegaRadPerS) ? fa.maxOmegaRadPerS : 1.1;
                const signL = typeof fa?.signL === 'number' && Number.isFinite(fa.signL) ? fa.signL : 1;
                const signR = typeof fa?.signR === 'number' && Number.isFinite(fa.signR) ? fa.signR : -1;

                /** @type {{ mesh: THREE.Object3D, axis: 'x'|'y'|'z', sign: number, maxAngleRad: number, maxOmegaRadPerS: number, state: { angle: number } }[]} */
                const flaps = [];
                for (const path of this._bindingPathsForRole(bindings, 'flap_L')) {
                    const mesh = findObjectByNamePath(root, path);
                    if (!mesh) console.warn('[AircraftController] flap_L path not found:', path);
                    else flaps.push({ mesh, axis: fAxis, sign: signL, maxAngleRad, maxOmegaRadPerS, state: { angle: NaN } });
                }
                for (const path of this._bindingPathsForRole(bindings, 'flap_R')) {
                    const mesh = findObjectByNamePath(root, path);
                    if (!mesh) console.warn('[AircraftController] flap_R path not found:', path);
                    else flaps.push({ mesh, axis: fAxis, sign: signR, maxAngleRad, maxOmegaRadPerS, state: { angle: NaN } });
                }

                if (!blades.length && !flaps.length) return;
                this._libAnim = { blades, flaps };
            })
            .catch((e) => {
                console.warn('[AircraftController] aircraft library fetch failed:', e);
            });
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
        this._throttle = 0;
        this._prevThrottle = 0;
        this._engineRpm = 0;
        this._flapIndex = 0;
        this._flapReliefCooldown = 0;
        this.physics = mergeAircraftPhysicsFromWorld(this._worldAircraftPhysicsRaw);
        this._libAnim = null;
        this._libAnimLoadingFor = null;
    }

    /**
     * 乗客視点用にスロットを登録し、マウスで視点オフセットを付与する
     * @param {object} slot
     */
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

    /**
     * 乗客視点の解除
     */
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

    /**
     * 操縦中にポインターロック＋マウスで周囲を見回す
     */
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

    /**
     * 操縦終了時にマウスリスナー解除
     */
    _detachPilotMouseLook() {
        if (this._onPilotMouseMove && this._pilotMouseBound) {
            document.removeEventListener('mousemove', this._onPilotMouseMove);
        }
        this._onPilotMouseMove = null;
        this._pilotMouseBound = false;
        this.pilotLookYaw = 0;
        this.pilotLookPitch = 0;
    }

    /**
     * lookAt + ライブラリ euler の後に、操縦者のヘッドムーブ回転を乗算する
     */
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
            this.keys[/** @type {keyof AircraftController['keys']} */ (k)] = false;
        });
    }

    /**
     * @param {number} delta
     */
    _bumpFlap(delta) {
        this._flapIndex = THREE.MathUtils.clamp(this._flapIndex + delta, 0, AIRCRAFT_FLAP_LABELS.length - 1);
    }

    /**
     * @param {KeyboardEvent} e
     * @param {boolean} down
     */
    _handleKey(e, down) {
        if (!this.slot) return;
        if (this._isInputActive()) return;
        const c = e.code;

        if (c === 'ArrowRight') {
            if (down && !e.repeat) {
                this._bumpFlap(1);
                e.preventDefault();
            }
            return;
        }
        if (c === 'ArrowLeft') {
            if (down && !e.repeat) {
                this._bumpFlap(-1);
                e.preventDefault();
            }
            return;
        }

        /** @type {[string, keyof AircraftController['keys']][]} */
        const map = [
            ['ArrowUp', 'throttleUp'],
            ['ArrowDown', 'throttleDown'],
            ['KeyQ', 'yawL'],
            ['KeyE', 'yawR'],
            ['KeyW', 'pitchUp'],
            ['KeyS', 'pitchDn'],
            ['KeyA', 'rollL'],
            ['KeyD', 'rollR'],
            ['Space', 'brake']
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
        return AircraftController.getAvatarFeetWorldForSlot(this.slot, out);
    }

    /**
     * 任意スロットの足元ワールド座標（操縦・乗客共通）
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
        return AircraftController.getAvatarQuaternionForSlot(this.slot, out);
    }

    /**
     * @param {object|null|undefined} slot
     * @param {THREE.Quaternion} [out]
     * @returns {THREE.Quaternion|null}
     */
    static getAvatarQuaternionForSlot(slot, out) {
        const root = slot?.root;
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
     * 操縦中: player-update 用にワールド空間のメインカメラ姿勢を返す（アバター位置＝視点に同期）
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
     * ワールド YXZ のヨー・ピッチ・ロールを physics の上限 (°) に収める
     * @param {import('three').Object3D} root
     * @param {{ yawMaxDeg: number, pitchMaxDeg: number, rollMaxDeg: number }} ph
     */
    _clampWorldAttitude(root, ph) {
        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const yawLim = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ph.yawMaxDeg, 1, 90));
        const pitchLim = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ph.pitchMaxDeg, 1, 90));
        const rollLim = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ph.rollMaxDeg, 1, 90));
        const y0 = this._eulerScratch.y;
        const x0 = this._eulerScratch.x;
        const z0 = this._eulerScratch.z;
        this._eulerScratch.y = THREE.MathUtils.clamp(y0, -yawLim, yawLim);
        this._eulerScratch.x = THREE.MathUtils.clamp(x0, -pitchLim, pitchLim);
        this._eulerScratch.z = THREE.MathUtils.clamp(z0, -rollLim, rollLim);
        if (
            this._eulerScratch.y === y0 &&
            this._eulerScratch.x === x0 &&
            this._eulerScratch.z === z0
        ) {
            return;
        }
        if (this._eulerScratch.y !== y0) this._omegaYaw = 0;
        if (this._eulerScratch.x !== x0) this._omegaPitch = 0;
        if (this._eulerScratch.z !== z0) this._omegaRoll = 0;
        this._qClampWorld.setFromEuler(this._eulerScratch);
        if (root.parent) {
            root.parent.updateMatrixWorld(true);
            root.parent.getWorldQuaternion(this._qParentWorld);
            const qLocal = this._qParentWorld.clone().invert().multiply(this._qClampWorld);
            root.quaternion.copy(qLocal);
        } else {
            root.quaternion.copy(this._qClampWorld);
        }
        root.updateMatrixWorld(true);
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        if (!this.slot) return;
        const root = this.slot.root;
        const dt = Math.min(0.1, deltaTime);

        const ph = this.physics;
        const dec = AIRCRAFT_PHYSICS_INTERNAL.angularDecel;
        const ls = AIRCRAFT_PHYSICS_INTERNAL.linearWorldScale;
        const g = ph.gravity * ls;
        const maxSpdNom = ph.maxThrustSpeed;
        const maxSpd = maxSpdNom * ls;

        if (this._flapReliefCooldown > 0) this._flapReliefCooldown = Math.max(0, this._flapReliefCooldown - dt);

        const throttleSpool = ph.throttleSpoolPerS;
        if (this.keys.throttleUp) {
            this._throttle = Math.min(THROTTLE_MAX, this._throttle + throttleSpool * dt);
        }
        if (this.keys.throttleDown) {
            this._throttle = Math.max(THROTTLE_MIN, this._throttle - throttleSpool * dt);
        }
        this._throttle = THREE.MathUtils.clamp(this._throttle, THROTTLE_MIN, THROTTLE_MAX);

        const maxRpm = ph.engineMaxRpm;
        const targetRpm = Math.max(0, this._throttle) * maxRpm;
        const rpmAccel = ph.engineRpmAccel;
        if (this._engineRpm < targetRpm) {
            this._engineRpm = Math.min(targetRpm, this._engineRpm + rpmAccel * dt);
        } else if (this._engineRpm > targetRpm) {
            this._engineRpm = Math.max(targetRpm, this._engineRpm - rpmAccel * dt);
        }

        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        const airForward = Math.max(0, this.velocity.dot(this._fwd));
        const vfe = flapVfeMs(this._flapIndex);
        const vfeCap = Number.isFinite(vfe) ? Math.min(maxSpd, vfe * ls) : maxSpd;

        if (this._flapIndex > 0 && airForward > vfe * 0.995 * ls && this._flapReliefCooldown <= 0) {
            this._flapIndex -= 1;
            this._flapReliefCooldown = FLAP_RELIEF_COOLDOWN_S;
        }

        const fa = flapAuthorityMultipliers(this._flapIndex);
        const yawIn = (this.keys.yawR ? 1 : 0) - (this.keys.yawL ? 1 : 0);
        const pitchIn = (this.keys.pitchUp ? 1 : 0) - (this.keys.pitchDn ? 1 : 0);
        const rollIn = (this.keys.rollL ? 1 : 0) - (this.keys.rollR ? 1 : 0);

        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const rollLimRad = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(ph.rollMaxDeg, 1, 90));
        const bank = this._eulerScratch.z;
        let rollInEff = rollIn;
        if (bank >= rollLimRad - 0.02 && rollIn > 0) rollInEff = 0;
        if (bank <= -rollLimRad + 0.02 && rollIn < 0) rollInEff = 0;

        this._omegaYaw = this._integrateOmega(
            yawIn,
            this._omegaYaw,
            ph.yawMaxAccel,
            ph.yawMaxRate,
            dec,
            dt
        );
        this._omegaPitch = this._integrateOmega(
            pitchIn,
            this._omegaPitch,
            ph.pitchMaxAccel * fa.pitchMul,
            ph.pitchMaxRate * fa.pitchMul,
            dec,
            dt
        );
        this._omegaRoll = this._integrateOmega(
            rollInEff,
            this._omegaRoll,
            ph.rollMaxAccel * fa.rollMul,
            ph.rollMaxRate * fa.rollMul,
            dec,
            dt
        );

        root.rotateOnAxis(new THREE.Vector3(0, 1, 0), -this._omegaYaw * dt);
        root.rotateOnAxis(new THREE.Vector3(1, 0, 0), this._omegaPitch * dt);
        root.rotateOnAxis(new THREE.Vector3(0, 0, 1), -this._omegaRoll * dt);
        root.updateMatrixWorld(true);
        this._clampWorldAttitude(root, ph);

        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        let thrust = thrustAccelFromEngineRpm(this._engineRpm, ph) * ls;
        if (this._throttle < 0) {
            thrust = (this._throttle / THROTTLE_MIN) * ph.thrustAccelPerEngineRpm * ls;
        }
        this.velocity.addScaledVector(this._fwd, thrust * dt);
        this.velocity.multiplyScalar(AIRCRAFT_PHYSICS_INTERNAL.drag);
        this._bodyUp.set(0, 1, 0).applyQuaternion(this._worldQuat).normalize();
        const vAlongBodyUp = this.velocity.dot(this._bodyUp);
        const vH = Math.sqrt(
            Math.max(0, this.velocity.lengthSq() - vAlongBodyUp * vAlongBodyUp)
        );
        const liftAccel = flapLiftCoeff(this._flapIndex, ph) * vH;
        this.velocity.y += (liftAccel - g) * dt;
        let sp = this.velocity.length();
        if (sp > vfeCap) this.velocity.multiplyScalar(vfeCap / sp);
        sp = this.velocity.length();
        if (sp > maxSpd) this.velocity.multiplyScalar(maxSpd / sp);

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
                        let fwdSpeed = this.velocity.x * hx + this.velocity.z * hz;
                        const rollMu = ph.tireKineticFriction;
                        const rollK = rollMu * g * 0.12;
                        if (rollK > 0) {
                            const mag = Math.abs(fwdSpeed);
                            if (mag > 0) {
                                const ds = Math.min(mag, rollK * dt);
                                fwdSpeed -= Math.sign(fwdSpeed) * ds;
                            }
                        }
                        if (this.keys.brake) {
                            const step = ph.tireBrakeAccel * ls * dt;
                            const mag = Math.abs(fwdSpeed);
                            if (mag > 0) {
                                const ds = Math.min(mag, step);
                                fwdSpeed -= Math.sign(fwdSpeed) * ds;
                            }
                        }
                        const latX = this.velocity.x - hx * fwdSpeed;
                        const latZ = this.velocity.z - hz * fwdSpeed;
                        const latMag = Math.hypot(latX, latZ);
                        const muLat =
                            Math.abs(fwdSpeed) < FWD_SPEED_STATIC_FRICTION_EPS
                                ? ph.tireStaticFriction
                                : ph.tireKineticFriction;
                        const latK = muLat * g;
                        if (latK > 0 && latMag > 1e-9) {
                            const reduce = Math.min(latMag, latK * dt);
                            const scale = (latMag - reduce) / latMag;
                            this.velocity.x = hx * fwdSpeed + latX * scale;
                            this.velocity.z = hz * fwdSpeed + latZ * scale;
                        } else {
                            this.velocity.x = hx * fwdSpeed;
                            this.velocity.z = hz * fwdSpeed;
                        }
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

        this._updateLibraryVisuals(dt);
        this._updateCamera();
    }

    /**
     * ライブラリ定義に基づきプロペラ・フラップをローカル更新（操縦中のみ）
     * @param {number} dt
     */
    _updateLibraryVisuals(dt) {
        if (!this.slot?.root) return;
        const ph = this.physics;
        const root = this.slot.root;
        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        const maxRpmVis = ph.engineMaxRpm;
        let t01 = maxRpmVis > 0 ? this._engineRpm / maxRpmVis : 0;
        t01 = THREE.MathUtils.clamp(t01, 0, 1);
        const ls = AIRCRAFT_PHYSICS_INTERNAL.linearWorldScale;
        const maxSpdVis = ph.maxThrustSpeed * ls;
        if (maxSpdVis > 0) {
            t01 = Math.max(t01, THREE.MathUtils.clamp(this.velocity.dot(this._fwd) / maxSpdVis, 0, 1));
        }

        if (this._libAnim?.blades?.length) {
            for (const b of this._libAnim.blades) {
                stepEngineBladeRotation(b.blade, b.axis, b.params, t01, dt, b.state);
            }
        }
        if (this._libAnim?.flaps?.length) {
            const n = AIRCRAFT_FLAP_LABELS.length - 1;
            const norm = n > 0 ? this._flapIndex / n : 0;
            for (const f of this._libAnim.flaps) {
                const target = norm * f.maxAngleRad * f.sign;
                stepFlapDeflection(f.mesh, f.axis, target, f.maxOmegaRadPerS, dt, f.state);
            }
        }
    }

    /**
     * 乗客時: 機体は同期済み root のみ使用し、カメラに視点オフセットを適用する
     */
    updatePassengerCamera() {
        const slot = this.passengerViewSlot;
        if (!slot?.root) return;
        const root = slot.root;
        root.updateMatrixWorld(true);
        const cockpit = slot.cockpitOffset || { x: 0, y: 1.2, z: 0 };
        const chase = slot.chaseOffset || { x: 0, y: 2, z: 8 };
        this._eulerScratch.set(this.passengerLookPitch, this.passengerLookYaw, 0, 'YXZ');
        this._qClampWorld.setFromEuler(this._eulerScratch);
        const qOff = this._qClampWorld;

        if (this.cameraMode === 'cockpit') {
            this._lookTarget.set(cockpit.x, cockpit.y, cockpit.z);
            root.localToWorld(this._lookTarget);
            this.camera.position.copy(this._lookTarget);
            root.getWorldQuaternion(this._worldQuat);
            this.camera.quaternion.copy(this._worldQuat);
            this._applySlotCameraBodyEuler(slot, 'cockpit');
            this.camera.quaternion.multiply(qOff);
            return;
        }

        this._lookTarget.set(chase.x, chase.y, chase.z);
        root.localToWorld(this._lookTarget);
        this.camera.position.copy(this._lookTarget);
        root.getWorldPosition(this._passengerAimScratch);
        this._passengerAimScratch.y += 1;
        const o = this._passengerBaseObj;
        o.position.copy(this.camera.position);
        o.quaternion.identity();
        o.lookAt(this._passengerAimScratch);
        this.camera.quaternion.copy(o.quaternion);
        this._applySlotCameraBodyEuler(slot, 'chase');
        this.camera.quaternion.multiply(qOff);
    }

    /**
     * 操縦 HUD 用。毎フレーム update の直後に呼ぶ。
     * @returns {{
     *   speedMs: number,
     *   pitchDeg: number,
     *   yawDeg: number,
     *   rollDeg: number,
     *   omegaYaw: number,
     *   omegaPitch: number,
     *   omegaRoll: number,
     *   grounded: boolean,
     *   throttle: number,
     *   engineRpm: number,
     *   flapLabel: string,
     *   vfeMs: number,
     *   vfeWarn: boolean
     * }|null}
     */
    getHudSnapshot() {
        const root = this.slot?.root;
        if (!root) return null;
        root.updateMatrixWorld(true);
        root.getWorldQuaternion(this._worldQuat);
        this._eulerScratch.setFromQuaternion(this._worldQuat, 'YXZ');
        const r2d = 180 / Math.PI;
        const vfe = flapVfeMs(this._flapIndex);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        const ls = AIRCRAFT_PHYSICS_INTERNAL.linearWorldScale;
        const airF = Math.max(0, this.velocity.dot(this._fwd)) / ls;
        const vfeWarn = this._flapIndex > 0 && Number.isFinite(vfe) && airF > vfe * 0.92;
        return {
            speedMs: this.velocity.length() / ls,
            pitchDeg: this._eulerScratch.x * r2d,
            yawDeg: this._eulerScratch.y * r2d,
            rollDeg: this._eulerScratch.z * r2d,
            omegaYaw: this._omegaYaw,
            omegaPitch: this._omegaPitch,
            omegaRoll: this._omegaRoll,
            grounded: this._aircraftGrounded,
            throttle: this._throttle,
            engineRpm: this._engineRpm,
            flapLabel: AIRCRAFT_FLAP_LABELS[this._flapIndex] || 'UP',
            vfeMs: Number.isFinite(vfe) ? vfe : this.physics.maxThrustSpeed,
            vfeWarn
        };
    }

    /**
     * 機体ローカル（ライブラリ camera.cockpitEulerDeg / chaseEulerDeg）の追加回転をカメラ姿勢に乗算する
     * @param {object|null|undefined} slot
     * @param {'cockpit'|'chase'} which
     */
    _applySlotCameraBodyEuler(slot, which) {
        const deg = which === 'cockpit' ? slot?.cockpitEulerDeg : slot?.chaseEulerDeg;
        if (!deg || typeof deg !== 'object') return;
        const rx = THREE.MathUtils.degToRad(Number(deg.x) || 0);
        const ry = THREE.MathUtils.degToRad(Number(deg.y) || 0);
        const rz = THREE.MathUtils.degToRad(Number(deg.z) || 0);
        this._eulerScratch.set(rx, ry, rz, 'YXZ');
        this._qParentWorld.setFromEuler(this._eulerScratch);
        this.camera.quaternion.multiply(this._qParentWorld);
    }

    /** 操縦開始直後などにコックピット／チェイス視点へ即時切替 */
    snapPilotCamera() {
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
            this._applySlotCameraBodyEuler(this.slot, 'cockpit');
            this._applyPilotLookOffset();
        } else {
            this._lookTarget.set(chase.x, chase.y, chase.z);
            root.localToWorld(this._lookTarget);
            this.camera.position.copy(this._lookTarget);
            root.getWorldPosition(this._fwd);
            this._fwd.y += 1;
            this.camera.lookAt(this._fwd);
            this._applySlotCameraBodyEuler(this.slot, 'chase');
            this._applyPilotLookOffset();
        }
    }
}
