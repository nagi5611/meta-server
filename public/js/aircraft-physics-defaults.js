// public/js/aircraft-physics-defaults.js — 飛行機操縦の数値デフォルト（THREE に依存しない）

/** @type {Readonly<{ maxSpeed: number, thrustAccel: number, drag: number, yawRate: number, pitchRate: number, rollRate: number, gravity: number, liftPerHorizontalSpeed: number }>} */
export const DEFAULT_AIRCRAFT_PHYSICS = Object.freeze({
    maxSpeed: 45,
    thrustAccel: 18,
    drag: 0.985,
    yawRate: 1.1,
    pitchRate: 0.9,
    rollRate: 1.2,
    /** ワールド下向き重力加速度 (m/s²)。0 で無効 */
    gravity: 9.81,
    /**
     * 揚力: 上向き加速度 += liftPerHorizontalSpeed × 水平速度 (m/s)。
     * 低速では重力が勝ち、速度が出るほど上向きに働く（失速しやすさの調整用）
     */
    liftPerHorizontalSpeed: 0.35
});

/**
 * worlds.json の aircraftPhysics を既定値でマージして検証クリップする
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {{ maxSpeed: number, thrustAccel: number, drag: number, yawRate: number, pitchRate: number, rollRate: number, gravity: number, liftPerHorizontalSpeed: number }}
 */
export function mergeAircraftPhysicsFromWorld(raw) {
    const base = { ...DEFAULT_AIRCRAFT_PHYSICS };
    if (!raw || typeof raw !== 'object') return base;
    for (const k of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const v = raw[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (k === 'drag') {
            base[k] = Math.min(0.99999, Math.max(0.5, v));
        } else if (k === 'maxSpeed') {
            base[k] = Math.min(500, Math.max(1, v));
        } else if (k === 'gravity') {
            base[k] = Math.min(50, Math.max(0, v));
        } else if (k === 'liftPerHorizontalSpeed') {
            base[k] = Math.min(5, Math.max(0, v));
        } else {
            base[k] = Math.min(50, Math.max(0.01, v));
        }
    }
    return base;
}
