// addons/aircraft/client/flight-map-coords.js — 地図 UV ↔ ワールド座標（クライアント用）

/**
 * ワールド座標 → 地図 UV（北=画像上端 v=0）
 * @param {number} worldX
 * @param {number} worldZ
 * @param {{ westX: number, eastX: number, northZ: number, southZ: number }} bounds
 * @returns {{ u: number, v: number }|null}
 */
export function worldToMapUv(worldX, worldZ, bounds) {
    const spanX = bounds.eastX - bounds.westX;
    const spanZ = bounds.southZ - bounds.northZ;
    if (!(spanX > 0 && spanZ > 0)) return null;
    return {
        u: (worldX - bounds.westX) / spanX,
        v: (worldZ - bounds.northZ) / spanZ,
    };
}
