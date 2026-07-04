// addons/aircraft/client/aircraft-controller-hard.js — hard 操縦（RPM・フラップ・Vfe）
// 入力: 矢印=スロットル/フラップ、W/S=ピッチ、A/D=ロール、Q/E=ラダー、Space=ブレーキ
// 直線運動は AIRCRAFT_PHYSICS_INTERNAL.linearWorldScale（既定 0.4）でワールド移動のみ縮小。パラメータ・HUD は名目 m/s。
// 推力=機首 -Z 方向、揚力=機体 +Y、重力=ワールド -Y。姿勢は角速度上限のみ（姿勢角ハード上限なし）。Vfe 近似。

import * as THREE from 'three';
import {
    mergeAircraftPhysicsFromWorld,
    flapAuthorityMultipliers,
    flapDeployNorm01,
    flapLiftCoeff,
    flapVfeMs,
    thrustAccelFromEngineRpm,
    highSpeedAngularRateScale,
    clampEngineHorizontalSpeedIfLevel,
    applyLiftVerticalOnly,
    updateGroundedHysteresis,
    AIRCRAFT_GROUND_FRICTION_MIN_FORWARD_HORIZ,
    AIRCRAFT_FLAP_LABELS,
    AIRCRAFT_PHYSICS_INTERNAL
} from './aircraft-physics-defaults.js';
import { findObjectByNamePath, findObjectsForBindingPaths, stepEngineBladeRotation, stepFlapDeflection } from './runtime-prefab-aircraft-anim.js';
import {
    applyAircraftViewpointCamera,
    resolveSlotCameraViewpoints,
    viewpointAtIndex,
} from './camera-viewpoint-runtime.js';
import { viewpointIndexFromLegacyMode } from '../../../public/js/aircraft/camera-viewpoints.js';
import {
    createAircraftAutopilotState,
    moveAircraftRootByVelocity,
    resetAircraftAutopilot,
    rotateAircraftRootByOmega,
    snapshotAircraftAutopilot,
} from './aircraft-autopilot.js';

const LANDING_RAY_MAX = 500;
const CLEARANCE_ABOVE_GROUND = 0.5;
/** @deprecated 接地は updateGroundedHysteresis の headroom で判定 */
const GROUNDED_Y_TOLERANCE = 0.15;
/** 前後速度がこの値未満なら静止摩擦（横滑り抑制に tireStaticFriction を使用） */
const FWD_SPEED_STATIC_FRICTION_EPS = 0.05;

const THROTTLE_MIN = -0.3;
const THROTTLE_MAX = 1;
/** 荷重解放: 連続収納の間隔 (s) */
const FLAP_RELIEF_COOLDOWN_S = 0.22;
/** 手動フラップ操作後、Vfe による自動収納を抑止する時間 (ms) */
const FLAP_MANUAL_LOCK_MS = 2500;
/** 矢印キー長押し時の段切り替え間隔 (ms) */
const FLAP_KEY_REPEAT_MS = 200;

/**
 * 共有 GLB ルートに推力・姿勢入力を適用し、カメラを更新する
 */
