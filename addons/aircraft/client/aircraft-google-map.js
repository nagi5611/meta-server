// addons/aircraft/client/aircraft-google-map.js — 操縦中の Google Maps 2D オーバーレイ（M キー）

import { parseFlightMapConfig, isGeoMapReady } from '../../../lib/aircraft-server/flight-map-schema.js';
import {
    halfExtentToGoogleZoom,
    viewHalfExtentM,
    worldXzToLatLng,
    worldYawToGeoBearing,
} from './flight-map-coords.js';
import { loadGoogleMapsApi } from './google-maps-loader.js';

/**
 * 飛行中に M キーで表示する Google Maps 2D マップ
 */
export default class AircraftGoogleMap {
    constructor() {
        /** @type {HTMLElement|null} */
        this.root = null;
        /** @type {HTMLElement|null} */
        this.mapMount = null;
        /** @type {google.maps.Map|null} */
        this._map = null;
        /** @type {google.maps.Marker|null} */
        this._aircraftMarker = null;
        /** @type {google.maps.Marker[]} */
        this._spotMarkers = [];
        /** @type {google.maps.Marker[]} */
        this._otherMarkers = [];
        /** @type {object|null} */
        this.mapConfig = null;
        /** @type {string|null} */
        this._apiKey = null;
        /** @type {boolean} */
        this._visible = false;
        /** @type {Promise<boolean>|null} */
        this._initPromise = null;
    }

