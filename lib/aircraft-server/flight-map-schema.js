// lib/aircraft-server/flight-map-schema.js — 飛行ミニマップ定義の正規化・検証

import {
    computeGeoCalibrationFromSpots,
    countGeoCalibratedSpots,
    MIN_GEO_CALIBRATION_SPOTS,
} from './flight-map-geo-calibration.js';

export { MIN_GEO_CALIBRATION_SPOTS, countGeoCalibratedSpots } from './flight-map-geo-calibration.js';

const SPOT_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;
const GEO_MAP_TYPES = new Set(['roadmap', 'satellite', 'hybrid', 'terrain']);
const GEO_HEADING_MODES = new Set(['northUp', 'trackUp']);
/** カメラ高度から見える半幅（m）の係数 */
const VIEW_HALF_EXTENT_FACTOR = 0.85;

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function finiteNum(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * 北方向（XZ 平面の単位ベクトル）。デフォルトは -Z（Three.js 前方）
 * @param {unknown} raw
 * @returns {{ x: number, z: number }}
 */
export function normalizeNorthDirection(raw) {
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let x = finiteNum(d.x);
    let z = finiteNum(d.z);
    if (x == null && z == null) return { x: 0, z: -1 };
    if (x == null) x = 0;
    if (z == null) z = -1;
    const len = Math.hypot(x, z);
    if (len < 1e-9) return { x: 0, z: -1 };
    return { x: x / len, z: z / len };
}

/**
 * 設定からミニマップ正射影の半幅（m）を求める
 * @param {unknown} config
 * @returns {number}
 */
export function viewHalfExtentM(config) {
    const c = config && typeof config === 'object' ? config : {};
    const explicit = finiteNum(c.viewHalfExtentM);
    if (explicit != null && explicit > 0) return Math.min(explicit, 50000);
    const heightRaw = finiteNum(c.cameraHeightM);
    const legacyRadius = finiteNum(c.minimapRadiusM);
    const height =
        heightRaw != null && heightRaw > 0
            ? heightRaw
            : legacyRadius != null && legacyRadius > 0
              ? legacyRadius * 0.55
              : 500;
    return height * VIEW_HALF_EXTENT_FACTOR;
}

/**
 * ワールド絶対 XZ（Three.js シーングローバル）のスポット一覧（任意で lat/lng）
 * @param {unknown} raw
 * @returns {{ id: string, name: string, x: number, z: number, lat?: number, lng?: number }[]}
 */
export function normalizeSpots(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ id: string, name: string, x: number, z: number, lat?: number, lng?: number }[]} */
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!SPOT_ID_RE.test(id)) continue;
        const name =
            typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 64)
                : id;
        const x = finiteNum(item.x) ?? finiteNum(item.worldX);
        const z = finiteNum(item.z) ?? finiteNum(item.worldZ);
        if (x == null || z == null) continue;
        if (out.some((s) => s.id === id)) continue;
        /** @type {{ id: string, name: string, x: number, z: number, lat?: number, lng?: number }} */
        const spot = { id, name, x, z };
        const lat = finiteNum(item.lat);
        const lng = finiteNum(item.lng);
        if (lat != null && lng != null) {
            spot.lat = Math.max(-90, Math.min(90, lat));
            spot.lng = Math.max(-180, Math.min(180, lng));
        }
        out.push(spot);
        if (out.length >= 128) break;
    }
    return out;
}

