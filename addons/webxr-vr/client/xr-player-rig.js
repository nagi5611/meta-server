// addons/webxr-vr/client/xr-player-rig.js — WebXR 用プレイヤーリグ

import * as THREE from 'three';

/**
 * カメラを一時的に子にし、足元＋ヨーで XR 参照空間とワールドを同期する。
 */
export class XrPlayerRig {
    /**
     * @param {object} opts
     * @param {THREE.Scene} opts.scene
     * @param {THREE.PerspectiveCamera} opts.camera
     * @param {THREE.WebGLRenderer} opts.renderer
     * @param {() => boolean} [opts.shouldApplyRig]
     * @param {() => number} [opts.getRigYaw]
     */
    constructor({ scene, camera, renderer, shouldApplyRig = null, getRigYaw = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.shouldApplyRig = typeof shouldApplyRig === 'function' ? shouldApplyRig : () => true;
        this.getRigYaw = typeof getRigYaw === 'function' ? getRigYaw : () => 0;

        this.rig = new THREE.Group();
        this.rig.name = 'xrPlayerRig';
        this._baseYaw = 0;
        this._attached = false;
    }

    /** @returns {boolean} */
    isAttached() {
        return this._attached;
    }

    /**
     * @param {import('../../../public/js/character-controller.js').default} characterController
     */
    attach(characterController) {
        if (this._attached) return;
        if (!this.shouldApplyRig()) return;
        if (!characterController) return;

        this._baseYaw = characterController.playerYaw;
        this.scene.add(this.rig);
        this.rig.add(this.camera);
        this._attached = true;
        this.sync(characterController);
    }

    detach() {
        if (!this._attached) return;
        if (this.camera.parent === this.rig) {
            this.rig.remove(this.camera);
        }
        if (this.rig.parent === this.scene) {
            this.scene.remove(this.rig);
        }
        this._attached = false;
    }

    /**
     * @param {import('../../../public/js/character-controller.js').default} characterController
     */
    sync(characterController) {
        if (!this._attached || !this.renderer.xr.isPresenting) return;
        if (!this.shouldApplyRig() || !characterController) return;

        const feet = characterController.getPosition();
        this.rig.position.set(feet.x, feet.y, feet.z);
        this.rig.rotation.set(0, this._baseYaw + this.getRigYaw(), 0);
        this.rig.updateMatrixWorld(true);
    }

    dispose() {
        this.detach();
    }
}
