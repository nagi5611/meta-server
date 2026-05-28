// lib/aircraft-server/validate-worlds.js — worlds.json の aircraft / aircraftPhysics 検証

/** aircraftPhysics / models[].aircraft.aircraftPhysics の数値下限（POST /admin/worlds 用。上限なし） */
export const AIRCRAFT_PHYSICS_MIN = {
    gravity: 0.1,
    maxThrustSpeed: 1,
    yawMaxDeg: 1,
    yawMaxRate: 0.005,
    yawMaxAccel: 0.01,
    pitchMaxDeg: 1,
    pitchMaxRate: 0.005,
    pitchMaxAccel: 0.01,
    rollMaxDeg: 1,
    rollMaxRate: 0.005,
    rollMaxAccel: 0.01,
    tireStaticFriction: 0.05,
    tireKineticFriction: 0.05,
    flapLiftCoeff0: 0,
    flapLiftCoeff1: 0,
    flapLiftCoeff2: 0,
    flapLiftCoeff3: 0,
    flapLiftCoeff4: 0,
    flapLiftCoeff5: 0,
    flapLiftCoeff6: 0,
    engineMaxRpm: 100,
    throttleSpoolPerS: 0.02,
    engineRpmAccel: 10,
    thrustAccelPerEngineRpm: 0.1,
    engineRpmAccelPerThrottle: 0.02,
    tireBrakeAccel: 0.5,
    // 旧キー（保存データ互換の検証）
    maxSpeed: 1,
    maxBankDeg: 1,
    thrustAccel: 0.1,
    wheelBrakeDecel: 0.5,
};

/** easy 操縦（機体ライブラリ flightPhysicsEasy）の数値下限 */
export const AIRCRAFT_PHYSICS_EASY_MIN = {
    maxSpeed: 1,
    thrustAccel: 0.1,
    drag: 0.5,
    yawAccelGround: 0.05,
    yawAccelAir: 0.05,
    pitchAccelGround: 0.05,
    pitchAccelAir: 0.05,
    rollAccel: 0.05,
    yawMaxRate: 0.02,
    pitchMaxRateGround: 0.02,
    pitchMaxRateAir: 0.02,
    rollMaxRate: 0.02,
    angularDecel: 0,
    yawGroundFrictionLeft: 0,
    yawGroundFrictionRight: 0,
    sideslipDamping: 0,
    excessClimbDamping: 0,
    gravity: 0.1,
    liftPerHorizontalSpeed: 0,
    wheelBrakeDecel: 0.5,
};

/** @deprecated 互換用。AIRCRAFT_PHYSICS_MIN のみ使用 */
export const AIRCRAFT_PHYSICS_LIMITS = AIRCRAFT_PHYSICS_MIN;

/**
 * aircraftPhysics オブジェクトのキーごとに下限検証する
 * @param {unknown} ap
 * @param {string} pathLabel 例: ワールド「lobby」: aircraftPhysics
 * @param {string[]} errors
 * @param {Record<string, number>} [minTable]
 */
export function appendAircraftPhysicsValidationErrors(ap, pathLabel, errors, minTable = AIRCRAFT_PHYSICS_MIN) {
    if (ap == null) return;
    if (typeof ap !== 'object' || Array.isArray(ap)) {
        errors.push(`${pathLabel} はオブジェクトである必要があります`);
        return;
    }
    for (const [key, lo] of Object.entries(minTable)) {
        if (!(key in /** @type {Record<string, unknown>} */ (ap))) continue;
        const v = /** @type {Record<string, unknown>} */ (ap)[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`${pathLabel}.${key} は有限の数値にしてください`);
            continue;
        }
        if (v < lo) {
            errors.push(`${pathLabel}.${key} は ${lo} 以上にしてください`);
        }
    }
}

/**
 * easy 操縦パラメータの下限検証
 * @param {unknown} ap
 * @param {string} pathLabel
 * @param {string[]} errors
 */
export function appendEasyAircraftPhysicsValidationErrors(ap, pathLabel, errors) {
    appendAircraftPhysicsValidationErrors(ap, pathLabel, errors, AIRCRAFT_PHYSICS_EASY_MIN);
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
