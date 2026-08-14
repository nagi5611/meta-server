// addons/qr-ar/client/ar/zxing-detect.js — ZXing QR 検出（TRY_HARDER、傾き対応）
// 参照: third-party/zxing-js-library (https://github.com/zxing-js/library)

import {
    BinaryBitmap,
    DecodeHintType,
    HybridBinarizer,
    QRCodeReader,
    RGBLuminanceSource,
} from 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm';
import { zxingResultPointsToLocation } from './zxing-location.js';

/**
 * @typedef {import('./zxing-location.js').QrLocation} QrLocation
 */

/**
 * @param {ImageData} imageData
 * @returns {{ data: string, location: QrLocation }|null}
 */
export function detectWithZxing(imageData) {
    try {
        const reader = new QRCodeReader();
        const source = new RGBLuminanceSource(imageData.data, imageData.width, imageData.height);
        const bitmap = new BinaryBitmap(new HybridBinarizer(source));
        const hints = new Map();
        hints.set(DecodeHintType.TRY_HARDER, true);
        const result = reader.decode(bitmap, hints);
        const text = result.getText()?.trim();
        if (!text) return null;
        const location = zxingResultPointsToLocation(result.getResultPoints());
        if (!location) return null;
        return { data: text, location };
    } catch {
        return null;
    }
}

/**
 * キャンバスを回転して ZXing を複数回試す（斜め QR 用）
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} anglesDeg
 */
export function detectWithZxingRotations(canvas, ctx, anglesDeg = [-15, -8, 8, 15]) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return null;

    const base = ctx.getImageData(0, 0, w, h);
    let hit = detectWithZxing(base);
    if (hit) return hit;

    const rotCanvas = document.createElement('canvas');
    const rotCtx = rotCanvas.getContext('2d', { willReadFrequently: true });
    if (!rotCtx) return null;

    for (const deg of anglesDeg) {
        const rad = (deg * Math.PI) / 180;
        const sin = Math.abs(Math.sin(rad));
        const cos = Math.abs(Math.cos(rad));
        const rw = Math.ceil(w * cos + h * sin);
        const rh = Math.ceil(w * sin + h * cos);
        rotCanvas.width = rw;
        rotCanvas.height = rh;
        rotCtx.fillStyle = '#000';
        rotCtx.fillRect(0, 0, rw, rh);
        rotCtx.translate(rw / 2, rh / 2);
        rotCtx.rotate(rad);
        rotCtx.drawImage(canvas, -w / 2, -h / 2);
        const rotated = rotCtx.getImageData(0, 0, rw, rh);
        hit = detectWithZxing(rotated);
        if (!hit) continue;

        hit.location = derotateLocation(hit.location, -deg, rw, rh, w, h);
        return hit;
    }

    return null;
}

/**
 * 回転後の location を元キャンバス座標へ戻す
 * @param {QrLocation} location
 * @param {number} deg
 * @param {number} rw
 * @param {number} rh
 * @param {number} w
 * @param {number} h
 */
function derotateLocation(location, deg, rw, rh, w, h) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = rw / 2;
    const cy = rh / 2;
    const ox = w / 2;
    const oy = h / 2;

    const map = (p) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        return {
            x: dx * cos - dy * sin + ox,
            y: dx * sin + dy * cos + oy,
        };
    };

    return {
        topLeftCorner: map(location.topLeftCorner),
        topRightCorner: map(location.topRightCorner),
        bottomRightCorner: map(location.bottomRightCorner),
        bottomLeftCorner: map(location.bottomLeftCorner),
    };
}
