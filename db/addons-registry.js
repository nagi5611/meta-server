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
 * 初回のみ: レジストリが空なら sample-echo が存在するとき有効化する
 * @param {string} addonsRoot
 */
export function seedFirstRunDefaultAddons(addonsRoot) {
    if (!db) return;
    const row = db.prepare('SELECT COUNT(*) as c FROM addon_enabled').get();
    if (row.c > 0) return;
    const manifestPath = path.join(addonsRoot, 'sample-echo', 'plugin.json');
    if (fs.existsSync(manifestPath)) {
        db.prepare('INSERT INTO addon_enabled (plugin_id, enabled) VALUES (?, 1)').run('sample-echo');
        console.log('[addons-registry] first run: enabled addon sample-echo');
    }
}
