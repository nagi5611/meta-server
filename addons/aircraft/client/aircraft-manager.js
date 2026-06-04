// addons/aircraft/client/aircraft-manager.js — 近接・搭乗・サーバー同期・駐機位置リセット

import * as THREE from 'three';
import {
    resolveSlotCameraViewpoints,
    viewpointAtIndex,
} from '../../../public/js/aircraft/camera-viewpoints.js';
import AircraftController from './aircraft-controller.js';
import AircraftMinimap from './aircraft-minimap.js';

const STORAGE_CAMERA = 'metaverse-aircraft-camera';
const BOARD_SOCKET_WAIT_MS = 10000;
const BOARD_ACK_TIMEOUT_MS = 8000;

/** @type {Record<string, string>} */
const BOARD_ERROR_JA = {
    deps_unconfigured: '飛行機機能がサーバーで有効になっていません。',
    bad_request: '搭乗リクエストが不正です。',
    invalid_slot: 'このワールドに飛行機が登録されていません（ID不一致）。',
    busy: 'すでに他のプレイヤーが操縦しています。',
    no_player: 'サーバーにプレイヤーが登録されていません。再接続してください。',
    already_piloting: 'すでに別の飛行機を操縦しています。',
};

/**
 * @typedef {object} AircraftSlot
 * @property {string} id
 * @property {{x:number,y:number,z:number}} position
 * @property {number} radius
 * @property {string} label
 * @property {{x:number,y:number,z:number}} cockpitOffset
 * @property {{x:number,y:number,z:number}} chaseOffset
 * @property {import('../../../public/js/aircraft/camera-viewpoints.js').AircraftViewpoint[]} [cameraViewpoints]
 * @property {import('three').Object3D} root
 * @property {import('three').Vector3} parkedPosition
 * @property {import('three').Quaternion} parkedQuaternion
 * @property {import('three').Vector3} parkedScale
 * @property {Record<string, number>} [physics] — 操縦パラメータ（hard/easy マージ済み）
 * @property {'hard'|'easy'} [controlMode] — ライブラリの実行操縦モード
 * @property {string|null} [aircraftLibraryId] — SQLite 機体ライブラリ ID（prefab + 視覚アニメ用）
 * @property {string|null} [prefabManifest] — models[].prefabManifest（ライブラリ未指定時にマニフェスト一致で ID 解決）
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
        /** 他プレイヤー操縦中の同乗（サーバー登録なし） */
        this.isPassenger = false;
        /** @type {AircraftSlot|null} */
        this.passengerSlot = null;
        /** @type {Map<string, string>} slotId -> pilot socket id（players-update の aircraft から更新） */
        this._slotPilotId = new Map();
        this.isMobileMode = false;
        this._tmpPlayerPos = new THREE.Vector3();
        /** @type {((e: KeyboardEvent) => void)|null} */
        this._pilotKeyHandler = null;
        /** @type {(() => void)|null} 操縦開始/終了時にローカルアバター表示を更新する */
        this._onPilotingChange = null;
        /** @type {(() => string|null)|null} */
        this._getCurrentWorldId = null;
        this.minimap = new AircraftMinimap();
        this._minimapPosScratch = new THREE.Vector3();
        /** ミニマップ更新間隔（ms）。3D 正射影は重いため低 FPS で十分 */
        this._minimapUpdateIntervalMs = 500;
        this._minimapLastUpdateMs = 0;
        this._loadCameraModeFromStorage();
    }

    /**
     * @param {(() => string|null)|null} fn
     */
    setWorldIdProvider(fn) {
        this._getCurrentWorldId = typeof fn === 'function' ? fn : null;
    }

    /**
     * 現在ワールドの飛行ミニマップ定義を読み込む
     * @param {string} [worldId]
     */
    async loadFlightMapForWorld(worldId) {
        const wid = worldId || this._getCurrentWorldId?.() || '';
        if (!wid) {
            this.minimap.clearMap();
            this.minimap.hide();
            return;
        }
        try {
            const res = await fetch(`/api/addons/aircraft/flight-maps/${encodeURIComponent(wid)}`);
            if (!res.ok) {
                this.minimap.clearMap();
                this.minimap.hide();
                return;
            }
            const j = await res.json();
            const ok = await this.minimap.setMap(j.map);
            if (ok && this.isPiloting) {
                this.minimap.show();
                this.updateMinimap(true);
            } else if (!ok) this.minimap.hide();
        } catch {
            this.minimap.clearMap();
            this.minimap.hide();
        }
    }

    /**
     * ミニマップ更新用の機体位置・向き
     * @returns {{ worldX: number, worldZ: number, yawDeg: number }|null}
     */
    getMinimapState() {
        if (!this.isPiloting || !this.activeSlot?.root) return null;
        const root = this.activeSlot.root;
        root.updateMatrixWorld(true);
        root.getWorldPosition(this._minimapPosScratch);
        const snap = this.aircraftController.getHudSnapshot();
        return {
            worldX: this._minimapPosScratch.x,
            worldZ: this._minimapPosScratch.z,
            yawDeg: snap?.yawDeg ?? 0,
        };
    }

    /**
     * 操縦中の他機（ネットワーク同期済み）をミニマップ用に列挙する
     * @returns {{ label: string, x: number, z: number }[]}
     */
    getMinimapOtherAircraft() {
        /** @type {{ label: string, x: number, z: number }[]} */
        const out = [];
        const skipId = this.isPiloting && this.activeSlot ? this.activeSlot.id : null;
        for (const [slotId] of this._slotPilotId) {
            if (slotId === skipId) continue;
            const slot = this.slotsById.get(slotId);
            if (!slot?.root) continue;
            slot.root.updateMatrixWorld(true);
            slot.root.getWorldPosition(this._minimapPosScratch);
            const libId = slot.aircraftLibraryId ? String(slot.aircraftLibraryId).trim() : '';
            out.push({
                label: libId || slotId,
                x: this._minimapPosScratch.x,
                z: this._minimapPosScratch.z,
            });
        }
        return out;
    }

    /**
     * ミニマップを更新する（通常は約 2 FPS に間引き）
     * @param {boolean} [force] true なら間引きを無視して即時更新
     */
    updateMinimap(force = false) {
        if (!this.isPiloting) return;
        const now = performance.now();
        if (
            !force &&
            now - this._minimapLastUpdateMs < this._minimapUpdateIntervalMs
        ) {
            return;
        }
        this._minimapLastUpdateMs = now;
        const state = this.getMinimapState();
        if (!state) return;
        state.otherAircraft = this.getMinimapOtherAircraft();
        this.minimap.update(state);
    }

    /**
     * @param {(() => void)|null} fn
     */
    setOnPilotingChange(fn) {
        this._onPilotingChange = typeof fn === 'function' ? fn : null;
    }

    _notifyPilotingChange() {
        this.uiManager?.setMenuBarAircraftPiloting?.(this.isPiloting);
        try {
            this._onPilotingChange?.();
        } catch (_) { /* ignore */ }
    }

    setMobileMode(mobile) {
        this.isMobileMode = !!mobile;
    }

    _loadCameraModeFromStorage() {
        try {
            this._storedViewpointId = localStorage.getItem(STORAGE_CAMERA);
        } catch (_) {
            this._storedViewpointId = null;
        }
    }

    /**
     * @param {AircraftSlot|null|undefined} slot
     */
    _applyStoredViewpointForSlot(slot) {
        this.aircraftController.applyStoredViewpointForSlot(slot, this._storedViewpointId);
    }

    /**
     * 現在視点 ID を localStorage に保存する
     */
    _persistCurrentViewpoint() {
        const slot = this.isPiloting ? this.activeSlot : this.isPassenger ? this.passengerSlot : null;
        if (!slot) return;
        const vp = viewpointAtIndex(
            resolveSlotCameraViewpoints(slot),
            this.aircraftController.viewpointIndex
        );
        const id = vp?.id;
        if (!id) return;
        try {
            localStorage.setItem(STORAGE_CAMERA, id);
            this._storedViewpointId = id;
        } catch (_) { /* ignore */ }
    }

    toggleCameraMode() {
        const name = this.aircraftController.cycleViewpoint();
        this._persistCurrentViewpoint();
        this.uiManager?.flashAircraftViewpointName?.(name);
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
        if (this.isPiloting || this.isPassenger || this.isMobileMode) {
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
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>}
     */
    async _waitForSocketConnected(timeoutMs = BOARD_SOCKET_WAIT_MS) {
        const socket = this.networkManager?.socket;
        if (!socket) return false;
        if (socket.connected) return true;
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                socket.off('connect', onConnect);
                resolve(ok);
            };
            const onConnect = () => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            socket.once('connect', onConnect);
        });
    }

    /**
     * @param {string} [code]
     */
    _reportBoardFailure(code) {
        const msg =
            (code && BOARD_ERROR_JA[code]) ||
            (code ? `搭乗できませんでした（${code}）` : '搭乗できませんでした。');
        console.warn('[AircraftManager] board failed:', code || 'unknown');
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert(msg);
        }
    }

    /**
     * @returns {Promise<boolean>}
     */
    async tryBoardNearest() {
        if (!this.nearestSlot || this.isPiloting || this.isPassenger || this.isMobileMode) return false;
        if (this.characterController.xrPresenting) return false;
        const slot = this.nearestSlot;
        if (!slot?.id || !slot?.root) {
            this._reportBoardFailure('invalid_slot');
            return false;
        }

        if (this._slotHasOtherPilot(slot.id)) {
            this._enterPassenger(slot);
            return true;
        }

        const socket = this.networkManager?.socket;
        if (!socket) {
            this._reportBoardFailure('bad_request');
            return false;
        }
        if (!socket.connected) {
            const connected = await this._waitForSocketConnected();
            if (!connected) {
                this._reportBoardFailure('bad_request');
                return false;
            }
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => {
                this._reportBoardFailure('timeout');
                finish(false);
            }, BOARD_ACK_TIMEOUT_MS);
            socket.emit('aircraft-board', { slotId: slot.id }, (res) => {
                if (res?.ok) {
                    this._enterPiloting(slot);
                    finish(true);
                    return;
                }
                if (res?.error === 'busy') {
                    this._enterPassenger(slot);
                    finish(true);
                    return;
                }
                this._reportBoardFailure(res?.error);
                finish(false);
            });
        });
    }

    /**
     * スナップショット上、そのスロットを自分以外が操縦しているか
     * @param {string} slotId
     * @returns {boolean}
     */
    _slotHasOtherPilot(slotId) {
        const myId = this.networkManager?.myPlayerId;
        const pid = this._slotPilotId.get(slotId);
        if (!pid || !myId) return false;
        return pid !== myId;
    }

    /**
     * 搭乗プロンプト用: 他者操縦中なら同乗文面にする
     * @returns {'pilot'|'passenger'}
     */
    getNearestBoardingUiMode() {
        const slot = this.nearestSlot;
        if (!slot?.id) return 'pilot';
        return this._slotHasOtherPilot(slot.id) ? 'passenger' : 'pilot';
    }

    /**
     * @param {AircraftSlot} slot
     */
    _enterPassenger(slot) {
        document.exitPointerLock();
        this.passengerSlot = slot;
        this.isPassenger = true;
        this.characterController.resetMovement();
        this.characterController.setFlyMode(false);
        this.characterController.setAircraftPoseProvider({
            getPosition: (out) => AircraftController.getAvatarFeetWorldForSlot(slot, out),
            getQuaternion: (out) => AircraftController.getAvatarQuaternionForSlot(slot, out)
        });
        this.aircraftController.unbind();
        this.aircraftController.bindPassengerView(slot);
        this._applyStoredViewpointForSlot(slot);
        this.aircraftController.updatePassengerCamera();
        this.uiManager.hideAircraftBoardPrompt();

        this._pilotKeyHandler = (e) => {
            if (!this.isPassenger) return;
            if (this.characterController.isInputActive()) return;
            if (e.code === 'KeyF') {
                e.preventDefault();
                this.exitPassenger();
            } else if (e.code === 'KeyV') {
                e.preventDefault();
                this.toggleCameraMode();
            }
        };
        document.addEventListener('keydown', this._pilotKeyHandler);
        this._notifyPilotingChange();
    }

    /**
     * 同乗をやめ地上へ
     */
    exitPassenger() {
        if (!this.isPassenger || !this.passengerSlot) return;
        const ps = this.passengerSlot;
        this.placeCharacterBesideAircraft(ps);
        this._localPassengerCleanup();
    }

    _localPassengerCleanup() {
        if (this._pilotKeyHandler) {
            document.removeEventListener('keydown', this._pilotKeyHandler);
            this._pilotKeyHandler = null;
        }
        this.aircraftController.unbindPassengerView();
        this.characterController.setAircraftPoseProvider(null);
        this.isPassenger = false;
        this.passengerSlot = null;
        this.uiManager.hideAircraftBoardPrompt();
        this._notifyPilotingChange();
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
        this._applyStoredViewpointForSlot(slot);
        this.aircraftController.snapPilotCamera();
        this.uiManager.showAircraftHud();
        void this.loadFlightMapForWorld().then(() => {
            if (this.isPiloting) {
                this.minimap.show();
                this.updateMinimap(true);
            }
        });
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
        this._notifyPilotingChange();
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
        this.aircraftController.unbindPassengerView();
        this.characterController.setAircraftPoseProvider(null);
        this.isPiloting = false;
        this.activeSlot = null;
        this.minimap.hide();
        this.uiManager.hideAircraftHud();
        this._notifyPilotingChange();
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
        this._slotPilotId.clear();
        for (const entry of list) {
            if (entry?.id && entry?.pilotId) {
                this._slotPilotId.set(String(entry.id), String(entry.pilotId));
            }
        }
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
        if (this.isPassenger && this.passengerSlot?.id === slotId) {
            this.placeCharacterBesideAircraft(this.passengerSlot);
            this._localPassengerCleanup();
        }
        this.resetSlotToParked(slotId);
    }

    /**
     * サーバーが既に room から外した後（change-world 等）にローカルだけ操縦状態を掃除する
     */
    forceLocalPilotingReset() {
        if (this.isPassenger && this.passengerSlot) {
            this.placeCharacterBesideAircraft(this.passengerSlot);
            this._localPassengerCleanup();
        }
        if (!this.isPiloting) return;
        if (this._pilotKeyHandler) {
            document.removeEventListener('keydown', this._pilotKeyHandler);
            this._pilotKeyHandler = null;
        }
        const sid = this.activeSlot?.id;
        this.aircraftController.unbind();
        this.aircraftController.unbindPassengerView();
        this.characterController.setAircraftPoseProvider(null);
        this.isPiloting = false;
        this.activeSlot = null;
        this.minimap.hide();
        this.uiManager.hideAircraftHud();
        this.uiManager.hideAircraftBoardPrompt();
        if (sid) this.resetSlotToParked(sid);
        this._notifyPilotingChange();
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
            && !this.isPiloting
            && !this.isPassenger;
    }
}
