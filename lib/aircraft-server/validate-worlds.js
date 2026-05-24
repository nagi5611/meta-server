// lib/aircraft-server/validate-worlds.js — worlds.json の aircraft / aircraftPhysics 検証

/** aircraftPhysics / models[].aircraft.aircraftPhysics の数値レンジ（POST /admin/worlds 用） */
export const AIRCRAFT_PHYSICS_LIMITS = {
    maxThrustSpeed: [1, 600],
    yawMaxDeg: [1, 90],
    yawMaxRate: [0.005, 10],
    yawMaxAccel: [0.01, 40],
    pitchMaxDeg: [1, 90],
    pitchMaxRate: [0.005, 10],
    pitchMaxAccel: [0.01, 40],
    rollMaxDeg: [1, 90],
    rollMaxRate: [0.005, 10],
    rollMaxAccel: [0.01, 40],
    tireStaticFriction: [0.05, 2],
    tireKineticFriction: [0.05, 2],
    flapLiftCoeff0: [0, 3],
    flapLiftCoeff1: [0, 3],
    flapLiftCoeff2: [0, 3],
    flapLiftCoeff3: [0, 3],
    flapLiftCoeff4: [0, 3],
    flapLiftCoeff5: [0, 3],
    flapLiftCoeff6: [0, 3],
    engineMaxRpm: [100, 120000],
    throttleSpoolPerS: [0.02, 5],
    engineRpmAccel: [10, 50000],
    thrustAccelPerEngineRpm: [0.1, 50],
    engineRpmAccelPerThrottle: [0.02, 5],
    tireBrakeAccel: [0.5, 15],
    // 旧キー（保存データ互換の検証）
    maxSpeed: [1, 600],
    maxBankDeg: [1, 90],
    thrustAccel: [0.1, 50],
    throttleSpoolPerS: [0.02, 5],
    wheelBrakeDecel: [0.5, 15],
};

/**
 * aircraftPhysics オブジェクトのキーごとにレンジ検証する
 * @param {unknown} ap
 * @param {string} pathLabel 例: ワールド「lobby」: aircraftPhysics
 * @param {string[]} errors
 */
export function appendAircraftPhysicsValidationErrors(ap, pathLabel, errors) {
    if (ap == null) return;
    if (typeof ap !== 'object' || Array.isArray(ap)) {
        errors.push(`${pathLabel} はオブジェクトである必要があります`);
        return;
    }
    for (const [key, [lo, hi]] of Object.entries(AIRCRAFT_PHYSICS_LIMITS)) {
        if (!(key in /** @type {Record<string, unknown>} */ (ap))) continue;
        const v = /** @type {Record<string, unknown>} */ (ap)[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`${pathLabel}.${key} は有限の数値にしてください`);
            continue;
        }
        if (v < lo || v > hi) {
            errors.push(`${pathLabel}.${key} は ${lo}〜${hi} にしてください`);
        }
    }
}

/**
 * aircraftPhysics（飛行機操縦の数値）検証（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
export function validateWorldsAircraftPhysics(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object') continue;
        const ap = /** @type {Record<string, unknown>} */ (w).aircraftPhysics;
        if (ap == null) continue;
        appendAircraftPhysicsValidationErrors(ap, `ワールド「${wid}」: aircraftPhysics`, errors);
    }
    return errors;
}

/**
 * aircraft メタデータの検証（同一ワールド内 id 一意）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
export function validateWorldsAircraft(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object' || !Array.isArray(/** @type {Record<string, unknown>} */ (w).models)) continue;
        const models = /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (w).models);
        const seen = new Set();
        models.forEach((m, i) => {
            const a = m && typeof m === 'object' ? /** @type {Record<string, unknown>} */ (m).aircraft : null;
            if (!a || typeof a !== 'object') return;
            const id = String(/** @type {Record<string, unknown>} */ (a).id || '').trim();
            if (!id) {
                errors.push(`ワールド「${wid}」オブジェクト#${i + 1}: aircraft.id が必要です`);
                return;
            }
            if (seen.has(id)) {
                errors.push(`ワールド「${wid}」: aircraft.id「${id}」が重複しています`);
            }
            seen.add(id);
            const r = /** @type {Record<string, unknown>} */ (a).radius;
            if (r != null && (typeof r !== 'number' || !Number.isFinite(r) || r <= 0)) {
                errors.push(`ワールド「${wid}」 aircraft「${id}」: radius は正の有限数値にしてください`);
            }
            const apPhys = /** @type {Record<string, unknown>} */ (a).aircraftPhysics;
            if (apPhys != null) {
                appendAircraftPhysicsValidationErrors(
                    apPhys,
                    `ワールド「${wid}」 aircraft「${id}」: aircraftPhysics`,
                    errors
                );
            }
        });
    }
    return errors;
}