export default class AircraftControllerHard {
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
        this._flapManualLockUntilMs = 0;
        this._lastFlapBumpMs = 0;
        /** @type {'cockpit'|'chase'} */
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
        this._autopilot = createAircraftAutopilotState();
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
        this._flapManualLockUntilMs = 0;
        this._lastFlapBumpMs = 0;
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
                const resolvedBlades = findObjectsForBindingPaths(root, ebPaths);
                if (resolvedBlades.length < ebPaths.length) {
                    console.warn(
                        '[AircraftController] some engineBlade paths not found:',
                        ebPaths.length - resolvedBlades.length,
                        'of',
                        ebPaths.length
                    );
                }
                for (const blade of resolvedBlades) {
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
        this._flapManualLockUntilMs = 0;
        this._lastFlapBumpMs = 0;
        this.physics = mergeAircraftPhysicsFromWorld(this._worldAircraftPhysicsRaw);
        this._libAnim = null;
        this._libAnimLoadingFor = null;
        resetAircraftAutopilot(this._autopilot);
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
            this.keys[/** @type {keyof AircraftControllerHard['keys']} */ (k)] = false;
        });
    }

    /**
     * @param {number} delta
     */
    _bumpFlap(delta) {
        const prev = this._flapIndex;
        this._flapIndex = THREE.MathUtils.clamp(this._flapIndex + delta, 0, AIRCRAFT_FLAP_LABELS.length - 1);
        if (this._flapIndex !== prev) {
            this._flapManualLockUntilMs = performance.now() + FLAP_MANUAL_LOCK_MS;
            this._syncFlapVisualToIndex();
        }
    }

    /**
     * フラップメッシュのローカル角をレバー段階に即時合わせる（段ごとの角度差を反映）
     */
    _syncFlapVisualToIndex() {
        if (!this._libAnim?.flaps?.length) return;
        const norm = flapDeployNorm01(this._flapIndex);
        for (const f of this._libAnim.flaps) {
            const target = norm * f.maxAngleRad * f.sign;
            f.state.angle = target;
            if (f.axis === 'x') f.mesh.rotation.x = target;
            else if (f.axis === 'y') f.mesh.rotation.y = target;
            else f.mesh.rotation.z = target;
        }
    }

    /**
     * @param {KeyboardEvent} e
     * @returns {boolean}
     */
    _tryFlapKeyBump(e) {
        const now = performance.now();
        if (e.repeat && now - this._lastFlapBumpMs < FLAP_KEY_REPEAT_MS) return false;
        this._lastFlapBumpMs = now;
        if (e.code === 'ArrowRight') {
            this._bumpFlap(1);
            return true;
        }
        if (e.code === 'ArrowLeft') {
            this._bumpFlap(-1);
            return true;
        }
        return false;
    }

    /**
     * @param {KeyboardEvent} e
     * @param {boolean} down
     */
    _handleKey(e, down) {
        if (!this.slot) return;
        if (this._isInputActive()) return;
        const c = e.code;

        if (c === 'ArrowRight' || c === 'ArrowLeft') {
            if (down && this._tryFlapKeyBump(e)) e.preventDefault();
            return;
        }

        /** @type {[string, keyof AircraftControllerHard['keys']][]} */
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
        return AircraftControllerHard.getAvatarFeetWorldForSlot(this.slot, out);
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
        return AircraftControllerHard.getAvatarQuaternionForSlot(this.slot, out);
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
     * オートパイロットのオン・オフを切り替える
     * @returns {boolean}
     */
    toggleAutopilot() {
        if (!this.slot) return false;
        this._autopilot.enabled = !this._autopilot.enabled;
        if (this._autopilot.enabled) {
            snapshotAircraftAutopilot(
                this._autopilot,
                this.velocity,
                this._omegaYaw,
                this._omegaPitch,
                this._omegaRoll
            );
        }
        return this._autopilot.enabled;
    }

    /**
     * @returns {boolean}
     */
    isAutopilotEnabled() {
        return this._autopilot.enabled;
    }

    /**
     * 記録済み速度・角速度で慣性飛行する
     * @param {THREE.Object3D} root
     * @param {number} dt
     */
    _updateAutopilotFrame(root, dt) {
        const ap = this._autopilot;
        this.velocity.copy(ap.velocity);
        this._omegaYaw = ap.omegaYaw;
        this._omegaPitch = ap.omegaPitch;
        this._omegaRoll = ap.omegaRoll;
        rotateAircraftRootByOmega(root, ap.omegaYaw, ap.omegaPitch, ap.omegaRoll, dt);
        moveAircraftRootByVelocity(root, ap.velocity, dt, this._worldPos);
        this._updateLibraryVisuals(dt);
        this._updateCamera();
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        if (!this.slot) return;
        const root = this.slot.root;
        const dt = Math.min(0.1, deltaTime);

        if (this._autopilot.enabled) {
            this._updateAutopilotFrame(root, dt);
            return;
        }

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

        const flapManualLocked = performance.now() < this._flapManualLockUntilMs;
        if (
            !flapManualLocked &&
            this._flapIndex > 0 &&
            airForward > vfe * 0.995 * ls &&
            this._flapReliefCooldown <= 0
        ) {
            this._flapIndex -= 1;
            this._flapReliefCooldown = FLAP_RELIEF_COOLDOWN_S;
            this._syncFlapVisualToIndex();
        }

        const fa = flapAuthorityMultipliers(this._flapIndex);
        const yawIn = (this.keys.yawR ? 1 : 0) - (this.keys.yawL ? 1 : 0);
        const pitchIn = (this.keys.pitchUp ? 1 : 0) - (this.keys.pitchDn ? 1 : 0);
        const rollIn = (this.keys.rollL ? 1 : 0) - (this.keys.rollR ? 1 : 0);
        const rateScale = highSpeedAngularRateScale(this.velocity.length(), maxSpd);

        this._omegaYaw = this._integrateOmega(
            yawIn,
            this._omegaYaw,
            ph.yawMaxAccel,
            ph.yawMaxRate * rateScale,
            dec,
            dt
        );
        this._omegaPitch = this._integrateOmega(
            pitchIn,
            this._omegaPitch,
            ph.pitchMaxAccel * fa.pitchMul,
            ph.pitchMaxRate * fa.pitchMul * rateScale,
            dec,
            dt
        );
        this._omegaRoll = this._integrateOmega(
            rollIn,
            this._omegaRoll,
            ph.rollMaxAccel * fa.rollMul,
            ph.rollMaxRate * fa.rollMul * rateScale,
            dec,
            dt
        );

        root.rotateOnAxis(new THREE.Vector3(0, 1, 0), -this._omegaYaw * dt);
        root.rotateOnAxis(new THREE.Vector3(1, 0, 0), this._omegaPitch * dt);
        root.rotateOnAxis(new THREE.Vector3(0, 0, 1), -this._omegaRoll * dt);
        root.updateMatrixWorld(true);

        root.getWorldQuaternion(this._worldQuat);
        this._fwd.set(0, 0, -1).applyQuaternion(this._worldQuat);
        if (this._fwd.lengthSq() > 1e-12) this._fwd.normalize();
        let thrust = thrustAccelFromEngineRpm(this._engineRpm, ph) * ls;
        if (this._throttle < 0) {
            thrust = (this._throttle / THROTTLE_MIN) * ph.thrustAccelPerEngineRpm * ls;
        }
        if (thrust !== 0) {
            this.velocity.addScaledVector(this._fwd, thrust * dt);
        }
        this.velocity.multiplyScalar(AIRCRAFT_PHYSICS_INTERNAL.drag);
        this._bodyUp.set(0, 1, 0).applyQuaternion(this._worldQuat).normalize();
        const vAlongBodyUp = this.velocity.dot(this._bodyUp);
        const vH = Math.sqrt(
            Math.max(0, this.velocity.lengthSq() - vAlongBodyUp * vAlongBodyUp)
        );
        const liftMag = flapLiftCoeff(this._flapIndex, ph) * vH * ls;
        this.velocity.y -= g * dt;
        if (!this._aircraftGrounded) {
            applyLiftVerticalOnly(this.velocity, this._bodyUp, liftMag, dt);
        }
        if (this._flapIndex > 0) {
            const airFwd = this.velocity.dot(this._fwd);
            if (airFwd > vfeCap) {
                this.velocity.addScaledVector(this._fwd, vfeCap - airFwd);
            }
        }
        clampEngineHorizontalSpeedIfLevel(this.velocity, maxSpd, this._fwd);

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
            const norm = flapDeployNorm01(this._flapIndex);
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
            controlMode: 'hard',
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
            vfeWarn,
            autopilot: this._autopilot.enabled,
        };
    }

    /** 操縦開始直後などにコックピット／チェイス視点へ即時切替 */
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
