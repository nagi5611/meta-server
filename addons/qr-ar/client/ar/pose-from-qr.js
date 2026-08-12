// addons/qr-ar/client/ar/pose-from-qr.js — jsQR 四隅から QR ローカル座標系の姿勢を推定
// QR 面 = XY 平面、Z 軸は面から垂直（カメラ方向）

import {
    buildCameraIntrinsics,
    qrObjectPointsFromPhysicalSize,
    solvePnPPlanar,
    opencvPoseToThree,
} from './pnp-planar.js';

/**
 * @typedef {{ x: number, y: number }} Point2D
 * @typedef {{ topLeftCorner: Point2D, topRightCorner: Point2D, bottomRightCorner: Point2D, bottomLeftCorner: Point2D }} QrLocation
 * @typedef {{ x: number, y: number, z: number }} Vec3
 * @typedef {{ x: number, y: number, z: number, w: number }} Quat
 * @typedef {{
 *   cx: number,
 *   cy: number,
 *   width: number,
 *   distance: number,
 *   position: Vec3,
 *   quaternion: Quat,
 *   reprojectionError: number,
 *   focalLength: number,
 * }} QrPose
 */

/**
 * jsQR location を画像点列（TL, TR, BR, BL）へ
 * @param {QrLocation} location
 * @returns {{x:number,y:number}[]}
 */
export function qrLocationToImagePoints(location) {
    return [
        location.topLeftCorner,
        location.topRightCorner,
        location.bottomRightCorner,
        location.bottomLeftCorner,
    ];
}

/**
 * QR 四隅から 6DoF 姿勢を推定（QR ローカル: XY 平面 + Z 垂直）
 * @param {QrLocation} location
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} qrPhysicalSizeM QR の物理幅（メートル）
 * @param {number} [fovDeg]
 * @returns {QrPose|null}
 */
export function estimatePoseFromQrCorners(location, videoWidth, videoHeight, qrPhysicalSizeM, fovDeg = 60) {
    if (!location || !videoWidth || !videoHeight || !qrPhysicalSizeM) return null;

    const imagePoints = qrLocationToImagePoints(location);
    if (imagePoints.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

    const intrinsics = buildCameraIntrinsics(videoWidth, videoHeight, fovDeg);
    const objectPoints = qrObjectPointsFromPhysicalSize(qrPhysicalSizeM);
    const solved = solvePnPPlanar(objectPoints, imagePoints, intrinsics, qrPhysicalSizeM);
    if (!solved) return null;

    const threePose = opencvPoseToThree(solved.t, solved.r);
    const tl = location.topLeftCorner;
    const tr = location.topRightCorner;
    const br = location.bottomRightCorner;
    const bl = location.bottomLeftCorner;
    const cx = (tl.x + tr.x + bl.x + br.x) / 4;
    const cy = (tl.y + tr.y + bl.y + br.y) / 4;
    const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const distance = Math.hypot(threePose.position.x, threePose.position.y, threePose.position.z);

    return {
        cx,
        cy,
        width,
        distance,
        position: threePose.position,
        quaternion: threePose.quaternion,
        reprojectionError: solved.reprojectionError,
        focalLength: intrinsics.fx,
    };
}

/**
 * オフセットを QR ローカル座標からカメラ（Three.js）空間へ変換
 * @param {Vec3} offset QR ローカル（X右 Y上 Z面から垂直）
 * @param {Quat} quaternion
 * @returns {Vec3}
 */
export function applyOffsetInQrLocalSpace(offset, quaternion) {
    const { x, y, z, w } = quaternion;
    const qx = offset.x;
    const qy = offset.y;
    const qz = offset.z;

    const ix = w * qx + y * qz - z * qy;
    const iy = w * qy + z * qx - x * qz;
    const iz = w * qz + x * qy - y * qx;
    const iw = -x * qx - y * qy - z * qz;

    return {
        x: ix * w + iw * -x + iy * -z - iz * -y,
        y: iy * w + iw * -y + iz * -x - ix * -z,
        z: iz * w + iw * -z + ix * -y - iy * -x,
    };
}

/**
 * @param {Quat} a
 * @param {Quat} b
 * @param {number} t
 * @returns {Quat}
 */
function slerpQuaternion(a, b, t) {
    let ax = a.x;
    let ay = a.y;
    let az = a.z;
    let aw = a.w;
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;

    let cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0) {
        cosom = -cosom;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }

    let scale0;
    let scale1;
    if (1 - cosom > 1e-6) {
        const sinom = Math.sqrt(1 - cosom * cosom);
        const omega = Math.atan2(sinom, cosom);
        scale0 = Math.sin((1 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
    } else {
        scale0 = 1 - t;
        scale1 = t;
    }

    return {
        x: scale0 * ax + scale1 * bx,
        y: scale0 * ay + scale1 * by,
        z: scale0 * az + scale1 * bz,
        w: scale0 * aw + scale1 * bw,
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
    if (!prev) {
        return {
            ...next,
            position: { ...next.position },
            quaternion: { ...next.quaternion },
        };
    }
    const t = Math.min(1, Math.max(0, alpha));
    const lerp = (a, b) => a + (b - a) * t;
    return {
        cx: lerp(prev.cx, next.cx),
        cy: lerp(prev.cy, next.cy),
        width: lerp(prev.width, next.width),
        distance: lerp(prev.distance, next.distance),
        position: {
            x: lerp(prev.position.x, next.position.x),
            y: lerp(prev.position.y, next.position.y),
            z: lerp(prev.position.z, next.position.z),
        },
        quaternion: slerpQuaternion(prev.quaternion, next.quaternion, t),
        reprojectionError: next.reprojectionError,
        focalLength: next.focalLength,
    };
}
