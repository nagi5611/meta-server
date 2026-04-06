// public/js/aircraft-physics-defaults.js — 飛行機操縦の数値デフォルト（THREE に依存しない）

/** @type {Readonly<{ maxSpeed: number, thrustAccel: number, drag: number, yawRate: number, pitchRate: number, rollRate: number }>} */
export const DEFAULT_AIRCRAFT_PHYSICS = Object.freeze({
    maxSpeed: 45,
    thrustAccel: 18,
    drag: 0.985,
    yawRate: 1.1,
    pitchRate: 0.9,
    rollRate: 1.2
});

/**
 * worlds.json の aircraftPhysics を既定値でマージして検証クリップする
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {{ maxSpeed: number, thrustAccel: number, drag: number, yawRate: number, pitchRate: number, rollRate: number }}
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
        } else {
            base[k] = Math.min(50, Math.max(0.01, v));
        }
    }
    return base;
}
