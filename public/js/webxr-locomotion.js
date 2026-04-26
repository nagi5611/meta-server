// public/js/webxr-locomotion.js — WebXR（リグ同期／左スティック移動／テレポート／スナップターン／ジャンプ）

import * as THREE from 'three';

const LS_LOCOMOTION = 'metaverse-vr-locomotion';
const SNAP_RAD = (Math.PI / 180) * 30;
const SNAP_COOLDOWN_SEC = 0.38;
const TELEPORT_COOLDOWN_SEC = 0.45;
const SNAP_THRESHOLD = 0.72;
const TELEPORT_MAX_DIST = 28;
const DOWN_CAST = 4;
const STICK_DEADZONE = 0.14;
const SINGLE_CTRL_SNAP_AX1_MAX = 0.38;

/** @typedef {'both'|'smooth'|'teleport'} LocomotionMode */

/**
 * @param {number} x
 * @param {number} y
 * @param {number} dead
 * @returns {{ x: number, y: number, mag: number }}
 */
function applyStickDeadzone(x, y, dead) {
    const m = Math.hypot(x, y);
    if (m < dead) {
        return { x: 0, y: 0, mag: 0 };
    }
    const nx = x / m;
    const ny = y / m;
    const t = Math.min(1, (m - dead) / Math.max(1e-6, 1 - dead));
    return { x: nx * t, y: ny * t, mag: t };
}

/**
 * axes (0,1) と (2,3) のうちノルムが大きいペアを採用する（ランタイムでスティック軸がずれる場合への対応）。
 * @param {Gamepad} gp
 * @returns {{ x: number, y: number, tag: string }}
 */
function pickPrimaryThumbstickXY(gp) {
    if (!gp || !gp.axes || gp.axes.length < 2) {
        return { x: 0, y: 0, tag: '—' };
    }
    const a = gp.axes;
    /** @type {{ x: number, y: number, tag: string }[]} */
    const cands = [{ x: a[0] || 0, y: a[1] || 0, tag: '0,1' }];
    if (a.length >= 4) {
        cands.push({ x: a[2] || 0, y: a[3] || 0, tag: '2,3' });
    }
    let best = cands[0];
    let bm = Math.hypot(best.x, best.y);
    for (let i = 1; i < cands.length; i++) {
        const m = Math.hypot(cands[i].x, cands[i].y);
        if (m > bm) {
            best = cands[i];
            bm = m;
        }
    }
    return { x: best.x, y: best.y, tag: best.tag };
}

export default class WebXRLocomotion {
    /**
     * @param {object} opts
     * @param {THREE.WebGLRenderer} opts.renderer
     * @param {import('./scene-manager.js').default} opts.sceneManager
     * @param {import('./physics-manager.js').default} opts.physicsManager
     * @param {import('./character-controller.js').default} opts.characterController
     * @param {import('./xr-player-rig.js').XrPlayerRig|null} [opts.xrPlayerRig]
     * @param {HTMLElement|null} [opts.domOverlayRoot]
     * @param {() => void} [opts.onVrSessionStart] renderer.xr sessionstart 時（一人称化など）
     * @param {() => void} [opts.onVrSessionEnd] sessionend 時（視点復元など）
     */
    constructor({
        renderer,
        sceneManager,
        physicsManager,
        characterController,
        xrPlayerRig = null,
        domOverlayRoot = null,
        onVrSessionStart = null,
        onVrSessionEnd = null
    }) {
        this.renderer = renderer;
        this.sceneManager = sceneManager;
        this.physicsManager = physicsManager;
        this.characterController = characterController;
        this.xrPlayerRig = xrPlayerRig || null;
        this.domOverlayRoot = domOverlayRoot;
        this.onVrSessionStart = typeof onVrSessionStart === 'function' ? onVrSessionStart : null;
        this.onVrSessionEnd = typeof onVrSessionEnd === 'function' ? onVrSessionEnd : null;

        /** @type {LocomotionMode} */
        this.locomotionMode = this._loadLocomotionMode();

        this._snapCooldown = 0;
        this._teleportCooldown = 0;
        this._prevLeftGrip = false;

        this._tmpOrigin = new THREE.Vector3();
        this._tmpDir = new THREE.Vector3();
        this._tmpDown = new THREE.Vector3(0, -1, 0);

        this._onSessionStart = () => this._handleSessionStart();
        this._onSessionEnd = () => this._handleSessionEnd();
        this.renderer.xr.addEventListener('sessionstart', this._onSessionStart);
        this.renderer.xr.addEventListener('sessionend', this._onSessionEnd);

        /** @type {HTMLElement|null} */
        this._stickFeedbackEl = typeof document !== 'undefined' ? document.getElementById('xr-stick-feedback') : null;

        this._savedPixelRatio = null;
        this._controllersWired = false;
        this._wireControllers();
        this._bindOverlayButtons();
    }

