// addons/aircraft/client/flight-map-coords.js — 北固定トップダウン用 XZ 座標変換

import * as THREE from 'three';

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
