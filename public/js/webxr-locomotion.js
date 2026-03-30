// public/js/webxr-locomotion.js — WebXR（テレポート／スナップターン／ジャンプ）。左スティック移動は行わない。

import * as THREE from 'three';

const LS_LOCOMOTION = 'metaverse-vr-locomotion';
const SNAP_RAD = (Math.PI / 180) * 30;
const SNAP_COOLDOWN_SEC = 0.38;
const TELEPORT_COOLDOWN_SEC = 0.45;
const SNAP_THRESHOLD = 0.72;
const TELEPORT_MAX_DIST = 28;
const DOWN_CAST = 4;

/** @typedef {'both'|'smooth'|'teleport'} LocomotionMode */

export default class WebXRLocomotion {
    /**
     * @param {object} opts
     * @param {THREE.WebGLRenderer} opts.renderer
     * @param {import('./scene-manager.js').default} opts.sceneManager
     * @param {import('./physics-manager.js').default} opts.physicsManager
     * @param {import('./character-controller.js').default} opts.characterController
     * @param {HTMLElement|null} [opts.domOverlayRoot]
     * @param {() => void} [opts.onVrSessionStart] renderer.xr sessionstart 時（一人称化など）
     * @param {() => void} [opts.onVrSessionEnd] sessionend 時（視点復元など）
     */
    constructor({
        renderer,
        sceneManager,
        physicsManager,
        characterController,
        domOverlayRoot = null,
        onVrSessionStart = null,
        onVrSessionEnd = null
    }) {
        this.renderer = renderer;
        this.sceneManager = sceneManager;
        this.physicsManager = physicsManager;
        this.characterController = characterController;
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
        if (this.onVrSessionStart) {
            try {
                this.onVrSessionStart();
            } catch (e) {
                console.error('[WebXR] onVrSessionStart:', e);
            }
        }
        this._savedPixelRatio = this.renderer.getPixelRatio();
        this.renderer.setPixelRatio(Math.min(this._savedPixelRatio, 1));
        this.sceneManager.onWindowResize();
    }

    _handleSessionEnd() {
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
            return;
        }

        const session = this.renderer.xr.getSession();
        if (!session) return;

        this._snapCooldown = Math.max(0, this._snapCooldown - deltaTime);
        this._teleportCooldown = Math.max(0, this._teleportCooldown - deltaTime);

        const { snapX, leftGrip } = this._readInputs(session);

        // 左スティックによるスムーズ移動は行わない（WebXR 入力は MDN XRInputSource.gamepad を参照）
        this.characterController.setXrMoveVector({ x: 0, y: 0, force: 0 });

        this._maybeSnapTurn(snapX);

        if (leftGrip && !this._prevLeftGrip) {
            this.characterController.triggerJump();
        }
        this._prevLeftGrip = leftGrip;
    }

    /**
     * @param {XRSession} session
     */
    _readInputs(session) {
        let snapX = 0;
        let leftGrip = false;

        for (const src of session.inputSources) {
            const gp = src.gamepad;
            if (!gp || !gp.axes || gp.axes.length < 2) continue;

            const ax0 = gp.axes[0] || 0;

            if (src.handedness === 'left') {
                const b1 = gp.buttons[1];
                leftGrip = !!(b1 && b1.pressed);
            } else if (src.handedness === 'right') {
                snapX = ax0;
            }
        }

        return { snapX, leftGrip };
    }

    _maybeSnapTurn(snapX) {
        if (this._snapCooldown > 0) return;
        if (Math.abs(snapX) < SNAP_THRESHOLD) return;
        const sign = snapX > 0 ? -1 : 1;
        this.characterController.applyXrSnapTurn(sign * SNAP_RAD);
        this._snapCooldown = SNAP_COOLDOWN_SEC;
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
        this.characterController.setPosition(land.x, feetY, land.z);
        this.characterController.resetVelocity();
        this._teleportCooldown = TELEPORT_COOLDOWN_SEC;
    }

    dispose() {
        this.renderer.xr.removeEventListener('sessionstart', this._onSessionStart);
        this.renderer.xr.removeEventListener('sessionend', this._onSessionEnd);
    }
}
