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
 * 北方向（XZ 平面の単位ベクトル）。デフォルトは -Z（Three.js 前方）
 * @param {unknown} raw
 * @returns {{ x: number, z: number }}
 */
export function normalizeNorthDirection(raw) {
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let x = finiteNum(d.x);
    let z = finiteNum(d.z);
    if (x == null && z == null) return { x: 0, z: -1 };
    if (x == null) x = 0;
    if (z == null) z = -1;
    const len = Math.hypot(x, z);
    if (len < 1e-9) return { x: 0, z: -1 };
    return { x: x / len, z: z / len };
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, name: string, x: number, z: number }[]}
 */
export function normalizeSpots(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ id: string, name: string, x: number, z: number }[]} */
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!SPOT_ID_RE.test(id)) continue;
        const name =
            typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 64)
                : id;
        const x = finiteNum(item.x);
        const z = finiteNum(item.z);
        if (x == null || z == null) continue;
        if (out.some((s) => s.id === id)) continue;
        out.push({ id, name, x, z });
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
    const northDirection = normalizeNorthDirection(src.northDirection);
    const radiusRaw = finiteNum(src.minimapRadiusM);
    const minimapRadiusM = radiusRaw != null && radiusRaw > 0 ? Math.min(radiusRaw, 50000) : 800;
    const offsetRaw = finiteNum(src.aircraftIconOffsetDeg);
    const aircraftIconOffsetDeg =
        offsetRaw != null ? Math.max(-180, Math.min(180, offsetRaw)) : 0;
    const spots = normalizeSpots(src.spots);
    const config = {
        northDirection,
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
 * @returns {object}
 */
export function defaultFlightMapConfig() {
    return parseFlightMapConfig(null).config;
}
