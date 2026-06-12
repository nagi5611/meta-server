// public/js/world-entry-flow.js — 論理ワールド入室（品質 LOD 選択 + ロード + ネットワーク同期）

import { hasMultipleQualityLods } from './world-quality-lod.js';
import { resolveQualityLodKeyForEntry } from './world-quality-lod-modal.js';

/**
 * 論理ワールドへ入室する（品質 LOD ポップアップ → 3D ロード → 必要なら change-world）
 * @param {object} app MetaverseApp インスタンス
 * @param {string} logicalWorldId
 * @param {{ qualityLodKey?: string|null, teleporterId?: string, skipNetworkChange?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, qualityLodKey?: string|null, message?: string }>}
 */
export async function enterLogicalWorld(app, logicalWorldId, options = {}) {
    const rawWorld = app.worldManager?.getWorld(logicalWorldId);
    if (!rawWorld) {
        return { ok: false, reason: 'not_found' };
    }

    const qualityLodKey = await resolveQualityLodKeyForEntry(rawWorld, options.qualityLodKey);
    if (qualityLodKey === null && hasMultipleQualityLods(rawWorld)) {
        return { ok: false, reason: 'cancelled' };
    }

    const teleporterId = options.teleporterId;
    const skipNetwork = options.skipNetworkChange === true;

    if (!skipNetwork && app.networkManager?.socket?.connected) {
        const currentRoom = app.networkManager.currentWorld;
        if (currentRoom !== logicalWorldId) {
            try {
                await new Promise((resolve, reject) => {
                    app.networkManager.changeWorld(logicalWorldId, { teleporterId }, (err) => {
                        if (err) reject(err);
                        else resolve(undefined);
                    });
                });
            } catch (err) {
                const message =
                    err && typeof err === 'object' && 'message' in err && err.message
                        ? String(err.message)
                        : 'ワールドへの移動に失敗しました';
                return { ok: false, reason: 'network', message };
            }
        }
    }

    await new Promise((resolve) => {
        app.worldManager.loadWorld(logicalWorldId, () => resolve(undefined), { qualityLodKey });
    });

    return { ok: true, qualityLodKey };
}
