// lib/aircraft-server/flight-map-geo-calibration.js — スポット対応からジオリファレンスを最小二乗で算出

export const MIN_GEO_CALIBRATION_SPOTS = 3;
const METERS_PER_DEG_LAT = 111320;

/**
 * @param {{ x: number, z: number }} north
 * @returns {{ x: number, z: number }}
 */
export function eastFromNorth(north) {
    return { x: north.z, z: -north.x };
}

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
 * 緯度経度付きスポットの件数
 * @param {unknown[]} spots
 * @returns {number}
 */
export function countGeoCalibratedSpots(spots) {
    if (!Array.isArray(spots)) return 0;
    return spots.filter((s) => spotHasGeo(s)).length;
}

/**
 * @param {unknown} spot
 * @returns {boolean}
 */
export function spotHasGeo(spot) {
    if (!spot || typeof spot !== 'object') return false;
    const lat = finiteNum(spot.lat);
    const lng = finiteNum(spot.lng);
    const x = finiteNum(spot.x) ?? finiteNum(spot.worldX);
    const z = finiteNum(spot.z) ?? finiteNum(spot.worldZ);
    return lat != null && lng != null && x != null && z != null;
}

/**
 * @param {{ x: number, z: number }[]} points
 * @returns {boolean}
 */
function areWorldPointsSpread(points) {
    if (points.length < 3) return false;
    let maxDist = 0;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
            if (d > maxDist) maxDist = d;
        }
    }
    if (maxDist < 1) return false;
    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const area2 = Math.abs(
        (p1.x - p0.x) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.x - p0.x)
    );
    return area2 > 0.5;
}

/**
 * 2x2 最小二乗
 * @param {number[][]} rows [coeffAlpha, coeffBeta, rhs]
 * @returns {{ alpha: number, beta: number }|null}
 */
function solveLeastSquares2(rows) {
    let ata00 = 0;
    let ata01 = 0;
    let ata11 = 0;
    let atb0 = 0;
    let atb1 = 0;
    for (const [c0, c1, rhs] of rows) {
        ata00 += c0 * c0;
        ata01 += c0 * c1;
        ata11 += c1 * c1;
        atb0 += c0 * rhs;
        atb1 += c1 * rhs;
    }
    const det = ata00 * ata11 - ata01 * ata01;
    if (Math.abs(det) < 1e-12) return null;
    const alpha = (atb0 * ata11 - atb1 * ata01) / det;
    const beta = (ata00 * atb1 - ata01 * atb0) / det;
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return null;
    return { alpha, beta };
}

/**
 * 3 点以上のスポットから geo パラメータを算出する
 * @param {unknown[]} spots
 * @param {{ x: number, z: number }} northDirection
 * @param {object} [baseGeo]
 * @returns {{ ok: true, geo: object, residualM: number, spotCount: number } | { ok: false, error: string }}
 */
