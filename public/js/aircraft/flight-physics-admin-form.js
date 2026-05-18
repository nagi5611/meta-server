// public/js/aircraft/flight-physics-admin-form.js — 飛行機管理パネル用・操縦パラメータ入力（DEFAULT キーから生成）

import { DEFAULT_AIRCRAFT_PHYSICS, mergeAircraftPhysicsFromWorld } from '../../../addons/aircraft/client/aircraft-physics-defaults.js';

/** @type {Record<string, string>} */
const LABEL_JA = {
    maxSpeed: '最高速度 (m/s)',
    thrustAccel: '推力加速度 (m/s²)',
    drag: '速度維持率（毎フレーム乗算）',
    yawAccelGround: 'ヨー角加速度 接地 (rad/s²)',
    yawAccelAir: 'ヨー角加速度 空中 (rad/s²)',
    pitchAccelGround: 'ピッチ角加速度 接地 (rad/s²)',
    pitchAccelAir: 'ピッチ角加速度 空中 (rad/s²)',
    rollAccel: 'ロール角加速度 (rad/s²)',
    yawMaxRateGround: 'ヨー最高角速度 接地 (rad/s)',
    yawMaxRateAir: 'ヨー最高角速度 空中 (rad/s)',
    pitchMaxRateGround: 'ピッチ最高角速度 接地 (rad/s)',
    pitchMaxRateAir: 'ピッチ最高角速度 空中 (rad/s)',
    rollMaxRate: 'ロール最高角速度 (rad/s)',
    angularDecel: '角速度減衰 入力オフ (rad/s²)',
    yawGroundFrictionLeft: '接地ヨー摩擦 左/Q 側 (rad/s²)',
    yawGroundFrictionRight: '接地ヨー摩擦 右/E 側 (rad/s²)',
    groundTireLateralDecel: 'タイヤ横滑り減速度 (m/s²)',
    groundTireRollingDecel: 'タイヤ転がり抵抗 (m/s²)',
    wheelBrakeDecel: 'Space ブレーキ減速度 (m/s²)',
    sideslipDamping: '側滑り減衰 (1/s)',
    excessClimbDamping: '上向き速度減衰 (1/s)',
    gravity: '重力 (m/s²)',
    liftPerHorizontalSpeed: '揚力係数 (1/s)',
    throttleSpoolPerS: 'スロットル変化率 (1/s)',
    maxBankDeg: 'バンク角上限 (°)',
    rudderAuthorityRefSpeedMs: 'ラダー権限参照速度 (m/s、0=最高速度)',
    rudderAuthorityMinScale: '高速ラダー下限スケール',
    thrustPitchFromThrottleDelta: '推力ピッチ係数',
    thrustPitchRelaxNoInput: 'ピッチ無入力時緩和 (1/s)',
    flapPitchDownAuthority: 'フラップ時機首下げ権限 (0–1)',
};

/**
 * @param {HTMLElement|null} container
 */
export function mountFlightPhysicsForm(container) {
    if (!container) return;
    container.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '0 0 8px';
    hint.textContent = '数値は保存時にクリップされます。未入力は既定値です。';
    container.appendChild(hint);
    for (const key of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const def = /** @type {number} */ (DEFAULT_AIRCRAFT_PHYSICS[/** @type {keyof typeof DEFAULT_AIRCRAFT_PHYSICS} */ (key)]);
        const row = document.createElement('div');
        row.className = 'field-row';
        const lab = document.createElement('label');
        lab.className = 'prop-label';
        lab.setAttribute('for', `ac-flight-${key}`);
        lab.textContent = LABEL_JA[key] || key;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.id = `ac-flight-${key}`;
        inp.className = 'prop-input num';
        inp.step = key === 'drag' ? '0.001' : key.includes('Deg') ? '1' : '0.05';
        inp.value = String(def);
        row.appendChild(lab);
        row.appendChild(inp);
        container.appendChild(row);
    }
}

/**
 * @returns {Record<string, number>}
 */
export function readFlightPhysicsFromForm() {
    /** @type {Record<string, number>} */
    const raw = {};
    for (const key of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const el = document.getElementById(`ac-flight-${key}`);
        const n = el && 'value' in el ? parseFloat(/** @type {HTMLInputElement} */ (el).value) : NaN;
        if (Number.isFinite(n)) raw[key] = n;
    }
    return mergeAircraftPhysicsFromWorld(raw);
}

/**
 * @param {Record<string, unknown>|null|undefined} flightPhysics
 */
export function fillFlightPhysicsForm(flightPhysics) {
    const m = mergeAircraftPhysicsFromWorld(flightPhysics);
    for (const key of Object.keys(DEFAULT_AIRCRAFT_PHYSICS)) {
        const el = document.getElementById(`ac-flight-${key}`);
        if (el && 'value' in el) {
            /** @type {HTMLInputElement} */ (el).value = String(m[/** @type {keyof typeof m} */ (key)]);
        }
    }
}
