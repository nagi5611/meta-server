// addons/aircraft/client/aircraft-physics-defaults.js — 飛行機操縦の数値デフォルト（THREE に依存しない）

/** ノット→m/s（ICAO 標準換算） */
export const KNOTS_TO_MS = 0.514444;

/** シミュレーション内部のみ（管理 UI には出さない） */
export const AIRCRAFT_PHYSICS_INTERNAL = Object.freeze({
    /**
     * 直線運動のワールドスケール。パラメータ・HUD は名目 m / m/s のまま、
     * 実際の移動・加減速はこの倍率で適用（0.1 = 同じ表示速度で移動距離 1/10）。
     */
    linearWorldScale: 0.6,
    /** 毎フレーム速度乗算（ゲーム用減衰） */
    drag: 0.985,
    /** 操縦入力オフ時の角速度減速 (rad/s²) */
    angularDecel: 2.5,
    /** フラップ展開時のロール・ピッチ権限乗数（固定。揚力は flapLiftCoeff* で調整） */
    flapRollPitchAuthority: Object.freeze([
        { rollMul: 1, pitchMul: 1 },
        { rollMul: 0.94, pitchMul: 0.9 },
        { rollMul: 0.88, pitchMul: 0.85 },
        { rollMul: 0.8, pitchMul: 0.78 },
        { rollMul: 0.74, pitchMul: 0.72 },
        { rollMul: 0.68, pitchMul: 0.66 },
        { rollMul: 0.62, pitchMul: 0.6 }
    ])
});

/**
 * B787 系の目安 Vfe（kt）。インデックス 0=Flaps1 … 5=Flaps30。
 * 出典: 一般向け運用資料・ACAPS 系の公開値域（ゲーム近似）
 * @type {readonly number[]}
 */
export const FLAP_VFE_KNOTS = Object.freeze([250, 230, 215, 210, 190, 180]);

/**
 * B787-9 目安をベースにした操縦パラメータ（公開仕様＋ゲーム換算の推論値）。
 * 出典例: 最大速度 Mach 0.90（≈296 m/s 付近）、バンク保護約67°、ロール率15–20°/s、
 * 離陸ローテーション約1°/s、乾燥滑走路タイヤμ≈0.7–0.85（推論）、着陸減速度目安≈4–6 m/s²（推論）
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_AIRCRAFT_PHYSICS = Object.freeze({
    /** 機体に働く重力加速度 (m/s²)。地球標準 9.81 */
    gravity: 9.81,
    /** 最大推進速度 (m/s)。ユーザー指定 default 254 */
    maxThrustSpeed: 254,
    /** ヨー: 最大姿勢角 (°)。ラダー・側滑の粗い上限（推論） */
    yawMaxDeg: 12,
    /** ヨー: 最大角速度 (rad/s)。巡航ターン約3°/s ≈ 0.052 */
    yawMaxRate: 0.052,
    /** ヨー: 最大角加速度 (rad/s²)。推論 */
    yawMaxAccel: 0.08,
    /** ピッチ: 最大姿勢角 (°)。機首上下の粗い上限（推論） */
    pitchMaxDeg: 25,
    /** ピッチ: 最大角速度 (rad/s)。運用目安 2–3°/s */
    pitchMaxRate: 0.052,
    /** ピッチ: 最大角加速度 (rad/s²)。推論 */
    pitchMaxAccel: 0.06,
    /** ロール: 最大バンク角 (°)。FBW 保護上限の公開値 67° 付近 */
    rollMaxDeg: 67,
    /** ロール: 最大角速度 (rad/s)。17°/s */
    rollMaxRate: 0.297,
    /** ロール: 最大角加速度 (rad/s²)。推論 */
    rollMaxAccel: 0.35,
    /** タイヤ静止摩擦係数 μs（乾燥舗装・航空タイヤの一般値域、推論） */
    tireStaticFriction: 0.78,
    /** タイヤ動摩擦係数 μk（推論） */
    tireKineticFriction: 0.55,
    /** フラップ UP 時の揚力係数 (1/s)×水平速度。巡航で重量支持のゲーム換算（推論） */
    flapLiftCoeff0: 0.078,
    flapLiftCoeff1: 0.082,
    flapLiftCoeff2: 0.086,
    flapLiftCoeff3: 0.091,
    flapLiftCoeff4: 0.094,
    flapLiftCoeff5: 0.097,
    flapLiftCoeff6: 0.1,
    /** エンジン最大回転数 (RPM)。HUD・推力の基準（ゲーム表示用の目安） */
    engineMaxRpm: 10500,
    /** 上下矢印でスロットル 0–1 が変化する速度 (1/s)。全開まで約5–6 s（推論） */
    throttleSpoolPerS: 0.18,
    /** 目標回転数へ追従する回転数加速度 (RPM/s)。maxRpm まで約5–6 s（推論） */
    engineRpmAccel: 1890,
    /** 最大回転数時の前進推力加速度 (m/s²)。787-9 推力/重量比 ≈2.5（推論） */
    thrustAccelPerEngineRpm: 2.5,
    /** Space ブレーキ減速度 (m/s²)。着陸 autobrake 高めの目安（推論） */
    tireBrakeAccel: 5.5
});

