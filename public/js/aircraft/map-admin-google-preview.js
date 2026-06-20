// public/js/aircraft/map-admin-google-preview.js — Map定義の Google Maps キャリブレーションプレビュー

import { loadGoogleMapsApi } from './google-maps-loader.js';
import { isGeoMapReady, spotHasGeo, worldXzToLatLng } from './flight-map-geo.js';

/**
 * 管理画面用 Google Maps プレビュー（スポット対応・補正確認）
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
        /** @type {((lat: number, lng: number) => void)|null} */
        this.onSpotGeoPick = null;
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
    }

    /**
     * @param {object|null} config
     */
    setConfig(config) {
        this._config = config;
        void this._syncFromConfig();
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
            center: { lat: 35.6812, lng: 139.7671 },
            zoom: 10,
            mapTypeId: 'satellite',
            gestureHandling: 'greedy',
            streetViewControl: false,
            fullscreenControl: false,
        });
        this._map.addListener('click', (ev) => {
            const lat = ev.latLng?.lat();
            const lng = ev.latLng?.lng();
            if (lat == null || lng == null) return;
            this.onSpotGeoPick?.(lat, lng);
        });
    }

    _clearMarkers() {
        for (const m of [...this._definedMarkers, ...this._predictedMarkers]) m.setMap(null);
        for (const l of this._residualLines) l.setMap(null);
        this._definedMarkers = [];
        this._predictedMarkers = [];
        this._residualLines = [];
    }

    async _syncFromConfig() {
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
                label: {
                    text: spot.name?.slice(0, 8) || spot.id,
                    color: '#fff',
                    fontSize: '10px',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 8,
                    fillColor: '#f57c00',
                    fillOpacity: 1,
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
                        scale: 6,
                        fillColor: '#43a047',
                        fillOpacity: 0.9,
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
                    strokeOpacity: 0.85,
                    strokeWeight: 2,
                });
                this._residualLines.push(line);
            }
        }

        if (boundsPts.length >= 1) {
            const bounds = new maps.LatLngBounds();
            for (const p of boundsPts) bounds.extend(p);
            this._map.fitBounds(bounds, 48);
        } else {
            this._map.setCenter({ lat: 35.6812, lng: 139.7671 });
            this._map.setZoom(10);
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
