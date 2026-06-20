// addons/aircraft/client/aircraft-minimap.js — 操縦中の円形ミニマップ（3D俯瞰 + オーバーレイ）

import * as THREE from 'three';
import { parseFlightMapConfig } from '../../../lib/aircraft-server/flight-map-schema.js';
import {
    aircraftIconRotationRad,
    applyNorthUpOrthoCamera,
    viewHalfExtentM,
    worldXzToMinimapScreen,
} from './flight-map-coords.js';

const DEFAULT_SIZE_PX = 264;
/** 352px 基準デザインからのスケール分母 */
const UI_DESIGN_BASE_PX = 352;
const CAMERA_HEIGHT_MIN_M = 80;
const CAMERA_HEIGHT_MAX_M = 20000;
/** 1 キー操作あたりの高度倍率（見える範囲はほぼ比例） */
const CAMERA_HEIGHT_ZOOM_FACTOR = 1.15;

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
        /** 表示・描画解像度（px） */
        this.sizePx = DEFAULT_SIZE_PX;
    }

    /**
     * 352px 基準 UI 要素のスケール
     * @returns {number}
     */
    _uiScale() {
        return this.sizePx / UI_DESIGN_BASE_PX;
    }

    /**
     * 円形クリップ半径（px）
     * @returns {number}
     */
    _radiusPx() {
        return this.sizePx / 2 - 5;
    }

    /**
     * sizePx を DOM・キャンバス・レンダラーへ反映する
     */
    _applySize() {
        const size = this.sizePx;
        if (this.root) {
            this.root.style.width = `${size}px`;
            this.root.style.height = `${size}px`;
        }
        for (const canvas of [this.canvas3d, this.canvasOverlay]) {
            if (!canvas) continue;
            canvas.width = size;
            canvas.height = size;
            canvas.style.width = `${size}px`;
            canvas.style.height = `${size}px`;
        }
        if (this._renderer) {
            this._renderer.setSize(size, size, false);
        }
    }

    /**
     * 俯瞰カメラ高度を変更し、見える範囲を広げる／狭める
     * @param {number} factor 1 より大きいと高度アップ（引き）、小さいと降下（寄り）
     * @returns {boolean}
     */
    adjustCameraHeight(factor) {
        if (!this.mapConfig || !Number.isFinite(factor) || factor <= 0) return false;
        const cur = this.mapConfig.cameraHeightM ?? 500;
        const next = Math.min(
            CAMERA_HEIGHT_MAX_M,
            Math.max(CAMERA_HEIGHT_MIN_M, cur * factor)
        );
        if (Math.abs(next - cur) < 0.5) return false;
        this.mapConfig.cameraHeightM = Math.round(next);
        if (typeof this.mapConfig.viewHalfExtentM === 'number') {
            delete this.mapConfig.viewHalfExtentM;
        }
        return true;
    }

    /** 見える範囲を狭める（;）— カメラを下げる */
    zoomIn() {
        return this.adjustCameraHeight(1 / CAMERA_HEIGHT_ZOOM_FACTOR);
    }

    /** 見える範囲を広げる（:）— カメラを上げる */
    zoomOut() {
        return this.adjustCameraHeight(CAMERA_HEIGHT_ZOOM_FACTOR);
    }

    /**
     * 現在の俯瞰カメラ高度（m）
     * @returns {number|null}
     */
    getCameraHeightM() {
        if (!this.mapConfig) return null;
        return this.mapConfig.cameraHeightM ?? 500;
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
        canvas3d.width = this.sizePx;
        canvas3d.height = this.sizePx;

        const canvasOverlay = document.createElement('canvas');
        canvasOverlay.className = 'aircraft-minimap-overlay';
        canvasOverlay.width = this.sizePx;
        canvasOverlay.height = this.sizePx;

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
        this._renderer.setSize(this.sizePx, this.sizePx, false);
        this._renderer.setPixelRatio(1);
        this._orthoCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 15000);
        this._applySize();
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
        const parsed = parseFlightMapConfig(map.config);
        if (!parsed.ok) {
            this.clearMap();
            return false;
        }
        this.mapConfig = JSON.parse(JSON.stringify(parsed.config));
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
     * ワールド絶対 XZ の地点を 2D オーバーレイに描画する
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} worldX
     * @param {number} worldZ
     * @param {number} groundY
     * @param {import('three').Camera} camera
     * @param {string} label
     * @param {string} fillColor
     * @param {number} radius
     */
    _drawMarkerAtWorld(ctx, worldX, worldZ, groundY, camera, label, fillColor, radius) {
        const size = this.sizePx;
        const screen = worldXzToMinimapScreen(worldX, worldZ, groundY, camera, size);
        if (!screen) return;
        const cx = size / 2;
        const cy = size / 2;
        const px = screen.sx - cx;
        const py = screen.sy - cy;
        if (Math.hypot(px, py) > this._radiusPx() - 4) return;
        const sx = screen.sx;
        const sy = screen.sy;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        const uiScale = this._uiScale();
        ctx.lineWidth = 2 * uiScale;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `${Math.round(14 * uiScale)}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(label, sx + radius + 2, sy + 3);
    }

    /**
     * スポット・他機・自機アイコンを 2D オーバーレイに描画する
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: { label: string, x: number, z: number }[] }} state
     */
    _drawOverlay(state) {
        if (!this.ctxOverlay || !this.mapConfig || !this._orthoCam) return;
        const { yawDeg } = state;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const groundY = this.mapConfig.groundRefY ?? 0;
        const size = this.sizePx;
        const cx = size / 2;
        const cy = size / 2;
        const ctx = this.ctxOverlay;
        ctx.clearRect(0, 0, size, size);
        const uiScale = this._uiScale();

        const spots = this.mapConfig.spots || [];
        for (const spot of spots) {
            if (!Number.isFinite(spot.x) || !Number.isFinite(spot.z)) continue;
            this._drawMarkerAtWorld(
                ctx,
                spot.x,
                spot.z,
                groundY,
                this._orthoCam,
                spot.name,
                '#f57c00',
                Math.round(10 * uiScale)
            );
        }

        const others = state.otherAircraft || [];
        for (const ac of others) {
            if (!Number.isFinite(ac.x) || !Number.isFinite(ac.z)) continue;
            this._drawMarkerAtWorld(
                ctx,
                ac.x,
                ac.z,
                groundY,
                this._orthoCam,
                ac.label,
                '#42a5f5',
                Math.round(8 * uiScale)
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
        this._drawOwnAircraftIcon(ctx);
        ctx.restore();
    }

    /**
     * トップダウン視点の自機シルエット（先端=進行方向・北固定時は機首）
     * @param {CanvasRenderingContext2D} ctx
     */
    _drawOwnAircraftIcon(ctx) {
        const s = this._uiScale();
        ctx.beginPath();
        ctx.moveTo(0, -16 * s);
        ctx.lineTo(11 * s, 12 * s);
        ctx.lineTo(0, 6 * s);
        ctx.lineTo(-11 * s, 12 * s);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
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
                g.fillRect(0, 0, this.sizePx, this.sizePx);
            }
        }

        this._drawOverlay(state);
    }
}
