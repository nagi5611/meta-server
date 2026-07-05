// public/js/aircraft/airframe-definition-schema.js — 機体ライブラリのロール列挙と既定アニメ JSON（管理画面用・/js 配下で配信）

/** 機体アニメーション用パーツロール */
export const AIRFRAME_ROLE_KEYS = [
    'engineBlade',
    'tire',
    'gear',
    'fuselage',
];

/** 管理 UI 表示名 */
export const AIRFRAME_ROLE_LABELS = Object.freeze({
    engineBlade: 'エンジンブレード',
    tire: 'タイヤ',
    gear: 'ギア',
    fuselage: '胴体',
});

/**
 * ロールの表示名を返す
 * @param {string} role
 * @returns {string}
 */
export function roleDisplayLabel(role) {
    const r = String(role || '').trim();
    return AIRFRAME_ROLE_LABELS[/** @type {keyof typeof AIRFRAME_ROLE_LABELS} */ (r)] || r;
}

/**
 * 空のバインドマップ（ロール → 名前パス配列）
 * @returns {Record<string, string[]>}
 */
export function emptyBindings() {
    return {};
}

/**
 * ロールに紐づく名前パス一覧（レガシー単一文字列も配列として解釈）
 * @param {unknown} rawBindings
 * @param {string} role
 * @returns {string[]}
 */
export function bindingPathsForRole(rawBindings, role) {
    const r = String(role || '').trim();
    if (!r || !isKnownRole(r)) return [];
    if (!isObj(rawBindings)) return [];
    const v = rawBindings[r];
    if (Array.isArray(v)) {
        return v.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
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
 * 保存前にバインドを正規化（未知キーは落とす。各ロールは複数パス可）
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export function normalizeBindings(raw) {
    if (!isObj(raw)) return {};
    /** @type {Record<string, string[]>} */
    const out = {};
    const MAX_PER_ROLE = 64;
    for (const k of AIRFRAME_ROLE_KEYS) {
        const v = raw[k];
        /** @type {string[]} */
        const paths = [];
        if (Array.isArray(v)) {
            for (const item of v) {
                const p = typeof item === 'string' ? item.trim() : '';
                if (!p) continue;
                if (!paths.includes(p)) paths.push(p);
                if (paths.length >= MAX_PER_ROLE) break;
            }
        } else if (typeof v === 'string' && v.trim()) {
            paths.push(v.trim());
        }
        if (paths.length) out[k] = paths;
    }
    return out;
}
