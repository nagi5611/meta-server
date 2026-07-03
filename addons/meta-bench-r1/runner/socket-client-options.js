// addons/meta-bench-r1/runner/socket-client-options.js — 本番 CORS 向け Socket.IO 共通オプション

/**
 * @param {string} serverUrl
 * @param {Record<string, unknown>} auth
 * @param {Record<string, unknown>} [overrides]
 */
export function buildSocketIoOptions(serverUrl, auth, overrides = {}) {
    const origin = String(serverUrl).replace(/\/$/, '');
    return {
        transports: ['websocket', 'polling'],
        extraHeaders: { Origin: origin },
        auth,
        ...overrides,
    };
}
