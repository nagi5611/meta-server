// addons/aircraft/client/flight-map-coords.js — 北固定トップダウン用 XZ 座標変換・ジオリファレンス

import * as THREE from 'three';
import { isGeoMapReady } from '../../../lib/aircraft-server/flight-map-schema.js';

const METERS_PER_DEG_LAT = 111320;

/**
 * ゲーム座標系の東北オフセット（m）を地理座標系へ変換する
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
 * 地理座標系の東北オフセット（m）をゲーム座標系へ逆変換する
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

const _projectScratch = new THREE.Vector3();

/**
 * 設定から正射影半幅（m）
 * @param {object|null|undefined} config
 * @returns {number}
 */
export function viewHalfExtentM(config) {
    const c = config && typeof config === 'object' ? config : {};
    const explicit =
        typeof c.viewHalfExtentM === 'number' && Number.isFinite(c.viewHalfExtentM)
            ? c.viewHalfExtentM
            : null;
    if (explicit != null && explicit > 0) return explicit;
    const height =
        typeof c.cameraHeightM === 'number' && Number.isFinite(c.cameraHeightM) && c.cameraHeightM > 0
            ? c.cameraHeightM
            : typeof c.minimapRadiusM === 'number' &&
                Number.isFinite(c.minimapRadiusM) &&
                c.minimapRadiusM > 0
              ? c.minimapRadiusM * 0.55
              : 500;
    return height * 0.85;
}

/**
 * @param {{ x: number, z: number }} north
 * @returns {{ x: number, z: number }}
 */
export function eastFromNorth(north) {
    return { x: north.z, z: -north.x };
}

/**
 * ワールド XZ 差分をミニマップピクセルオフセットへ（北=上）
 * @param {number} dx
 * @param {number} dz
 * @param {{ x: number, z: number }} north
 * @param {number} halfExtentM
 * @param {number} radiusPx
 * @returns {{ px: number, py: number }}
 */
export function worldDeltaToMinimapPx(dx, dz, north, halfExtentM, radiusPx) {
    const east = eastFromNorth(north);
    const northComp = dx * north.x + dz * north.z;
    const eastComp = dx * east.x + dz * east.z;
    const scale = radiusPx / Math.max(halfExtentM, 1);
    return {
        px: eastComp * scale,
        py: -northComp * scale,
    };
}

/**
 * ワールド絶対 XZ をミニマップ canvas 座標へ（正射影カメラの project と一致）
 * @param {number} worldX
 * @param {number} worldZ
 * @param {number} groundY
 * @param {import('three').Camera} camera
 * @param {number} canvasSizePx
 * @returns {{ sx: number, sy: number }|null}
 */
export function worldXzToMinimapScreen(worldX, worldZ, groundY, camera, canvasSizePx) {
    _projectScratch.set(worldX, groundY, worldZ);
    _projectScratch.project(camera);
    if (!Number.isFinite(_projectScratch.x) || !Number.isFinite(_projectScratch.y)) {
        return null;
    }
    return {
        sx: (_projectScratch.x * 0.5 + 0.5) * canvasSizePx,
        sy: (-_projectScratch.y * 0.5 + 0.5) * canvasSizePx,
    };
}

/**
 * 機体ヨー角からミニマップ上のアイコン回転（ラジアン、0=北向き）
 * @param {number} yawDeg
 * @param {{ x: number, z: number }} north
 * @param {number} [offsetDeg]
 * @returns {number}
 */
export function aircraftIconRotationRad(yawDeg, north, offsetDeg = 0) {
    const yawRad = (Number.isFinite(yawDeg) ? yawDeg : 0) * (Math.PI / 180);
    const fwdX = Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const east = eastFromNorth(north);
    const northComp = fwdX * north.x + fwdZ * north.z;
    const eastComp = fwdX * east.x + fwdZ * east.z;
    return Math.atan2(eastComp, northComp) + ((offsetDeg || 0) * Math.PI) / 180;
}

/**
 * 正射影カメラを北固定トップダウンに合わせる
 * @param {import('three').OrthographicCamera} camera
 * @param {number} centerX
 * @param {number} centerZ
 * @param {number} groundY
 * @param {number} cameraHeightM
 * @param {{ x: number, z: number }} north
 * @param {number} halfExtentM
 */
export function applyNorthUpOrthoCamera(
    camera,
    centerX,
    centerZ,
    groundY,
    cameraHeightM,
    north,
    halfExtentM
) {
    const half = Math.max(halfExtentM, 10);
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 1;
    camera.far = Math.max(cameraHeightM + 8000, 12000);
    camera.position.set(centerX, groundY + cameraHeightM, centerZ);
    camera.up.set(north.x, 0, north.z);
    camera.lookAt(centerX, groundY, centerZ);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
}

/**
 * ワールド XZ を緯度経度へ変換する（geo アンカー・北方向・縮尺・回転補正）
 * @param {number} worldX
 * @param {number} worldZ
 * @param {object|null|undefined} geo normalizeGeoConfig の結果
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
 * 緯度経度をワールド XZ へ逆変換する
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
 * 機体ヨー角から地理的方位（°、北=0・時計回り）を求める
 * @param {number} yawDeg
 * @param {{ x: number, z: number }} north
 * @param {number} [geoNorthOffsetDeg]
 * @param {number} [iconOffsetDeg]
 * @returns {number}
 */
export function worldYawToGeoBearing(yawDeg, north, geoNorthOffsetDeg = 0, iconOffsetDeg = 0) {
    const yawRad = (Number.isFinite(yawDeg) ? yawDeg : 0) * (Math.PI / 180);
    const fwdX = Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const east = eastFromNorth(north);
    const northComp = fwdX * north.x + fwdZ * north.z;
    const eastComp = fwdX * east.x + fwdZ * east.z;
    const gameBearingDeg = (Math.atan2(eastComp, northComp) * 180) / Math.PI;
    let bearing = gameBearingDeg + (geoNorthOffsetDeg || 0) + (iconOffsetDeg || 0);
    bearing = ((bearing % 360) + 360) % 360;
    return bearing;
}

/**
 * 俯瞰半幅（m）から Google Maps ズームレベルを概算する
 * @param {number} halfExtentM
 * @param {number} lat
 * @param {number} [mapWidthPx]
 * @returns {number}
 */
export function halfExtentToGoogleZoom(halfExtentM, lat, mapWidthPx = 640) {
    const half = Math.max(halfExtentM, 10);
    const metersPerPixel = (2 * half) / Math.max(mapWidthPx, 64);
    const latRad = (lat * Math.PI) / 180;
    const zoom = Math.log2((156543.03392 * Math.cos(latRad)) / Math.max(metersPerPixel, 1e-6));
    return Math.max(1, Math.min(22, Math.round(zoom)));
}
