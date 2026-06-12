// public/js/world-quality-lod-normalize.js — worlds.json の品質 LOD 正規化（Admin / server 共用）

import { getQualityLodKeys } from './world-quality-lod.js';

/**
 * 1 ワールドの qualityLods を正規化する
 * @param {Record<string, unknown>} world
 */
export function normalizeWorldQualityLods(world) {
    if (!world || typeof world !== 'object') return;

    const ql = world.qualityLods;
    if (!ql || typeof ql !== 'object' || Array.isArray(ql)) {
        delete world.qualityLods;
        return;
    }

    /** @type {Record<string, { label: string, models: unknown[], pdfs?: unknown[] }>} */
    const out = {};
    const rawKeys = Object.keys(ql).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
    });

    for (const key of rawKeys) {
        const k = String(key).trim();
        if (!k) continue;
        const raw = ql[key];
        if (!raw || typeof raw !== 'object') continue;

        const entry = /** @type {Record<string, unknown>} */ (raw);
        const label = typeof entry.label === 'string' ? entry.label.trim() : '';
        const models = Array.isArray(entry.models) ? entry.models.filter(Boolean) : [];

        /** @type {{ label: string, models: unknown[], pdfs?: unknown[] }} */
        const normalized = { label, models };

        if (Array.isArray(entry.pdfs) && entry.pdfs.length > 0) {
            normalized.pdfs = entry.pdfs.filter(Boolean);
        }

        out[k] = normalized;
    }

    const keys = Object.keys(out);
    if (keys.length === 0) {
        delete world.qualityLods;
        return;
    }

    world.qualityLods = out;

    // 有効 LOD が 1 件のみでルート models が空の場合、ルートへコピー（後方互換）
    const validKeys = getQualityLodKeys(world);
    if (validKeys.length === 1 && (!Array.isArray(world.models) || world.models.length === 0)) {
        const onlyKey = validKeys[0];
        if (onlyKey && out[onlyKey]?.models?.length) {
            world.models = out[onlyKey].models.map((m) =>
                m && typeof m === 'object' ? { ...m } : m
            );
        }
    }
}

/**
 * 全ワールドに対して品質 LOD 正規化を行う
 * @param {Record<string, unknown>} worlds
 */
export function normalizeWorldsQualityLods(worlds) {
    if (!worlds || typeof worlds !== 'object') return;
    for (const w of Object.values(worlds)) {
        if (w && typeof w === 'object') {
            normalizeWorldQualityLods(/** @type {Record<string, unknown>} */ (w));
        }
    }
}
