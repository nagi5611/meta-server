// public/js/aircraft/map-admin-spot-workbench.js — 俯瞰メタバース + 薄い Google Map オーバーレイ

import { AdminMapSpotWorldViewer } from './map-spot-world-viewer.js';
import { AdminMapGooglePreview } from './map-admin-google-preview.js';
import { MIN_GEO_CALIBRATION_SPOTS } from './flight-map-geo.js';

/** @typedef {'spots' | 'map' | 'geo'} MapWorkbenchInteraction */

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
 * Google オーバーレイ表示に必要なスポット数
 * @param {object|null|undefined} config
 * @returns {number}
 */
export function countWorldSpots(config) {
    return Array.isArray(config?.spots) ? config.spots.length : 0;
}

/**
 * 俯瞰メタバース上に Google Map を重ねるワークベンチ
 */
export class AdminMapSpotWorkbench {
    /**
     * @param {HTMLElement} root
     */
    constructor(root) {
        this.root = root;
        /** @type {object|null} */
        this._config = null;
        /** @type {object|null} */
        this._world = null;
        /** @type {string|null} */
        this._selectedSpotId = null;
        /** @type {number} */
        this._lodBand = 1;
        /** @type {boolean} */
        this._googleOverlayOn = false;
        /** @type {MapWorkbenchInteraction} */
        this._interaction = 'spots';
        /** @type {AdminMapSpotWorldViewer|null} */
        this._worldViewer = null;
        /** @type {AdminMapGooglePreview|null} */
        this._google = null;
        /** @type {((x: number, z: number) => void)|null} */
        this.onSpotWorldPick = null;
        /** @type {((lat: number, lng: number) => void)|null} */
        this.onSpotGeoPick = null;
        /** @type {((view: object) => void)|null} */
        this.onMapViewChange = null;

        root.innerHTML = `
            <div class="ac-map-workbench-toolbar">
                <div class="ac-map-workbench-modes" role="group" aria-label="操作モード">
                    <button type="button" class="ac-map-workbench-mode is-active" data-interaction="spots">スポット配置</button>
                    <button type="button" class="ac-map-workbench-mode" data-interaction="map" disabled title="Google Map 表示をオンにすると利用できます">地図調整</button>
                    <button type="button" class="ac-map-workbench-mode" data-interaction="geo" disabled title="Google Map 表示をオンにすると利用できます">地図座標</button>
                </div>
                <p class="ac-map-workbench-hint" id="ac-map-workbench-hint">俯瞰でクリックしてスポットを配置（3点以上）</p>
                <div class="ac-map-workbench-toolbar-right">
                    <label class="ac-map-lod-label" id="ac-map-lod-label" hidden>
                        LOD
                        <select id="ac-map-lod-select" class="prop-input"></select>
                    </label>
                </div>
            </div>
            <div class="ac-map-workbench-stage" data-google="off" data-interaction="spots">
                <div id="ac-map-workbench-google" class="ac-map-workbench-layer ac-map-workbench-google"></div>
                <div id="ac-map-workbench-world" class="ac-map-workbench-layer ac-map-workbench-world"></div>
            </div>
        `;

        this._stageEl = root.querySelector('.ac-map-workbench-stage');
        this._hintEl = root.querySelector('#ac-map-workbench-hint');
        this._mapModeBtn = /** @type {HTMLButtonElement|null} */ (
            root.querySelector('[data-interaction="map"]')
        );
        this._geoModeBtn = /** @type {HTMLButtonElement|null} */ (
            root.querySelector('[data-interaction="geo"]')
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
            this._google.onMapViewChange = (view) => this.onMapViewChange?.(view);
        }

        root.querySelectorAll('.ac-map-workbench-mode').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.hasAttribute('disabled')) return;
                const mode = btn.getAttribute('data-interaction');
                if (mode === 'spots' || mode === 'map' || mode === 'geo') {
                    this.setInteractionMode(mode);
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

        this._applyInteractionUi();
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
        const spotCount = countWorldSpots(config);
        const geoOn = config?.geo?.enabled === true;
        this._worldViewer?.setViewOptions({
            cameraHeightM: config?.cameraHeightM,
            groundRefY: config?.groundRefY,
            northDirection: config?.northDirection,
        });
        this._worldViewer?.setSpotMarkers(config?.spots || []);
        this._google?.setConfig(config, { overlayMode: geoOn });
        this.setGoogleOverlayEnabled(geoOn, { spotCount, silent: true });
    }

