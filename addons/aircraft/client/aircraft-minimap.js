// addons/aircraft/client/aircraft-minimap.js — 操縦中の円形ミニマップ（3D俯瞰 + オーバーレイ）

import * as THREE from 'three';
import {
    aircraftIconRotationRad,
    applyNorthUpOrthoCamera,
    viewHalfExtentM,
    worldDeltaToMinimapPx,
} from './flight-map-coords.js';

const SIZE_PX = 176;
const RADIUS_PX = SIZE_PX / 2 - 4;

/**
 * 飛行操縦中 HUD 右下の円形ミニマップ（3D ワールド俯瞰・North-up）
 */
export default class AircraftMinimap {
    constructor() {
        /** @type {HTMLElement|null} */
        this.root = null;
        /** @type {HTMLCanvasElement|null} */
        this.canvas3d = null;
        /** @type {HTMLCanvasElement|null} */
        this.canvasOverlay = null;
        /** @type {CanvasRenderingContext2D|null} */
        this.ctxOverlay = null;
        /** @type {THREE.WebGLRenderer|null} */
        this._renderer = null;
        /** @type {THREE.OrthographicCamera|null} */
        this._orthoCam = null;
        /** @type {THREE.Scene|null} */
        this._scene = null;
        /** @type {THREE.Object3D|null} */
        this._skyDomeMesh = null;
        /** @type {THREE.Color} */
        this._minimapClearColor = new THREE.Color(0x2a3545);
        /** @type {object|null} */
        this.mapConfig = null;
    }

