// public/js/aircraft/flight-physics-admin-form.js — 飛行機管理パネル用・操縦パラメータ入力（DEFAULT キーから生成）

import { DEFAULT_AIRCRAFT_PHYSICS, mergeAircraftPhysicsFromWorld } from '../../../addons/aircraft/client/aircraft-physics-defaults.js';

/** @type {Record<string, string>} */
const LABEL_JA = {
    maxThrustSpeed: '最大推進速度 (m/s)',
    yawMaxDeg: 'ヨー 最大角度 (°)',
    yawMaxRate: 'ヨー 最大角速度 (rad/s)',
    yawMaxAccel: 'ヨー 最大角加速度 (rad/s²)',
    pitchMaxDeg: 'ピッチ 最大角度 (°)',
    pitchMaxRate: 'ピッチ 最大角速度 (rad/s)',
    pitchMaxAccel: 'ピッチ 最大角加速度 (rad/s²)',
    rollMaxDeg: 'ロール 最大角度 (°)',
    rollMaxRate: 'ロール 最大角速度 (rad/s)',
    rollMaxAccel: 'ロール 最大角加速度 (rad/s²)',
    tireStaticFriction: 'タイヤ静止摩擦係数 μs',
    tireKineticFriction: 'タイヤ動摩擦係数 μk',
    flapLiftCoeff0: '揚力係数 Flap UP',
    flapLiftCoeff1: '揚力係数 Flap 1',
    flapLiftCoeff2: '揚力係数 Flap 5',
    flapLiftCoeff3: '揚力係数 Flap 15',
    flapLiftCoeff4: '揚力係数 Flap 20',
    flapLiftCoeff5: '揚力係数 Flap 25',
    flapLiftCoeff6: '揚力係数 Flap 30',
    engineMaxRpm: 'エンジン最大回転数 (RPM)',
    throttleSpoolPerS: 'スロットル変化速度 (1/s)',
    engineRpmAccel: 'エンジン回転数加速度 (RPM/s)',
    thrustAccelPerEngineRpm: '最大回転数時の推力加速度 (m/s²)',
    tireBrakeAccel: 'タイヤブレーキ減速度 (m/s²)',
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
    hint.textContent =
        'B787-9 目安の既定値です。保存時にクリップされます。旧キー（maxSpeed 等）は読み込み時に自動変換されます。';
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
        inp.step =
            key.includes('Friction') || key.startsWith('flapLiftCoeff')
                ? '0.001'
                : key.endsWith('Deg')
                  ? '1'
                  : '0.01';
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
