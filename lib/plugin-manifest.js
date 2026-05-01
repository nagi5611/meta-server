// lib/plugin-manifest.js — plugin.json の読み取りと検証
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} PluginManifest
 * @property {string} id
 * @property {string} version
 * @property {string} main 相対パス（addon ルートから）
 * @property {{ 'meta-server': string }} [engines]
 * @property {string} [socketPrefix]
 * @property {string} [migrationsDir]
 * @property {{ admin?: string, game?: string }} [client]
 */

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function readErrors(v) {
    const errs = [];
    if (!v || typeof v !== 'object') {
        errs.push('manifest must be an object');
        return errs;
    }
    const m = /** @type {Record<string, unknown>} */ (v);
    if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
        errs.push('id must be kebab-case');
    }
    if (!m.version || typeof m.version !== 'string') {
        errs.push('version required (semver)');
    }
    if (!m.main || typeof m.main !== 'string') {
        errs.push('main entry path required');
    }
    const eng = m.engines;
    if (!eng || typeof eng !== 'object' || !('meta-server' in eng)) {
        errs.push('engines.meta-server semver range required');
    } else {
        const r = /** @type {Record<string, unknown>} */ (eng)['meta-server'];
        if (typeof r !== 'string' || !r.trim()) errs.push('engines.meta-server must be non-empty');
    }
    return errs;
}

/**
 * @param {string} addonRoot
 * @returns {{ ok: true, manifest: PluginManifest } | { ok: false, errors: string[] }}
 */
export function readPluginManifest(addonRoot) {
    const manifestPath = path.join(addonRoot, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
        return { ok: false, errors: ['plugin.json not found'] };
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        return { ok: false, errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const errors = readErrors(raw);
    if (errors.length) return { ok: false, errors };

    const manifest = /** @type {PluginManifest} */ (raw);
    const mainAbs = path.join(addonRoot, manifest.main);
    if (!fs.existsSync(mainAbs)) {
        return { ok: false, errors: [`main file missing: ${manifest.main}`] };
    }
    return { ok: true, manifest };
}
