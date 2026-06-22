// addons/webxr-vr/client/vr-ui-raycast.js — VR メニュー用レイキャスト + 右コントローラーポインター

import * as THREE from 'three';
import { resolveRightControllerIndex } from './vr-controller-utils.js';
import { VR_UI_COLORS, collectUiMeshes, resolveMenuActionFromObject } from './vr-ui-helpers.js';

const POINTER_MAX_LEN = 2.5;
const POINTER_COLOR = 0x4fc3f7;
const POINTER_COLOR_HIT = 0xffee58;

/**
 * 右コントローラー select + 可視レイによる 3D UI 操作
 */
export class VrUiRaycast {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     */
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.raycaster = new THREE.Raycaster();
        this._tmpMatrix = new THREE.Matrix4();
        this._origin = new THREE.Vector3();
        this._direction = new THREE.Vector3();
        /** @type {THREE.Object3D|null} */
        this._hoverBlock = null;
        this._enabled = false;
        /** @type {THREE.Object3D|null} */
        this._uiRoot = null;
        /** @type {((action: string, payload: string) => void)|null} */
        this.onSelect = null;
        this._wired = false;
        /** @type {number|null} */
        this._selectingRightIndex = null;

        this._pointer = this._createPointerVisuals();
        this._pointer.group.visible = false;
    }

    /** 右コントローラー先端のレイ + ヒットマーカー */
    _createPointerVisuals() {
        const positions = new Float32Array([0, 0, 0, 0, 0, -POINTER_MAX_LEN]);
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const lineMat = new THREE.LineBasicMaterial({
            color: POINTER_COLOR,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.renderOrder = 1001;
        line.frustumCulled = false;

        const dot = new THREE.Mesh(
            new THREE.RingGeometry(0.006, 0.011, 20),
            new THREE.MeshBasicMaterial({
                color: POINTER_COLOR_HIT,
                transparent: true,
                opacity: 0.95,
                side: THREE.DoubleSide,
                depthTest: false,
            })
        );
        dot.visible = false;
        dot.renderOrder = 1002;
        dot.frustumCulled = false;

        const group = new THREE.Group();
        group.name = 'vr-ui-pointer';
        group.add(line);
        group.add(dot);

        return { group, line, lineMat, dot, positions };
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
            this._pointer.group.visible = false;
            this._detachPointer();
        }
    }

    /** 右コントローラーの select のみ配線 */
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
        if (controllerIndex !== resolveRightControllerIndex(this.renderer)) return;

        this._selectingRightIndex = controllerIndex;
        const hit = this._raycastController(controllerIndex);
        if (hit?.block) {
            this._setHover(hit.block, 'pressed');
        }
    }

    /**
     * @param {number} controllerIndex
     */
    _onSelectEnd(controllerIndex) {
        if (!this._enabled || !this._uiRoot) return;
        if (controllerIndex !== resolveRightControllerIndex(this.renderer)) return;

        const hit = this._raycastController(controllerIndex);
        this._clearHover();
        this._selectingRightIndex = null;
        if (hit?.action && typeof this.onSelect === 'function') {
            this.onSelect(hit.action, hit.payload);
        }
    }

    /**
     * 毎フレーム: レイ表示・ホバー更新（ThreeMeshUI.update 後に呼ぶ）
     */
    update() {
        if (!this._enabled || !this._uiRoot) {
            this._pointer.group.visible = false;
            return;
        }

        const rightIdx = resolveRightControllerIndex(this.renderer);
        const ctrl = this._attachPointerToController(rightIdx);
        if (!ctrl) {
            this._pointer.group.visible = false;
            return;
        }

        this._pointer.group.visible = true;
        const hit = this._raycastController(rightIdx);
        const dist = hit?.distance ?? POINTER_MAX_LEN;
        const clamped = Math.max(0.05, Math.min(POINTER_MAX_LEN, dist));

        this._updatePointerGeometry(clamped, !!hit?.block);

        if (this._selectingRightIndex === rightIdx) return;

        if (hit?.block) {
            if (this._hoverBlock !== hit.block) {
                this._clearHover();
                this._hoverBlock = hit.block;
                this._setHover(hit.block, 'hover');
            }
        } else {
            this._clearHover();
        }
    }

    /**
     * @param {number} controllerIndex
     * @returns {THREE.Object3D|null}
     */
    _attachPointerToController(controllerIndex) {
        const ctrl = this.renderer.xr.getController(controllerIndex);
        if (!ctrl.parent) {
            this.scene.add(ctrl);
        }
        if (this._pointer.group.parent !== ctrl) {
            ctrl.add(this._pointer.group);
        }
        return ctrl;
    }

    _detachPointer() {
        if (this._pointer.group.parent) {
            this._pointer.group.parent.remove(this._pointer.group);
        }
    }

    /**
     * @param {number} length
     * @param {boolean} hasHit
     */
    _updatePointerGeometry(length, hasHit) {
        const { positions, lineMat, dot } = this._pointer;
        positions[3] = 0;
        positions[4] = 0;
        positions[5] = -length;
        this._pointer.line.geometry.attributes.position.needsUpdate = true;

        lineMat.color.setHex(hasHit ? POINTER_COLOR_HIT : POINTER_COLOR);

        if (hasHit) {
            dot.visible = true;
            dot.position.set(0, 0, -length);
        } else {
            dot.visible = false;
        }
    }

    /**
     * @param {number} controllerIndex
     * @returns {{ action: string, payload: string, block: THREE.Object3D|null, distance: number }|null}
     */
    _raycastController(controllerIndex) {
        const ctrl = this.renderer.xr.getController(controllerIndex);
        this._tmpMatrix.copy(ctrl.matrixWorld);
        this._origin.setFromMatrixPosition(this._tmpMatrix);
        this._direction.set(0, 0, -1).transformDirection(this._tmpMatrix).normalize();

        const meshes = collectUiMeshes(this._uiRoot);
        if (!meshes.length) return null;

        this.raycaster.far = POINTER_MAX_LEN;
        this.raycaster.set(this._origin, this._direction);
        const hits = this.raycaster.intersectObjects(meshes, false);
        if (!hits.length) return null;

        const resolved = resolveMenuActionFromObject(hits[0].object);
        if (!resolved.action) return null;
        return { ...resolved, distance: hits[0].distance };
    }

    /**
     * @param {THREE.Object3D} block
     * @param {'hover'|'pressed'} state
     */
    _setHover(block, state) {
        if (this._hoverBlock && this._hoverBlock !== block) {
            this._applyBlockColor(this._hoverBlock, 'normal');
        }
        this._hoverBlock = block;
        this._applyBlockColor(block, state);
    }

    _clearHover() {
        if (this._hoverBlock) {
            this._applyBlockColor(this._hoverBlock, 'normal');
            this._hoverBlock = null;
        }
    }

    /**
     * @param {THREE.Object3D} block
     * @param {'normal'|'hover'|'pressed'} state
     */
    _applyBlockColor(block, state) {
        if (!block?.set) return;
        const base = block.userData?.vrBaseColor ?? VR_UI_COLORS.bg;
        let color = base;
        if (state === 'hover') color = VR_UI_COLORS.bgHover;
        if (state === 'pressed') color = VR_UI_COLORS.bgActive;
        block.set({ backgroundColor: new THREE.Color(color) });
    }

    dispose() {
        this._clearHover();
        this._detachPointer();
        this._pointer.group.visible = false;
        this._uiRoot = null;
        this._enabled = false;
        this._selectingRightIndex = null;
    }
}
