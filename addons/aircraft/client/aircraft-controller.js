// addons/aircraft/client/aircraft-controller.js — hard/easy 操縦ファサード
import * as THREE from 'three';
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
        this.cameraMode = mode === 'chase' ? 'chase' : 'cockpit';
        this._hard.setCameraMode(mode);
        this._easy.setCameraMode(mode);
    }

    /**
     * @param {object} slot
     */
    bindSlot(slot) {
        this._active = this._implForSlot(slot);
        this._active.bindSlot(slot);
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
