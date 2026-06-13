// public/js/world-rod-resolve.js — ワールド品質ロッドの正規化・解決（Admin / Client / Server 共用）

/** @typedef {{ id: string, label: string, description: string }} WorldRodEntry */

export const DEFAULT_ROD_ID = 'rod-1';

const DEFAULT_ROD_LABEL = 'ロッド1';

/**
 * ワールドに rods 配列の骨格を保証し、ロッド1を必ず含める
 * @param {Record<string, unknown>|null|undefined} world
 */
export function ensureWorldRodsShape(world) {
    if (!world || typeof world !== 'object') return;
    if (!Array.isArray(world.rods)) {
        world.rods = [];
    }
    const rods = /** @type {WorldRodEntry[]} */ (world.rods);
    const hasRod1 = rods.some((r) => r && String(r.id || '').trim() === DEFAULT_ROD_ID);
    if (!hasRod1) {
        rods.unshift({
            id: DEFAULT_ROD_ID,
            label: DEFAULT_ROD_LABEL,
            description: '',
        });
    }
}

/**
 * ワールド内で未使用の rod-N ID を生成する
 * @param {Record<string, unknown>} world
 * @returns {string}
 */
export function generateUniqueRodId(world) {
    ensureWorldRodsShape(world);
    const rods = /** @type {WorldRodEntry[]} */ (world.rods);
    const used = new Set(rods.map((r) => String(r?.id || '').trim()).filter(Boolean));
    let n = rods.length + 1;
    while (used.has(`rod-${n}`)) n++;
    return `rod-${n}`;
}

/**
 * モデルがプレファブかどうか
 * @param {Record<string, unknown>|null|undefined} model
 * @returns {boolean}
 */
export function isPrefabModelConfig(model) {
    if (!model || typeof model !== 'object') return false;
    return !!String(model.prefabManifest || '').trim();
}

/**
 * ロッド ID に対応する prefabManifest を解決する
 * @param {Record<string, unknown>|null|undefined} modelConfig
 * @param {string} rodId
 * @returns {string}
 */
export function resolvePrefabManifestForRod(modelConfig, rodId) {
    if (!modelConfig || typeof modelConfig !== 'object') return '';
    const base = String(modelConfig.prefabManifest || '').trim();
    const rid = String(rodId || DEFAULT_ROD_ID).trim() || DEFAULT_ROD_ID;
    if (rid === DEFAULT_ROD_ID) return base;

    const overrides = modelConfig.rodOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base;

    const entry = /** @type {Record<string, unknown>} */ (overrides)[rid];
    if (!entry || typeof entry !== 'object') return base;

    const overrideManifest = String(entry.prefabManifest || '').trim();
    return overrideManifest || base;
}

/**
 * ロッド用に models[] を浅いコピーし prefabManifest / path を解決する
 * @param {unknown[]} models
 * @param {string} rodId
 * @returns {Record<string, unknown>[]}
 */
export function resolveWorldModelsForRod(models, rodId) {
    const list = Array.isArray(models) ? models : [];
    const rid = String(rodId || DEFAULT_ROD_ID).trim() || DEFAULT_ROD_ID;

    return list.map((raw) => {
        if (!raw || typeof raw !== 'object') return /** @type {Record<string, unknown>} */ ({ ...(raw || {}) });
        const src = /** @type {Record<string, unknown>} */ (raw);
        const out = { ...src };

        if (!isPrefabModelConfig(src)) return out;

        const resolved = resolvePrefabManifestForRod(src, rid);
        if (resolved) {
            out.prefabManifest = resolved;
            if (!String(out.path || '').trim() || String(out.path).trim() === String(src.prefabManifest || '').trim()) {
                out.path = resolved;
            }
        }
        return out;
    });
}

/**
 * ロッド2以上が定義されているか（入室ポップアップ表示条件）
 * @param {Record<string, unknown>|null|undefined} world
 * @returns {boolean}
 */
export function worldHasMultipleRods(world) {
    if (!world || typeof world !== 'object') return false;
    ensureWorldRodsShape(world);
    const rods = /** @type {WorldRodEntry[]} */ (world.rods);
    return rods.length >= 2;
}

/**
 * 1 ワールドの rods と models[].rodOverrides を正規化する
 * @param {Record<string, unknown>} world
 */
export function normalizeWorldRodSystem(world) {
    if (!world || typeof world !== 'object') return;
    ensureWorldRodsShape(world);

    const rawRods = /** @type {unknown[]} */ (world.rods);
    /** @type {WorldRodEntry[]} */
    const normalized = [];
    const seen = new Set();

    for (const raw of rawRods) {
        if (!raw || typeof raw !== 'object') continue;
        const r = /** @type {Record<string, unknown>} */ (raw);
        let id = String(r.id || '').trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        normalized.push({
            id,
            label: r.label != null && String(r.label).trim() ? String(r.label).trim() : id,
            description: r.description != null ? String(r.description) : '',
        });
    }

    const hasRod1 = normalized.some((r) => r.id === DEFAULT_ROD_ID);
    if (!hasRod1) {
        normalized.unshift({
            id: DEFAULT_ROD_ID,
            label: DEFAULT_ROD_LABEL,
            description: '',
        });
    } else {
        const rod1 = normalized.find((r) => r.id === DEFAULT_ROD_ID);
        if (rod1 && !String(rod1.label || '').trim()) {
            rod1.label = DEFAULT_ROD_LABEL;
        }
    }

    world.rods = normalized;
    const validRodIds = new Set(normalized.map((r) => r.id));

    const models = Array.isArray(world.models) ? world.models : [];
    for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        const cfg = /** @type {Record<string, unknown>} */ (m);

        if (!isPrefabModelConfig(cfg)) {
            delete cfg.rodOverrides;
            continue;
        }

        const overrides = cfg.rodOverrides;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
            delete cfg.rodOverrides;
            continue;
        }

        /** @type {Record<string, { prefabManifest: string }>} */
        const cleaned = {};
        for (const [key, val] of Object.entries(overrides)) {
            if (key === DEFAULT_ROD_ID) continue;
            if (!validRodIds.has(key)) continue;
            if (!val || typeof val !== 'object') continue;
            const manifest = String(/** @type {Record<string, unknown>} */ (val).prefabManifest || '').trim();
            if (!manifest) continue;
            cleaned[key] = { prefabManifest: manifest };
        }

        if (Object.keys(cleaned).length > 0) {
            cfg.rodOverrides = cleaned;
        } else {
            delete cfg.rodOverrides;
        }
    }
}

/**
 * 全ワールドに対してロッド正規化を行う（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 */
export function normalizeWorldsRod(worlds) {
    if (!worlds || typeof worlds !== 'object') return;
    for (const w of Object.values(worlds)) {
        if (w && typeof w === 'object') normalizeWorldRodSystem(/** @type {Record<string, unknown>} */ (w));
    }
}
