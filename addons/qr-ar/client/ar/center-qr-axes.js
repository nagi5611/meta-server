// addons/qr-ar/client/ar/center-qr-axes.js — QR 中心原点の軸表示（ファインダ3隅 + 中心マーカー）

import {
    buildCameraIntrinsics,
    qrObjectPointsFromPhysicalSize,
    solvePnPPlanar,
    projectObjectPoints,
} from './pnp-planar.js';
import { qrLocationToImagePoints } from './pose-from-qr.js';
import { normalizeQrLocation } from './qr-corner-order.js';

/**
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 */

/**
 * 正規化済み location の幾何中心（軸の原点）
 * @param {QrLocation} location
 */
export function qrCenterFromLocation(location) {
    const loc = normalizeQrLocation(location);
    if (!loc) return null;
    return {
        x: (loc.topLeftCorner.x + loc.topRightCorner.x + loc.bottomRightCorner.x + loc.bottomLeftCorner.x) / 4,
        y: (loc.topLeftCorner.y + loc.topRightCorner.y + loc.bottomRightCorner.y + loc.bottomLeftCorner.y) / 4,
        location: loc,
    };
}

/**
 * ファインダパターンがある3隅（TL, TR, BL）。BR は対角でファインダなし
 * @param {QrLocation} location
 */
export function getQrFinderCorners(location) {
    const loc = normalizeQrLocation(location);
    if (!loc) return null;
    return {
        topLeft: loc.topLeftCorner,
        topRight: loc.topRightCorner,
        bottomLeft: loc.bottomLeftCorner,
        bottomRight: loc.bottomRightCorner,
    };
}

/**
 * 中心原点 PnP（XY 平面 + Z 垂直）
 * @param {QrLocation} location
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} qrSizeM
 * @param {number} [fovDeg]
 */
export function estimateCenterQrAxesPose(location, videoWidth, videoHeight, qrSizeM, fovDeg = 60) {
    const normalized = normalizeQrLocation(location);
    if (!normalized || !videoWidth || !videoHeight || !qrSizeM) return null;

    const intrinsics = buildCameraIntrinsics(videoWidth, videoHeight, fovDeg);
    const objectPoints = qrObjectPointsFromPhysicalSize(qrSizeM);
    const imagePoints = qrLocationToImagePoints(normalized);
    const solved = solvePnPPlanar(objectPoints, imagePoints, intrinsics, qrSizeM);
    if (!solved) return null;

    return {
        r: solved.r,
        t: solved.t,
        reprojectionError: solved.reprojectionError,
        intrinsics,
        location: normalized,
    };
}

/**
 * 中心原点から XYZ 軸端点を画像座標へ投影
 * @param {{ r: number[], t: {x:number,y:number,z:number}, intrinsics: import('./pnp-planar.js').CameraIntrinsics }} pose
 * @param {number} axisLength
 */
export function projectCenterQrAxes(pose, axisLength) {
    const axisPoints = [
        { x: 0, y: 0, z: 0 },
        { x: axisLength, y: 0, z: 0 },
        { x: 0, y: axisLength, z: 0 },
        { x: 0, y: 0, z: axisLength },
    ];
    return projectObjectPoints(axisPoints, pose.r, pose.t, pose.intrinsics);
}

/**
 * ファインダ3隅を青で表示
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ topLeft: {x:number,y:number}, topRight: {x:number,y:number}, bottomLeft: {x:number,y:number} }} corners
 */
export function drawQrFinderMarkers(ctx, corners) {
    if (!corners) return;
    const radius = 9;
    ctx.fillStyle = '#3399ff';
    ctx.strokeStyle = '#1a5fb4';
    ctx.lineWidth = 2;
    for (const pt of [corners.topLeft, corners.topRight, corners.bottomLeft]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

/**
 * QR 中心を黄色で表示（軸の原点）
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number }} center
 */
export function drawQrCenterMarker(ctx, center) {
    if (!center) return;
    ctx.fillStyle = '#ffdd00';
    ctx.strokeStyle = '#aa9900';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#aa9900';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('O', center.x + 13, center.y - 6);
}

/**
 * 中心原点の XYZ 軸を描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {({x:number,y:number}|null)[]} projected
 * @param {{ lineWidth?: number }} [opts]
 */
export function drawCenterAxesOnCanvas(ctx, projected, opts = {}) {
    if (!projected?.length || projected.length < 4) return;
    const origin = projected[0];
    if (!origin) return;

    const lineWidth = opts.lineWidth ?? 5;
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
}

/**
 * マーカー + 軸をまとめて描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {QrLocation} location
 * @param {({x:number,y:number}|null)[]} projectedAxes
 */
export function drawCenterQrAxesOverlay(ctx, location, projectedAxes) {
    const corners = getQrFinderCorners(location);
    const center = qrCenterFromLocation(location);
    if (corners) drawQrFinderMarkers(ctx, corners);
    if (center) drawQrCenterMarker(ctx, center);
    drawCenterAxesOnCanvas(ctx, projectedAxes, { lineWidth: 5 });
}