    /**
     * @param {{ getScene: () => THREE.Scene }} sceneManager
     */
    bindSceneManager(sceneManager) {
        if (!sceneManager || typeof sceneManager.getScene !== 'function') return;
        this._scene = sceneManager.getScene();
        this._skyDomeMesh = null;
        if (this._scene) {
            this._scene.traverse((o) => {
                if (o.name === 'SkyDome') this._skyDomeMesh = o;
            });
        }
        if (!this._orthoCam) {
            this._orthoCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 15000);
        }
    }

    /**
     * DOM を初期化する
     */
    ensureDom() {
        if (this.root) return;
        const root = document.createElement('div');
        root.id = 'aircraft-minimap';
        root.className = 'aircraft-minimap';
        root.setAttribute('aria-hidden', 'true');
        root.style.display = 'none';

        const canvas3d = document.createElement('canvas');
        canvas3d.className = 'aircraft-minimap-3d';
        canvas3d.width = SIZE_PX;
        canvas3d.height = SIZE_PX;

        const canvasOverlay = document.createElement('canvas');
        canvasOverlay.className = 'aircraft-minimap-overlay';
        canvasOverlay.width = SIZE_PX;
        canvasOverlay.height = SIZE_PX;

        const north = document.createElement('span');
        north.className = 'aircraft-minimap-north';
        north.textContent = 'N';

        root.appendChild(canvas3d);
        root.appendChild(canvasOverlay);
        root.appendChild(north);
        document.body.appendChild(root);

        this.root = root;
        this.canvas3d = canvas3d;
        this.canvasOverlay = canvasOverlay;
        this.ctxOverlay = canvasOverlay.getContext('2d');
        this._renderer = new THREE.WebGLRenderer({
            canvas: canvas3d,
            alpha: false,
            antialias: true,
            powerPreference: 'low-power',
        });
        this._renderer.setSize(SIZE_PX, SIZE_PX, false);
        this._renderer.setPixelRatio(1);
        this._orthoCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 15000);
    }

    /**
     * @param {object|null} map API レスポンスの map オブジェクト
     * @returns {Promise<boolean>}
     */
    async setMap(map) {
        this.ensureDom();
        if (!map?.config?.northDirection) {
            this.clearMap();
            return false;
        }
        this.mapConfig = map.config;
        return true;
    }

    clearMap() {
        this.mapConfig = null;
    }

    show() {
        this.ensureDom();
        if (!this.root || !this.mapConfig) return;
        this.root.style.display = 'block';
    }

    hide() {
        if (this.root) this.root.style.display = 'none';
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cx
     * @param {number} cy
     * @param {number} dx
     * @param {number} dz
     * @param {{ x: number, z: number }} north
     * @param {number} half
     * @param {string} label
     * @param {string} fillColor
     * @param {number} radius
     */
    _drawMarkerAtDelta(ctx, cx, cy, dx, dz, north, half, label, fillColor, radius) {
        const { px, py } = worldDeltaToMinimapPx(dx, dz, north, half, RADIUS_PX);
        if (Math.hypot(px, py) > RADIUS_PX - 4) return;
        const sx = cx + px;
        const sy = cy + py;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, sx + radius + 2, sy + 3);
    }

    /**
     * スポット・他機・自機アイコンを 2D オーバーレイに描画する
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: { label: string, x: number, z: number }[] }} state
     */
    _drawOverlay(state) {
        if (!this.ctxOverlay || !this.mapConfig) return;
        const { worldX, worldZ, yawDeg } = state;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const half = viewHalfExtentM(this.mapConfig);
        const cx = SIZE_PX / 2;
        const cy = SIZE_PX / 2;
        const ctx = this.ctxOverlay;
        ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);

        const spots = this.mapConfig.spots || [];
        for (const spot of spots) {
            this._drawMarkerAtDelta(
                ctx,
                cx,
                cy,
                spot.x - worldX,
                spot.z - worldZ,
                north,
                half,
                spot.name,
                '#f57c00',
                5
            );
        }

        const others = state.otherAircraft || [];
        for (const ac of others) {
            this._drawMarkerAtDelta(
                ctx,
                cx,
                cy,
                ac.x - worldX,
                ac.z - worldZ,
                north,
                half,
                ac.label,
                '#42a5f5',
                4
            );
        }

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(
            aircraftIconRotationRad(
                yawDeg,
                north,
                this.mapConfig.aircraftIconOffsetDeg || 0
            )
        );
        ctx.beginPath();
        ctx.moveTo(0, -14);
        ctx.lineTo(8, 10);
        ctx.lineTo(0, 5);
        ctx.lineTo(-8, 10);
        ctx.closePath();
        ctx.fillStyle = '#111';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: { label: string, x: number, z: number }[] }|null} state
     */
    update(state) {
        if (!state || !this.mapConfig || this.root?.style.display === 'none') return;
        this.ensureDom();

        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const groundY = this.mapConfig.groundRefY ?? 0;
        const cameraHeightM = this.mapConfig.cameraHeightM ?? 500;
        const half = viewHalfExtentM(this.mapConfig);

        if (this._scene && this._renderer && this._orthoCam) {
            applyNorthUpOrthoCamera(
                this._orthoCam,
                state.worldX,
                state.worldZ,
                groundY,
                cameraHeightM,
                north,
                half
            );
            const prevBg = this._scene.background;
            const prevFog = this._scene.fog;
            const prevSkyVisible = this._skyDomeMesh ? this._skyDomeMesh.visible : null;
            if (this._skyDomeMesh) this._skyDomeMesh.visible = false;
            this._scene.fog = null;
            this._scene.background = this._minimapClearColor;
            const prevAutoClear = this._renderer.autoClear;
            this._renderer.autoClear = true;
            this._renderer.setClearColor(this._minimapClearColor, 1);
            this._renderer.render(this._scene, this._orthoCam);
            this._renderer.autoClear = prevAutoClear;
            if (this._skyDomeMesh && prevSkyVisible != null) {
                this._skyDomeMesh.visible = prevSkyVisible;
            }
            this._scene.background = prevBg;
            this._scene.fog = prevFog;
        } else if (this.canvas3d) {
            const g = this.canvas3d.getContext('2d');
            if (g) {
                g.fillStyle = '#1a2634';
                g.fillRect(0, 0, SIZE_PX, SIZE_PX);
            }
        }

        this._drawOverlay(state);
    }
}
