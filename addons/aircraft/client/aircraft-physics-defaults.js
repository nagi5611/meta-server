// addons/aircraft/client/aircraft-physics-defaults.js — 飛行機操縦の数値デフォルト（THREE に依存しない）

/** ノット→m/s（ICAO 標準換算） */
export const KNOTS_TO_MS = 0.514444;

/**
 * B787 系の目安 Vfe（kt）。インデックス 0=Flaps1 … 5=Flaps30。一般向け資料ベースのゲーム近似。
 * @type {readonly number[]}
 */
export const FLAP_VFE_KNOTS = Object.freeze([250, 230, 215, 210, 190, 180]);

/**
 * @type {Readonly<{
 *   maxSpeed: number,
 *   thrustAccel: number,
 *   drag: number,
 *   yawAccelGround: number,
 *   yawAccelAir: number,
 *   pitchAccelGround: number,
 *   pitchAccelAir: number,
 *   rollAccel: number,
 *   yawMaxRateGround: number,
 *   yawMaxRateAir: number,
 *   pitchMaxRateGround: number,
 *   pitchMaxRateAir: number,
 *   rollMaxRate: number,
 *   angularDecel: number,
 *   yawGroundFrictionLeft: number,
 *   yawGroundFrictionRight: number,
 *   groundTireLateralDecel: number,
 *   groundTireRollingDecel: number,
 *   wheelBrakeDecel: number,
 *   sideslipDamping: number,
 *   excessClimbDamping: number,
 *   gravity: number,
 *   liftPerHorizontalSpeed: number,
 *   throttleSpoolPerS: number,
 *   maxBankDeg: number,
 *   rudderAuthorityRefSpeedMs: number,
 *   rudderAuthorityMinScale: number,
 *   thrustPitchFromThrottleDelta: number,
 *   thrustPitchRelaxNoInput: number,
 *   flapPitchDownAuthority: number
 * }>}
 */
export const DEFAULT_AIRCRAFT_PHYSICS = Object.freeze({
    maxSpeed: 45,
    thrustAccel: 18,
    drag: 0.985,
    yawAccelGround: 5,
    yawAccelAir: 5,
    pitchAccelGround: 4,
    pitchAccelAir: 4,
    rollAccel: 3.5,
    yawMaxRateGround: 1.1,
    yawMaxRateAir: 1.1,
    pitchMaxRateGround: 0.9,
    /** 空中ピッチ率の目安は一般向け B787 解説（数°/s）に寄せたゲーム値（rad/s） */
    pitchMaxRateAir: 0.055,
    /** ロール率 ≈17°/s（15〜20°/s の中間）相当のゲーム値 */
    rollMaxRate: 0.31,
    /** 入力オフ時の角速度減速 (rad/s²) */
    angularDecel: 3,
    /** 接地中・ヨー角速度が負（A/左寄り）のときに加算する減速 (rad/s²)。angularDecel に加算 */
    yawGroundFrictionLeft: 0,
    /** 接地中・ヨー角速度が正（D/右寄り）のときに加算する減速 (rad/s²) */
    yawGroundFrictionRight: 0,
    /**
     * 接地タイヤの横滑り減速度 (m/s²)。前進軸に垂直な水平速度を減衰。
     * 0 のときは従来どおり、横成分を即時に除去（前進方向への射影のみ）。
     */
    groundTireLateralDecel: 0,
    /** 接地タイヤの転がり抵抗 (m/s²)。前後速度を減速。Space ブレーキとは別。0 で無効 */
    groundTireRollingDecel: 0,
    /** 接地中・Space タイヤブレーキ時の前後速度減速度 (m/s²) */
    wheelBrakeDecel: 32,
    /** 空中のみ: 速度の機体前後軸に垂直な成分を exp(-k*dt) で減衰 (1/s)。0 で無効 */
    sideslipDamping: 0,
    /** 空中かつ上向き速度時のみ vy を exp(-k*dt) で減衰 (1/s)。揚力の積み上がりを抑える。0 で無効 */
    excessClimbDamping: 0,
    gravity: 9.81,
    liftPerHorizontalSpeed: 0.35,
    /** スロットルレバー押しっぱなし時の変化率（1 秒あたりの無次元スロットル量） */
    throttleSpoolPerS: 1.2,
    /** ワールド YXZ ロール（バンク）上限（度）。787 向けは 67 などをワールドで指定可能 */
    maxBankDeg: 30,
    /** ラダー権限が最小になる参考速度 (m/s)。0 のとき maxSpeed を使用 */
    rudderAuthorityRefSpeedMs: 0,
    /** 参考速度以上でラダー最高角速度・角加速度に掛ける下限スケール（FBW の高速ラダー・リミット近似） */
    rudderAuthorityMinScale: 0.15,
    /** d(throttle)/dt に比例して加えるピッチ角速度 (rad / (無次元/秒)) — 推力変化の機首上げ近似 */
    thrustPitchFromThrottleDelta: 0.14,
    /** ピッチ入力ゼロ時、推力由来ピッチ角速度を指数で戻す係数 (1/s) */
    thrustPitchRelaxNoInput: 5,
    /**
     * フラップ展開中、機首下げ入力（S）に掛ける権限係数 0〜1（マイナス G 制限の粗い近似）
     */
    flapPitchDownAuthority: 0.22
});

