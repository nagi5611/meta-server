// lib/client-spawn-registry.js — アドオン向け入場スポーン解決の拡張ポイント

/**
 * @typedef {object} ClientSpawnPlan
 * @property {string} worldId
 * @property {{ x: number, y: number, z: number }} position
 * @property {number} [yaw] 度
 * @property {string} [label]
 */

/** @type {(() => Promise<ClientSpawnPlan|null>)|null} */
let resolver = null;

/** @type {((app: object, plan: ClientSpawnPlan) => Promise<void>)|null} */
let applier = null;

/**
 * @param {() => Promise<ClientSpawnPlan|null>} fn
 */
export function registerClientSpawnResolver(fn) {
    resolver = fn;
}

/**
 * @param {(app: object, plan: ClientSpawnPlan) => Promise<void>} fn
 */
export function registerClientSpawnApplier(fn) {
    applier = fn;
}

/**
 * @returns {Promise<ClientSpawnPlan|null>}
 */
export async function tryResolveClientSpawn() {
    if (!resolver) return null;
    try {
        return await resolver();
    } catch (e) {
        console.warn('[spawn-registry] resolve failed:', e);
        return null;
    }
}

/**
 * @param {object} app
 * @param {ClientSpawnPlan} plan
 */
export async function applyClientSpawnPlan(app, plan) {
    if (!applier || !plan) return;
    try {
        await applier(app, plan);
    } catch (e) {
        console.warn('[spawn-registry] apply failed:', e);
    }
}
