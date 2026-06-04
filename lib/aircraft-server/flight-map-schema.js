// lib/aircraft-server/flight-map-schema.js — 飛行ミニマップ定義の正規化・検証

const SPOT_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function finiteNum(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {unknown} raw
 * @returns {{ westX: number, eastX: number, northZ: number, southZ: number }}
 */
export function defaultWorldBounds(raw) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        westX: finiteNum(b.westX) ?? -5000,
        eastX: finiteNum(b.eastX) ?? 5000,
        northZ: finiteNum(b.northZ) ?? -5000,
        southZ: finiteNum(b.southZ) ?? 5000,
    };
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, name: string, u: number, v: number }[]}
 */
export function normalizeSpots(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ id: string, name: string, u: number, v: number }[]} */
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!SPOT_ID_RE.test(id)) continue;
        const name =
            typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 64)
                : id;
        const u = finiteNum(item.u);
        const v = finiteNum(item.v);
        if (u == null || v == null) continue;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        if (out.some((s) => s.id === id)) continue;
        out.push({ id, name, u, v });
        if (out.length >= 128) break;
    }
    return out;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function parseFlightMapConfig(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const bounds = defaultWorldBounds(src.worldBounds);
    if (bounds.eastX <= bounds.westX) {
        return { ok: false, error: 'worldBounds.eastX must be greater than westX' };
    }
    if (bounds.southZ <= bounds.northZ) {
        return { ok: false, error: 'worldBounds.southZ must be greater than northZ' };
    }
    const radiusRaw = finiteNum(src.minimapRadiusM);
    const minimapRadiusM = radiusRaw != null && radiusRaw > 0 ? Math.min(radiusRaw, 50000) : 800;
    const offsetRaw = finiteNum(src.aircraftIconOffsetDeg);
    const aircraftIconOffsetDeg =
        offsetRaw != null ? Math.max(-180, Math.min(180, offsetRaw)) : 0;
    const spots = normalizeSpots(src.spots);
    const config = {
        worldBounds: bounds,
        minimapRadiusM,
        aircraftIconOffsetDeg,
        spots,
    };
    const s = JSON.stringify(config);
    if (s.length > 64000) return { ok: false, error: 'flight map config too large' };
    return { ok: true, config };
}

/**
 * 空または不正な入力時と同じデフォルト設定
 * @returns {ReturnType<typeof parseFlightMapConfig> extends { ok: true, config: infer C } ? C : never}
 */
export function defaultFlightMapConfig() {
    const parsed = parseFlightMapConfig(null);
    return parsed.config;
}

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

/**
 * 地図 UV → ワールド XZ
 * @param {number} u
 * @param {number} v
 * @param {{ westX: number, eastX: number, northZ: number, southZ: number }} bounds
 * @returns {{ x: number, z: number }}
 */
export function mapUvToWorld(u, v, bounds) {
    return {
        x: bounds.westX + u * (bounds.eastX - bounds.westX),
        z: bounds.northZ + v * (bounds.southZ - bounds.northZ),
    };
}
