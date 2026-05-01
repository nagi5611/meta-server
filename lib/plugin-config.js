// lib/plugin-config.js — config.json と環境変数 ADDON_<ID>_ のマージ（後者優先）
import fs from 'node:fs';
import path from 'node:path';
import { getAddonConfigMap } from '../db/addons-registry.js';

/**
 * ADDON_SAMPLE_ECHO_GREETING のプレフィックスを addon id に応じて生成
 * @param {string} pluginId kebab-case
 */
export function addonEnvPrefix(pluginId) {
    const upper = pluginId.replace(/-/g, '_').toUpperCase();
    return `ADDON_${upper}_`;
}

/**
 * @param {string} pluginId
 * @param {string} addonRoot
 * @returns {Record<string, unknown>}
 */
export function loadMergedAddonConfig(pluginId, addonRoot) {
    const cfgPath = path.join(addonRoot, 'config.json');
    /** @type {Record<string, unknown>} */
    let base = {};
    if (fs.existsSync(cfgPath)) {
        try {
            base = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (!base || typeof base !== 'object') base = {};
        } catch {
            base = {};
        }
    }

    const prefix = addonEnvPrefix(pluginId);
    const dbConfig = getAddonConfigMap(pluginId);
    /** @type {Record<string, unknown>} */
    const overlay = { ...base, ...dbConfig };

    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith(prefix) || v === undefined) continue;
        const shortKey = k.slice(prefix.length).toLowerCase();
        if (!shortKey) continue;
        overlay[shortKey] = v;
    }

    return overlay;
}
