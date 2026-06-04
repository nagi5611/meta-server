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
    /** Space 押下時の地上ブレーキ減速度 (m/s²) */
    wheelBrakeDecel: 32,
});

/**
 * @param {string} _key
 * @param {number} v
 * @returns {number}
 */
function clipEasyPhysicsValue(_key, v) {
    return v;
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
    if (typeof r.tireBrakeAccel === 'number' && typeof r.wheelBrakeDecel !== 'number') {
        r.wheelBrakeDecel = r.tireBrakeAccel;
    }

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