    /** @returns {LocomotionMode} */
    _loadLocomotionMode() {
        try {
            const v = localStorage.getItem(LS_LOCOMOTION);
            if (v === 'smooth' || v === 'teleport' || v === 'both') return v;
        } catch (_) { /* ignore */ }
        return 'both';
    }

    /** @param {LocomotionMode} mode */
    setLocomotionMode(mode) {
        if (mode !== 'smooth' && mode !== 'teleport' && mode !== 'both') return;
        this.locomotionMode = mode;
        try {
            localStorage.setItem(LS_LOCOMOTION, mode);
        } catch (_) { /* ignore */ }
        this._syncOverlayActiveStates();
    }

    _syncOverlayActiveStates() {
        if (!this.domOverlayRoot) return;
        this.domOverlayRoot.querySelectorAll('[data-vr-locomotion]').forEach((btn) => {
            const m = btn.getAttribute('data-vr-locomotion');
            btn.classList.toggle('active', m === this.locomotionMode);
        });
    }

    _bindOverlayButtons() {
        if (!this.domOverlayRoot) return;
        this.domOverlayRoot.addEventListener('click', (e) => {
            const t = e.target.closest('[data-vr-locomotion]');
            if (!t) return;
            const m = t.getAttribute('data-vr-locomotion');
            if (m === 'both' || m === 'smooth' || m === 'teleport') {
                this.setLocomotionMode(m);
            }
        });
        this._syncOverlayActiveStates();
    }

    _wireControllers() {
        if (this._controllersWired) return;
        this._controllersWired = true;
        for (let i = 0; i < 2; i++) {
            const c = this.renderer.xr.getController(i);
            c.addEventListener('selectend', () => this._tryTeleportFromController(i));
        }
    }

    _handleSessionStart() {
        document.exitPointerLock?.();
        // 没入直後から歩行物理を有効にし、スティック移動が効くようにする
        this.characterController.notifyGameplayInputIntent();
        if (this.onVrSessionStart) {
            try {
                this.onVrSessionStart();
            } catch (e) {
                console.error('[WebXR] onVrSessionStart:', e);
            }
        }
        if (this.xrPlayerRig) {
            try {
                this.xrPlayerRig.attach(this.characterController);
            } catch (e) {
                console.error('[WebXR] xrPlayerRig.attach:', e);
            }
        }
        this._savedPixelRatio = this.renderer.getPixelRatio();
        this.renderer.setPixelRatio(Math.min(this._savedPixelRatio, 1));
        this.sceneManager.onWindowResize();
    }

    _handleSessionEnd() {
        if (this.xrPlayerRig) {
            try {
                this.xrPlayerRig.detach();
            } catch (e) {
                console.error('[WebXR] xrPlayerRig.detach:', e);
            }
        }
        if (this.onVrSessionEnd) {
            try {
                this.onVrSessionEnd();
            } catch (e) {
                console.error('[WebXR] onVrSessionEnd:', e);
            }
        }
        if (this._savedPixelRatio != null) {
            this.renderer.setPixelRatio(this._savedPixelRatio);
            this._savedPixelRatio = null;
            this.sceneManager.onWindowResize();
        }
    }

