// public/js/aircraft/map-admin-spot-workbench.js — スポット定義（メタバース / Google / 統合）

import { AdminMapSpotWorldViewer } from './map-spot-world-viewer.js';
import { AdminMapGooglePreview } from './map-admin-google-preview.js';
import {
    MIN_GEO_CALIBRATION_SPOTS,
    countGeoCalibratedSpots,
} from './flight-map-geo.js';

/** @typedef {'metaverse' | 'google' | 'merged'} MapWorkbenchMode */

/**
 * ワールドの LOD バンド数（最大）
 * @param {object|null|undefined} world
 * @returns {number}
 */
export function getWorldMaxLodBands(world) {
    const ls = world?.lodSystem;
    if (!ls?.thresholdsById || typeof ls.thresholdsById !== 'object') return 0;
    let max = 0;
    for (const ratios of Object.values(ls.thresholdsById)) {
        if (Array.isArray(ratios)) max = Math.max(max, ratios.length + 1);
    }
    return max;
}

/**
 * 統合表示が可能か（地図座標付きスポットが 3 点以上）
 * @param {object|null|undefined} config
 * @returns {boolean}
 */
export function canShowMergedMapView(config) {
    if (!config) return false;
    return countGeoCalibratedSpots(config.spots || []) >= MIN_GEO_CALIBRATION_SPOTS;
}

/**
 * @param {object[]} spots
 * @returns {{ lat: number, lng: number }|null}
 */
function centroidLatLng(spots) {
    const geo = spots.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
    if (!geo.length) return null;
    let lat = 0;
    let lng = 0;
    for (const s of geo) {
        lat += s.lat;
        lng += s.lng;
    }
    return { lat: lat / geo.length, lng: lng / geo.length };
}

/**
 * スポット群の地理的半幅（m）を概算する
 * @param {object[]} spots
 * @returns {number}
 */
