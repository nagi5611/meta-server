// public/js/aircraft/flight-map-geo.js — ジオリファレンス変換・スポット補正（/js 配信）

export {
    MIN_GEO_CALIBRATION_SPOTS,
    countGeoCalibratedSpots,
    computeGeoCalibrationFromSpots,
    spotHasGeo,
} from '/lib/aircraft-server/flight-map-geo-calibration.js';

const METERS_PER_DEG_LAT = 111320;

/**
 * @param {{ x: number, z: number }} north
 * @returns {{ x: number, z: number }}
 */
function eastFromNorth(north) {
    return { x: north.z, z: -north.x };
}

/**
 * @param {number} eastM
 * @param {number} northM
 * @param {number} offsetDeg
 * @returns {{ geoEastM: number, geoNorthM: number }}
 */
function gameMetersToGeoMeters(eastM, northM, offsetDeg) {
    const dist = Math.hypot(eastM, northM);
    if (dist < 1e-9) return { geoEastM: 0, geoNorthM: 0 };
    const offsetRad = (offsetDeg * Math.PI) / 180;
    const gameBearingRad = Math.atan2(eastM, northM);
    const geoBearingRad = gameBearingRad + offsetRad;
    return {
        geoEastM: dist * Math.sin(geoBearingRad),
        geoNorthM: dist * Math.cos(geoBearingRad),
    };
}

/**
 * @param {number} geoEastM
 * @param {number} geoNorthM
 * @param {number} offsetDeg
 * @returns {{ eastM: number, northM: number }}
 */
function geoMetersToGameMeters(geoEastM, geoNorthM, offsetDeg) {
    const dist = Math.hypot(geoEastM, geoNorthM);
    if (dist < 1e-9) return { eastM: 0, northM: 0 };
    const offsetRad = (offsetDeg * Math.PI) / 180;
    const geoBearingRad = Math.atan2(geoEastM, geoNorthM);
    const gameBearingRad = geoBearingRad - offsetRad;
    return {
        eastM: dist * Math.sin(gameBearingRad),
        northM: dist * Math.cos(gameBearingRad),
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
 * @param {number} worldX
 * @param {number} worldZ
 * @param {object|null|undefined} geo
 * @param {{ x: number, z: number }} north
 * @returns {{ lat: number, lng: number }|null}
 */
export function worldXzToLatLng(worldX, worldZ, geo, north) {
    if (!isGeoMapReady(geo)) return null;
    const anchorLat = /** @type {number} */ (geo.anchorLat);
    const anchorLng = /** @type {number} */ (geo.anchorLng);
    const metersPerWorldUnit = geo.metersPerWorldUnit > 0 ? geo.metersPerWorldUnit : 1;
    const east = eastFromNorth(north);
    const dx = worldX - (geo.anchorWorldX || 0);
    const dz = worldZ - (geo.anchorWorldZ || 0);
    const northU = dx * north.x + dz * north.z;
    const eastU = dx * east.x + dz * east.z;
    const northM = northU * metersPerWorldUnit;
    const eastM = eastU * metersPerWorldUnit;
    const { geoEastM, geoNorthM } = gameMetersToGeoMeters(
        eastM,
        northM,
        geo.geoNorthOffsetDeg || 0
    );
    const lat = anchorLat + geoNorthM / METERS_PER_DEG_LAT;
    const lng =
        anchorLng
        + geoEastM / (METERS_PER_DEG_LAT * Math.max(Math.cos((anchorLat * Math.PI) / 180), 1e-6));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {object|null|undefined} geo
 * @param {{ x: number, z: number }} north
 * @returns {{ x: number, z: number }|null}
 */
export function latLngToWorldXz(lat, lng, geo, north) {
    if (!isGeoMapReady(geo)) return null;
    const anchorLat = /** @type {number} */ (geo.anchorLat);
    const anchorLng = /** @type {number} */ (geo.anchorLng);
    const metersPerWorldUnit = geo.metersPerWorldUnit > 0 ? geo.metersPerWorldUnit : 1;
    const east = eastFromNorth(north);
    const geoNorthM = (lat - anchorLat) * METERS_PER_DEG_LAT;
    const geoEastM =
        (lng - anchorLng) * METERS_PER_DEG_LAT * Math.cos((anchorLat * Math.PI) / 180);
    const { eastM, northM } = geoMetersToGameMeters(
        geoEastM,
        geoNorthM,
        geo.geoNorthOffsetDeg || 0
    );
    const eastU = eastM / metersPerWorldUnit;
    const northU = northM / metersPerWorldUnit;
    return {
        x: (geo.anchorWorldX || 0) + eastU * east.x + northU * north.x,
        z: (geo.anchorWorldZ || 0) + eastU * east.z + northU * north.z,
    };
}

/**
 * 補正済み geo から全スポットの lat/lng をワールド XZ から算出する
 * @param {object[]} spots
 * @param {object|null|undefined} geo
 * @param {{ x: number, z: number }} north
 * @returns {object[]}
 */
export function projectSpotsGeoFromWorld(spots, geo, north) {
    if (!isGeoMapReady(geo) || !Array.isArray(spots)) return spots;
    return spots.map((spot) => {
        if (!Number.isFinite(spot.x) || !Number.isFinite(spot.z)) return spot;
        const ll = worldXzToLatLng(spot.x, spot.z, geo, north);
        if (!ll) return spot;
        return { ...spot, lat: ll.lat, lng: ll.lng };
    });
}

/**
 * 補正済み geo から全スポットの XZ を lat/lng から逆算する
 * @param {object[]} spots
 * @param {object|null|undefined} geo
 * @param {{ x: number, z: number }} north
 * @returns {object[]}
 */
export function projectSpotsWorldFromGeo(spots, geo, north) {
    if (!isGeoMapReady(geo) || !Array.isArray(spots)) return spots;
    return spots.map((spot) => {
        if (!spotHasGeo(spot)) return spot;
        const xz = latLngToWorldXz(spot.lat, spot.lng, geo, north);
        if (!xz) return spot;
        return { ...spot, x: xz.x, z: xz.z };
    });
}
