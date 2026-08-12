// addons/qr-ar/client/ar/qr-tracker.js — jsQR による QR 検出
import jsQR from 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';
import { estimatePoseFromQrCorners } from './pose-from-qr.js';

/**
 * @typedef {import('./pose-from-qr.js').QrPose} QrPose
 */

/**
 * フレームから QR を検出する
 * @param {Uint8ClampedArray} imageData
 * @param {number} width
 * @param {number} height
 * @returns {{ cardId: string, pose: QrPose } | null}
 */
export function detectQrInFrame(imageData, width, height) {
    const code = jsQR(imageData, width, height, { inversionAttempts: 'dontInvert' });
    if (!code?.data || !code.location) return null;
    const cardId = String(code.data).trim();
    if (!cardId) return null;
    const pose = estimatePoseFromQrCorners(code.location, width, height, 0.02);
    if (!pose) return null;
    return { cardId, pose, location: code.location };
}

/**
 * QR 検出ループ用キャンバスを用意する
 * @param {number} width
 * @param {number} height
 */
export function createScanCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas_2d_unavailable');
    return { canvas, ctx };
}

/**
 * video フレームをキャンバスへ描画して ImageData を返す
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
export function captureVideoFrame(video, canvas, ctx) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
}

/**
 * @param {QrPose} pose
 * @param {number} qrPhysicalSizeM
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} location
 */
export function refinePoseWithCardConfig(pose, qrPhysicalSizeM, videoWidth, videoHeight, location) {
    const refined = estimatePoseFromQrCorners(location, videoWidth, videoHeight, qrPhysicalSizeM);
    return refined || pose;
}