    /**
     * DOM を初期化する
     */
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
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
    }

    /**
     * @returns {boolean}
     */
    hasApiKey() {
        return !!this._apiKey;
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
        if (this._visible) {
            await this._ensureMapInstance();
            this._syncMapTypeAndZoom();
            this._rebuildStaticMarkers();
        }
        return true;
    }

    clearMap() {
        this.mapConfig = null;
        this._disposeMarkers();
        if (this._map) {
            this._map = null;
        }
        if (this.mapMount) this.mapMount.innerHTML = '';
        this.hide();
    }

    /**
     * Google Maps が利用可能か
     * @returns {boolean}
     */
    isAvailable() {
        return !!(this.mapConfig && isGeoMapReady(this.mapConfig.geo) && this._apiKey);
    }

    /**
     * @returns {boolean}
     */
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
        void this._ensureMapInstance().then(() => {
            if (!this._visible) return;
            this._syncMapTypeAndZoom();
            this._rebuildStaticMarkers();
            if (this._map) {
                window.google.maps.event.trigger(this._map, 'resize');
            }
        });
    }

    hide() {
        this._visible = false;
        if (this.root) {
            this.root.hidden = true;
            this.root.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * 表示状態を切り替える
     * @returns {boolean} 切り替え後の表示状態
     */
    toggle() {
        if (this._visible) {
            this.hide();
            return false;
        }
        this.show();
        return true;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async _ensureMapInstance() {
        if (!this.isAvailable() || !this.mapMount) return false;
        if (this._map) return true;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            try {
                const maps = await loadGoogleMapsApi(/** @type {string} */ (this._apiKey));
                const geo = this.mapConfig.geo;
                const north = this.mapConfig.northDirection || { x: 0, z: -1 };
                const anchor = worldXzToLatLng(
                    geo.anchorWorldX || 0,
                    geo.anchorWorldZ || 0,
                    geo,
                    north
                );
                if (!anchor) return false;
                this._map = new maps.Map(this.mapMount, {
                    center: anchor,
                    zoom: this._resolveZoom(anchor.lat),
                    mapTypeId: geo.mapType || 'satellite',
                    disableDefaultUI: true,
                    zoomControl: true,
                    rotateControl: false,
                    streetViewControl: false,
                    fullscreenControl: false,
                    gestureHandling: 'greedy',
                    clickableIcons: false,
                });
                this._aircraftMarker = new maps.Marker({
                    map: this._map,
                    position: anchor,
                    icon: this._aircraftSymbolIcon(0),
                    zIndex: 1000,
                });
                return true;
            } catch {
                return false;
            } finally {
                this._initPromise = null;
            }
        })();
        return this._initPromise;
    }

    /**
     * @param {number} bearingDeg
     * @returns {google.maps.Symbol}
     */
    _aircraftSymbolIcon(bearingDeg) {
        const maps = window.google.maps;
        return {
            path: maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: '#ffffff',
            fillOpacity: 1,
            strokeColor: '#1565c0',
            strokeWeight: 2,
            rotation: bearingDeg,
        };
    }

    /**
     * @param {number} lat
     * @returns {number}
     */
    _resolveZoom(lat) {
        const geo = this.mapConfig?.geo;
        if (!geo) return 15;
        const base = typeof geo.zoom === 'number' ? geo.zoom : 15;
        const offset = typeof geo.zoomOffset === 'number' ? geo.zoomOffset : 0;
        if (geo.zoom != null) return Math.max(1, Math.min(22, base + offset));
        const half = viewHalfExtentM(this.mapConfig);
        return halfExtentToGoogleZoom(half, lat) + offset;
    }

    _syncMapTypeAndZoom() {
        if (!this._map || !this.mapConfig?.geo) return;
        const geo = this.mapConfig.geo;
        this._map.setMapTypeId(geo.mapType || 'satellite');
    }

    _disposeMarkers() {
        for (const m of [...this._spotMarkers, ...this._otherMarkers]) {
            m.setMap(null);
        }
        this._spotMarkers = [];
        this._otherMarkers = [];
        if (this._aircraftMarker) {
            this._aircraftMarker.setMap(null);
            this._aircraftMarker = null;
        }
    }

    _rebuildStaticMarkers() {
        if (!this._map || !this.mapConfig) return;
        const maps = window.google.maps;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const geo = this.mapConfig.geo;

        for (const m of this._spotMarkers) m.setMap(null);
        this._spotMarkers = [];
        for (const spot of this.mapConfig.spots || []) {
            if (!Number.isFinite(spot.x) || !Number.isFinite(spot.z)) continue;
            const pos = worldXzToLatLng(spot.x, spot.z, geo, north);
            if (!pos) continue;
            const marker = new maps.Marker({
                map: this._map,
                position: pos,
                title: spot.name,
                label: {
                    text: spot.name?.slice(0, 12) || spot.id,
                    color: '#fff',
                    fontSize: '11px',
                    fontWeight: '600',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 7,
                    fillColor: '#f57c00',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: 50,
            });
            this._spotMarkers.push(marker);
        }
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: { label: string, x: number, z: number }[] }|null} state
     */
    update(state) {
        if (!state || !this._visible || !this._map || !this.mapConfig) return;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const geo = this.mapConfig.geo;
        const pos = worldXzToLatLng(state.worldX, state.worldZ, geo, north);
        if (!pos) return;

        if (this._aircraftMarker) {
            this._aircraftMarker.setPosition(pos);
            const bearing = worldYawToGeoBearing(
                state.yawDeg,
                north,
                geo.geoNorthOffsetDeg || 0,
                this.mapConfig.aircraftIconOffsetDeg || 0
            );
            this._aircraftMarker.setIcon(this._aircraftSymbolIcon(bearing));
        }

        this._map.setCenter(pos);
        const zoom = this._resolveZoom(pos.lat);
        if (this._map.getZoom() !== zoom) {
            this._map.setZoom(zoom);
        }

        const headingMode = geo.headingMode || 'trackUp';
        if (headingMode === 'trackUp') {
            const bearing = worldYawToGeoBearing(
                state.yawDeg,
                north,
                geo.geoNorthOffsetDeg || 0,
                this.mapConfig.aircraftIconOffsetDeg || 0
            );
            this._map.setHeading?.(bearing);
        } else if (this._map.setHeading) {
            this._map.setHeading(0);
        }

        for (const m of this._otherMarkers) m.setMap(null);
        this._otherMarkers = [];
        const others = state.otherAircraft || [];
        const maps = window.google.maps;
        for (const ac of others) {
            if (!Number.isFinite(ac.x) || !Number.isFinite(ac.z)) continue;
            const otherPos = worldXzToLatLng(ac.x, ac.z, geo, north);
            if (!otherPos) continue;
            const marker = new maps.Marker({
                map: this._map,
                position: otherPos,
                title: ac.label,
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 6,
                    fillColor: '#42a5f5',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: 80,
            });
            this._otherMarkers.push(marker);
        }
    }
}
