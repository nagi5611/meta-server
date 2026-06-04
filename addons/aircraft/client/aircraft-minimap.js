// addons/aircraft/client/aircraft-minimap.js — 操縦中の円形ミニマップ（North-up）

import { worldToMapUv } from './flight-map-coords.js';

const SIZE_PX = 176;
const RADIUS_PX = SIZE_PX / 2 - 4;

/**
 * 飛行操縦中 HUD 右下の円形ミニマップ
 */
export default class AircraftMinimap {
    constructor() {
        /** @type {HTMLElement|null} */
        this.root = null;
        /** @type {HTMLCanvasElement|null} */
        this.canvas = null;
        /** @type {CanvasRenderingContext2D|null} */
        this.ctx = null;
        /** @type {HTMLImageElement|null} */
        this.mapImage = null;
        /** @type {object|null} */
        this.mapConfig = null;
        /** @type {string} */
        this._loadToken = '';
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
        if (!map?.imageUrl || !map?.config?.worldBounds) {
            this.clearMap();
            return false;
        }
        const token = `${Date.now()}-${Math.random()}`;
        this._loadToken = token;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const loaded = await new Promise((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = map.imageUrl;
        });
        if (this._loadToken !== token) return false;
        if (!loaded) {
            this.clearMap();
            return false;
        }
        this.mapImage = img;
        this.mapConfig = map.config;
        return true;
    }

    /**
     * 地図定義をクリアする
     */
    clearMap() {
        this.mapImage = null;
        this.mapConfig = null;
        this._loadToken = '';
    }

    show() {
        this.ensureDom();
        if (!this.root || !this.mapImage || !this.mapConfig) return;
        this.root.style.display = 'block';
    }

    hide() {
        if (this.root) this.root.style.display = 'none';
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number }|null} state
     */
    update(state) {
        if (!state || !this.ctx || !this.canvas || !this.mapImage || !this.mapConfig) return;
        if (this.root?.style.display === 'none') return;

        const { worldX, worldZ, yawDeg } = state;
        const bounds = this.mapConfig.worldBounds;
        const uv = worldToMapUv(worldX, worldZ, bounds);
        if (!uv) return;

        const radiusM = this.mapConfig.minimapRadiusM || 800;
        const spanX = bounds.eastX - bounds.westX;
        const spanZ = bounds.southZ - bounds.northZ;
        const viewU = radiusM / spanX;
        const viewV = radiusM / spanZ;

        const cx = SIZE_PX / 2;
        const cy = SIZE_PX / 2;
        const ctx = this.ctx;
        ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, RADIUS_PX, 0, Math.PI * 2);
        ctx.clip();

        const img = this.mapImage;
        const sx = Math.max(0, (uv.u - viewU) * img.width);
        const sy = Math.max(0, (uv.v - viewV) * img.height);
        const sw = Math.min(img.width - sx, 2 * viewU * img.width);
        const sh = Math.min(img.height - sy, 2 * viewV * img.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE_PX, SIZE_PX);

        const spots = this.mapConfig.spots || [];
        for (const spot of spots) {
            const du = (spot.u - uv.u) / (2 * viewU);
            const dv = (spot.v - uv.v) / (2 * viewV);
            const dist = Math.hypot(du, dv);
            if (dist > 1) continue;
            const px = cx + du * RADIUS_PX;
            const py = cy + dv * RADIUS_PX;
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#f57c00';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(spot.name, px + 7, py + 3);
        }

        ctx.restore();

        ctx.save();
        ctx.translate(cx, cy);
        const iconDeg =
            (Number.isFinite(yawDeg) ? yawDeg : 0) + (this.mapConfig.aircraftIconOffsetDeg || 0);
        ctx.rotate((iconDeg * Math.PI) / 180);
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
