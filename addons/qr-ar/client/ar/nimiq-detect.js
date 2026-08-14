// addons/qr-ar/client/ar/nimiq-detect.js — nimiq/qr-scanner（改良 jsQR + Worker）

import QrScanner from '/addons/qr-ar/vendor/qr-scanner.min.js';
import { qrLocationFromPoints } from './qr-corner-order.js';

QrScanner.WORKER_PATH = '/addons/qr-ar/vendor/qr-scanner-worker.min.js';

/**
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 */

/**
 * nimiq cornerPoints を正規化した location へ
 * @param {{x:number,y:number}[]} points
 * @returns {import('./qr-corner-order.js').QrLocation|null}
 */
export function nimiqCornerPointsToLocation(points) {
    if (!points || points.length < 3) return null;
    return qrLocationFromPoints(points.map((p) => ({ x: p.x, y: p.y })));
}

/**
 * canvas / video から QR を検出（非同期・Worker 併用）
 * @param {HTMLCanvasElement|HTMLVideoElement} source
 * @returns {Promise<{ data: string, location: QrLocation }|null>}
 */
export async function detectWithNimiq(source) {
    try {
        const result = await QrScanner.scanImage(source, {
            returnDetailedScanResult: true,
            alsoTryWithoutScanRegion: true,
            disallowCanvasResizing: false,
        });
        const text = result?.data ? String(result.data).trim() : '';
        if (!text) return null;
        const location = nimiqCornerPointsToLocation(result.cornerPoints);
        if (!location) return null;
        return { data: text, location };
    } catch {
        return null;
    }
}
