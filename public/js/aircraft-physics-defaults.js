// public/js/aircraft-physics-defaults.js — 飛行機操縦の数値デフォルト（THREE に依存しない）

/** @type {Readonly<{ maxSpeed: number, thrustAccel: number, drag: number, yawAccel: number, pitchAccel: number, rollAccel: number, yawMaxRate: number, pitchMaxRate: number, rollMaxRate: number, angularDecel: number, yawGroundFrictionLeft: number, yawGroundFrictionRight: number, sideslipDamping: number, excessClimbDamping: number, gravity: number, liftPerHorizontalSpeed: number }>} */
export const DEFAULT_AIRCRAFT_PHYSICS = Object.freeze({
    maxSpeed: 45,
    thrustAccel: 18,
    drag: 0.985,
    yawAccel: 5,
    pitchAccel: 4,
    rollAccel: 5,
    yawMaxRate: 1.1,
    pitchMaxRate: 0.9,
    rollMaxRate: 1.2,
    /** 入力オフ時の角速度減速 (rad/s²) */
    angularDecel: 3,
    /** 接地中・ヨー角速度が負（A/左寄り）のときに加算する減速 (rad/s²)。angularDecel に加算 */
    yawGroundFrictionLeft: 0,
    /** 接地中・ヨー角速度が正（D/右寄り）のときに加算する減速 (rad/s²) */
    yawGroundFrictionRight: 0,
    /** 空中のみ: 速度の機体前後軸に垂直な成分を exp(-k*dt) で減衰 (1/s)。0 で無効 */
    sideslipDamping: 0,
    /** 空中かつ上向き速度時のみ vy を exp(-k*dt) で減衰 (1/s)。揚力の積み上がりを抑える。0 で無効 */
    excessClimbDamping: 0,
    gravity: 9.81,
    liftPerHorizontalSpeed: 0.35
});

/**
 * worlds.json の aircraftPhysics を既定値でマージして検証クリップする。
 * 旧キー yawRate / pitchRate / rollRate は最高角速度として読み替える。
 * @param {Record<string, unknown>|null|undefined} raw
 */
export function mergeAircraftPhysicsFromWorld(raw) {
    const base = { ...DEFAULT_AIRCRAFT_PHYSICS };
    if (!raw || typeof raw !== 'object') return base;
    const r = { ...raw };
    if (typeof r.yawRate === 'number' && typeof r.yawMaxRate !== 'number') r.yawMaxRate = r.yawRate;
    if (typeof r.pitchRate === 'number' && typeof r.pitchMaxRate !== 'number') r.pitchMaxRate = r.pitchRate;
    if (typeof r.rollRate === 'number' && typeof r.rollMaxRate !== 'number') r.rollMaxRate = r.rollRate;

    for (const k of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const v = r[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (k === 'drag') {
            base[k] = Math.min(0.99999, Math.max(0.5, v));
        } else if (k === 'maxSpeed') {
            base[k] = Math.min(500, Math.max(1, v));
        } else if (k === 'gravity') {
            base[k] = Math.min(50, Math.max(0, v));
        } else if (k === 'liftPerHorizontalSpeed') {
            base[k] = Math.min(5, Math.max(0, v));
        } else if (k === 'sideslipDamping' || k === 'excessClimbDamping') {
            base[k] = Math.min(10, Math.max(0, v));
        } else if (k === 'angularDecel' || k === 'yawGroundFrictionLeft' || k === 'yawGroundFrictionRight') {
            base[k] = Math.min(30, Math.max(0, v));
        } else if (k.endsWith('Accel')) {
            base[k] = Math.min(40, Math.max(0.05, v));
        } else if (k.endsWith('MaxRate')) {
            base[k] = Math.min(10, Math.max(0.02, v));
        } else {
            base[k] = Math.min(50, Math.max(0.01, v));
        }
    }
    return base;
}
