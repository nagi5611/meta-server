// public/js/aircraft/map-admin-google-preview.js — 管理画面用 Google Maps 2D（スタンドアロン）

import { loadGoogleMapsApi } from './google-maps-loader.js';
import { isGeoMapReady, spotHasGeo, worldXzToLatLng } from './flight-map-geo.js';

const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const TRIANGLE_STROKE = '#e53935';
const TRIANGLE_FILL = 'rgba(229, 57, 53, 0.15)';

/**
 * @param {object|null|undefined} geo
 * @returns {{ lat: number, lng: number, zoom: number, heading: number }|null}
 */
function readSavedOverlayView(geo) {
    if (!geo || typeof geo !== 'object') return null;
    const lat = typeof geo.overlayCenterLat === 'number' ? geo.overlayCenterLat : geo.anchorLat;
    const lng = typeof geo.overlayCenterLng === 'number' ? geo.overlayCenterLng : geo.anchorLng;
    const zoom =
        typeof geo.overlayZoom === 'number' && geo.overlayZoom >= 1
            ? geo.overlayZoom
            : typeof geo.zoom === 'number'
              ? geo.zoom
              : null;
    const heading =
        typeof geo.overlayHeading === 'number' && Number.isFinite(geo.overlayHeading)
            ? geo.overlayHeading
            : 0;
    if (lat == null || lng == null || zoom == null) return null;
    return { lat, lng, zoom, heading };
}

/**
 * スポットの地図上位置を決定する（補正済みは投影、未補正は手動 lat/lng）
 * @param {object} spot
 * @param {object|null|undefined} geo
 * @param {{ x: number, z: number }} north
 * @returns {{ lat: number, lng: number }|null}
 */
function spotMapPosition(spot, geo, north) {
    if (isGeoMapReady(geo) && Number.isFinite(spot.x) && Number.isFinite(spot.z)) {
        const projected = worldXzToLatLng(spot.x, spot.z, geo, north);
        if (projected) return projected;
    }
    if (spotHasGeo(spot)) {
        return { lat: spot.lat, lng: spot.lng };
    }
    return null;
}

/**
 * 管理画面用 Google Maps（タブ内スタンドアロン）
 */
export class AdminMapGooglePreview {
    /**
     * @param {HTMLElement} mountEl
     */
    constructor(mountEl) {
        this.mountEl = mountEl;
        /** @type {google.maps.Map|null} */
        this._map = null;
        /** @type {google.maps.Marker[]} */
        this._spotMarkers = [];
        /** @type {google.maps.Polygon|null} */
        this._trianglePolygon = null;
        /** @type {string|null} */
        this._apiKey = null;
        /** @type {object|null} */
        this._config = null;
        /** @type {string|null} */
        this._selectedSpotId = null;
        /** @type {((lat: number, lng: number) => void)|null} */
        this.onSpotGeoPick = null;
        /** @type {((view: object) => void)|null} */
        this.onMapViewChange = null;
        /** @type {boolean} */
        this._pickingEnabled = false;
        /** @type {boolean} */
        this._mapInteractive = true;
        /** @type {boolean} */
        this._suppressViewSync = false;
        /** @type {boolean} */
        this._initialFitDone = false;
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
    }

    /**
     * @param {string|null} spotId
     */
    setSelectedSpotId(spotId) {
        this._selectedSpotId = spotId;
    }

    /**
     * @param {object|null} config
     */
    setConfig(config) {
        this._config = config;
        void this._syncFromConfig({ preserveView: true });
    }

    /**
     * 地図操作（パン・回転・ズーム）の有効化
     * @param {boolean} interactive
     */
    setMapInteractive(interactive) {
        this._mapInteractive = interactive;
        if (this._map) {
            this._map.setOptions({
                gestureHandling: interactive ? 'greedy' : 'none',
                draggable: interactive,
                scrollwheel: interactive,
                disableDoubleClickZoom: !interactive,
            });
        }
    }

    /**
     * クリックで緯度経度を取得
     * @param {boolean} enabled
     */
    setPickingEnabled(enabled) {
        this._pickingEnabled = enabled;
    }

    /**
     * タブ表示時の初回フィット
     * @param {object|null} config
     */
    async initialFit(config) {
        await this._ensureMap();
        if (!this._map || !config) return;
        const saved = readSavedOverlayView(config.geo);
        if (saved) {
            this._applyView(saved);
            this._initialFitDone = true;
            return;
        }
        if (this._initialFitDone) return;
        const spots = config.spots || [];
        const north = config.northDirection || { x: 0, z: -1 };
        const geo = config.geo;
        const maps = window.google?.maps;
        if (!maps) return;
        /** @type {google.maps.LatLngLiteral[]} */
        const boundsPts = [];
        for (const spot of spots.slice(0, 3)) {
            const pos = spotMapPosition(spot, geo, north);
            if (pos) boundsPts.push(pos);
        }
        if (boundsPts.length >= 1) {
            const bounds = new maps.LatLngBounds();
            for (const p of boundsPts) bounds.extend(p);
            this._suppressViewSync = true;
            this._map.fitBounds(bounds, 48);
            this._suppressViewSync = false;
            this._emitMapView();
        } else {
            this._applyView({ ...DEFAULT_CENTER, zoom: 15, heading: 0 });
        }
        this._initialFitDone = true;
    }

    /**
     * 保存済みビューを適用
     * @param {object|null|undefined} geo
     */
    applySavedView(geo) {
        const saved = readSavedOverlayView(geo);
        if (saved) this._applyView(saved);
    }

    /**
     * 地図の resize を発火する
     */
    resize() {
        if (this._map) {
            window.google?.maps?.event?.trigger(this._map, 'resize');
        }
    }

