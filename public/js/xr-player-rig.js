// public/js/xr-player-rig.js — WebXR 用プレイヤーリグ（足元ワールド座標と HMD を three.js の親行列で結ぶ）

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
     * @param {() => boolean} [opts.shouldApplyRig] false のとき attach/sync しない
     */
    constructor({ scene, camera, renderer, shouldApplyRig = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.shouldApplyRig = typeof shouldApplyRig === 'function' ? shouldApplyRig : () => true;

        this.rig = new THREE.Group();
        this.rig.name = 'xrPlayerRig';
        /** @type {number} セッション開始時のキャラヨー（ラジアン） */
        this._baseYaw = 0;
        this._attached = false;
    }

    /** @returns {boolean} */
    isAttached() {
        return this._attached;
    }

    /**
     * WebXR セッション開始時: カメラをリグの子にする。
     * @param {import('./character-controller.js').default} characterController
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

    /**
     * セッション終了時: カメラをシーンから切り離す。
     */
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
     * 毎フレーム: 足元とリグヨー（スナップ累積込み）を反映する。render 直前に呼ぶ。
     * @param {import('./character-controller.js').default} characterController
     */
    sync(characterController) {
        if (!this._attached || !this.renderer.xr.isPresenting) return;
        if (!this.shouldApplyRig() || !characterController) return;

        const feet = characterController.getPosition();
        this.rig.position.set(feet.x, feet.y, feet.z);
        this.rig.rotation.set(0, this._baseYaw + characterController.xrRigYaw, 0);
        this.rig.updateMatrixWorld(true);
    }

    dispose() {
        this.detach();
    }
}
