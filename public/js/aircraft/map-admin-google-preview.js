// public/js/aircraft/map-admin-google-preview.js — Map定義の Google Maps キャリブレーションプレビュー

import { loadGoogleMapsApi } from './google-maps-loader.js';
import { isGeoMapReady, latLngToWorldXz, worldXzToLatLng } from './flight-map-geo.js';

/**
 * 管理画面用 Google Maps プレビュー（アンカー・スポット・北方向の確認）
 */
export class AdminMapGooglePreview {
    /**
     * @param {HTMLElement} mountEl
     */
    constructor(mountEl) {
        this.mountEl = mountEl;
        /** @type {google.maps.Map|null} */
        this._map = null;
        /** @type {google.maps.Marker|null} */
        this._anchorMarker = null;
        /** @type {google.maps.Marker[]} */
        this._spotMarkers = [];
        /** @type {google.maps.Polyline|null} */
        this._northLine = null;
        /** @type {string|null} */
        this._apiKey = null;
        /** @type {object|null} */
        this._config = null;
        /** @type {((lat: number, lng: number) => void)|null} */
        this.onAnchorPick = null;
    }

    /**
     * @param {string|null|undefined} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = String(apiKey || '').trim() || null;
    }

    /**
     * @param {object|null} config flight map config（northDirection, geo, spots 含む）
     */
    setConfig(config) {
        this._config = config;
        void this._syncFromConfig();
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureMap() {
        if (this._map || !this.mountEl) return;
        if (!this._apiKey) {
            this.mountEl.innerHTML = '<p class="hint">GOOGLE_MAPS_API_KEY が未設定です（.env）</p>';
            return;
        }
        const maps = await loadGoogleMapsApi(this._apiKey);
        this.mountEl.innerHTML = '';
        const center = { lat: 35.6812, lng: 139.7671 };
        this._map = new maps.Map(this.mountEl, {
            center,
            zoom: 14,
            mapTypeId: 'satellite',
            gestureHandling: 'greedy',
            streetViewControl: false,
            fullscreenControl: false,
        });
        this._map.addListener('click', (ev) => {
            const lat = ev.latLng?.lat();
            const lng = ev.latLng?.lng();
            if (lat == null || lng == null) return;
            this.onAnchorPick?.(lat, lng);
        });
    }

    async _syncFromConfig() {
        await this._ensureMap();
        if (!this._map || !this._config) return;
        const geo = this._config.geo;
        const north = this._config.northDirection || { x: 0, z: -1 };
        const maps = window.google.maps;

        if (geo?.mapType) {
            this._map.setMapTypeId(geo.mapType);
        }

        if (this._anchorMarker) this._anchorMarker.setMap(null);
        if (this._northLine) this._northLine.setMap(null);
        for (const m of this._spotMarkers) m.setMap(null);
        this._spotMarkers = [];

        if (!isGeoMapReady(geo)) {
            this._map.setCenter({ lat: 35.6812, lng: 139.7671 });
            this._map.setZoom(10);
            return;
        }

        const anchorPos = { lat: geo.anchorLat, lng: geo.anchorLng };
        this._map.setCenter(anchorPos);
        this._map.setZoom(typeof geo.zoom === 'number' ? geo.zoom + (geo.zoomOffset || 0) : 15);

        this._anchorMarker = new maps.Marker({
            map: this._map,
            position: anchorPos,
            title: 'アンカー（ワールド原点対応）',
            label: { text: 'A', color: '#fff', fontWeight: '700' },
            icon: {
                path: maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#e53935',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2,
            },
        });

        const northEnd = worldXzToLatLng(
            (geo.anchorWorldX || 0) + north.x * 200,
            (geo.anchorWorldZ || 0) + north.z * 200,
            geo,
            north
        );
        if (northEnd) {
            this._northLine = new maps.Polyline({
                map: this._map,
                path: [anchorPos, northEnd],
                strokeColor: '#ffeb3b',
                strokeWeight: 4,
                strokeOpacity: 0.9,
            });
        }

        for (const spot of this._config.spots || []) {
            if (!Number.isFinite(spot.x) || !Number.isFinite(spot.z)) continue;
            const pos = worldXzToLatLng(spot.x, spot.z, geo, north);
            if (!pos) continue;
            const marker = new maps.Marker({
                map: this._map,
                position: pos,
                title: `${spot.name} (X=${spot.x.toFixed(1)} Z=${spot.z.toFixed(1)})`,
                label: {
                    text: spot.name?.slice(0, 10) || spot.id,
                    color: '#fff',
                    fontSize: '10px',
                },
                icon: {
                    path: maps.SymbolPath.CIRCLE,
                    scale: 7,
                    fillColor: '#f57c00',
                    fillOpacity: 1,
                    strokeColor: '#fff',
                    strokeWeight: 2,
                },
            });
            this._spotMarkers.push(marker);
        }
    }

    /**
     * クリック位置の緯度経度からワールド XZ を逆算して返す（参照用）
     * @param {number} lat
     * @param {number} lng
     * @returns {{ x: number, z: number }|null}
     */
    latLngToWorld(lat, lng) {
        if (!this._config?.geo) return null;
        return latLngToWorldXz(
            lat,
            lng,
            this._config.geo,
            this._config.northDirection || { x: 0, z: -1 }
        );
    }

    dispose() {
        if (this._anchorMarker) this._anchorMarker.setMap(null);
        if (this._northLine) this._northLine.setMap(null);
        for (const m of this._spotMarkers) m.setMap(null);
        this._anchorMarker = null;
        this._northLine = null;
        this._spotMarkers = [];
        this._map = null;
        if (this.mountEl) this.mountEl.innerHTML = '';
    }
}

/**
 * client-config から Google Maps API キーを取得する
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
