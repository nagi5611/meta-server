// public/js/aircraft/airframe-definition-schema.js — 機体ライブラリのロール列挙と既定アニメ JSON（管理画面用・/js 配下で配信）

/** 割り当て可能なパーツロール */
export const AIRFRAME_ROLE_KEYS = [
    'engineBlade',
    'tire',
    'gear',
    'fuselage',
];

/** 管理 UI 表示用ラベル */
export const AIRFRAME_ROLE_LABELS = Object.freeze({
    engineBlade: 'エンジンブレード',
    tire: 'タイヤ',
    gear: 'ギア',
    fuselage: '胴体',
});

/**
 * @param {string} role
 * @returns {string}
 */
export function airframeRoleLabel(role) {
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
 * @param {unknown} rawBindings
 * @param {string} roleKey
 * @returns {string[]}
 */
function pathsFromBindingField(rawBindings, roleKey) {
    if (!isObj(rawBindings)) return [];
    const v = rawBindings[roleKey];
    if (Array.isArray(v)) {
        return v.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
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
    const paths = pathsFromBindingField(rawBindings, r);
    if (r === 'gear' && !paths.length) {
        return pathsFromBindingField(rawBindings, 'landingGear');
    }
    return paths;
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
        flap: {
            hingeAxis: 'x',
            maxAngleRad: 0.52,
            maxOmegaRadPerS: 1.1,
            signL: 1,
            signR: -1,
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
    /** @type {Record<string, unknown>} */
    const migrated = { ...raw };
    if (migrated.landingGear && !migrated.gear) {
        migrated.gear = migrated.landingGear;
    }
    /** @type {Record<string, string[]>} */
    const out = {};
    const MAX_PER_ROLE = 64;
    for (const k of AIRFRAME_ROLE_KEYS) {
        const v = migrated[k];
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
