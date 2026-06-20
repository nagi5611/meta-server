// public/js/aircraft/map-admin-spot-workbench.js — メタバース俯瞰 / Google 2D タブ切替ワークベンチ

import { AdminMapSpotWorldViewer } from './map-spot-world-viewer.js';
import { AdminMapGooglePreview } from './map-admin-google-preview.js';
import { MIN_GEO_CALIBRATION_SPOTS } from './flight-map-geo.js';

/** @typedef {'metaverse' | 'google'} MapViewTab */

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
 * @param {object|null|undefined} config
 * @returns {number}
 */
export function countWorldSpots(config) {
    return Array.isArray(config?.spots) ? config.spots.length : 0;
}

/**
 * メタバース俯瞰と Google Map をタブで切り替えるワークベンチ
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
        this._googleTabEnabled = false;
        /** @type {MapViewTab} */
        this._activeTab = 'metaverse';
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
            <div class="ac-map-view-tabs" role="tablist" aria-label="マップ表示">
                <button type="button" class="ac-map-view-tab is-active" data-view-tab="metaverse" role="tab" aria-selected="true">メタバース上方俯瞰</button>
                <button type="button" class="ac-map-view-tab" data-view-tab="google" role="tab" aria-selected="false" disabled title="スポット3点以上かつ Google Map 有効時に利用できます">Google Maps 2D</button>
            </div>
            <div class="ac-map-workbench-toolbar">
                <p class="ac-map-workbench-hint" id="ac-map-workbench-hint">俯瞰でクリックしてスポットを配置（3点以上）</p>
                <div class="ac-map-workbench-toolbar-right">
                    <label class="ac-map-lod-label" id="ac-map-lod-label" hidden>
                        LOD
                        <select id="ac-map-lod-select" class="prop-input"></select>
                    </label>
                </div>
            </div>
            <div class="ac-map-workbench-stage">
                <div id="ac-map-pane-metaverse" class="ac-map-view-pane is-active" data-view-pane="metaverse">
                    <div id="ac-map-workbench-world" class="ac-map-workbench-world"></div>
                </div>
                <div id="ac-map-pane-google" class="ac-map-view-pane" data-view-pane="google" hidden>
                    <div id="ac-map-workbench-google" class="ac-map-workbench-google"></div>
                </div>
            </div>
        `;

        this._hintEl = root.querySelector('#ac-map-workbench-hint');
        this._googleTabBtn = /** @type {HTMLButtonElement|null} */ (
            root.querySelector('[data-view-tab="google"]')
        );
        this._metaversePane = root.querySelector('#ac-map-pane-metaverse');
        this._googlePane = root.querySelector('#ac-map-pane-google');
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

        root.querySelectorAll('.ac-map-view-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.hasAttribute('disabled')) return;
                const tab = btn.getAttribute('data-view-tab');
                if (tab === 'metaverse' || tab === 'google') {
                    this.setActiveViewTab(tab);
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

        this._applyTabUi();
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
        this._google?.setConfig(config);
        this.setGoogleTabEnabled(geoOn, { spotCount, silent: true });
    }

    /**
     * @param {string|null} spotId
     */
    setSelectedSpotId(spotId) {
        this._selectedSpotId = spotId;
        this._google?.setSelectedSpotId(spotId);
        if (this._config) {
            this._google?.setConfig(this._config);
        }
    }

    /**
     * Google タブの有効化（geo 有効かつスポット3点以上）
     * @param {boolean} enabled
     * @param {{ spotCount?: number, silent?: boolean }} [opts]
     */
    setGoogleTabEnabled(enabled, opts = {}) {
        const spotCount = opts.spotCount ?? countWorldSpots(this._config);
        const canEnable = enabled && spotCount >= MIN_GEO_CALIBRATION_SPOTS;
        this._googleTabEnabled = canEnable;

        if (enabled && spotCount < MIN_GEO_CALIBRATION_SPOTS && !opts.silent) {
            this._updateHint(
                `Google Map にはスポットが ${MIN_GEO_CALIBRATION_SPOTS} 点以上必要です（現在 ${spotCount}）`
            );
        }

        if (this._googleTabBtn) {
            this._googleTabBtn.disabled = !canEnable;
            this._googleTabBtn.title = canEnable
                ? 'Google Maps 2D 表示'
                : `スポット ${MIN_GEO_CALIBRATION_SPOTS} 点以上かつ Google Map 有効時に利用できます`;
        }

        if (!canEnable && this._activeTab === 'google') {
            this.setActiveViewTab('metaverse');
        } else {
            this._applyTabUi();
        }
    }

    /**
     * @returns {boolean}
     */
    isGoogleTabEnabled() {
        return this._googleTabEnabled;
    }

    /**
     * @param {MapViewTab} tab
     */
    setActiveViewTab(tab) {
        if (tab === 'google' && !this._googleTabEnabled) return;
        this._activeTab = tab;
        this._applyTabUi();
        if (tab === 'google') {
            void this._google?.initialFit(this._config);
        }
    }

    /**
     * @returns {MapViewTab}
     */
    getActiveViewTab() {
        return this._activeTab;
    }

    _applyTabUi() {
        const tab = this._activeTab;
        this.root.querySelectorAll('.ac-map-view-tab').forEach((btn) => {
            const isActive = btn.getAttribute('data-view-tab') === tab;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        if (this._metaversePane) {
            const show = tab === 'metaverse';
            this._metaversePane.classList.toggle('is-active', show);
            this._metaversePane.hidden = !show;
        }
        if (this._googlePane) {
            const show = tab === 'google';
            this._googlePane.classList.toggle('is-active', show);
            this._googlePane.hidden = !show;
        }

        const metaversePick = tab === 'metaverse';
        this._worldViewer?.setPickingEnabled(metaversePick);
        this._google?.setMapInteractive(tab === 'google');
        this._google?.setPickingEnabled(tab === 'google');

        if (tab === 'metaverse') {
            this._updateHint(
                `俯瞰でクリックしてスポットを配置（${MIN_GEO_CALIBRATION_SPOTS} 点以上で Google タブが有効になります）`
            );
        } else {
            this._updateHint(
                'スポットを一覧で選択し、地図上をクリックして緯度経度を設定。補正後はメタバースの変更が自動反映されます'
            );
            if (this._google) {
                this._google.resize();
            }
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
    }

    /**
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
