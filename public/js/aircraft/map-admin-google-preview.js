// public/js/aircraft/map-admin-google-preview.js — 俯瞰メタバース下層の Google Map オーバーレイ

import { loadGoogleMapsApi } from './google-maps-loader.js';
import { isGeoMapReady, spotHasGeo, worldXzToLatLng } from './flight-map-geo.js';

const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const OVERLAY_OPACITY = 0.42;

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
 * 管理画面用 Google Maps（薄い下層オーバーレイ）
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
        this._definedMarkers = [];
        /** @type {google.maps.Marker[]} */
        this._predictedMarkers = [];
        /** @type {google.maps.Polyline[]} */
        this._residualLines = [];
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
        this._overlayVisible = false;
        /** @type {boolean} */
        this._overlayMode = false;
        /** @type {boolean} */
        this._mapInteractive = false;
        /** @type {boolean} */
        this._suppressViewSync = false;
        /** @type {boolean} */
        this._initialFitDone = false;
        if (mountEl) {
            mountEl.style.opacity = String(OVERLAY_OPACITY);
        }
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
     * @param {{ overlayMode?: boolean }} [opts]
     */
    setConfig(config, opts = {}) {
        this._config = config;
        this._overlayMode = opts.overlayMode === true;
        void this._syncFromConfig({ preserveView: true });
    }

    /**
     * オーバーレイの表示/非表示
     * @param {boolean} visible
     */
    setOverlayVisible(visible) {
        this._overlayVisible = visible;
        if (this.mountEl) {
            this.mountEl.style.visibility = visible ? 'visible' : 'hidden';
            this.mountEl.style.pointerEvents = visible && this._mapInteractive ? 'auto' : 'none';
        }
    }

    /**
     * 地図操作（パン・回転・ズーム）の有効化
     * @param {boolean} interactive
     */
    setMapInteractive(interactive) {
        this._mapInteractive = interactive;
        if (this.mountEl) {
            this.mountEl.style.pointerEvents =
                interactive && this._overlayVisible ? 'auto' : 'none';
        }
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
     * 初回オーバーレイ表示時の地図位置合わせ
     * @param {object|null} config
     */
    async initialFitForOverlay(config) {
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
        const geoPts = spots.filter((s) => spotHasGeo(s));
        const maps = window.google?.maps;
        if (!maps) return;
        if (geoPts.length >= 1) {
            const bounds = new maps.LatLngBounds();
            for (const s of geoPts) bounds.extend({ lat: s.lat, lng: s.lng });
            this._suppressViewSync = true;
            this._map.fitBounds(bounds, 40);
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
            gestureHandling: 'none',
            draggable: false,
            scrollwheel: false,
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

    _clearMarkers() {
        for (const m of [...this._definedMarkers, ...this._predictedMarkers]) m.setMap(null);
        for (const l of this._residualLines) l.setMap(null);
        this._definedMarkers = [];
        this._predictedMarkers = [];
        this._residualLines = [];
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

        this._clearMarkers();

        if (!this._overlayMode) {
            /** @type {google.maps.LatLngLiteral[]} */
            const boundsPts = [];
            const geoReady = isGeoMapReady(geo);
            for (const spot of spots) {
                if (!spotHasGeo(spot)) continue;
                const defined = { lat: spot.lat, lng: spot.lng };
                boundsPts.push(defined);
                const marker = new maps.Marker({
                    map: this._map,
                    position: defined,
                    title: `${spot.name}（登録座標）`,
                    icon: {
                        path: maps.SymbolPath.CIRCLE,
                        scale: 7,
                        fillColor: '#f57c00',
                        fillOpacity: 0.85,
                        strokeColor: '#fff',
                        strokeWeight: 2,
                    },
                    zIndex: 60,
                });
                this._definedMarkers.push(marker);
                if (geoReady) {
                    const predicted = worldXzToLatLng(spot.x, spot.z, geo, north);
                    if (!predicted) continue;
                    boundsPts.push(predicted);
                    const predMarker = new maps.Marker({
                        map: this._map,
                        position: predicted,
                        title: `${spot.name}（補正予測）`,
                        icon: {
                            path: maps.SymbolPath.CIRCLE,
                            scale: 5,
                            fillColor: '#43a047',
                            fillOpacity: 0.75,
                            strokeColor: '#fff',
                            strokeWeight: 2,
                        },
                        zIndex: 55,
                    });
                    this._predictedMarkers.push(predMarker);
                    const line = new maps.Polyline({
                        map: this._map,
                        path: [defined, predicted],
                        strokeColor: '#ff5252',
                        strokeOpacity: 0.7,
                        strokeWeight: 2,
                    });
                    this._residualLines.push(line);
                }
            }
            if (!opts.preserveView && boundsPts.length >= 1) {
                const bounds = new maps.LatLngBounds();
                for (const p of boundsPts) bounds.extend(p);
                this._suppressViewSync = true;
                this._map.fitBounds(bounds, 48);
                this._suppressViewSync = false;
            }
            return;
        }

        // オーバーレイモード: 地図座標設定用に登録済みマーカーのみ薄く表示
        for (const spot of spots) {
            if (!spotHasGeo(spot)) continue;
            const marker = new maps.Marker({
                map: this._map,
                position: { lat: spot.lat, lng: spot.lng },
                title: spot.name,
                opacity: 0.65,
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 6,
                    fillColor: spot.id === this._selectedSpotId ? '#1565c0' : '#f57c00',
                    fillOpacity: 0.8,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
                zIndex: spot.id === this._selectedSpotId ? 70 : 60,
            });
            this._definedMarkers.push(marker);
        }
    }

    dispose() {
        this._clearMarkers();
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