function geoHalfExtentFromSpots(spots) {
    const geo = spots.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
    if (geo.length < 2) return 500;
    const lats = geo.map((s) => s.lat);
    const lngs = geo.map((s) => s.lng);
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const northM = (Math.max(...lats) - Math.min(...lats)) * 111320;
    const eastM =
        (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos((centerLat * Math.PI) / 180);
    return Math.max(northM, eastM) * 0.55 + 80;
}

/**
 * スポット群のワールド XZ 半幅（m）を概算する
 * @param {object[]} spots
 * @returns {number}
 */
function worldHalfExtentFromSpots(spots) {
    if (!spots.length) return 500;
    const xs = spots.map((s) => s.x);
    const zs = spots.map((s) => s.z);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    return Math.max(span * 0.55 + 50, 100);
}

/**
 * メタバース / Google Map / 統合の切替ワークベンチ
 */
export class AdminMapSpotWorkbench {
    /**
     * @param {HTMLElement} root
     */
    constructor(root) {
        this.root = root;
        /** @type {MapWorkbenchMode} */
        this._mode = 'metaverse';
        /** @type {object|null} */
        this._config = null;
        /** @type {object|null} */
        this._world = null;
        /** @type {string|null} */
        this._selectedSpotId = null;
        /** @type {number} */
        this._lodBand = 1;
        /** @type {AdminMapSpotWorldViewer|null} */
        this._worldViewer = null;
        /** @type {AdminMapGooglePreview|null} */
        this._google = null;
        /** @type {((x: number, z: number) => void)|null} */
        this.onSpotWorldPick = null;
        /** @type {((lat: number, lng: number) => void)|null} */
        this.onSpotGeoPick = null;

        root.innerHTML = `
            <div class="ac-map-workbench-toolbar">
                <div class="ac-map-workbench-tabs" role="tablist">
                    <button type="button" class="ac-map-workbench-tab is-active" data-mode="metaverse" role="tab">メタバース</button>
                    <button type="button" class="ac-map-workbench-tab" data-mode="google" role="tab">Google Map</button>
                    <button type="button" class="ac-map-workbench-tab" data-mode="merged" role="tab" disabled title="地図座標付きスポット3点以上で有効">統合</button>
                </div>
                <div class="ac-map-workbench-toolbar-right">
                    <label class="ac-map-lod-label" id="ac-map-lod-label" hidden>
                        LOD
                        <select id="ac-map-lod-select" class="prop-input"></select>
                    </label>
                </div>
            </div>
            <div class="ac-map-workbench-stage" data-mode="metaverse">
                <div id="ac-map-workbench-google" class="ac-map-workbench-layer ac-map-workbench-google"></div>
                <div id="ac-map-workbench-world" class="ac-map-workbench-layer ac-map-workbench-world"></div>
            </div>
        `;

        this._stageEl = root.querySelector('.ac-map-workbench-stage');
        this._mergedTab = /** @type {HTMLButtonElement|null} */ (
            root.querySelector('[data-mode="merged"]')
        );
        this._lodLabel = root.querySelector('#ac-map-lod-label');
        this._lodSelect = /** @type {HTMLSelectElement|null} */ (root.querySelector('#ac-map-lod-select'));

        const worldMount = root.querySelector('#ac-map-workbench-world');
        const googleMount = root.querySelector('#ac-map-workbench-google');
        if (worldMount) {
            this._worldViewer = new AdminMapSpotWorldViewer(/** @type {HTMLElement} */ (worldMount));
            this._worldViewer.onSpotPick = (x, z) => this.onSpotWorldPick?.(x, z);
        }
        if (googleMount) {
            this._google = new AdminMapGooglePreview(/** @type {HTMLElement} */ (googleMount));
            this._google.onSpotGeoPick = (lat, lng) => this.onSpotGeoPick?.(lat, lng);
        }

        root.querySelectorAll('.ac-map-workbench-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.hasAttribute('disabled')) return;
                const mode = btn.getAttribute('data-mode');
                if (mode === 'metaverse' || mode === 'google' || mode === 'merged') {
                    this.setViewMode(mode);
                }
            });
        });

        this._lodSelect?.addEventListener('change', () => {
            const v = Number(this._lodSelect?.value);
            if (Number.isFinite(v) && v >= 1) {
                this._lodBand = Math.floor(v);
                void this._reloadWorldIfNeeded();
            }
        });

        this.setViewMode('metaverse');
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._google?.setApiKey(apiKey);
    }

    /**
     * @param {object|null} world
     */
    setWorld(world) {
        this._world = world;
        this._syncLodSelector();
        void this._reloadWorldIfNeeded();
    }

    /**
     * @param {object|null} config
     */
    setConfig(config) {
        this._config = config;
        const mergedOk = canShowMergedMapView(config);
        if (this._mergedTab) {
            this._mergedTab.disabled = !mergedOk;
            this._mergedTab.title = mergedOk
                ? 'メタバースと Google Map を重ねて表示'
                : `地図座標付きスポットが ${MIN_GEO_CALIBRATION_SPOTS} 点以上必要`;
        }
        this._worldViewer?.setViewOptions({
            cameraHeightM: config?.cameraHeightM,
            groundRefY: config?.groundRefY,
            northDirection: config?.northDirection,
        });
        this._google?.setConfig(config);
        this._worldViewer?.setSpotMarkers(config?.spots || []);
        if (this._mode === 'merged' && !mergedOk) {
            this.setViewMode('google');
        } else {
            this._applyMergedSync();
        }
    }

    /**
     * @param {string|null} spotId
     */
    setSelectedSpotId(spotId) {
        this._selectedSpotId = spotId;
    }

    /**
     * @param {MapWorkbenchMode} mode
     */
    setViewMode(mode) {
        if (mode === 'merged' && !canShowMergedMapView(this._config)) return;
        this._mode = mode;
        this.root.querySelectorAll('.ac-map-workbench-tab').forEach((btn) => {
            const m = btn.getAttribute('data-mode');
            btn.classList.toggle('is-active', m === mode);
        });
        if (this._stageEl) {
            this._stageEl.dataset.mode = mode;
        }
        const worldAlpha = mode === 'merged';
        this._worldViewer?.setOverlayMode(worldAlpha, mode === 'merged' ? 0.48 : 1);
        this._google?.setLayerOpacity(mode === 'merged' ? 0.52 : 1);
        const pickWorld = mode === 'metaverse';
        const pickGoogle = mode === 'google';
        this._worldViewer?.setPickingEnabled(pickWorld);
        this._google?.setPickingEnabled(pickGoogle);
        this._applyMergedSync();
    }

    /**
     * @returns {MapWorkbenchMode}
     */
    getViewMode() {
        return this._mode;
    }

    _syncLodSelector() {
        const bands = getWorldMaxLodBands(this._world);
        if (!this._lodSelect || !this._lodLabel) return;
        if (bands < 2) {
            this._lodLabel.hidden = true;
            this._lodBand = 1;
            return;
        }
        this._lodLabel.hidden = false;
        this._lodSelect.innerHTML = '';
        for (let r = 1; r <= bands; r++) {
            const opt = document.createElement('option');
            opt.value = String(r);
            opt.textContent = r === 1 ? `LOD ${r}（高詳細）` : `LOD ${r}`;
            this._lodSelect.appendChild(opt);
        }
        this._lodSelect.value = String(this._lodBand);
    }

    async _reloadWorldIfNeeded() {
        if (!this._worldViewer || !this._world) return;
        const cfg = this._config || {};
        this._worldViewer.setViewOptions({
            cameraHeightM: cfg.cameraHeightM,
            groundRefY: cfg.groundRefY,
            northDirection: cfg.northDirection,
        });
        await this._worldViewer.loadWorld(this._world, {
            lodSystem: this._world.lodSystem,
            lodBand: this._lodBand,
        });
        this._worldViewer.setSpotMarkers(cfg.spots || []);
        this._applyMergedSync();
    }

    _applyMergedSync() {
        if (this._mode !== 'merged' || !this._config) return;
        const spots = this._config.spots || [];
        const geoHalf = geoHalfExtentFromSpots(spots);
        const worldHalf = worldHalfExtentFromSpots(spots);
        const half = Math.max(geoHalf, worldHalf);
        const center = centroidLatLng(spots);
        if (center && this._google) {
            this._google.fitGeoExtent(center, half, this._config.geo);
        }
        if (this._worldViewer) {
            this._worldViewer.frameSpots(spots, half);
        }
    }

    dispose() {
        this._worldViewer?.dispose();
        this._google?.dispose();
        this._worldViewer = null;
        this._google = null;
    }
}
