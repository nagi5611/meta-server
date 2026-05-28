// addons/aircraft/client/aircraft-physics-easy-defaults.js — easy 操縦の数値デフォルト（Git 9239d93 由来）

/** @type {Readonly<Record<string, number>>} */
export const DEFAULT_EASY_AIRCRAFT_PHYSICS = Object.freeze({
    maxSpeed: 45,
    thrustAccel: 18,
    drag: 0.985,
    yawAccelGround: 5,
    yawAccelAir: 5,
    pitchAccelGround: 4,
    pitchAccelAir: 4,
    rollAccel: 5,
    yawMaxRate: 1.1,
    pitchMaxRateGround: 0.9,
    pitchMaxRateAir: 0.9,
    rollMaxRate: 1.2,
    angularDecel: 3,
    yawGroundFrictionLeft: 0,
    yawGroundFrictionRight: 0,
    sideslipDamping: 0,
    excessClimbDamping: 0,
    gravity: 9.81,
    liftPerHorizontalSpeed: 0.35,
});

/**
 * @param {string} key
 * @param {number} v
 * @returns {number}
 */
function clipEasyPhysicsValue(key, v) {
    if (key === 'drag') return Math.min(0.99999, Math.max(0.5, v));
    if (key === 'maxSpeed') return Math.min(500, Math.max(1, v));
    if (key === 'gravity') return Math.min(50, Math.max(0.1, v));
    if (key === 'liftPerHorizontalSpeed') return Math.min(5, Math.max(0, v));
    if (key === 'sideslipDamping' || key === 'excessClimbDamping') {
        return Math.min(10, Math.max(0, v));
    }
    if (key === 'angularDecel' || key === 'yawGroundFrictionLeft' || key === 'yawGroundFrictionRight') {
        return Math.min(30, Math.max(0, v));
    }
    if (
        key === 'pitchAccelGround' ||
        key === 'pitchAccelAir' ||
        key === 'yawAccelGround' ||
        key === 'yawAccelAir'
    ) {
        return Math.min(40, Math.max(0.05, v));
    }
    if (key === 'pitchMaxRateGround' || key === 'pitchMaxRateAir') {
        return Math.min(10, Math.max(0.02, v));
    }
    if (key.endsWith('Accel')) return Math.min(40, Math.max(0.05, v));
    if (key.endsWith('MaxRate')) return Math.min(10, Math.max(0.02, v));
    return Math.min(50, Math.max(0.01, v));
}

/**
 * easy 操縦パラメータを既定値でマージする。
 * @param {Record<string, unknown>|null|undefined} raw
 */
export function mergeEasyAircraftPhysicsFromWorld(raw) {
    const base = { ...DEFAULT_EASY_AIRCRAFT_PHYSICS };
    if (!raw || typeof raw !== 'object') return base;
    const r = { ...raw };
    if (typeof r.yawAccel === 'number') {
        if (typeof r.yawAccelGround !== 'number') r.yawAccelGround = r.yawAccel;
        if (typeof r.yawAccelAir !== 'number') r.yawAccelAir = r.yawAccel;
    }
    if (typeof r.yawRate === 'number' && typeof r.yawMaxRate !== 'number') r.yawMaxRate = r.yawRate;
    if (typeof r.pitchMaxRate === 'number') {
        if (typeof r.pitchMaxRateGround !== 'number') r.pitchMaxRateGround = r.pitchMaxRate;
        if (typeof r.pitchMaxRateAir !== 'number') r.pitchMaxRateAir = r.pitchMaxRate;
    }
    if (typeof r.pitchRate === 'number') {
        if (typeof r.pitchMaxRateGround !== 'number') r.pitchMaxRateGround = r.pitchRate;
        if (typeof r.pitchMaxRateAir !== 'number') r.pitchMaxRateAir = r.pitchRate;
    }
    if (typeof r.pitchAccel === 'number') {
        if (typeof r.pitchAccelGround !== 'number') r.pitchAccelGround = r.pitchAccel;
        if (typeof r.pitchAccelAir !== 'number') r.pitchAccelAir = r.pitchAccel;
    }
    if (typeof r.rollRate === 'number' && typeof r.rollMaxRate !== 'number') r.rollMaxRate = r.rollRate;

    for (const k of Object.keys(DEFAULT_EASY_AIRCRAFT_PHYSICS)) {
        const v = r[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        base[k] = clipEasyPhysicsValue(k, v);
    }
    return base;
}

/**
 * @param {'hard'|'easy'|string|null|undefined} mode
 * @returns {'hard'|'easy'}
 */
export function normalizeAircraftControlMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    return m === 'easy' ? 'easy' : 'hard';
}