/**
 * Google Maps 連携用のジオリファレンス設定
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeGeoConfig(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const enabled = src.enabled === true;
    const anchorWorldX = finiteNum(src.anchorWorldX) ?? 0;
    const anchorWorldZ = finiteNum(src.anchorWorldZ) ?? 0;
    const anchorLat = finiteNum(src.anchorLat);
    const anchorLng = finiteNum(src.anchorLng);
    const metersPerWorldUnitRaw = finiteNum(src.metersPerWorldUnit);
    const metersPerWorldUnit =
        metersPerWorldUnitRaw != null && metersPerWorldUnitRaw > 0
            ? Math.min(metersPerWorldUnitRaw, 100000)
            : 1;
    const offsetRaw = finiteNum(src.geoNorthOffsetDeg);
    const geoNorthOffsetDeg =
        offsetRaw != null ? Math.max(-180, Math.min(180, offsetRaw)) : 0;
    const mapTypeRaw = typeof src.mapType === 'string' ? src.mapType.trim() : 'satellite';
    const mapType = GEO_MAP_TYPES.has(mapTypeRaw) ? mapTypeRaw : 'satellite';
    const zoomRaw = finiteNum(src.zoom);
    const zoom =
        zoomRaw != null && zoomRaw >= 1 && zoomRaw <= 22 ? Math.round(zoomRaw) : 15;
    const zoomOffsetRaw = finiteNum(src.zoomOffset);
    const zoomOffset =
        zoomOffsetRaw != null ? Math.max(-8, Math.min(8, Math.round(zoomOffsetRaw))) : 0;
    const headingModeRaw = typeof src.headingMode === 'string' ? src.headingMode.trim() : 'trackUp';
    const headingMode = GEO_HEADING_MODES.has(headingModeRaw) ? headingModeRaw : 'trackUp';
    const calCountRaw = finiteNum(src.calibrationSpotCount);
    const calResidualRaw = finiteNum(src.calibrationResidualM);
    return {
        enabled,
        anchorWorldX,
        anchorWorldZ,
        anchorLat: anchorLat != null ? Math.max(-90, Math.min(90, anchorLat)) : null,
        anchorLng: anchorLng != null ? Math.max(-180, Math.min(180, anchorLng)) : null,
        metersPerWorldUnit,
        geoNorthOffsetDeg,
        mapType,
        zoom,
        zoomOffset,
        headingMode,
        ...(calCountRaw != null ? { calibrationSpotCount: Math.round(calCountRaw) } : {}),
        ...(calResidualRaw != null ? { calibrationResidualM: calResidualRaw } : {}),
    };
}

/**
 * geo が有効かつアンカー緯度経度が揃っているか
 * @param {unknown} geo
 * @returns {boolean}
 */
export function isGeoMapReady(geo) {
    const g = geo && typeof geo === 'object' ? geo : null;
    if (!g?.enabled) return false;
    return (
        typeof g.anchorLat === 'number'
        && Number.isFinite(g.anchorLat)
        && typeof g.anchorLng === 'number'
        && Number.isFinite(g.anchorLng)
    );
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function parseFlightMapConfig(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const northDirection = normalizeNorthDirection(src.northDirection);
    const heightRaw = finiteNum(src.cameraHeightM);
    const legacyRadius = finiteNum(src.minimapRadiusM);
    const cameraHeightM =
        heightRaw != null && heightRaw > 0
            ? Math.min(heightRaw, 20000)
            : legacyRadius != null && legacyRadius > 0
              ? Math.min(legacyRadius * 0.55, 20000)
              : 500;
    const groundRefY = finiteNum(src.groundRefY) ?? 0;
    const offsetRaw = finiteNum(src.aircraftIconOffsetDeg);
    const aircraftIconOffsetDeg =
        offsetRaw != null ? Math.max(-180, Math.min(180, offsetRaw)) : 0;
    const spots = normalizeSpots(src.spots);
    let geo = normalizeGeoConfig(src.geo);
    if (
        geo.enabled
        && countGeoCalibratedSpots(spots) >= MIN_GEO_CALIBRATION_SPOTS
    ) {
        const calibrated = computeGeoCalibrationFromSpots(spots, northDirection, geo);
        if (calibrated.ok) {
            geo = normalizeGeoConfig(calibrated.geo);
        }
    }
    const config = {
        northDirection,
        cameraHeightM,
        groundRefY,
        aircraftIconOffsetDeg,
        spots,
        geo,
    };
    const s = JSON.stringify(config);
    if (s.length > 64000) return { ok: false, error: 'flight map config too large' };
    return { ok: true, config };
}

/**
 * 空または不正な入力時と同じデフォルト設定
 * @returns {object}
 */
export function defaultFlightMapConfig() {
    return parseFlightMapConfig(null).config;
}
