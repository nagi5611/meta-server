// public/js/aircraft/flight-physics-easy-admin-form.js — easy 操縦パラメータ入力

import {
    DEFAULT_EASY_AIRCRAFT_PHYSICS,
    mergeEasyAircraftPhysicsFromWorld,
} from '../../../addons/aircraft/client/aircraft-physics-easy-defaults.js';

/** @type {Record<string, string>} */
const LABEL_JA = {
    maxSpeed: '最大速度 (m/s)',
    thrustAccel: '推力加速度 (m/s²)',
    drag: '速度減衰（毎フレーム乗算）',
    yawAccelGround: 'ヨー角加速度・地上 (rad/s²)',
    yawAccelAir: 'ヨー角加速度・空中 (rad/s²)',
    pitchAccelGround: 'ピッチ角加速度・地上 (rad/s²)',
    pitchAccelAir: 'ピッチ角加速度・空中 (rad/s²)',
    rollAccel: 'ロール角加速度 (rad/s²)',
    yawMaxRate: 'ヨー最大角速度 (rad/s)',
    pitchMaxRateGround: 'ピッチ最大角速度・地上 (rad/s)',
    pitchMaxRateAir: 'ピッチ最大角速度・空中 (rad/s)',
    rollMaxRate: 'ロール最大角速度 (rad/s)',
    angularDecel: '入力オフ時の角減速 (rad/s²)',
    yawGroundFrictionLeft: '地上ヨー摩擦・左 (rad/s²)',
    yawGroundFrictionRight: '地上ヨー摩擦・右 (rad/s²)',
    sideslipDamping: '側滑減衰 (1/s・0=無効)',
    excessClimbDamping: '上昇過剰減衰 (1/s・0=無効)',
    gravity: '重力 (m/s²)',
    liftPerHorizontalSpeed: '揚力係数×水平速度 (1/s)',
    wheelBrakeDecel: 'Space ブレーキ減速度・地上 (m/s²)',
};

/**
 * @param {HTMLElement|null} container
 */
export function mountEasyFlightPhysicsForm(container) {
    if (!container) return;
    container.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '0 0 8px';
    hint.textContent =
        'Easy（アーケード）操縦用。W/S=推力、A/D=ヨー、矢印=ピッチ/ロール、Space=地上ブレーキ、バンク ±30°。';
    container.appendChild(hint);
    for (const key of Object.keys(DEFAULT_EASY_AIRCRAFT_PHYSICS)) {
        const def = /** @type {number} */ (
            DEFAULT_EASY_AIRCRAFT_PHYSICS[/** @type {keyof typeof DEFAULT_EASY_AIRCRAFT_PHYSICS} */ (key)]
        );
        const row = document.createElement('div');
        row.className = 'field-row';
        const lab = document.createElement('label');
        lab.className = 'prop-label';
        lab.setAttribute('for', `ac-flight-easy-${key}`);
        lab.textContent = LABEL_JA[key] || key;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.id = `ac-flight-easy-${key}`;
        inp.className = 'prop-input num';
        inp.step = key === 'drag' ? '0.001' : key === 'maxSpeed' ? '1' : '0.01';
        inp.value = String(def);
        row.appendChild(lab);
        row.appendChild(inp);
        container.appendChild(row);
    }
}

/**
 * @returns {Record<string, number>}
 */
export function readEasyFlightPhysicsFromForm() {
    /** @type {Record<string, number>} */
    const raw = {};
    for (const key of Object.keys(DEFAULT_EASY_AIRCRAFT_PHYSICS)) {
        const el = document.getElementById(`ac-flight-easy-${key}`);
        const n = el && 'value' in el ? parseFloat(/** @type {HTMLInputElement} */ (el).value) : NaN;
        if (Number.isFinite(n)) raw[key] = n;
    }
    return mergeEasyAircraftPhysicsFromWorld(raw);
}

/**
 * @param {Record<string, unknown>|null|undefined} flightPhysics
 */
export function fillEasyFlightPhysicsForm(flightPhysics) {
    const m = mergeEasyAircraftPhysicsFromWorld(flightPhysics);
    for (const key of Object.keys(DEFAULT_EASY_AIRCRAFT_PHYSICS)) {
        const el = document.getElementById(`ac-flight-easy-${key}`);
        if (el && 'value' in el) {
            /** @type {HTMLInputElement} */ (el).value = String(m[key]);
        }
    }
}
