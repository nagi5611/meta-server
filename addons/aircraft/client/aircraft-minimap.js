// addons/aircraft/client/aircraft-minimap.js — 操縦中の円形ミニマップ（North-up・トップダウン）

import { aircraftIconRotationRad, worldDeltaToMinimapPx } from './flight-map-coords.js';

const SIZE_PX = 176;
const RADIUS_PX = SIZE_PX / 2 - 4;

/**
 * 飛行操縦中 HUD 右下の円形ミニマップ（地図画像なし・機体中心）
 */
export default class AircraftMinimap {
    constructor() {
        /** @type {HTMLElement|null} */
        this.root = null;
        /** @type {HTMLCanvasElement|null} */
        this.canvas = null;
        /** @type {CanvasRenderingContext2D|null} */
        this.ctx = null;
        /** @type {object|null} */
        this.mapConfig = null;
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
        const canvas = document.createElement('canvas');
        canvas.className = 'aircraft-minimap-canvas';
        canvas.width = SIZE_PX;
        canvas.height = SIZE_PX;
        root.appendChild(canvas);
        const north = document.createElement('span');
        north.className = 'aircraft-minimap-north';
        north.textContent = 'N';
        root.appendChild(north);
        document.body.appendChild(root);
        this.root = root;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
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

    /**
     * 地図定義をクリアする
     */
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
     * 背景グリッドを描画する
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cx
     * @param {number} cy
     * @param {number} radiusM
     */
    _drawGrid(ctx, cx, cy, radiusM) {
        ctx.fillStyle = 'rgba(26, 38, 52, 0.95)';
        ctx.fillRect(0, 0, SIZE_PX, SIZE_PX);

        const stepM = radiusM >= 2000 ? 500 : radiusM >= 800 ? 200 : 100;
        const scale = RADIUS_PX / radiusM;
        ctx.strokeStyle = 'rgba(120, 150, 190, 0.35)';
        ctx.lineWidth = 1;
        for (let m = -radiusM; m <= radiusM; m += stepM) {
            const off = m * scale;
            ctx.beginPath();
            ctx.moveTo(cx + off, cy - RADIUS_PX);
            ctx.lineTo(cx + off, cy + RADIUS_PX);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cx - RADIUS_PX, cy + off);
            ctx.lineTo(cx + RADIUS_PX, cy + off);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(180, 200, 230, 0.5)';
        ctx.beginPath();
        ctx.moveTo(cx, cy - RADIUS_PX);
        ctx.lineTo(cx, cy + RADIUS_PX);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - RADIUS_PX, cy);
        ctx.lineTo(cx + RADIUS_PX, cy);
        ctx.stroke();
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number }|null} state
     */
    update(state) {
        if (!state || !this.ctx || !this.canvas || !this.mapConfig) return;
        if (this.root?.style.display === 'none') return;

        const { worldX, worldZ, yawDeg } = state;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const radiusM = this.mapConfig.minimapRadiusM || 800;
        const cx = SIZE_PX / 2;
        const cy = SIZE_PX / 2;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, RADIUS_PX, 0, Math.PI * 2);
        ctx.clip();

        this._drawGrid(ctx, cx, cy, radiusM);

        const spots = this.mapConfig.spots || [];
        for (const spot of spots) {
            const { px, py } = worldDeltaToMinimapPx(
                spot.x - worldX,
                spot.z - worldZ,
                north,
                radiusM,
                RADIUS_PX
            );
            if (Math.hypot(px, py) > RADIUS_PX - 4) continue;
            const sx = cx + px;
            const sy = cy + py;
            ctx.beginPath();
            ctx.arc(sx, sy, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#f57c00';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(spot.name, sx + 7, sy + 3);
        }

        ctx.restore();

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

        ctx.beginPath();
        ctx.arc(cx, cy, RADIUS_PX, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}
