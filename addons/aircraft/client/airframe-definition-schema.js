// addons/aircraft/client/airframe-definition-schema.js — 機体ライブラリのロール列挙と既定アニメ JSON

/** ワールド編集で割り当て可能なパーツロール（v1.1） */
export const AIRFRAME_ROLE_KEYS = [
    'engineBlade',
    'aileron_L',
    'aileron_R',
    'flap_L',
    'flap_R',
    'landingGear',
];

/**
 * 空のバインドマップ（ロール → 名前パス）
 * @returns {Record<string, string>}
 */
export function emptyBindings() {
    return {};
}

/**
 * エンジンブレード用の既定アニメーション定義（数値はゲーム内で上書き可）
 * @returns {Record<string, unknown>}
 */
export function defaultAnimationJson() {
    return {
        engineBlade: {
            maxAccelRadPerS2: 24,
            maxOmegaRadPerS: 140,
            spinAxis: 'z',
        },
    };
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * ロールキーが既知かどうか
 * @param {string} role
 * @returns {boolean}
 */
export function isKnownRole(role) {
    return AIRFRAME_ROLE_KEYS.includes(role);
}

/**
 * 保存前にバインドを正規化（未知キーは落とす）
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeBindings(raw) {
    if (!isObj(raw)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of AIRFRAME_ROLE_KEYS) {
        const v = raw[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
}
