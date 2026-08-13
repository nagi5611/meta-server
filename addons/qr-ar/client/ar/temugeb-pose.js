// addons/qr-ar/client/ar/temugeb-pose.js — TemugeB/QR_code_orientation_OpenCV と同じ PnP 手順
// 参照: third-party/QR_code_orientation_OpenCV/run_qr.py (get_qr_coords)

import {
    buildCameraIntrinsics,
    solvePnPPlanar,
    projectObjectPoints,
} from './pnp-planar.js';

/**
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 * @typedef {{ r: number[], t: {x:number,y:number,z:number}, reprojectionError: number, intrinsics: import('./pnp-planar.js').CameraIntrinsics } | null} TemugebPose
 */

/**
 * TemugeB の qr_edges（単位正方形、原点は corner #1）
 * @param {number} size 辺の長さ（メートル）
 * @returns {{x:number,y:number,z:number}[]}
 */
export function temugebQrObjectPoints(size = 1) {
    return [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: size, z: 0 },
        { x: size, y: size, z: 0 },
        { x: size, y: 0, z: 0 },
    ];
}

/**
 * TemugeB の unitv_points（原点 + X/Y/Z 単位軸）
 * @param {number} axisLength
 * @returns {{x:number,y:number,z:number}[]}
 */
export function temugebAxisObjectPoints(axisLength = 1) {
    return [
        { x: 0, y: 0, z: 0 },
        { x: axisLength, y: 0, z: 0 },
        { x: 0, y: axisLength, z: 0 },
        { x: 0, y: 0, z: axisLength },
    ];
}

/**
 * jsQR 四隅を TemugeB の solvePnP 順序へ（原点 TL, +Y BL, 対角 BR, +X TR）
 * @param {QrLocation} location
 * @returns {{x:number,y:number}[]}
 */
export function jsQrLocationToTemugebImagePoints(location) {
    return [
        location.topLeftCorner,
        location.bottomLeftCorner,
        location.bottomRightCorner,
        location.topRightCorner,
    ];
}

/**
 * run_qr.py の get_qr_coords 相当
 * @param {QrLocation} location
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} [qrSizeM] QR 辺長（メートル）
 * @param {number} [fovDeg]
 * @returns {TemugebPose}
 */
export function estimateTemugebQrPose(location, videoWidth, videoHeight, qrSizeM = 0.05, fovDeg = 60) {
    if (!location || !videoWidth || !videoHeight) return null;

    const intrinsics = buildCameraIntrinsics(videoWidth, videoHeight, fovDeg);
    const objectPoints = temugebQrObjectPoints(qrSizeM);
    const imagePoints = jsQrLocationToTemugebImagePoints(location);

    const solved = solvePnPPlanar(objectPoints, imagePoints, intrinsics, qrSizeM);
    if (!solved) return null;

    return {
        r: solved.r,
        t: solved.t,
        reprojectionError: solved.reprojectionError,
        intrinsics,
    };
}

/**
 * 軸端点を画像座標へ投影（cv.projectPoints 相当）
 * @param {TemugebPose} pose
 * @param {number} [axisLength]
 * @returns {({x:number,y:number}|null)[]}
 */
export function projectTemugebAxes(pose, axisLength = 1) {
    if (!pose) return [];
    const axisPoints = temugebAxisObjectPoints(axisLength);
    return projectObjectPoints(axisPoints, pose.r, pose.t, pose.intrinsics);
}

/**
 * 2D キャンバスへ TemugeB 方式で XYZ 軸を描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {({x:number,y:number}|null)[]} projected
 * @param {{ lineWidth?: number }} [opts]
 */
export function drawTemugebAxesOnCanvas(ctx, projected, opts = {}) {
    if (!projected?.length || projected.length < 4) return;
    const origin = projected[0];
    if (!origin) return;

    const lineWidth = opts.lineWidth ?? 4;
    const axes = [
        { pt: projected[1], color: '#ff3333', label: 'X' },
        { pt: projected[2], color: '#33ff33', label: 'Y' },
        { pt: projected[3], color: '#3399ff', label: 'Z' },
    ];

    const maxCoord = ctx.canvas.width * 5;
    const ox = origin.x;
    const oy = origin.y;
    if (ox > maxCoord || oy > maxCoord || ox < -maxCoord || oy < -maxCoord) return;

    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    for (const axis of axes) {
        if (!axis.pt) continue;
        const px = axis.pt.x;
        const py = axis.pt.y;
        if (px > maxCoord || py > maxCoord || px < -maxCoord || py < -maxCoord) continue;

        ctx.strokeStyle = axis.color;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(px, py);
        ctx.stroke();

        ctx.fillStyle = axis.color;
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText(axis.label, px + 4, py - 4);
    }

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ox, oy, lineWidth + 2, 0, Math.PI * 2);
    ctx.fill();
}
