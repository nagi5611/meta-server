// public/js/world-model-load-order.js — spawn から近い順の段階ロード用

import { clampViewDistanceM } from './ibl-setup.js';

/**
 * @param {object|string} config
 * @returns {{ x: number, y: number, z: number }}
 */
export function modelConfigWorldPosition(config) {
    const c = typeof config === 'string' ? { path: config } : config || {};
    const p = c.position && typeof c.position === 'object' ? c.position : { x: 0, y: 0, z: 0 };
    return {
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        z: Number(p.z) || 0,
    };
}

/**
 * @param {object|string} config
 * @param {{ x: number, y: number, z: number }} spawn
 * @returns {number}
 */
export function distanceSqFromSpawn(config, spawn) {
    const p = modelConfigWorldPosition(config);
    const dx = p.x - spawn.x;
    const dy = p.y - spawn.y;
    const dz = p.z - spawn.z;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * legacy 読込 index を spawn 距離の近い順に並べ替える
 * @param {Array<object|string>} modelConfigs
 * @param {number[]} indices
 * @param {{ x: number, y: number, z: number }} spawn
 * @returns {number[]}
 */
export function sortLegacyIndicesBySpawnDistance(modelConfigs, indices, spawn) {
    return [...indices].sort((a, b) => {
        const da = distanceSqFromSpawn(modelConfigs[a], spawn);
        const db = distanceSqFromSpawn(modelConfigs[b], spawn);
        return da - db;
    });
}

/**
 * 描画距離 R 以内を「近傍」、それ以外を「遠方」に分ける（各グループは近い順）
 * @param {Array<object|string>} modelConfigs
 * @param {number[]} indices
 * @param {{ x: number, y: number, z: number }} spawn
 * @param {number} viewDistanceM
 * @returns {{ near: number[], far: number[] }}
 */
export function splitLegacyIndicesByViewDistance(modelConfigs, indices, spawn, viewDistanceM) {
    const R = clampViewDistanceM(viewDistanceM);
    const r2 = R * R;
    /** @type {number[]} */
    const near = [];
    /** @type {number[]} */
    const far = [];
    for (const idx of indices) {
        if (distanceSqFromSpawn(modelConfigs[idx], spawn) <= r2) {
            near.push(idx);
        } else {
            far.push(idx);
        }
    }
    return {
        near: sortLegacyIndicesBySpawnDistance(modelConfigs, near, spawn),
        far: sortLegacyIndicesBySpawnDistance(modelConfigs, far, spawn),
    };
}
