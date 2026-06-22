// addons/webxr-vr/client/vr-ui-raycast.js — VR メニュー用レイキャスト

import * as THREE from 'three';
import { VR_UI_COLORS, collectUiMeshes, resolveMenuActionFromObject } from './vr-ui-helpers.js';

/**
 * コントローラ select による 3D UI レイキャスト
 */
export class VrUiRaycast {
    /**
     * @param {THREE.WebGLRenderer} renderer
     */
    constructor(renderer) {
        this.renderer = renderer;
        this.raycaster = new THREE.Raycaster();
        this._tmpMatrix = new THREE.Matrix4();
        this._hoverBlock = null;
        this._enabled = false;
        this._uiRoot = null;
        /** @type {((action: string, payload: string) => void)|null} */
        this.onSelect = null;
        this._wired = false;
    }

    /**
     * @param {THREE.Object3D|null} root
     * @param {boolean} enabled
     */
    setTarget(root, enabled) {
        this._uiRoot = root;
        this._enabled = enabled && !!root;
        if (!this._enabled) {
            this._clearHover();
        }
    }

    /** コントローラ select イベントを配線 */
    wireControllers() {
        if (this._wired) return;
        this._wired = true;
        for (let i = 0; i < 2; i++) {
            const c = this.renderer.xr.getController(i);
            c.addEventListener('selectstart', () => this._onSelectStart(i));
            c.addEventListener('selectend', () => this._onSelectEnd(i));
        }
    }

    /**
     * @param {number} controllerIndex
     */
    _onSelectStart(controllerIndex) {
        if (!this._enabled || !this._uiRoot) return;
        const hit = this._raycastController(controllerIndex);
        if (hit?.block) {
            this._setHover(hit.block, true);
        }
    }

    /**
     * @param {number} controllerIndex
     */
    _onSelectEnd(controllerIndex) {
        if (!this._enabled || !this._uiRoot) return;
        const hit = this._raycastController(controllerIndex);
        this._clearHover();
        if (hit?.action && typeof this.onSelect === 'function') {
            this.onSelect(hit.action, hit.payload);
        }
    }

    /**
     * @param {number} controllerIndex
     * @returns {{ action: string, payload: string, block: THREE.Object3D|null }|null}
     */
    _raycastController(controllerIndex) {
        const ctrl = this.renderer.xr.getController(controllerIndex);
        this._tmpMatrix.copy(ctrl.matrixWorld);
        const origin = new THREE.Vector3().setFromMatrixPosition(this._tmpMatrix);
        const direction = new THREE.Vector3(0, 0, -1).transformDirection(this._tmpMatrix).normalize();

        const meshes = collectUiMeshes(this._uiRoot);
        if (!meshes.length) return null;

        this.raycaster.set(origin, direction);
        const hits = this.raycaster.intersectObjects(meshes, false);
        if (!hits.length) return null;

        const resolved = resolveMenuActionFromObject(hits[0].object);
        if (!resolved.action) return null;
        return resolved;
    }

    /**
     * @param {THREE.Object3D} block
     * @param {boolean} pressed
     */
    _setHover(block, pressed) {
        if (this._hoverBlock && this._hoverBlock !== block) {
            this._applyBlockColor(this._hoverBlock, false);
        }
        this._hoverBlock = block;
        this._applyBlockColor(block, pressed);
    }

    _clearHover() {
        if (this._hoverBlock) {
            this._applyBlockColor(this._hoverBlock, false);
            this._hoverBlock = null;
        }
    }

    /**
     * @param {THREE.Object3D} block
     * @param {boolean} pressed
     */
    _applyBlockColor(block, pressed) {
        if (!block?.set) return;
        const base = block.userData?.vrBaseColor ?? VR_UI_COLORS.bg;
        const color = pressed ? VR_UI_COLORS.bgActive : base;
        block.set({ backgroundColor: new THREE.Color(color) });
    }

    dispose() {
        this._clearHover();
        this._uiRoot = null;
        this._enabled = false;
    }
}
