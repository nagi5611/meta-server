// public/js/aircraft-manager.js — 近接・搭乗・サーバー同期・駐機位置リセット

import * as THREE from 'three';

const STORAGE_CAMERA = 'metaverse-aircraft-camera';

/**
 * @typedef {object} AircraftSlot
 * @property {string} id
 * @property {{x:number,y:number,z:number}} position
 * @property {number} radius
 * @property {string} label
 * @property {{x:number,y:number,z:number}} cockpitOffset
 * @property {{x:number,y:number,z:number}} chaseOffset
 * @property {import('three').Object3D} root
 * @property {import('three').Vector3} parkedPosition
 * @property {import('three').Quaternion} parkedQuaternion
 * @property {import('three').Vector3} parkedScale
 */

export default class AircraftManager {
    /**
     * @param {import('./scene-manager.js').default} sceneManager
     * @param {import('./aircraft-controller.js').default} aircraftController
     * @param {import('./character-controller.js').default} characterController
     * @param {import('./network-manager.js').default} networkManager
     * @param {import('./ui-manager.js').default} uiManager
     */
    constructor(sceneManager, aircraftController, characterController, networkManager, uiManager) {
        this.sceneManager = sceneManager;
        this.aircraftController = aircraftController;
        this.characterController = characterController;
        this.networkManager = networkManager;
        this.uiManager = uiManager;
        /** @type {Map<string, AircraftSlot>} */
        this.slotsById = new Map();
        /** @type {AircraftSlot|null} */
        this.nearestSlot = null;
        this.isPiloting = false;
        /** @type {AircraftSlot|null} */
        this.activeSlot = null;
        this.isMobileMode = false;
        this._tmpPlayerPos = new THREE.Vector3();
        /** @type {((e: KeyboardEvent) => void)|null} */
        this._pilotKeyHandler = null;
        this._loadCameraModeFromStorage();
    }

    setMobileMode(mobile) {
        this.isMobileMode = !!mobile;
    }

    _loadCameraModeFromStorage() {
        try {
            const v = localStorage.getItem(STORAGE_CAMERA);
            this.aircraftController.setCameraMode(v === 'chase' ? 'chase' : 'cockpit');
        } catch (_) {
            this.aircraftController.setCameraMode('cockpit');
        }
    }

    /**
     * @param {'cockpit'|'chase'} mode
     */
    setCameraModeAndPersist(mode) {
        const m = mode === 'chase' ? 'chase' : 'cockpit';
        this.aircraftController.setCameraMode(m);
        try {
            localStorage.setItem(STORAGE_CAMERA, m);
        } catch (_) { /* ignore */ }
    }

    toggleCameraMode() {
        const next = this.aircraftController.cameraMode === 'chase' ? 'cockpit' : 'chase';
        this.setCameraModeAndPersist(next);
    }

    /**
     * ワールドロード後に呼ぶ
     */
    refreshSlotsFromScene() {
        this.slotsById.clear();
        const slots = this.sceneManager.getAircraftSlots();
        slots.forEach((s) => this.slotsById.set(s.id, s));
        this.nearestSlot = null;
    }

