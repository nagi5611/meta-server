// public/js/aircraft/camera-viewpoints.js — 機体 camera.viewpoints とレガシー cockpit/chase フィールドの相互変換

/** @typedef {{ id: string, name?: string, role: 'cockpit'|'chase'|'free', position: {x:number,y:number,z:number}, eulerDeg?: {x:number,y:number,z:number} }} AircraftViewpoint */

const VP_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;

/**
 * @param {unknown} v
 * @param {number} d
 * @returns {number}
 */
function num(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * @param {unknown} o
 * @param {{x:number,y:number,z:number}} def
 */
function vec3(o, def) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...def };
    return { x: num(o.x, def.x), y: num(o.y, def.y), z: num(o.z, def.z) };
}

/**
 * @param {unknown} o
 */
function eulerDeg(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { x: 0, y: 0, z: 0 };
    return { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0) };
}

/**
 * @param {unknown} raw
 * @returns {AircraftViewpoint[]}
 */
export function normalizeViewpointsArray(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {AircraftViewpoint[]} */
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = String(item.id || '').trim();
        if (!VP_ID_RE.test(id)) continue;
        const roleRaw = String(item.role || 'free').toLowerCase();
        const role = roleRaw === 'cockpit' || roleRaw === 'chase' ? roleRaw : 'free';
        const name = item.name != null ? String(item.name).trim().slice(0, 64) : '';
        out.push({
            id,
            name: name || id,
            role,
            position: vec3(item.position, { x: 0, y: 1.2, z: 0 }),
            eulerDeg: eulerDeg(item.eulerDeg),
        });
        if (out.length >= 24) break;
    }
    return out;
}

/**
 * レガシー cockpit/chase から既定の viewpoints を構築する
 * @param {unknown} cam
 * @returns {AircraftViewpoint[]}
 */
export function migrateLegacyCameraToViewpoints(cam) {
    const c = cam && typeof cam === 'object' && !Array.isArray(cam) ? cam : {};
    const existing = normalizeViewpointsArray(c.viewpoints);
    if (existing.length) return existing;
    const ck = vec3(c.cockpitOffset, { x: 0, y: 1.2, z: 0 });
    const ch = vec3(c.chaseOffset, { x: 0, y: 3, z: 12 });
    return [
        {
            id: 'cockpit',
            name: 'コックピット',
            role: 'cockpit',
            position: { ...ck },
            eulerDeg: eulerDeg(c.cockpitEulerDeg),
        },
        {
            id: 'chase',
            name: '追従',
            role: 'chase',
            position: { ...ch },
            eulerDeg: eulerDeg(c.chaseEulerDeg),
        },
    ];
}

/**
 * 保存用: viewpoints を正規化し、先頭の cockpit / chase からレガシー4キーを埋める（ゲーム互換）
 * @param {unknown} cam
 * @param {AircraftViewpoint[]} viewpoints
 * @returns {Record<string, unknown>}
 */
export function buildCameraJsonForPut(cam, viewpoints) {
    const vps = normalizeViewpointsArray(viewpoints);
    const merged = vps.length ? vps : migrateLegacyCameraToViewpoints(cam);
    const cockpit = merged.find((v) => v.role === 'cockpit') || merged[0];
    const chase = merged.find((v) => v.role === 'chase') || merged[1] || merged[0];
    /** @type {Record<string, unknown>} */
    const out = {
        viewpoints: merged.map((v) => ({
            id: v.id,
            name: v.name || v.id,
            role: v.role,
            position: { ...v.position },
            eulerDeg: { ...v.eulerDeg },
        })),
    };
    if (cockpit) {
        out.cockpitOffset = { ...cockpit.position };
        out.cockpitEulerDeg = { ...cockpit.eulerDeg };
    }
    if (chase) {
        out.chaseOffset = { ...chase.position };
        out.chaseEulerDeg = { ...chase.eulerDeg };
    }
    return out;
}

/**
 * ライブラリの camera からゲーム用 cockpit/chase を解決する
 * @param {unknown} cam
 * @returns {{ cockpitOffset: {x:number,y:number,z:number}, chaseOffset: {x:number,y:number,z:number}, cockpitEulerDeg?: object, chaseEulerDeg?: object }}
 */
export function resolveLegacyCameraFromLibrary(cam) {
    const c = cam && typeof cam === 'object' && !Array.isArray(cam) ? cam : {};
    const vps = normalizeViewpointsArray(c.viewpoints);
    if (vps.length) {
        const cockpit = vps.find((v) => v.role === 'cockpit') || vps[0];
        const chase = vps.find((v) => v.role === 'chase') || vps[1] || vps[0];
        return {
            cockpitOffset: { ...cockpit.position },
            chaseOffset: { ...chase.position },
            cockpitEulerDeg: { ...cockpit.eulerDeg },
            chaseEulerDeg: { ...chase.eulerDeg },
        };
    }
    return {
        cockpitOffset: vec3(c.cockpitOffset, { x: 0, y: 1.2, z: 0 }),
        chaseOffset: vec3(c.chaseOffset, { x: 0, y: 3, z: 12 }),
        cockpitEulerDeg: eulerDeg(c.cockpitEulerDeg),
        chaseEulerDeg: eulerDeg(c.chaseEulerDeg),
    };
}

export { VP_ID_RE };
