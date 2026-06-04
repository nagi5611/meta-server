// addons/aircraft/client/flight-map-coords.js — 北固定トップダウン用 XZ 座標変換

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
 * @param {number} radiusM
 * @param {number} radiusPx
 * @returns {{ px: number, py: number }}
 */
export function worldDeltaToMinimapPx(dx, dz, north, radiusM, radiusPx) {
    const east = eastFromNorth(north);
    const northComp = dx * north.x + dz * north.z;
    const eastComp = dx * east.x + dz * east.z;
    const scale = radiusPx / Math.max(radiusM, 1);
    return {
        px: eastComp * scale,
        py: -northComp * scale,
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
