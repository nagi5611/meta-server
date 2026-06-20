// addons/aircraft/client/google-map-flight-view.js — 操縦中 Google Maps 描画の共通ロジック

import { isGeoMapReady } from '../../../lib/aircraft-server/flight-map-schema.js';
import {
    halfExtentToGoogleZoom,
    viewHalfExtentM,
    worldXzToLatLng,
    worldYawToGeoBearing,
} from './flight-map-coords.js';
import { loadGoogleMapsApi } from './google-maps-loader.js';

const TRIANGLE_STROKE = '#e53935';
const TRIANGLE_FILL = 'rgba(229, 57, 53, 0.12)';

/**
 * 操縦 HUD 用 Google Maps ビュー（ミニマップ円形 / Mキー全画面）
 */
export class GoogleMapFlightView {
    /**
     * @param {HTMLElement} mountEl
     * @param {{ interactive?: boolean, showZoomControl?: boolean }} [opts]
     */
    constructor(mountEl, opts = {}) {
        this.mountEl = mountEl;
        this._interactive = opts.interactive !== false;
        this._showZoomControl = opts.showZoomControl === true;
        /** @type {google.maps.Map|null} */
        this._map = null;
        /** @type {google.maps.Marker|null} */
        this._aircraftMarker = null;
        /** @type {google.maps.Marker[]} */
        this._spotMarkers = [];
        /** @type {google.maps.Marker[]} */
        this._otherMarkers = [];
        /** @type {google.maps.Polygon|null} */
        this._trianglePolygon = null;
        /** @type {string|null} */
        this._apiKey = null;
        /** @type {object|null} */
        this.mapConfig = null;
        /** @type {Promise<boolean>|null} */
        this._initPromise = null;
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
    }

    hasApiKey() {
        return !!this._apiKey;
    }

    /**
     * @param {object|null} mapConfig
     * @returns {Promise<boolean>}
     */
    async setMapConfig(mapConfig) {
        if (!mapConfig?.northDirection || !isGeoMapReady(mapConfig.geo)) {
            this.clear();
            return false;
        }
        this.mapConfig = JSON.parse(JSON.stringify(mapConfig));
        if (this._map) {
            this._syncMapType();
            this.rebuildStaticOverlays();
        }
        return true;
    }

    clear() {
        this.mapConfig = null;
        this._disposeOverlays();
        if (this._map) {
            this._map = null;
        }
        if (this.mountEl) this.mountEl.innerHTML = '';
    }

    isReady() {
        return !!(this.mapConfig && isGeoMapReady(this.mapConfig.geo) && this._apiKey);
    }

    /**
     * @returns {Promise<boolean>}
     */
    async ensureMap() {
        if (!this.isReady() || !this.mountEl) return false;
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
                this.mountEl.innerHTML = '';
                this._map = new maps.Map(this.mountEl, {
                    center: anchor,
                    zoom: this._resolveZoom(anchor.lat),
                    mapTypeId: geo.mapType || 'satellite',
                    disableDefaultUI: true,
                    zoomControl: this._showZoomControl,
                    rotateControl: false,
                    streetViewControl: false,
                    fullscreenControl: false,
                    gestureHandling: this._interactive ? 'greedy' : 'none',
                    draggable: this._interactive,
                    scrollwheel: this._interactive,
                    clickableIcons: false,
                });
                this._aircraftMarker = new maps.Marker({
                    map: this._map,
                    position: anchor,
                    icon: this._aircraftSymbolIcon(0),
                    zIndex: 1000,
                });
                this.rebuildStaticOverlays();
                return true;
            } catch {
                return false;
            } finally {
                this._initPromise = null;
            }
        })();
        return this._initPromise;
    }

    resize() {
        if (this._map) {
            window.google?.maps?.event?.trigger(this._map, 'resize');
        }
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

    _syncMapType() {
        if (!this._map || !this.mapConfig?.geo) return;
        this._map.setMapTypeId(this.mapConfig.geo.mapType || 'satellite');
    }

    _disposeOverlays() {
        for (const m of [...this._spotMarkers, ...this._otherMarkers]) {
            m.setMap(null);
        }
        this._spotMarkers = [];
        this._otherMarkers = [];
        if (this._trianglePolygon) {
            this._trianglePolygon.setMap(null);
            this._trianglePolygon = null;
        }
        if (this._aircraftMarker) {
            this._aircraftMarker.setMap(null);
            this._aircraftMarker = null;
        }
    }

    rebuildStaticOverlays() {
        if (!this._map || !this.mapConfig) return;
        const maps = window.google.maps;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const geo = this.mapConfig.geo;
        const spots = this.mapConfig.spots || [];

        for (const m of this._spotMarkers) m.setMap(null);
        this._spotMarkers = [];
        if (this._trianglePolygon) {
            this._trianglePolygon.setMap(null);
            this._trianglePolygon = null;
        }

        /** @type {google.maps.LatLngLiteral[]} */
        const trianglePath = [];
        for (let i = 0; i < spots.length; i++) {
            const spot = spots[i];
            if (!Number.isFinite(spot.x) || !Number.isFinite(spot.z)) continue;
            const pos = worldXzToLatLng(spot.x, spot.z, geo, north);
            if (!pos) continue;
            if (i < 3) trianglePath.push(pos);
            const marker = new maps.Marker({
                map: this._map,
                position: pos,
                title: spot.name,
                label: {
                    text: i < 3 ? `A${i + 1}` : spot.name?.slice(0, 10) || spot.id,
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: '600',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: i < 3 ? 7 : 6,
                    fillColor: '#f57c00',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: 50,
            });
            this._spotMarkers.push(marker);
        }

        if (trianglePath.length >= 3) {
            this._trianglePolygon = new maps.Polygon({
                map: this._map,
                paths: trianglePath,
                strokeColor: TRIANGLE_STROKE,
                strokeOpacity: 0.9,
                strokeWeight: 2,
                fillColor: TRIANGLE_FILL,
                fillOpacity: 0.3,
                zIndex: 40,
            });
        }
    }

    /**
     * @param {{ worldX: number, worldZ: number, yawDeg: number, otherAircraft?: { label: string, x: number, z: number }[] }|null} state
     */
    update(state) {
        if (!state || !this._map || !this.mapConfig) return;
        const north = this.mapConfig.northDirection || { x: 0, z: -1 };
        const geo = this.mapConfig.geo;
        const pos = worldXzToLatLng(state.worldX, state.worldZ, geo, north);
        if (!pos) return;

        const bearing = worldYawToGeoBearing(
            state.yawDeg,
            north,
            geo.geoNorthOffsetDeg || 0,
            this.mapConfig.aircraftIconOffsetDeg || 0
        );

        if (this._aircraftMarker) {
            this._aircraftMarker.setPosition(pos);
            this._aircraftMarker.setIcon(this._aircraftSymbolIcon(bearing));
        }

        this._map.setCenter(pos);
        const zoom = this._resolveZoom(pos.lat);
        if (this._map.getZoom() !== zoom) {
            this._map.setZoom(zoom);
        }

        const headingMode = geo.headingMode || 'trackUp';
        if (headingMode === 'trackUp' && this._map.setHeading) {
            this._map.setHeading(bearing);
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

    /**
     * @param {number} delta
     * @returns {boolean}
     */
    adjustZoomOffset(delta) {
        if (!this.mapConfig?.geo) return false;
        const cur = this.mapConfig.geo.zoomOffset ?? 0;
        const next = Math.max(-8, Math.min(8, cur + delta));
        if (next === cur) return false;
        this.mapConfig.geo.zoomOffset = next;
        return true;
    }
}
