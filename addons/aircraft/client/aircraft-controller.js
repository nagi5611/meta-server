// addons/aircraft/client/aircraft-controller.js — hard/easy 操縦ファサード
import * as THREE from 'three';
import {
    resolveSlotCameraViewpoints,
    viewpointAtIndex,
    viewpointIndexFromLegacyMode,
} from '../../../public/js/aircraft/camera-viewpoints.js';
import { normalizeAircraftControlMode } from './aircraft-physics-easy-defaults.js';
import AircraftControllerHard from './aircraft-controller-hard.js';
import AircraftControllerEasy from './aircraft-controller-easy.js';

/**
 * スロットの controlMode に応じて hard / easy 実装へ委譲する
 */
export default class AircraftController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {import('./physics-manager.js').default} physicsManager
     */
    constructor(camera, physicsManager) {
        this.camera = camera;
        this.physicsManager = physicsManager;
        this._hard = new AircraftControllerHard(camera, physicsManager);
        this._easy = new AircraftControllerEasy(camera, physicsManager);
        /** @type {AircraftControllerHard|AircraftControllerEasy} */
        this._active = this._hard;
        this.cameraMode = 'cockpit';
        this.viewpointIndex = 0;
    }

    /**
     * @param {object|null|undefined} slot
     * @returns {AircraftControllerHard|AircraftControllerEasy}
     */
    _implForSlot(slot) {
        return normalizeAircraftControlMode(slot?.controlMode) === 'easy' ? this._easy : this._hard;
    }

    /**
     * @returns {AircraftControllerHard|AircraftControllerEasy}
     */
    _impl() {
        return this._active;
    }

    /**
     * @param {Record<string, unknown>|null|undefined} raw
     */
    applyWorldPhysics(raw) {
        this._hard.applyWorldPhysics(raw);
        this._easy.applyWorldPhysics(raw);
    }

    /**
     * @param {'cockpit'|'chase'} mode
     */
    setCameraMode(mode) {
        const slot = this._active.slot || this._active.passengerViewSlot;
        const vps = resolveSlotCameraViewpoints(slot);
        this.setViewpointIndex(viewpointIndexFromLegacyMode(mode === 'chase' ? 'chase' : 'cockpit', vps));
    }

    /**
     * @param {number} index
     */
    setViewpointIndex(index) {
        this._hard.setViewpointIndex(index);
        this._easy.setViewpointIndex(index);
        this.viewpointIndex = this._active.viewpointIndex;
        const slot = this._active.slot || this._active.passengerViewSlot;
        const vp = viewpointAtIndex(resolveSlotCameraViewpoints(slot), this.viewpointIndex);
        this.cameraMode = vp?.role === 'chase' ? 'chase' : 'cockpit';
    }

    /**
     * 視点を1つ進め、表示名を返す
     * @returns {string}
     */
    cycleViewpoint() {
        const slot = this._active.slot || this._active.passengerViewSlot;
        const vps = resolveSlotCameraViewpoints(slot);
        const n = Math.max(1, vps.length);
        const next = (this.viewpointIndex + 1) % n;
        this.setViewpointIndex(next);
        const vp = viewpointAtIndex(vps, this.viewpointIndex);
        return vp?.name || vp?.id || '';
    }

    /**
     * localStorage 等に保存した視点 ID をスロットへ反映する
     * @param {object|null|undefined} slot
     * @param {string|null|undefined} storedId
     */
    applyStoredViewpointForSlot(slot, storedId) {
        const vps = resolveSlotCameraViewpoints(slot);
        if (!vps.length) {
            this.setViewpointIndex(0);
            return;
        }
        const id = String(storedId || '').trim();
        if (id) {
            const byId = vps.findIndex((v) => v.id === id);
            if (byId >= 0) {
                this.setViewpointIndex(byId);
                return;
            }
            if (id === 'chase' || id === 'cockpit') {
                this.setViewpointIndex(viewpointIndexFromLegacyMode(id, vps));
                return;
            }
        }
        this.setViewpointIndex(0);
    }

    /**
     * @param {object} slot
     */
    bindSlot(slot) {
        this._active = this._implForSlot(slot);
        this._active.bindSlot(slot);
        this.viewpointIndex = this._active.viewpointIndex;
        this.cameraMode = this._active.cameraMode;
    }

    unbind() {
        this._hard.unbind();
        this._easy.unbind();
        this._active = this._hard;
    }

    bindPassengerView(slot) {
        this._active = this._implForSlot(slot);
        this._active.bindPassengerView(slot);
        this.viewpointIndex = this._active.viewpointIndex;
        this.cameraMode = this._active.cameraMode;
    }

    unbindPassengerView() {
        this._hard.unbindPassengerView();
        this._easy.unbindPassengerView();
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        this._impl().update(deltaTime);
    }

    updatePassengerCamera() {
        this._impl().updatePassengerCamera();
    }

    getHudSnapshot() {
        return this._impl().getHudSnapshot();
    }

    getPoseForNetwork() {
        return this._impl().getPoseForNetwork();
    }

    getNetworkCameraPose() {
        return this._impl().getNetworkCameraPose();
    }

    getAvatarFeetWorld(out) {
        return this._impl().getAvatarFeetWorld(out);
    }

    getAvatarQuaternion(out) {
        return this._impl().getAvatarQuaternion(out);
    }

    snapPilotCamera() {
        this._impl().snapPilotCamera();
    }

    /**
     * オートパイロットのオン・オフを切り替える
     * @returns {boolean|null} 操縦中でなければ null
     */
    toggleAutopilot() {
        const impl = this._impl();
        if (!impl.slot) return null;
        return impl.toggleAutopilot();
    }

    /**
     * @returns {boolean}
     */
    isAutopilotEnabled() {
        return this._impl().isAutopilotEnabled();
    }

    /**
     * Easy 操縦向けタッチ入力（Hard では no-op）
     * @param {Record<string, boolean>} partialKeys
     */
    setTouchInput(partialKeys) {
        if (this._active === this._easy) {
            this._easy.setTouchInput(partialKeys);
        }
    }

    /**
     * Easy 操縦向け視線デルタ（Hard では no-op）
     * @param {number} dx
     * @param {number} dy
     */
    addPilotLookDelta(dx, dy) {
        if (this._active === this._easy) {
            this._easy.addPilotLookDelta(dx, dy);
        }
    }

    /**
     * @param {object|null|undefined} slot
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3|null}
     */
    static getAvatarFeetWorldForSlot(slot, out) {
        const impl =
            normalizeAircraftControlMode(slot?.controlMode) === 'easy'
                ? AircraftControllerEasy
                : AircraftControllerHard;
        return impl.getAvatarFeetWorldForSlot(slot, out);
    }

    /**
     * @param {object|null|undefined} slot
     * @param {THREE.Quaternion} [out]
     * @returns {THREE.Quaternion|null}
     */
    static getAvatarQuaternionForSlot(slot, out) {
        const impl =
            normalizeAircraftControlMode(slot?.controlMode) === 'easy'
                ? AircraftControllerEasy
                : AircraftControllerHard;
        return impl.getAvatarQuaternionForSlot(slot, out);
    }
}