    /**
     * @param {number} deltaTime
     */
    update(deltaTime) {
        const presenting = this.renderer.xr.isPresenting;
        this.characterController.setXrPresenting(presenting);
        if (!presenting) {
            this.characterController.setXrMoveVector({ x: 0, y: 0, force: 0 });
            if (this._stickFeedbackEl) {
                this._stickFeedbackEl.hidden = true;
                this._stickFeedbackEl.textContent = '';
            }
            return;
        }

        const session = this.renderer.xr.getSession();
        if (!session) return;

        this._snapCooldown = Math.max(0, this._snapCooldown - deltaTime);
        this._teleportCooldown = Math.max(0, this._teleportCooldown - deltaTime);

        const inp = this._readInputs(session);

        this.characterController.setXrMoveVector({
            x: inp.moveX,
            y: inp.moveY,
            force: inp.moveMag
        });

        this._updateStickFeedback(session, inp);

        this._maybeSnapTurn(inp.snapX);

        if (inp.leftGrip && !this._prevLeftGrip) {
            this.characterController.triggerJump();
        }
        this._prevLeftGrip = inp.leftGrip;
    }

    /**
     * 左スティック入力の検出状況を没入中のみ表示する。
     * @param {XRSession} session
     * @param {{ moveX: number, moveY: number, moveMag: number, rawHypot: number, axisTag: string, hasMoveGamepad: boolean, sourceCount: number }} inp
     */
    _updateStickFeedback(session, inp) {
        const el = this._stickFeedbackEl;
        if (!el) return;

        const rawLo = STICK_DEADZONE * 0.55;
        const moving = inp.moveMag > 0.04;
        const rawActive = inp.rawHypot >= rawLo;

        if (inp.sourceCount === 0) {
            el.hidden = false;
            el.textContent = 'スティック: 入力ソースがありません（コントローラーを認識できていません）';
            return;
        }
        if (!inp.hasMoveGamepad) {
            el.hidden = false;
            el.textContent = 'スティック: gamepad 付きのソースがありません';
            return;
        }
        if (moving) {
            el.hidden = false;
            el.textContent = `左スティック操作中\n移動量 ${inp.moveMag.toFixed(2)}  左右 ${inp.moveX.toFixed(2)} 前後 ${inp.moveY.toFixed(2)}\n軸ペア [${inp.axisTag}]`;
            return;
        }
        if (rawActive) {
            el.hidden = false;
            el.textContent = `スティック入力を検出（デッドゾーン内）\nraw 強さ ${inp.rawHypot.toFixed(2)}  [${inp.axisTag}]`;
            return;
        }
        el.hidden = true;
        el.textContent = '';
    }

