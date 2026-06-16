// addons/nfc-spawn/client/spawn-url.js — URL / sessionStorage から spawn トークンを取得

const STORAGE_KEY = 'metaverse_pending_spawn';

/**
 * @returns {string|null}
 */
export function getSpawnTokenFromUrl() {
    if (typeof window !== 'undefined' && window.metaverseSpawnPending?.getPendingSpawnToken) {
        return window.metaverseSpawnPending.getPendingSpawnToken();
    }
    try {
        const token = new URLSearchParams(window.location.search).get('spawn');
        if (token != null) {
            const id = String(token).trim();
            if (id) {
                try {
                    sessionStorage.setItem(STORAGE_KEY, id);
                } catch {
                    /* ignore */
                }
                return id;
            }
        }
        const stored = sessionStorage.getItem(STORAGE_KEY);
        return stored && String(stored).trim() ? String(stored).trim() : null;
    } catch {
        return null;
    }
}

/**
 * スポーン適用後に保留トークンを削除
 */
export function clearPendingSpawnToken() {
    if (typeof window !== 'undefined' && window.metaverseSpawnPending?.clearPendingSpawnToken) {
        window.metaverseSpawnPending.clearPendingSpawnToken();
        return;
    }
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        /* ignore */
    }
}
