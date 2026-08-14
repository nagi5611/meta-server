// addons/qr-ar/client/ar/zxing-location.js — ZXing 3点から四隅復元（CDN 非依存）

/**
 * @typedef {{ topLeftCorner: {x:number,y:number}, topRightCorner: {x:number,y:number}, bottomRightCorner: {x:number,y:number}, bottomLeftCorner: {x:number,y:number} }} QrLocation
 */

/**
 * ZXing の 3 点（BL, TL, TR）から第 4 角を復元する
 * @param {{ getX: () => number, getY: () => number }[]} points
 * @returns {QrLocation|null}
 */
export function zxingResultPointsToLocation(points) {
    if (!points || points.length < 3) return null;
    const bl = points[0];
    const tl = points[1];
    const tr = points[2];
    if (!bl || !tl || !tr) return null;

    const brX = tr.getX() + bl.getX() - tl.getX();
    const brY = tr.getY() + bl.getY() - tl.getY();

    return {
        topLeftCorner: { x: tl.getX(), y: tl.getY() },
        topRightCorner: { x: tr.getX(), y: tr.getY() },
        bottomRightCorner: { x: brX, y: brY },
        bottomLeftCorner: { x: bl.getX(), y: bl.getY() },
    };
}