/**
 * フラップ段階 i（0=UP … 6=30）の揚力・ロール・ピッチに掛ける乗数（FBW「フラップ展開でマイルド」＋揚力増の近似）
 * @param {number} flapIndex
 * @returns {{ liftMul: number, rollMul: number, pitchMul: number }}
 */
export function flapAuthorityMultipliers(flapIndex) {
    const idx = Math.round(Number(flapIndex));
    const i = Math.max(0, Math.min(6, Number.isFinite(idx) ? idx : 0));
    /** @type {readonly { liftMul: number, rollMul: number, pitchMul: number }[]} */
    const table = [
        { liftMul: 1, rollMul: 1, pitchMul: 1 },
        { liftMul: 1.05, rollMul: 0.94, pitchMul: 0.9 },
        { liftMul: 1.1, rollMul: 0.88, pitchMul: 0.85 },
        { liftMul: 1.16, rollMul: 0.8, pitchMul: 0.78 },
        { liftMul: 1.2, rollMul: 0.74, pitchMul: 0.72 },
        { liftMul: 1.24, rollMul: 0.68, pitchMul: 0.66 },
        { liftMul: 1.28, rollMul: 0.62, pitchMul: 0.6 }
    ];
    return table[i];
}

/**
 * フラップ段階に対する Vfe（m/s）。UP は制限なし（Infinity）
 * @param {number} flapIndex
 * @returns {number}
 */
export function flapVfeMs(flapIndex) {
    const idx = Math.round(Number(flapIndex));
    const i = Math.max(0, Math.min(6, Number.isFinite(idx) ? idx : 0));
    if (i <= 0) return Infinity;
    const kt = FLAP_VFE_KNOTS[Math.min(i - 1, FLAP_VFE_KNOTS.length - 1)];
    return kt * KNOTS_TO_MS;
}

/**
 * worlds.json の aircraftPhysics を既定値でマージして検証クリップする。
 * 旧キー pitchRate / rollRate は最高角速度として読み替える。yawRate はヨー最高角速度（接地・空中の両方）に読み替える。
 * 旧 pitchAccel / pitchMaxRate は接地・空中の両方にコピーする。
 * 旧 yawAccel は yawAccelGround / yawAccelAir の両方にコピーする。
 * 旧 yawMaxRate / yawRate は yawMaxRateGround / yawMaxRateAir の両方にコピーする。
 * @param {Record<string, unknown>|null|undefined} raw
 */
export function mergeAircraftPhysicsFromWorld(raw) {
    const base = { ...DEFAULT_AIRCRAFT_PHYSICS };
    if (!raw || typeof raw !== 'object') return base;
    const r = { ...raw };
    if (typeof r.yawAccel === 'number') {
        if (typeof r.yawAccelGround !== 'number') r.yawAccelGround = r.yawAccel;
        if (typeof r.yawAccelAir !== 'number') r.yawAccelAir = r.yawAccel;
    }
    if (typeof r.yawMaxRate === 'number') {
        if (typeof r.yawMaxRateGround !== 'number') r.yawMaxRateGround = r.yawMaxRate;
        if (typeof r.yawMaxRateAir !== 'number') r.yawMaxRateAir = r.yawMaxRate;
    }
    if (typeof r.yawRate === 'number') {
        if (typeof r.yawMaxRateGround !== 'number') r.yawMaxRateGround = r.yawRate;
        if (typeof r.yawMaxRateAir !== 'number') r.yawMaxRateAir = r.yawRate;
    }
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
        } else if (k === 'groundTireLateralDecel' || k === 'groundTireRollingDecel') {
            base[k] = Math.min(500, Math.max(0, v));
        } else if (k === 'wheelBrakeDecel') {
            base[k] = Math.min(200, Math.max(0.5, v));
        } else if (k === 'throttleSpoolPerS') {
            base[k] = Math.min(5, Math.max(0.05, v));
        } else if (k === 'maxBankDeg') {
            base[k] = Math.min(85, Math.max(1, v));
        } else if (k === 'rudderAuthorityRefSpeedMs') {
            base[k] = Math.min(500, Math.max(0, v));
        } else if (k === 'rudderAuthorityMinScale') {
            base[k] = Math.min(1, Math.max(0.05, v));
        } else if (k === 'thrustPitchFromThrottleDelta') {
            base[k] = Math.min(2, Math.max(0, v));
        } else if (k === 'thrustPitchRelaxNoInput') {
            base[k] = Math.min(20, Math.max(0, v));
        } else if (k === 'flapPitchDownAuthority') {
            base[k] = Math.min(1, Math.max(0, v));
        } else if (k === 'pitchAccelGround' || k === 'pitchAccelAir' || k === 'yawAccelGround' || k === 'yawAccelAir') {
            base[k] = Math.min(40, Math.max(0.05, v));
        } else if (k === 'pitchMaxRateGround' || k === 'pitchMaxRateAir' || k === 'yawMaxRateGround' || k === 'yawMaxRateAir') {
            base[k] = Math.min(10, Math.max(0.02, v));
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
 * ユーザーが貼り付けた JSON から、既知キーのみをクリップした機体上書きオブジェクトを返す。
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