const FLAP_LIFT_KEYS = Object.freeze([
    'flapLiftCoeff0',
    'flapLiftCoeff1',
    'flapLiftCoeff2',
    'flapLiftCoeff3',
    'flapLiftCoeff4',
    'flapLiftCoeff5',
    'flapLiftCoeff6'
]);

/**
 * フラップ段階 i（0=UP … 6=30）のロール・ピッチ権限乗数
 * @param {number} flapIndex
 * @returns {{ rollMul: number, pitchMul: number }}
 */
export function flapAuthorityMultipliers(flapIndex) {
    const idx = Math.round(Number(flapIndex));
    const i = Math.max(0, Math.min(6, Number.isFinite(idx) ? idx : 0));
    const table = AIRCRAFT_PHYSICS_INTERNAL.flapRollPitchAuthority;
    return table[i] || table[0];
}

/**
 * フラップ段階の揚力係数 (1/s)×vH
 * @param {number} flapIndex
 * @param {Record<string, number>} ph merge 済み physics
 * @returns {number}
 */
export function flapLiftCoeff(flapIndex, ph) {
    const idx = Math.round(Number(flapIndex));
    const i = Math.max(0, Math.min(6, Number.isFinite(idx) ? idx : 0));
    const key = FLAP_LIFT_KEYS[i];
    const v = ph[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return /** @type {number} */ (DEFAULT_AIRCRAFT_PHYSICS[key]);
}

/**
 * フラップ段階に対する Vfe（m/s）。UP は制限なし（Infinity）
 * @param {number} flapIndex
 * @returns {number}
 */
/**
 * エンジン回転数 (RPM) から前進推力加速度 (m/s²) を算出する（最大回転数で thrustAccelPerEngineRpm）
 * @param {number} engineRpm
 * @param {Record<string, number>} ph merge 済み physics
 * @returns {number}
 */
export function thrustAccelFromEngineRpm(engineRpm, ph) {
    const max = ph.engineMaxRpm;
    if (!(max > 0) || !Number.isFinite(engineRpm)) return 0;
    const rpm = Math.max(0, engineRpm);
    return (rpm / max) * ph.thrustAccelPerEngineRpm;
}

export function flapVfeMs(flapIndex) {
    const idx = Math.round(Number(flapIndex));
    const i = Math.max(0, Math.min(6, Number.isFinite(idx) ? idx : 0));
    if (i <= 0) return Infinity;
    const kt = FLAP_VFE_KNOTS[Math.min(i - 1, FLAP_VFE_KNOTS.length - 1)];
    return kt * KNOTS_TO_MS;
}

/**
 * 旧 physics JSON を新キーへ写す（保存データ互換）
 * @param {Record<string, unknown>} r
 */
function applyLegacyPhysicsAliases(r) {
    if (typeof r.maxSpeed === 'number' && typeof r.maxThrustSpeed !== 'number') {
        r.maxThrustSpeed = r.maxSpeed;
    }
    if (typeof r.maxBankDeg === 'number' && typeof r.rollMaxDeg !== 'number') {
        r.rollMaxDeg = r.maxBankDeg;
    }
    if (typeof r.wheelBrakeDecel === 'number' && typeof r.tireBrakeAccel !== 'number') {
        r.tireBrakeAccel = r.wheelBrakeDecel;
    }
    if (typeof r.throttleSpoolPerS !== 'number' && typeof r.engineRpmAccelPerThrottle === 'number') {
        r.throttleSpoolPerS = r.engineRpmAccelPerThrottle;
    }
    if (typeof r.engineRpmAccel !== 'number') {
        const spool =
            (typeof r.throttleSpoolPerS === 'number' ? r.throttleSpoolPerS : undefined) ??
            (typeof r.engineRpmAccelPerThrottle === 'number' ? r.engineRpmAccelPerThrottle : undefined);
        const maxRpm =
            typeof r.engineMaxRpm === 'number' && Number.isFinite(r.engineMaxRpm)
                ? r.engineMaxRpm
                : DEFAULT_AIRCRAFT_PHYSICS.engineMaxRpm;
        if (typeof spool === 'number' && maxRpm > 0) r.engineRpmAccel = spool * maxRpm;
    }
    if (typeof r.thrustAccel === 'number' && typeof r.thrustAccelPerEngineRpm !== 'number') {
        r.thrustAccelPerEngineRpm = r.thrustAccel;
    }
    const avg = (a, b) => {
        const xs = [a, b].filter((x) => typeof x === 'number' && Number.isFinite(x));
        return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
    };
    if (typeof r.yawMaxAccel !== 'number') {
        const v = avg(r.yawAccelGround, r.yawAccelAir) ?? r.yawAccel;
        if (typeof v === 'number') r.yawMaxAccel = v;
    }
    if (typeof r.pitchMaxAccel !== 'number') {
        const v = avg(r.pitchAccelGround, r.pitchAccelAir) ?? r.pitchAccel;
        if (typeof v === 'number') r.pitchMaxAccel = v;
    }
    if (typeof r.rollMaxAccel !== 'number' && typeof r.rollAccel === 'number') {
        r.rollMaxAccel = r.rollAccel;
    }
    if (typeof r.yawMaxRate !== 'number') {
        const v = avg(r.yawMaxRateGround, r.yawMaxRateAir) ?? r.yawRate ?? r.yawMaxRate;
        if (typeof v === 'number') r.yawMaxRate = v;
    }
    if (typeof r.pitchMaxRate !== 'number') {
        const v = avg(r.pitchMaxRateGround, r.pitchMaxRateAir) ?? r.pitchRate ?? r.pitchMaxRate;
        if (typeof v === 'number') r.pitchMaxRate = v;
    }
    if (typeof r.rollMaxRate !== 'number' && typeof r.rollRate === 'number') {
        r.rollMaxRate = r.rollRate;
    }
    if (typeof r.groundTireLateralDecel === 'number' && typeof r.tireKineticFriction !== 'number') {
        const g =
            typeof r.gravity === 'number' && Number.isFinite(r.gravity)
                ? r.gravity
                : DEFAULT_AIRCRAFT_PHYSICS.gravity;
        if (g > 0) r.tireKineticFriction = r.groundTireLateralDecel / g;
    }
    if (typeof r.liftPerHorizontalSpeed === 'number') {
        const base = r.liftPerHorizontalSpeed;
        const legacyMul = [1, 1.05, 1.1, 1.16, 1.2, 1.24, 1.28];
        for (let i = 0; i < FLAP_LIFT_KEYS.length; i++) {
            const k = FLAP_LIFT_KEYS[i];
            if (typeof r[k] !== 'number') r[k] = base * legacyMul[i];
        }
    }
}

/**
 * @param {string} key
 * @param {number} v
 * @returns {number}
 */
function clipPhysicsValue(key, v) {
    if (key === 'gravity') return Math.max(0.1, v);
    if (key === 'maxThrustSpeed') return Math.max(1, v);
    if (key.endsWith('Deg')) return Math.max(1, v);
    if (key.endsWith('MaxRate')) return Math.max(0.005, v);
    if (key.endsWith('MaxAccel')) return Math.max(0.01, v);
    if (key.startsWith('flapLiftCoeff')) return Math.max(0, v);
    if (key === 'tireStaticFriction' || key === 'tireKineticFriction') {
        return Math.max(0.05, v);
    }
    if (key === 'engineMaxRpm') return Math.max(100, v);
    if (key === 'throttleSpoolPerS') return Math.max(0.02, v);
    if (key === 'engineRpmAccel') return Math.max(10, v);
    if (key === 'thrustAccelPerEngineRpm') return Math.max(0.1, v);
    if (key === 'tireBrakeAccel') return Math.max(0.5, v);
    return Math.max(0.001, v);
}

/**
 * worlds.json の aircraftPhysics を既定値でマージし、下限のみクランプする。
 * @param {Record<string, unknown>|null|undefined} raw
 */
export function mergeAircraftPhysicsFromWorld(raw) {
    const base = { ...DEFAULT_AIRCRAFT_PHYSICS };
    if (!raw || typeof raw !== 'object') return base;
    const r = { ...raw };
    applyLegacyPhysicsAliases(r);

    for (const k of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const v = r[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        base[k] = clipPhysicsValue(k, v);
    }
    return base;
}

/**
 * ワールド共通の aircraftPhysics に、この機体の上書きをマージした操縦パラメータを返す。
 * @param {Record<string, unknown>|null|undefined} worldRaw
 * @param {Record<string, unknown>|null|undefined} objectOverrideRaw
 * @returns {ReturnType<typeof mergeAircraftPhysicsFromWorld>}
 */
export function mergeAircraftPhysicsForObject(worldRaw, objectOverrideRaw) {
    const worldMerged = mergeAircraftPhysicsFromWorld(worldRaw);
    if (!objectOverrideRaw || typeof objectOverrideRaw !== 'object' || Array.isArray(objectOverrideRaw)) {
        return worldMerged;
    }
    return mergeAircraftPhysicsFromWorld({ ...worldMerged, ...objectOverrideRaw });
}

/**
 * ユーザーが貼り付けた JSON から、既知キーのみを下限クランプした機体上書きオブジェクトを返す。
 * @param {unknown} raw
 * @returns {Record<string, number>|null}
 */
export function clipAircraftPhysicsPartialFromUser(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const merged = mergeAircraftPhysicsFromWorld(raw);
    /** @type {Record<string, number>} */
    const out = {};
    for (const k of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        const v = raw[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        out[k] = merged[k];
    }
    return Object.keys(out).length ? out : null;
}
