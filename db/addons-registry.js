// db/addons-registry.js — addon 有効フラグ（SQLite）
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STORAGE_PATHS } from '../config/storage-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGISTRY_PATH = path.join(STORAGE_PATHS.DB_DIR, 'addons_registry.db');

/** @type {import('better-sqlite3').Database | null} */
let db = null;

export function initAddonsRegistryDb() {
    const dir = STORAGE_PATHS.DB_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(REGISTRY_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS addon_enabled (
            plugin_id TEXT PRIMARY KEY NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS addon_config_kv (
            plugin_id TEXT NOT NULL,
            config_key TEXT NOT NULL,
            config_value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            PRIMARY KEY (plugin_id, config_key)
        );
    `);
    console.log('[addons-registry] addons_registry.db ready');
}

/**
 * @returns {Map<string, boolean>}
 */
export function getAddonEnabledMap() {
    if (!db) return new Map();
    const rows = db.prepare('SELECT plugin_id, enabled FROM addon_enabled').all();
    const m = new Map();
    for (const row of rows) {
        m.set(row.plugin_id, row.enabled === 1);
    }
    return m;
}

/**
 * @param {string} pluginId
 * @returns {boolean} 行がなければ false（既定は無効）
 */
export function isAddonEnabled(pluginId) {
    if (!db) return false;
    const row = db.prepare('SELECT enabled FROM addon_enabled WHERE plugin_id = ?').get(pluginId);
    if (!row) return false;
    return row.enabled === 1;
}

/**
 * @param {string} pluginId
 * @param {boolean} enabled
 */
export function setAddonEnabled(pluginId, enabled) {
    if (!db) throw new Error('addons registry not initialized');
    db.prepare(
        'INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, ?) ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled'
    ).run(pluginId, enabled ? 1 : 0);
}

/**
 * @param {string} pluginId
 * @returns {Array<{ key: string, value: string, updatedAt: number }>}
 */
export function getAddonConfigEntries(pluginId) {
    if (!db) return [];
    const rows = db.prepare(
        `SELECT config_key, config_value, updated_at
           FROM addon_config_kv
          WHERE plugin_id = ?
          ORDER BY config_key ASC`
    ).all(pluginId);
    return rows.map((row) => ({
        key: row.config_key,
        value: row.config_value,
        updatedAt: Number(row.updated_at || 0),
    }));
}

/**
 * @param {string} pluginId
 * @returns {Record<string, string>}
 */
export function getAddonConfigMap(pluginId) {
    const entries = getAddonConfigEntries(pluginId);
    /** @type {Record<string, string>} */
    const map = {};
    for (const row of entries) {
        map[row.key] = row.value;
    }
    return map;
}

/**
 * @param {string} pluginId
 * @param {string} key
 * @param {string} value
 */
export function setAddonConfigValue(pluginId, key, value) {
    if (!db) throw new Error('addons registry not initialized');
    db.prepare(
        `INSERT INTO addon_config_kv (plugin_id, config_key, config_value, updated_at)
         VALUES (?, ?, ?, strftime('%s','now'))
         ON CONFLICT(plugin_id, config_key)
         DO UPDATE SET config_value = excluded.config_value, updated_at = strftime('%s','now')`
    ).run(pluginId, key, value);
}

/**
 * @param {string} pluginId
 * @param {string} key
 */
export function deleteAddonConfigValue(pluginId, key) {
    if (!db) throw new Error('addons registry not initialized');
    db.prepare('DELETE FROM addon_config_kv WHERE plugin_id = ? AND config_key = ?').run(pluginId, key);
}

/**
 * 初回のみ: レジストリが空なら sample-echo が存在するとき有効化する
 * @param {string} addonsRoot
 */
export function seedFirstRunDefaultAddons(addonsRoot) {
    if (!db) return;
    const row = db.prepare('SELECT COUNT(*) as c FROM addon_enabled').get();
    if (row.c > 0) return;
    const sampleManifest = path.join(addonsRoot, 'sample-echo', 'plugin.json');
    if (fs.existsSync(sampleManifest)) {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('sample-echo');
        console.log('[addons-registry] first run: enabled addon sample-echo');
    }
    const aircraftManifest = path.join(addonsRoot, 'aircraft', 'plugin.json');
    if (fs.existsSync(aircraftManifest)) {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('aircraft');
        console.log('[addons-registry] first run: enabled addon aircraft');
    }
    const matsuyamaFlightsManifest = path.join(addonsRoot, 'matsuyama-flights', 'plugin.json');
    if (fs.existsSync(matsuyamaFlightsManifest)) {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('matsuyama-flights');
        console.log('[addons-registry] first run: enabled addon matsuyama-flights');
    }
    const webxrManifest = path.join(addonsRoot, 'webxr-vr', 'plugin.json');
    if (fs.existsSync(webxrManifest)) {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('webxr-vr');
        console.log('[addons-registry] first run: enabled addon webxr-vr');
    }
}

/**
 * アップグレード時: webxr-vr 行が無ければ有効化（既存環境の VR 維持）
 * @param {string} addonsRoot
 */
export function ensureWebxrVrOnUpgrade(addonsRoot) {
    if (!db) return;
    const manifest = path.join(addonsRoot, 'webxr-vr', 'plugin.json');
    if (!fs.existsSync(manifest)) return;
    const row = db.prepare('SELECT enabled FROM addon_enabled WHERE plugin_id = ?').get('webxr-vr');
    if (row) return;
    try {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('webxr-vr');
        console.log('[addons-registry] upgrade: enabled addon webxr-vr');
    } catch (e) {
        console.warn('[addons-registry] ensureWebxrVrOnUpgrade failed:', e);
    }
}
