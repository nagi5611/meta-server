// addons/qr-ar/client/ar/zxing-location.js — ZXing 点列から四隅復元

import { qrLocationFromPoints } from './qr-corner-order.js';

/**
 * @typedef {import('./qr-corner-order.js').QrLocation} QrLocation
 */

/**
 * ZXing の 3〜4 点から四隅を復元・順序付け
 * @param {{ getX: () => number, getY: () => number }[]} points
 * @returns {QrLocation|null}
 */
export function zxingResultPointsToLocation(points) {
    if (!points || points.length < 3) return null;
    const pts = points
        .slice(0, 4)
        .map((p) => (p ? { x: p.getX(), y: p.getY() } : null))
        .filter(Boolean);
    return qrLocationFromPoints(pts);
}