    /**
     * @returns {object|null}
     */
    getMapView() {
        if (!this._map) return null;
        const c = this._map.getCenter();
        if (!c) return null;
        return {
            overlayCenterLat: c.lat(),
            overlayCenterLng: c.lng(),
            overlayZoom: this._map.getZoom() ?? 15,
            overlayHeading: this._map.getHeading() ?? 0,
        };
    }

    async _ensureMap() {
        if (this._map || !this.mountEl) return;
        if (!this._apiKey) {
            this.mountEl.innerHTML = '<p class="hint">GOOGLE_MAPS_API_KEY が未設定です（.env）</p>';
            return;
        }
        const maps = await loadGoogleMapsApi(this._apiKey);
        this.mountEl.innerHTML = '';
        this._map = new maps.Map(this.mountEl, {
            center: DEFAULT_CENTER,
            zoom: 15,
            mapTypeId: 'satellite',
            tilt: 0,
            heading: 0,
            gestureHandling: 'greedy',
            draggable: true,
            scrollwheel: true,
            rotateControl: true,
            streetViewControl: false,
            fullscreenControl: false,
            mapTypeControl: false,
            keyboardShortcuts: false,
        });
        this._map.addListener('click', (ev) => {
            if (!this._pickingEnabled) return;
            const lat = ev.latLng?.lat();
            const lng = ev.latLng?.lng();
            if (lat == null || lng == null) return;
            this.onSpotGeoPick?.(lat, lng);
        });
        const emitIfReady = () => {
            if (this._suppressViewSync) return;
            this._emitMapView();
        };
        this._map.addListener('idle', emitIfReady);
        this.setMapInteractive(this._mapInteractive);
    }

    /**
     * @param {{ lat: number, lng: number, zoom: number, heading: number }} view
     */
    _applyView(view) {
        if (!this._map) return;
        this._suppressViewSync = true;
        this._map.setCenter({ lat: view.lat, lng: view.lng });
        this._map.setZoom(view.zoom);
        this._map.setHeading(view.heading);
        this._map.setTilt(0);
        this._suppressViewSync = false;
    }

    _emitMapView() {
        const view = this.getMapView();
        if (view) this.onMapViewChange?.(view);
    }

    _clearOverlays() {
        for (const m of this._spotMarkers) m.setMap(null);
        this._spotMarkers = [];
        if (this._trianglePolygon) {
            this._trianglePolygon.setMap(null);
            this._trianglePolygon = null;
        }
    }

    /**
     * @param {{ preserveView?: boolean }} [opts]
     */
    async _syncFromConfig(opts = {}) {
        await this._ensureMap();
        if (!this._map || !this._config) return;
        const geo = this._config.geo;
        const north = this._config.northDirection || { x: 0, z: -1 };
        const maps = window.google.maps;
        const spots = this._config.spots || [];

        if (geo?.mapType) {
            this._map.setMapTypeId(geo.mapType);
        }

        this._clearOverlays();

        /** @type {google.maps.LatLngLiteral[]} */
        const trianglePath = [];
        for (let i = 0; i < Math.min(3, spots.length); i++) {
            const spot = spots[i];
            const pos = spotMapPosition(spot, geo, north);
            if (pos) trianglePath.push(pos);
            const markerPos = pos || (spotHasGeo(spot) ? { lat: spot.lat, lng: spot.lng } : null);
            if (!markerPos) continue;
            const label = i < 3 ? `A${i + 1}` : spot.name?.slice(0, 8) || spot.id;
            const marker = new maps.Marker({
                map: this._map,
                position: markerPos,
                title: spot.name,
                label: {
                    text: label,
                    color: '#fff',
                    fontSize: '11px',
                    fontWeight: '700',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: spot.id === this._selectedSpotId ? 8 : 7,
                    fillColor: spot.id === this._selectedSpotId ? '#1565c0' : '#f57c00',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: spot.id === this._selectedSpotId ? 70 : 60,
            });
            this._spotMarkers.push(marker);
        }

        if (trianglePath.length >= 3) {
            this._trianglePolygon = new maps.Polygon({
                map: this._map,
                paths: trianglePath,
                strokeColor: TRIANGLE_STROKE,
                strokeOpacity: 0.95,
                strokeWeight: 3,
                fillColor: TRIANGLE_FILL,
                fillOpacity: 0.35,
                zIndex: 40,
            });
        }

        for (let i = 3; i < spots.length; i++) {
            const spot = spots[i];
            const pos = spotMapPosition(spot, geo, north);
            if (!pos) continue;
            const marker = new maps.Marker({
                map: this._map,
                position: pos,
                title: spot.name,
                label: {
                    text: spot.name?.slice(0, 8) || spot.id,
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: '600',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 6,
                    fillColor: '#f57c00',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: 55,
            });
            this._spotMarkers.push(marker);
        }

        if (!opts.preserveView && trianglePath.length >= 1 && !this._initialFitDone) {
            const bounds = new maps.LatLngBounds();
            for (const p of trianglePath) bounds.extend(p);
            this._suppressViewSync = true;
            this._map.fitBounds(bounds, 48);
            this._suppressViewSync = false;
        }
    }

    dispose() {
        this._clearOverlays();
        this._map = null;
        if (this.mountEl) this.mountEl.innerHTML = '';
    }
}

/**
 * @returns {Promise<string|null>}
 */
export async function fetchGoogleMapsApiKey() {
    try {
        const res = await fetch('/api/client-config', { credentials: 'include' });
        if (!res.ok) return null;
        const j = await res.json();
        const key = String(j.googleMapsApiKey || '').trim();
        return key || null;
    } catch {
        return null;
    }
}
