// lib/plugin-bootstrap.js — 起動時ロード・終了フック
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAddonsRegistryDb, seedFirstRunDefaultAddons, getAddonEnabledMap } from '../db/addons-registry.js';
import { loadAllAddons, discoverAddonDirectories, checkEngineRange } from './plugin-loader.js';
import { readPluginManifest } from './plugin-manifest.js';
import { getHookRegistry, HOOKS } from './hook-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readCoreVersion() {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0');
}

/**
 * addons ディレクトリ（リポジトリ直下）
 */
export function getAddonsRoot() {
    return path.join(__dirname, '..', 'addons');
}

/**
 * @param {object} opts
 * @param {import('express').Express} opts.app
 * @param {import('socket.io').Server} opts.io
 */
export async function loadAddonsAtStartup(opts) {
    const { app, io } = opts;
    initAddonsRegistryDb();
    const addonsRoot = getAddonsRoot();
    seedFirstRunDefaultAddons(addonsRoot);
    const coreVersion = readCoreVersion();

    const report = await loadAllAddons({
        addonsRoot,
        coreVersion,
        app,
        io,
    });

    const loaded = report.filter((r) => r.loaded).length;
    console.log(`[addons] startup summary: ${loaded} loaded, ${report.length - loaded} skipped/failed`);
    return report;
}

/**
 * HTTP サーバー終了時に shutdown フックを実行
 * @param {import('http').Server} httpServer
 */
export function registerAddonShutdownHooks(httpServer) {
    const hooks = getHookRegistry();
    httpServer.on('close', () => {
        hooks.emitAsync(HOOKS.SHUTDOWN, { httpServer }).catch((e) => {
            console.error('[addons] shutdown hook error:', e);
        });
    });
}

/**
 * 管理画面用: ディスク上のアドオン一覧と有効状態・エンジン整合性
 * @returns {{
 *   coreVersion: string,
 *   addons: Array<Record<string, unknown>>
 * }}
 */
export function getAddonCatalogSnapshot() {
    const addonsRoot = getAddonsRoot();
    const coreVersion = readCoreVersion();
    const enabledMap = getAddonEnabledMap();
    const dirs = discoverAddonDirectories(addonsRoot).sort();
    /** @type {Record<string, unknown>[]} */
    const addons = [];

    for (const dirName of dirs) {
        const addonRoot = path.join(addonsRoot, dirName);
        const mr = readPluginManifest(addonRoot);
        const enabled = mr.ok
            ? enabledMap.get(mr.manifest.id) === true
            : enabledMap.get(dirName) === true;

        if (!mr.ok) {
            addons.push({
                id: dirName,
                manifestOk: false,
                errors: mr.errors,
                enabled,
                coreVersion,
            });
            continue;
        }

        const eng = checkEngineRange(coreVersion, mr.manifest);
        addons.push({
            id: mr.manifest.id,
            version: mr.manifest.version,
            manifestOk: true,
            engineOk: eng.ok,
            engineReason: eng.reason || null,
            enginesMetaServer: mr.manifest.engines?.['meta-server'],
            enabled,
            coreVersion,
            socketPrefix: mr.manifest.socketPrefix || `addon:${mr.manifest.id}`,
        });
    }

    return { coreVersion, addons };
}
