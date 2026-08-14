// addons/qr-ar/client/ar/nimiq-detect.js — nimiq/qr-scanner（改良 jsQR + Worker）
// 参照: third-party/qr-scanner (https://github.com/nimiq/qr-scanner)

import QrScanner from '/addons/qr-ar/vendor/qr-scanner.min.js';

QrScanner.WORKER_PATH = '/addons/qr-ar/vendor/qr-scanner-worker.min.js';

/**
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 */

/**
 * nimiq cornerPoints（TL, TR, BR, BL）を location 形式へ
 * @param {{x:number,y:number}[]} points
 * @returns {QrLocation|null}
 */
export function nimiqCornerPointsToLocation(points) {
    if (!points || points.length < 4) return null;
    return {
        topLeftCorner: { x: points[0].x, y: points[0].y },
        topRightCorner: { x: points[1].x, y: points[1].y },
        bottomRightCorner: { x: points[2].x, y: points[2].y },
        bottomLeftCorner: { x: points[3].x, y: points[3].y },
    };
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
