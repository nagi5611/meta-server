// addons/nfc-spawn/lib/worlds.js — worlds.json 読み込み・検証
import fs from 'node:fs';
import { STORAGE_PATHS } from '../../../config/storage-paths.js';

/**
 * @returns {Record<string, object>}
 */
export function loadWorldsJson() {
    const raw = fs.readFileSync(STORAGE_PATHS.WORLDS_PATH, 'utf8');
    const worlds = JSON.parse(raw);
    return worlds != null && typeof worlds === 'object' ? worlds : {};
}

/**
 * @param {string} worldId
 * @returns {object|null}
 */
export function getWorldById(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return null;
    const worlds = loadWorldsJson();
    return worlds[id] ?? null;
}

/**
 * @param {string} worldId
 * @returns {boolean}
 */
export function isValidWorldId(worldId) {
    return getWorldById(worldId) != null;
}

/**
 * @param {string} worldId
 * @returns {object[]}
 */
export function getWorldModels(worldId) {
    const world = getWorldById(worldId);
    if (!world) return [];
    return Array.isArray(world.models) ? world.models : [];
}
