// lib/avator-scalable-bindings.js — avator-scalable-animations の bindings 解析（サーバー・アドオン共通）
import fs from 'node:fs';
import path from 'node:path';
import { loadMergedAddonConfig } from './plugin-config.js';

const PLUGIN_ID = 'avator-scalable-animations';

/**
 * config.bindings を配列に正規化する。clip は省略可（管理画面でアバターごとに割当）。
 * @param {unknown} raw
 * @returns {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }[]}
 */
export function parseAvatorScalableBindings(raw) {
    /** @type {unknown} */
    let arr = raw;
    if (typeof raw === 'string') {
        try {
            arr = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(arr)) return [];

    /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }[]} */
    const out = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = /** @type {Record<string, unknown>} */ (item);
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        const key = typeof o.key === 'string' ? o.key.trim() : '';
        if (!name || !key) continue;

        const idRaw = typeof o.id === 'string' ? o.id.trim() : '';
        const id = idRaw && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(idRaw) ? idRaw : '';

        let clipIndex;
        if (typeof o.clipIndex === 'number' && Number.isFinite(o.clipIndex)) {
            clipIndex = Math.trunc(o.clipIndex);
        } else if (typeof o.clipIndex === 'string' && o.clipIndex.trim()) {
            const n = Number(o.clipIndex.trim());
            if (Number.isFinite(n)) clipIndex = Math.trunc(n);
        }

        const clipName = typeof o.clipName === 'string' && o.clipName.trim() ? o.clipName.trim() : '';

        /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }} */
        const entry = { name, key };
        if (id) entry.id = id;
        if (clipIndex !== undefined) entry.clipIndex = clipIndex;
        if (clipName) entry.clipName = clipName;
        out.push(entry);
    }
    return out;
}

/**
 * レジストリ animationMap 用の安定キー（scalable_*）
 * @param {{ id?: string }} b
 * @param {number} index
 * @returns {string}
 */
export function slotKeyForBinding(b, index) {
    const id = b.id && typeof b.id === 'string' ? b.id.trim() : '';
    if (id && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)) return `scalable_${id}`;
    return `scalable_${index}`;
}

/**
 * @param {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }[]} bindings
 * @returns {Array<{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string, slotKey: string }>}
 */
export function enrichBindingsWithSlotKeys(bindings) {
    return bindings.map((b, i) => ({
        ...b,
        slotKey: slotKeyForBinding(b, i),
    }));
}

/** loadMergedAddonConfig の予約キー（JSON の bindings 以外は「定義名 → 割り当てキー」ペア） */
const MERGED_CONFIG_RESERVED_KEYS = new Set(['bindings']);

/**
 * config.json / DB / ADDON_AVATOR_SCALABLE_ANIMATIONS_* をマージしたオブジェクトから bindings を組み立てる。
 * - bindings: 従来の JSON 配列（または文字列）
 * - その他のキー: キー＝モーション定義名、値＝キーボード割り当て（管理画面の KV と一致）
 * @param {Record<string, unknown>|null|undefined} cfg
 * @returns {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }[]}
 */
export function parseAvatorScalableMergedConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return [];

    /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }[]} */
    const out = [];

    if (Object.prototype.hasOwnProperty.call(cfg, 'bindings')) {
        out.push(...parseAvatorScalableBindings(cfg.bindings));
    }

    for (const [k, v] of Object.entries(cfg)) {
        if (MERGED_CONFIG_RESERVED_KEYS.has(k)) continue;
        const nameStr = String(k).trim();
        const keyStr = v == null ? '' : String(v).trim();
        if (!nameStr || !keyStr) continue;

        /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string, id?: string }} */
        const row = { name: nameStr, key: keyStr };
        if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nameStr)) {
            row.id = nameStr;
        }
        out.push(row);
    }
    return out;
}

/**
 * アドオン設定からスロット一覧を読む（アドオンディレクトリが無ければ空）。
 * @param {string} addonsRoot
 */
export function loadScalableBindingsFromAddonConfig(addonsRoot) {
    const addonRoot = path.join(addonsRoot, PLUGIN_ID);
    if (!fs.existsSync(addonRoot)) return [];
    const cfg = loadMergedAddonConfig(PLUGIN_ID, addonRoot);
    return parseAvatorScalableMergedConfig(cfg);
}

/**
 * 管理画面・GET /admin/avatars 用
 * @param {string} addonsRoot
 */
export function getScalableAnimationSlotsForAdmin(addonsRoot) {
    return enrichBindingsWithSlotKeys(loadScalableBindingsFromAddonConfig(addonsRoot));
}
