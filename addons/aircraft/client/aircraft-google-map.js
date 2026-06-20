// addons/aircraft/client/aircraft-google-map.js — 操縦中の Google Maps 2D オーバーレイ（M キー）

import { parseFlightMapConfig, isGeoMapReady } from '../../../lib/aircraft-server/flight-map-schema.js';
import { GoogleMapFlightView } from './google-map-flight-view.js';

/**
 * 飛行中に M キーで表示する Google Maps 2D マップ
 */
export default class AircraftGoogleMap {
    constructor() {
        /** @type {HTMLElement|null} */
        this.root = null;
        /** @type {HTMLElement|null} */
        this.mapMount = null;
        /** @type {GoogleMapFlightView|null} */
        this._flightView = null;
        /** @type {object|null} */
        this.mapConfig = null;
        /** @type {string|null} */
        this._apiKey = null;
        /** @type {boolean} */
        this._visible = false;
    }

    ensureDom() {
        if (this.root) return;
        const root = document.createElement('div');
        root.id = 'aircraft-google-map';
        root.className = 'aircraft-google-map';
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');

        const header = document.createElement('div');
        header.className = 'aircraft-google-map-header';
        header.innerHTML =
            '<span class="aircraft-google-map-title">2D Map</span>'
            + '<span class="aircraft-google-map-hint">M で閉じる</span>';

        const mapMount = document.createElement('div');
        mapMount.className = 'aircraft-google-map-mount';

        const attribution = document.createElement('div');
        attribution.className = 'aircraft-google-map-attribution';
        attribution.textContent = '© Google';

        root.appendChild(header);
        root.appendChild(mapMount);
        root.appendChild(attribution);
        document.body.appendChild(root);

        this.root = root;
        this.mapMount = mapMount;
        this._flightView = new GoogleMapFlightView(mapMount, {
            interactive: true,
            showZoomControl: true,
        });
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
        this._flightView?.setApiKey(apiKey);
    }

    hasApiKey() {
        return !!this._apiKey;
    }

    /**
     * @returns {string|null}
     */
    getApiKey() {
        return this._apiKey;
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
        if (!parsed.ok || !isGeoMapReady(parsed.config.geo)) {
            this.clearMap();
            return false;
        }
        this.mapConfig = JSON.parse(JSON.stringify(parsed.config));
        this._flightView?.setApiKey(this._apiKey);
        const ok = await this._flightView?.setMapConfig(this.mapConfig);
        if (!ok) {
            this.clearMap();
            return false;
        }
        if (this._visible) {
            await this._flightView?.ensureMap();
            this._flightView?.resize();
        }
        return true;
    }

    clearMap() {
        this.mapConfig = null;
        this._flightView?.clear();
        this.hide();
    }

    isAvailable() {
        return !!(this.mapConfig && isGeoMapReady(this.mapConfig.geo) && this._apiKey);
    }

    isVisible() {
        return this._visible;
    }

    show() {
        if (!this.isAvailable()) return;
        this.ensureDom();
        if (!this.root) return;
        this._visible = true;
        this.root.hidden = false;
        this.root.setAttribute('aria-hidden', 'false');
        void this._flightView?.ensureMap().then(() => {
            if (!this._visible) return;
            this._flightView?.resize();
        });
    }

    hide() {
        this._visible = false;
        if (this.root) {
            this.root.hidden = true;
            this.root.setAttribute('aria-hidden', 'true');
        }
    }

    toggle() {
        if (this._visible) {
            this.hide();
            return false;
        }
        this.show();
        return true;
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: object[] }|null} state
     */
    update(state) {
        if (!state || !this._visible) return;
        this._flightView?.update(state);
    }
}