    /**
     * @param {string|null} spotId
     */
    setSelectedSpotId(spotId) {
        this._selectedSpotId = spotId;
        this._google?.setSelectedSpotId(spotId);
        if (this._config && this._googleOverlayOn) {
            this._google?.setConfig(this._config, { overlayMode: true });
        }
    }

    /**
     * Google Map オーバーレイの表示
     * @param {boolean} enabled
     * @param {{ spotCount?: number, silent?: boolean }} [opts]
     */
    setGoogleOverlayEnabled(enabled, opts = {}) {
        const spotCount = opts.spotCount ?? countWorldSpots(this._config);
        const canEnable = enabled && spotCount >= MIN_GEO_CALIBRATION_SPOTS;
        this._googleOverlayOn = canEnable;

        if (enabled && spotCount < MIN_GEO_CALIBRATION_SPOTS && !opts.silent) {
            this._updateHint(
                `Google Map 表示にはスポットが ${MIN_GEO_CALIBRATION_SPOTS} 点以上必要です（現在 ${spotCount}）`
            );
        }

        if (this._mapModeBtn) {
            this._mapModeBtn.disabled = !canEnable;
        }
        if (this._geoModeBtn) {
            this._geoModeBtn.disabled = !canEnable;
        }

        if (this._stageEl) {
            this._stageEl.dataset.google = canEnable ? 'on' : 'off';
        }

        this._worldViewer?.setMapOverlayActive(canEnable);
        this._google?.setOverlayVisible(canEnable);

        if (canEnable && !opts.silent) {
            void this._google?.initialFitForOverlay(this._config);
        }

        if (!canEnable && this._interaction !== 'spots') {
            this.setInteractionMode('spots');
        } else {
            this._applyInteractionUi();
        }
    }

    /**
     * @returns {boolean}
     */
    isGoogleOverlayEnabled() {
        return this._googleOverlayOn;
    }

    /**
     * @param {MapWorkbenchInteraction} mode
     */
    setInteractionMode(mode) {
        if (mode !== 'spots' && !this._googleOverlayOn) return;
        this._interaction = mode;
        this._applyInteractionUi();
    }

    /**
     * @returns {MapWorkbenchInteraction}
     */
    getInteractionMode() {
        return this._interaction;
    }

    _applyInteractionUi() {
        const mode = this._interaction;
        this.root.querySelectorAll('.ac-map-workbench-mode').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-interaction') === mode);
        });
        if (this._stageEl) {
            this._stageEl.dataset.interaction = mode;
        }

        const spotPick = mode === 'spots';
        const mapActive = mode === 'map' || mode === 'geo';
        this._worldViewer?.setPickingEnabled(spotPick);
        this._worldViewer?.setPointerPassthrough(!spotPick);
        this._google?.setMapInteractive(mapActive);
        this._google?.setPickingEnabled(mode === 'geo');

        if (mode === 'spots') {
            this._updateHint(
                this._googleOverlayOn
                    ? '俯瞰でスポットを配置・移動（ホイールで拡大縮小、ドラッグで移動）'
                    : `俯瞰でクリックしてスポットを配置（${MIN_GEO_CALIBRATION_SPOTS} 点以上で Google Map をオンにできます）`
            );
        } else if (mode === 'map') {
            this._updateHint(
                '地図をドラッグ・ピンチで移動、Ctrl+ドラッグまたは右クリックで回転、ホイールで拡大縮小して地形に合わせます'
            );
        } else {
            this._updateHint('スポットを一覧で選択し、地図上の対応位置をクリックして緯度経度を設定');
        }
    }

    /**
     * @param {string} text
     */
    _updateHint(text) {
        if (this._hintEl) this._hintEl.textContent = text;
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
        await this._worldViewer.loadWorld(this._world, {
            lodSystem: this._world.lodSystem,
            lodBand: this._lodBand,
        });
        this._worldViewer.setSpotMarkers(cfg.spots || []);
        this._worldViewer.setMapOverlayActive(this._googleOverlayOn);
    }

    /**
     * 保存済みビューを Google Map に適用
     * @param {object} geo
     */
    applySavedMapView(geo) {
        this._google?.applySavedView(geo);
    }

    dispose() {
        this._worldViewer?.dispose();
        this._google?.dispose();
        this._worldViewer = null;
        this._google = null;
    }
}
