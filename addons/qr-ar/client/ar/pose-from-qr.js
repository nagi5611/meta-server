// addons/qr-ar/client/ar/pose-from-qr.js — jsQR 四隅からカメラ空間の姿勢を推定

/**
 * @typedef {{ x: number, y: number }} Point2D
 * @typedef {{ topLeftCorner: Point2D, topRightCorner: Point2D, bottomRightCorner: Point2D, bottomLeftCorner: Point2D }} QrLocation
 * @typedef {{ cx: number, cy: number, width: number, distance: number, angle: number, position: { x: number, y: number, z: number }, focalLength: number }} QrPose
 */

/**
 * QR 四隅から中心・距離・回転角を推定する
 * @param {QrLocation} location
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} qrPhysicalSizeM QR の物理幅（メートル）
 * @param {number} [fovDeg]
 * @returns {QrPose|null}
 */
export function estimatePoseFromQrCorners(location, videoWidth, videoHeight, qrPhysicalSizeM, fovDeg = 60) {
    if (!location || !videoWidth || !videoHeight || !qrPhysicalSizeM) return null;

    const tl = location.topLeftCorner;
    const tr = location.topRightCorner;
    const br = location.bottomRightCorner;
    const bl = location.bottomLeftCorner;
    if (!tl || !tr || !br || !bl) return null;

    const cx = (tl.x + tr.x + bl.x + br.x) / 4;
    const cy = (tl.y + tr.y + bl.y + br.y) / 4;
    const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    if (!Number.isFinite(width) || width < 4) return null;

    const fov = (fovDeg * Math.PI) / 180;
    const focalLength = videoHeight / (2 * Math.tan(fov / 2));
    const distance = (focalLength * qrPhysicalSizeM) / width;
    if (!Number.isFinite(distance) || distance <= 0) return null;

    const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
    const nx = (cx - videoWidth / 2) / focalLength;
    const ny = -(cy - videoHeight / 2) / focalLength;
    const x = nx * distance;
    const y = ny * distance;
    const z = -distance;

    return {
        cx,
        cy,
        width,
        distance,
        angle,
        position: { x, y, z },
        focalLength,
    };
}

/**
 * オフセットを QR ローカル座標（幅方向・高さ方向）からカメラ空間へ変換
 * @param {{ x: number, y: number, z: number }} offset
 * @param {number} angle
 * @returns {{ x: number, y: number, z: number }}
 */
export function applyOffsetInQrPlane(offset, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
        x: offset.x * cos - offset.y * sin,
        y: offset.x * sin + offset.y * cos,
        z: offset.z,
    };
}

/**
 * 姿勢をフレーム間で平滑化する
 * @param {QrPose|null} prev
 * @param {QrPose|null} next
 * @param {number} alpha 0〜1（大きいほど新値を反映）
 * @returns {QrPose|null}
 */
export function smoothQrPose(prev, next, alpha = 0.35) {
    if (!next) return null;
    if (!prev) return { ...next, position: { ...next.position } };
    const t = Math.min(1, Math.max(0, alpha));
    const lerp = (a, b) => a + (b - a) * t;
    let angle = next.angle;
    const delta = angle - prev.angle;
    if (delta > Math.PI) angle -= 2 * Math.PI;
    if (delta < -Math.PI) angle += 2 * Math.PI;
    return {
        cx: lerp(prev.cx, next.cx),
        cy: lerp(prev.cy, next.cy),
        width: lerp(prev.width, next.width),
        distance: lerp(prev.distance, next.distance),
        angle: lerp(prev.angle, angle),
        position: {
            x: lerp(prev.position.x, next.position.x),
            y: lerp(prev.position.y, next.position.y),
            z: lerp(prev.position.z, next.position.z),
        },
        focalLength: next.focalLength,
    };
}