    /**
     * @param {XRSession} session
     * @returns {{ moveX: number, moveY: number, moveMag: number, snapX: number, leftGrip: boolean, rawHypot: number, axisTag: string, hasMoveGamepad: boolean, sourceCount: number }}
     */
    _readInputs(session) {
        /** @type {{ src: XRInputSource, gp: Gamepad }[]} */
        const sources = [];
        for (const src of session.inputSources) {
            const gp = src.gamepad;
            if (!gp || !gp.axes || gp.axes.length < 2) continue;
            sources.push({ src, gp });
        }
        const sourceCount = session.inputSources.length;

        let moveEntry = null;
        for (const entry of sources) {
            if (entry.src.handedness === 'left') {
                moveEntry = entry;
                break;
            }
        }
        if (!moveEntry && sources.length > 0) {
            moveEntry = sources[0];
        }

        let snapEntry = null;
        for (const entry of sources) {
            if (entry.src.handedness === 'right') {
                snapEntry = entry;
                break;
            }
        }
        if (!snapEntry && sources.length >= 2 && moveEntry) {
            snapEntry = sources.find((e) => e !== moveEntry) || null;
        }

        let moveX = 0;
        let moveY = 0;
        let moveMag = 0;
        /** @type {string} */
        let axisTag = '—';
        let rawHypot = 0;
        const hasMoveGamepad = !!moveEntry;
        if (moveEntry) {
            const pick = pickPrimaryThumbstickXY(moveEntry.gp);
            axisTag = pick.tag;
            rawHypot = Math.hypot(pick.x, pick.y);
            const dz = applyStickDeadzone(pick.x, -pick.y, STICK_DEADZONE);
            moveX = dz.x;
            moveY = dz.y;
            moveMag = dz.mag;
        }

        let snapX = 0;
        if (snapEntry && snapEntry !== moveEntry) {
            const sp = pickPrimaryThumbstickXY(snapEntry.gp);
            snapX = sp.x;
        } else if (moveEntry && (!snapEntry || snapEntry === moveEntry)) {
            const pick = pickPrimaryThumbstickXY(moveEntry.gp);
            if (Math.abs(pick.y) < SINGLE_CTRL_SNAP_AX1_MAX) {
                snapX = pick.x;
            }
        }

        let leftGrip = false;
        for (const entry of sources) {
            if (entry.src.handedness === 'left') {
                const b1 = entry.gp.buttons[1];
                leftGrip = !!(b1 && b1.pressed);
                break;
            }
        }
        if (!leftGrip && sources.length === 1) {
            const b1 = sources[0].gp.buttons[1];
            leftGrip = !!(b1 && b1.pressed);
        }

        return { moveX, moveY, moveMag, snapX, leftGrip, rawHypot, axisTag, hasMoveGamepad, sourceCount };
    }

    _maybeSnapTurn(snapX) {
        if (this._snapCooldown > 0) return;
        if (Math.abs(snapX) < SNAP_THRESHOLD) return;
        const sign = snapX > 0 ? -1 : 1;
        this.characterController.applyXrSnapTurn(sign * SNAP_RAD);
        this._snapCooldown = SNAP_COOLDOWN_SEC;
        this.characterController.notifyGameplayInputIntent();
    }

    /**
     * @param {number} controllerIndex
     */
    _tryTeleportFromController(controllerIndex) {
        const mode = this.locomotionMode;
        if (mode === 'smooth') return;
        if (this._teleportCooldown > 0) return;

        const session = this.renderer.xr.getSession();
        if (session) {
            let hasRight = false;
            for (const s of session.inputSources) {
                if (s.handedness === 'right') hasRight = true;
            }
            if (!hasRight) {
                let count = 0;
                for (const s of session.inputSources) {
                    if (s.gamepad && s.gamepad.axes && s.gamepad.axes.length >= 2) count++;
                }
                if (count >= 2 && controllerIndex === 0) hasRight = true;
            }
            if (hasRight && controllerIndex === 0) return;
        }

        const ctrl = this.renderer.xr.getController(controllerIndex);
        const m = new THREE.Matrix4();
        m.copy(ctrl.matrixWorld);
        this._tmpOrigin.setFromMatrixPosition(m);
        this._tmpDir.set(0, 0, -1).transformDirection(m).normalize();

        const hit = this.physicsManager.raycastStaticWorld(
            this._tmpOrigin,
            this._tmpDir,
            TELEPORT_MAX_DIST
        );
        if (!hit) return;

        let land = hit.point.clone();
        const downFrom = land.clone().add(new THREE.Vector3(0, 0.35, 0));
        const downHit = this.physicsManager.raycastStaticWorld(downFrom, this._tmpDown, DOWN_CAST);
        if (downHit) {
            land.copy(downHit.point);
        }

        const feetY = land.y + 0.02;
        this.characterController.notifyGameplayInputIntent();
        this.characterController.setPosition(land.x, feetY, land.z);
        this.characterController.resetVelocity();
        this._teleportCooldown = TELEPORT_COOLDOWN_SEC;
    }

    dispose() {
        this.renderer.xr.removeEventListener('sessionstart', this._onSessionStart);
        this.renderer.xr.removeEventListener('sessionend', this._onSessionEnd);
        if (this.xrPlayerRig) {
            this.xrPlayerRig.dispose();
        }
    }
}
