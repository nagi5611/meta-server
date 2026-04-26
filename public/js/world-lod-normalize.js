// public/js/world-lod-normalize.js — worlds.json の Prefab LOD 正規化（Admin / server 共用）

/** LOD 境界のヒステリシス（ランタイムと同値に揃える） */
export const PREFAB_LOD_HYSTERESIS = 0.05;

/** 描画距離に対する境界比の上限（異常値抑制） */
export const PREFAB_LOD_MAX_THRESHOLD_RATIO = 50;

/**
 * 数値配列を単調非減少・有限に正規化する
 * @param {unknown} raw
 * @param {number} expectedLen
 * @returns {number[]}
 */
export function normalizeThresholdRatios(raw, expectedLen) {
    const n = Math.max(0, Math.floor(expectedLen));
    if (n === 0) return [];
    let arr = [];
    if (Array.isArray(raw)) {
        arr = raw.map((v) => Number(v)).filter((x) => Number.isFinite(x));
    }
    if (arr.length < n) {
        const base = arr.length ? arr[arr.length - 1] : 1;
        while (arr.length < n) {
            arr.push(base + (arr.length + 1) * 0.5);
        }
    }
    if (arr.length > n) arr = arr.slice(0, n);
    let prev = 0.05;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        let v = Math.min(PREFAB_LOD_MAX_THRESHOLD_RATIO, Math.max(prev + 0.05, arr[i]));
        out.push(v);
        prev = v;
    }
    return out;
}

/**
 * ワールド内の lod ID 一覧を一意化する（重複エントリは先勝ちで間引き、しきい値は残るキーのみ保持）
 * @param {Record<string, unknown>} world
 */
export function dedupeWorldLodIds(world) {
    if (!world || typeof world !== 'object') return;
    const ls = world.lodSystem;
    if (!ls || typeof ls !== 'object') return;
    const raw = Array.isArray(ls.ids) ? ls.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const uniq = [];
    const seen = new Set();
    for (const id of raw) {
        if (seen.has(id)) continue;
        seen.add(id);
        uniq.push(id);
    }
    ls.ids = uniq;
    if (ls.thresholdsById && typeof ls.thresholdsById === 'object' && !Array.isArray(ls.thresholdsById)) {
        for (const k of Object.keys(ls.thresholdsById)) {
            if (!uniq.includes(k)) delete ls.thresholdsById[k];
        }
    }
}

/**
 * prefab でないモデルから lod フィールドを除去する
 * @param {Record<string, unknown>} m
 */
export function stripLodFromNonPrefabModel(m) {
    if (!m || typeof m !== 'object') return;
    const pfm = String(m.prefabManifest || '').trim();
    if (pfm) return;
    delete m.lodId;
    delete m.lodRank;
    delete m.lodPartRanks;
    delete m.lodRanks;
}

/**
 * 1 ワールドの lodSystem と models の lod 関連を正規化する
 * @param {Record<string, unknown>} world
 */
export function normalizeWorldLodSystem(world) {
    if (!world || typeof world !== 'object') return;
    dedupeWorldLodIds(world);

    const ls = world.lodSystem;
    if (!ls || typeof ls !== 'object') {
        const models = world.models;
        if (Array.isArray(models)) models.forEach(stripLodFromNonPrefabModel);
        return;
    }

    const ids = Array.isArray(ls.ids) ? ls.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    ls.ids = ids;

    /** @type {Record<string, unknown>} */
    let tb = {};
    if (ls.thresholdsById && typeof ls.thresholdsById === 'object' && !Array.isArray(ls.thresholdsById)) {
        tb = { ...ls.thresholdsById };
    }
    ls.thresholdsById = tb;

    for (const id of ids) {
        if (!Object.prototype.hasOwnProperty.call(tb, id)) {
            tb[id] = [1, 2];
        }
    }
    for (const key of Object.keys(tb)) {
        if (!ids.includes(key)) delete tb[key];
    }

    for (const id of ids) {
        let raw = tb[id];
        if (!Array.isArray(raw) || raw.length === 0) {
            raw = [1, 2];
        }
        const n = raw.length;
        tb[id] = normalizeThresholdRatios(raw, n);
    }

    const models = Array.isArray(world.models) ? world.models : [];
    for (const m of models) {
        stripLodFromNonPrefabModel(m);
    }
    for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        const pfm = String(m.prefabManifest || '').trim();
        if (!pfm) continue;

        const lid = String(m.lodId || '').trim();
        if (!lid || !ids.includes(lid)) {
            delete m.lodId;
            delete m.lodRank;
            delete m.lodPartRanks;
            delete m.lodRanks;
            continue;
        }

        const ratios = /** @type {number[]} */ (tb[lid]);
        const numBands = Array.isArray(ratios) ? ratios.length + 1 : 2;

        let lr = Number(m.lodRank);
        if (!Number.isFinite(lr) || lr < 1) lr = 1;
        lr = Math.min(numBands, Math.floor(lr));
        m.lodRank = lr;

        if (m.lodPartRanks && typeof m.lodPartRanks === 'object' && !Array.isArray(m.lodPartRanks)) {
            /** @type {Record<string, number>} */
            const next = {};
            for (const [pk, pv] of Object.entries(m.lodPartRanks)) {
                const path = String(pk || '').trim();
                if (!path) continue;
                let r = Number(pv);
                if (!Number.isFinite(r) || r < 1) r = lr;
                next[path] = Math.min(numBands, Math.floor(r));
            }
            m.lodPartRanks = next;
        }

        if (Array.isArray(m.lodRanks) && m.lodRanks.length > 0) {
            m.lodRanks = m.lodRanks.map((x) => {
                let r = Number(x);
                if (!Number.isFinite(r) || r < 1) r = lr;
                return Math.min(numBands, Math.floor(r));
            });
        } else {
            delete m.lodRanks;
        }
    }
}

/**
 * 全ワールドに対して lod 正規化を行う（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 */
export function normalizeWorldsLod(worlds) {
    if (!worlds || typeof worlds !== 'object') return;
    for (const w of Object.values(worlds)) {
        if (w && typeof w === 'object') normalizeWorldLodSystem(/** @type {Record<string, unknown>} */ (w));
    }
}