export function computeGeoCalibrationFromSpots(spots, northDirection, baseGeo = {}) {
    const north = northDirection || { x: 0, z: -1 };
    const east = eastFromNorth(north);
    const calibrated = (Array.isArray(spots) ? spots : []).filter((s) => spotHasGeo(s));
    if (calibrated.length < MIN_GEO_CALIBRATION_SPOTS) {
        return {
            ok: false,
            error: `geo_calibration_needs_${MIN_GEO_CALIBRATION_SPOTS}_spots`,
        };
    }
    const worldPts = calibrated.map((s) => ({
        x: /** @type {number} */ (finiteNum(s.x) ?? finiteNum(s.worldX)),
        z: /** @type {number} */ (finiteNum(s.z) ?? finiteNum(s.worldZ)),
    }));
    if (!areWorldPointsSpread(worldPts)) {
        return { ok: false, error: 'geo_calibration_spots_collinear' };
    }

    const ref = calibrated[0];
    const anchorWorldX = /** @type {number} */ (finiteNum(ref.x) ?? finiteNum(ref.worldX));
    const anchorWorldZ = /** @type {number} */ (finiteNum(ref.z) ?? finiteNum(ref.worldZ));
    const anchorLat = /** @type {number} */ (finiteNum(ref.lat));
    const anchorLng = /** @type {number} */ (finiteNum(ref.lng));
    const cosLat = Math.cos((anchorLat * Math.PI) / 180);

    /** @type {number[][]} */
    const rows = [];
    for (let i = 1; i < calibrated.length; i++) {
        const s = calibrated[i];
        const wx = /** @type {number} */ (finiteNum(s.x) ?? finiteNum(s.worldX));
        const wz = /** @type {number} */ (finiteNum(s.z) ?? finiteNum(s.worldZ));
        const lat = /** @type {number} */ (finiteNum(s.lat));
        const lng = /** @type {number} */ (finiteNum(s.lng));
        const dx = wx - anchorWorldX;
        const dz = wz - anchorWorldZ;
        const eastU = dx * east.x + dz * east.z;
        const northU = dx * north.x + dz * north.z;
        const geoEastM = (lng - anchorLng) * METERS_PER_DEG_LAT * cosLat;
        const geoNorthM = (lat - anchorLat) * METERS_PER_DEG_LAT;
        rows.push([eastU, -northU, geoEastM]);
        rows.push([northU, eastU, geoNorthM]);
    }

    const solved = solveLeastSquares2(rows);
    if (!solved) {
        return { ok: false, error: 'geo_calibration_solve_failed' };
    }

    const { alpha, beta } = solved;
    const metersPerWorldUnit = Math.hypot(alpha, beta);
    if (metersPerWorldUnit < 1e-6 || metersPerWorldUnit > 100000) {
        return { ok: false, error: 'geo_calibration_invalid_scale' };
    }
    const geoNorthOffsetDeg = (Math.atan2(beta, alpha) * 180) / Math.PI;

    let residualM = 0;
    for (let i = 1; i < calibrated.length; i++) {
        const s = calibrated[i];
        const wx = /** @type {number} */ (finiteNum(s.x) ?? finiteNum(s.worldX));
        const wz = /** @type {number} */ (finiteNum(s.z) ?? finiteNum(s.worldZ));
        const lat = /** @type {number} */ (finiteNum(s.lat));
        const lng = /** @type {number} */ (finiteNum(s.lng));
        const dx = wx - anchorWorldX;
        const dz = wz - anchorWorldZ;
        const eastU = dx * east.x + dz * east.z;
        const northU = dx * north.x + dz * north.z;
        const predEastM = alpha * eastU - beta * northU;
        const predNorthM = beta * eastU + alpha * northU;
        const obsEastM = (lng - anchorLng) * METERS_PER_DEG_LAT * cosLat;
        const obsNorthM = (lat - anchorLat) * METERS_PER_DEG_LAT;
        residualM += Math.hypot(predEastM - obsEastM, predNorthM - obsNorthM);
    }
    residualM /= Math.max(calibrated.length - 1, 1);

    const src = baseGeo && typeof baseGeo === 'object' ? baseGeo : {};
    const geo = {
        enabled: true,
        anchorWorldX,
        anchorWorldZ,
        anchorLat,
        anchorLng,
        metersPerWorldUnit,
        geoNorthOffsetDeg,
        mapType: typeof src.mapType === 'string' ? src.mapType : 'satellite',
        zoom: typeof src.zoom === 'number' ? src.zoom : 15,
        zoomOffset: typeof src.zoomOffset === 'number' ? src.zoomOffset : 0,
        headingMode: typeof src.headingMode === 'string' ? src.headingMode : 'trackUp',
        calibrationSpotCount: calibrated.length,
        calibrationResidualM: Math.round(residualM * 100) / 100,
    };

    return { ok: true, geo, residualM, spotCount: calibrated.length };
}
