// addons/nfc-spawn/client/spawn-url.js — URL から spawn トークンを取得

/**
 * @returns {string|null}
 */
export function getSpawnTokenFromUrl() {
    try {
        const token = new URLSearchParams(window.location.search).get('spawn');
        if (token == null) return null;
        const id = String(token).trim();
        return id || null;
    } catch {
        return null;
    }
}
