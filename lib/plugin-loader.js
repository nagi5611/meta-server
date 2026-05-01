// lib/plugin-loader.js — アドオン発見・semver・動的 import・register 呼び出し
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import Database from 'better-sqlite3';
import { readPluginManifest } from './plugin-manifest.js';
import { loadMergedAddonConfig } from './plugin-config.js';
import { runPluginMigrations } from './plugin-migrations.js';
import { getHookRegistry, HOOKS } from './hook-registry.js';
import { STORAGE_PATHS } from '../config/storage-paths.js';
import { isAddonEnabled } from '../db/addons-registry.js';

/**
 * @param {string} addonsRoot
 * @returns {string[]} ディレクトリ名（プラグイン ID 候補）
 */
export function discoverAddonDirectories(addonsRoot) {
    if (!fs.existsSync(addonsRoot)) return [];
    const ents = fs.readdirSync(addonsRoot, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * @param {string} coreVersion meta-server package.json version
 * @param {import('./plugin-manifest.js').PluginManifest} manifest
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkEngineRange(coreVersion, manifest) {
    const range = manifest.engines?.['meta-server'];
    if (!range || typeof range !== 'string') {
        return { ok: false, reason: 'missing engines.meta-server' };
    }
    try {
        if (semver.satisfies(coreVersion, range, { includePrerelease: true })) {
            return { ok: true };
        }
        return { ok: false, reason: `core ${coreVersion} does not satisfy ${range}` };
    } catch (e) {
        return { ok: false, reason: `invalid semver range: ${e instanceof Error ? e.message : e}` };
    }
}

/**
 * @typedef {object} PluginRegisterApi
 * @property {string} pluginId
 * @property {import('./plugin-manifest.js').PluginManifest} manifest
 * @property {Record<string, unknown>} config
 * @property {{ info: Function, warn: Function, error: Function }} logger
 * @property {import('./hook-registry.js').HookRegistry} hooks
 * @property {object} paths
 * @property {string} paths.addonRoot
 * @property {string} paths.pluginDbPath
 * @property {string} paths.httpBasePath
 * @property {string} paths.socketPrefix
 * @property {string} coreVersion
 * @property {() => import('better-sqlite3').Database} openDatabase
 */

/**
 * @param {object} opts
 * @param {string} opts.addonsRoot
 * @param {string} opts.coreVersion
 * @param {import('express').Express} opts.app
 * @param {import('socket.io').Server} opts.io
 */
export async function loadAllAddons(opts) {
    const { addonsRoot, coreVersion, app, io } = opts;
    const hooks = getHookRegistry();
    const dirs = discoverAddonDirectories(addonsRoot).sort();

    /** @type {{ id: string, version: string, loaded: boolean, skipReason?: string }[]} */
    const report = [];

    for (const dirName of dirs) {
        const addonRoot = path.join(addonsRoot, dirName);
        const manifestResult = readPluginManifest(addonRoot);
        if (!manifestResult.ok) {
            report.push({
                id: dirName,
                version: '?',
                loaded: false,
                skipReason: manifestResult.errors.join('; '),
            });
            continue;
        }
        const { manifest } = manifestResult;
        if (manifest.id !== dirName) {
            report.push({
                id: dirName,
                version: manifest.version,
                loaded: false,
                skipReason: `directory name must match manifest.id (expected ${manifest.id})`,
            });
            continue;
        }

        const eng = checkEngineRange(coreVersion, manifest);
        if (!eng.ok) {
            console.warn(`[addons] skip ${manifest.id}: ${eng.reason}`);
            report.push({ id: manifest.id, version: manifest.version, loaded: false, skipReason: eng.reason });
            continue;
        }

        if (!isAddonEnabled(manifest.id)) {
            report.push({
                id: manifest.id,
                version: manifest.version,
                loaded: false,
                skipReason: 'disabled in admin registry',
            });
            continue;
        }

        const engineMainUrl = pathToFileURL(path.join(addonRoot, manifest.main)).href;

        try {
            const mod = await import(engineMainUrl);
            const plugin = mod.default;
            if (!plugin || typeof plugin.register !== 'function') {
                throw new Error('default export must have register(context)');
            }

            const pluginDbPath = path.join(STORAGE_PATHS.PLUGIN_DATABASES_DIR, `${manifest.id}.db`);
            const migrationsRel = manifest.migrationsDir || 'migrations';
            const migrationsDir = path.join(addonRoot, migrationsRel);

            const prefix = manifest.socketPrefix || `addon:${manifest.id}`;

            /** @type {import('better-sqlite3').Database | null} */
            let dbInstance = null;

            const ctx = /** @type {PluginRegisterApi} */ ({
                pluginId: manifest.id,
                manifest,
                config: loadMergedAddonConfig(manifest.id, addonRoot),
                logger: createLogger(manifest.id),
                hooks,
                paths: {
                    addonRoot,
                    pluginDbPath,
                    httpBasePath: `/api/addons/${manifest.id}`,
                    socketPrefix: prefix,
                },
                coreVersion,
                openDatabase: () => {
                    if (!dbInstance) {
                        const parent = path.dirname(pluginDbPath);
                        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
                        dbInstance = new Database(pluginDbPath);
                        runPluginMigrations(dbInstance, migrationsDir);
                    }
                    return dbInstance;
                },
            });

            await plugin.register(ctx);

            console.log(`[addons] loaded ${manifest.id}@${manifest.version}`);
            report.push({ id: manifest.id, version: manifest.version, loaded: true });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[addons] failed to load ${manifest.id}:`, msg);
            report.push({
                id: manifest.id,
                version: manifest.version,
                loaded: false,
                skipReason: msg,
            });
        }
    }

    hooks.emitSync(HOOKS.EXPRESS_SETUP, { app });
    hooks.emitSync(HOOKS.SOCKET_SETUP, { io });

    return report;
}

/**
 * @param {string} pluginId
 */
function createLogger(pluginId) {
    const p = `[addon:${pluginId}]`;
    return {
        info: (...args) => console.log(p, ...args),
        warn: (...args) => console.warn(p, ...args),
        error: (...args) => console.error(p, ...args),
    };
}
