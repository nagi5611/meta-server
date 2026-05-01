// lib/aircraft-server/deps-registry.js — server.js が登録する getRoomState / readWorlds への遅延参照

/** @typedef {{ getRoomState: (roomId: string) => object, readWorlds: () => Record<string, unknown> }} AircraftServerDeps */

/** @type {AircraftServerDeps | null} */
let deps = null;

/**
 * メインサーバーからコア依存を登録する（getRoomState 定義後に1回）。
 * @param {AircraftServerDeps} d
 */
export function setAircraftServerDeps(d) {
    deps = d;
}

/**
 * @returns {AircraftServerDeps|null}
 */
export function getAircraftServerDeps() {
    return deps;
}
