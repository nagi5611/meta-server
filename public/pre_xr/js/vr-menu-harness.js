// public/pre_xr/js/vr-menu-harness.js — VR クイックメニュー検証（three-mesh-ui + Y ボタン）

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import ThreeMeshUI from 'https://cdn.jsdelivr.net/npm/three-mesh-ui@6.5.4/build/three-mesh-ui.module.js';

const FONT_JSON = '/addons/webxr-vr/client/assets/font-msdf/Roboto-msdf.json';
const FONT_TEXTURE = '/addons/webxr-vr/client/assets/font-msdf/Roboto-msdf.png';
const Y_INDEX = 5;

/**
 * pre_xr 用 VR メニュー検証ハーネス
 */
export class VrMenuHarness {
    /**
     * @param {object} opts
     * @param {import('three').WebGLRenderer} opts.renderer
     * @param {import('three').PerspectiveCamera} opts.camera
     * @param {HTMLElement} opts.stateEl
     * @param {HTMLElement} opts.yEl
     * @param {HTMLElement} opts.fontEl
     * @param {(msg: string) => void} opts.onLog
     * @param {HTMLButtonElement} [opts.toggleBtn]
     */
    constructor({ renderer, camera, stateEl, yEl, fontEl, onLog, toggleBtn = null }) {
        this.renderer = renderer;
        this.camera = camera;
        this.stateEl = stateEl;
        this.yEl = yEl;
        this.fontEl = fontEl;
        this.onLog = onLog;
        this.toggleBtn = toggleBtn;

        this._attached = false;
        this._visible = false;
        this._prevY = false;
        this._fontStatus = 'checking…';
        this._headEuler = new THREE.Euler(0, 0, 0, 'YXZ');

        this.root = new THREE.Group();
        this.root.name = 'pre-xr-vr-menu';
        this.root.visible = false;

        this.anchor = new THREE.Group();
        this.anchor.position.set(0, -0.22, -0.85);
        this.anchor.rotation.x = -0.35;

        const panel = new ThreeMeshUI.Block({
            width: 1.1,
            height: 0.16,
            padding: 0.03,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 0x1a1f28,
            backgroundOpacity: 0.92,
            borderRadius: 0.04,
            fontFamily: FONT_JSON,
            fontTexture: FONT_TEXTURE,
        });
        panel.add(new ThreeMeshUI.Text({
            content: 'pre_xr VR Menu TEST',
            fontSize: 0.05,
            fontFamily: FONT_JSON,
            fontTexture: FONT_TEXTURE,
        }));
        panel.add(new ThreeMeshUI.Text({
            content: '左手 Y で表示切替',
            fontSize: 0.03,
            fontFamily: FONT_JSON,
            fontTexture: FONT_TEXTURE,
        }));

        this.anchor.add(panel);
        this.root.add(this.anchor);

        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this._toggle('manual-btn'));
        }

        void this._probeFont();
    }

    async _probeFont() {
        try {
            const res = await fetch(FONT_JSON, { method: 'HEAD' });
            this._fontStatus = res.ok ? 'OK' : `FAIL (${res.status})`;
            if (!res.ok) this.onLog(`font HEAD failed: ${res.status}`);
        } catch (e) {
            this._fontStatus = `FAIL (${e?.message || e})`;
            this.onLog(`font fetch error: ${e?.message || e}`);
        }
        if (this.fontEl) this.fontEl.textContent = this._fontStatus;
    }

    attach() {
        if (this._attached) return;
        this.camera.add(this.root);
        this._attached = true;
        this.onLog('vr-menu harness attach');
        ThreeMeshUI.update();
    }

    detach() {
        if (!this._attached) return;
        this._visible = false;
        this.root.visible = false;
        this.camera.remove(this.root);
        this._attached = false;
        this.onLog('vr-menu harness detach');
    }

    /**
     * @param {string} reason
     */
    _toggle(reason) {
        this._visible = !this._visible;
        this.root.visible = this._visible;
        ThreeMeshUI.update();
        this.onLog(`menu toggle → ${this._visible ? 'ON' : 'off'} (${reason})`);
    }

    /**
     * @param {XRSession|null} session
     */
    _pollY(session) {
        if (!session) return { pressed: false, edge: false, summary: '—' };

        const pressedButtons = [];
        let pressed = false;

        for (let si = 0; si < session.inputSources.length; si++) {
            const src = session.inputSources[si];
            const buttons = src.gamepad?.buttons;
            if (!buttons) continue;
            for (let bi = 0; bi < buttons.length; bi++) {
                if (!buttons[bi]?.pressed) continue;
                pressedButtons.push(`${src.handedness || '?'}[${bi}]`);
                if ((src.handedness === 'left' || src.handedness !== 'right') && bi === Y_INDEX) {
                    pressed = true;
                }
            }
        }

        const edge = pressed && !this._prevY;
        this._prevY = pressed;
        return {
            pressed,
            edge,
            summary: pressedButtons.length ? pressedButtons.join(', ') : '押下なし',
        };
    }

    /**
     * @param {boolean} presenting
     */
    update(presenting) {
        if (!presenting) {
            if (this.stateEl) this.stateEl.textContent = 'VR 未入室';
            if (this.yEl) this.yEl.textContent = '—';
            return;
        }

        if (!this._attached) this.attach();

        const session = this.renderer.xr.getSession();
        const y = this._pollY(session);

        if (y.edge) this._toggle('Y-edge');

        this._headEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.anchor.rotation.set(-this._headEuler.x - 0.35, 0, -this._headEuler.z);

        if (this.stateEl) {
            this.stateEl.textContent = [
                `接続: ${this._attached ? 'yes' : 'no'}`,
                `表示: ${this._visible ? 'ON' : 'off'}`,
                `入力ソース: ${session?.inputSources?.length ?? 0}`,
            ].join('\n');
        }
        if (this.yEl) {
            this.yEl.textContent = [
                `Y[5] 押下: ${y.pressed ? 'YES' : 'no'}`,
                `全押下: ${y.summary}`,
            ].join('\n');
        }

        ThreeMeshUI.update();
    }
}

export { ThreeMeshUI as PreXrThreeMeshUI };
