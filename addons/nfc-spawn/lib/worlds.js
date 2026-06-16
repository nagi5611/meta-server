// addons/nfc-spawn/lib/worlds.js — worlds.json から world_id の存在を検証
import fs from 'node:fs';
import { STORAGE_PATHS } from '../../../config/storage-paths.js';

/**
 * @param {string} worldId
 * @returns {boolean}
 */
export function isValidWorldId(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return false;
    try {
        const raw = fs.readFileSync(STORAGE_PATHS.WORLDS_PATH, 'utf8');
        const worlds = JSON.parse(raw);
        return worlds != null && typeof worlds === 'object' && Object.prototype.hasOwnProperty.call(worlds, id);
    } catch {
        return false;
    }
}