    /**
     * @param {THREE.Vector3} playerWorldFeet
     */
    updateProximity(playerWorldFeet) {
        if (this.isPiloting || this.isMobileMode) {
            this.nearestSlot = null;
            return;
        }
        let best = null;
        let bestD = Infinity;
        this.slotsById.forEach((slot) => {
            const dx = playerWorldFeet.x - slot.position.x;
            const dy = playerWorldFeet.y - slot.position.y;
            const dz = playerWorldFeet.z - slot.position.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < slot.radius && d < bestD) {
                bestD = d;
                best = slot;
            }
        });
        this.nearestSlot = best;
    }

    /**
     * @returns {boolean}
     */
    async tryBoardNearest() {
        if (!this.nearestSlot || this.isPiloting || this.isMobileMode) return false;
        if (this.characterController.xrPresenting) return false;
        const slot = this.nearestSlot;
        const socket = this.networkManager.socket;
        if (!socket?.connected) return false;

        return new Promise((resolve) => {
            socket.emit('aircraft-board', { slotId: slot.id }, (res) => {
                if (!res || !res.ok) {
                    if (res?.error === 'busy') {
                        console.warn('[Aircraft] 既に他プレイヤーが操縦中です');
                    }
                    resolve(false);
                    return;
                }
                this._enterPiloting(slot);
                resolve(true);
            });
        });
    }

    /**
     * @param {AircraftSlot} slot
     */
    _enterPiloting(slot) {
        document.exitPointerLock();
        this.activeSlot = slot;
        this.isPiloting = true;
        this.characterController.resetMovement();
        this.characterController.setFlyMode(false);
        this.characterController.setAircraftPoseProvider({
            getPosition: (out) => this.aircraftController.getAvatarFeetWorld(out),
            getQuaternion: (out) => this.aircraftController.getAvatarQuaternion(out)
        });
        this.aircraftController.bindSlot(slot);
        this.uiManager.showAircraftHud();
        this.uiManager.hideAircraftBoardPrompt();

        this._pilotKeyHandler = (e) => {
            if (!this.isPiloting) return;
            if (this.characterController.isInputActive()) return;
            if (e.code === 'KeyF') {
                e.preventDefault();
                this.exitPiloting();
            } else if (e.code === 'KeyV') {
                e.preventDefault();
                this.toggleCameraMode();
            }
        };
        document.addEventListener('keydown', this._pilotKeyHandler);
    }

    /**
     * @returns {Promise<boolean>}
     */
    async exitPiloting() {
        if (!this.isPiloting || !this.activeSlot) return false;
        const slot = this.activeSlot;
        const slotId = slot.id;
        const socket = this.networkManager.socket;

        this.placeCharacterBesideAircraft(slot);

        if (socket?.connected) {
            await new Promise((resolve) => {
                socket.emit('aircraft-exit', { slotId }, () => resolve());
            });
        }

        this._localExitCleanup();
        this.resetSlotToParked(slotId);
        return true;
    }

    _localExitCleanup() {
        if (this._pilotKeyHandler) {
            document.removeEventListener('keydown', this._pilotKeyHandler);
            this._pilotKeyHandler = null;
        }
        this.aircraftController.unbind();
        this.characterController.setAircraftPoseProvider(null);
        this.isPiloting = false;
        this.activeSlot = null;
        this.uiManager.hideAircraftHud();
    }

    /**
     * 降りた後のキャラ位置（機体横・地上）
     * @param {AircraftSlot} slot
     */
    placeCharacterBesideAircraft(slot) {
        const root = slot.root;
        root.updateMatrixWorld(true);
        const q = new THREE.Quaternion();
        root.getWorldQuaternion(q);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const wp = new THREE.Vector3();
        root.getWorldPosition(wp);
        wp.addScaledVector(right, 4);
        const pm = this.sceneManager.physicsManager;
        const origin = new THREE.Vector3(wp.x, wp.y + 80, wp.z);
        const hit = pm?.raycastStaticWorld?.(origin, new THREE.Vector3(0, -1, 0), 200);
        if (hit) {
            wp.y = hit.point.y + 0.05;
        } else {
            wp.y += 1;
        }
        this.characterController.setPosition(wp.x, wp.y, wp.z);
        this.characterController.resetVelocity();
    }

    /**
     * @param {string} slotId
     */
    resetSlotToParked(slotId) {
        const slot = this.slotsById.get(slotId);
        if (!slot?.root) return;
        slot.root.position.copy(slot.parkedPosition);
        slot.root.quaternion.copy(slot.parkedQuaternion);
        slot.root.scale.copy(slot.parkedScale);
        slot.root.updateMatrixWorld(true);
    }

    /**
     * players-update / aircraft-initial の配列を適用（自機操縦中はスキップ）
     * @param {Array<{id:string,pilotId:string,position:{x,y,z},quaternion:{x,y,z,w}}>} list
     * @param {string|null} mySocketId
     */
    applyNetworkAircraftSnapshot(list, mySocketId) {
        if (!Array.isArray(list)) return;
        for (const entry of list) {
            if (!entry || !entry.id || !entry.position || !entry.quaternion) continue;
            if (mySocketId && entry.pilotId === mySocketId) continue;
            const slot = this.slotsById.get(entry.id);
            if (!slot?.root) continue;
            this._applyWorldPoseToObject(slot.root, entry.position, entry.quaternion);
        }
    }

    /**
     * @param {import('three').Object3D} r
     * @param {{x:number,y:number,z:number}} posW
     * @param {{x:number,y:number,z:number,w:number}} quatW
     */
    _applyWorldPoseToObject(r, posW, quatW) {
        const wp = this._tmpPlayerPos.set(posW.x, posW.y, posW.z);
        const wq = new THREE.Quaternion(quatW.x, quatW.y, quatW.z, quatW.w);
        const parent = r.parent;
        if (parent) {
            parent.updateMatrixWorld(true);
            parent.worldToLocal(wp);
            const pq = new THREE.Quaternion();
            parent.getWorldQuaternion(pq);
            const localQ = pq.clone().invert().multiply(wq);
            r.position.copy(wp);
            r.quaternion.copy(localQ);
        } else {
            r.position.copy(wp);
            r.quaternion.copy(wq);
        }
        r.updateMatrixWorld(true);
    }

    /**
     * @param {string} slotId
     */
    onAircraftReleased(slotId) {
        if (this.isPiloting && this.activeSlot?.id === slotId) {
            return;
        }
        this.resetSlotToParked(slotId);
    }

    /**
     * サーバーが既に room から外した後（change-world 等）にローカルだけ操縦状態を掃除する
     */
    forceLocalPilotingReset() {
        if (!this.isPiloting) return;
        const sid = this.activeSlot?.id;
        this.aircraftController.unbind();
        this.characterController.setAircraftPoseProvider(null);
        this.isPiloting = false;
        this.activeSlot = null;
        this.uiManager.hideAircraftHud();
        this.uiManager.hideAircraftBoardPrompt();
        if (sid) this.resetSlotToParked(sid);
    }

    /**
     * @returns {{ slotId: string, position: object, quaternion: object }|null}
     */
    getAircraftPoseForNetwork() {
        if (!this.isPiloting) return null;
        return this.aircraftController.getPoseForNetwork();
    }

    /**
     * WebXR 中は搭乗しない
     * @returns {boolean}
     */
    canBoard() {
        return !this.isMobileMode
            && !this.characterController.xrPresenting
            && !!this.nearestSlot
            && !this.isPiloting;
    }
}
