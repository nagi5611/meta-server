// public/js/spawn-pending-storage.js — NFC ?spawn= / ?world= をログイン跨ぎで保持（classic script）
(function () {
    const STORAGE_KEY = 'metaverse_pending_spawn';
    const WORLD_STORAGE_KEY = 'metaverse_pending_world';

    /**
     * @param {string} [search]
     * @returns {string|null}
     */
    function readSpawnFromSearch(search) {
        try {
            const t = new URLSearchParams(search || '').get('spawn');
            if (t == null) return null;
            const id = String(t).trim();
            return id || null;
        } catch {
            return null;
        }
    }

    /**
     * @param {string} [search]
     * @returns {string|null}
     */
    function readWorldFromSearch(search) {
        try {
            const w = new URLSearchParams(search || '').get('world');
            if (w == null) return null;
            const id = String(w).trim();
            return id || null;
        } catch {
            return null;
        }
    }

    /**
     * @param {string} [hash]
     * @returns {string|null}
     */
    function readWorldFromHash(hash) {
        try {
            const raw = String(hash || '').replace(/^#/, '');
            if (!raw.startsWith('world=')) return null;
            const id = raw.slice('world='.length).split('&')[0].trim();
            return id ? decodeURIComponent(id) : null;
        } catch {
            return null;
        }
    }

    /**
     * 現在ページの URL から world を読む（?world= または #world=）
     * @returns {string|null}
     */
    function readWorldFromCurrentUrl() {
        return (
            readWorldFromSearch(window.location.search) ||
            readWorldFromHash(window.location.hash)
        );
    }

    /**
     * URL の spawn / world を sessionStorage に保存
     * @returns {string|null} spawn トークン
     */
    function captureSpawnFromUrl() {
        const t = readSpawnFromSearch(window.location.search);
        if (t) {
            try {
                sessionStorage.setItem(STORAGE_KEY, t);
            } catch {
                /* ignore */
            }
        }

        const worldId = readWorldFromCurrentUrl();
        if (worldId) {
            try {
                sessionStorage.setItem(WORLD_STORAGE_KEY, worldId);
            } catch {
                /* ignore */
            }
        }

        return t;
    }

    /**
     * URL 優先、なければ sessionStorage
     * @returns {string|null}
     */
    function getPendingSpawnToken() {
        const fromUrl = readSpawnFromSearch(window.location.search);
        if (fromUrl) {
            try {
                sessionStorage.setItem(STORAGE_KEY, fromUrl);
            } catch {
                /* ignore */
            }
            return fromUrl;
        }
        try {
            const stored = sessionStorage.getItem(STORAGE_KEY);
            return stored && String(stored).trim() ? String(stored).trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * URL 優先、なければ sessionStorage（?world= / #world=）
     * @returns {string|null}
     */
    function getPendingWorldId() {
        const fromUrl = readWorldFromCurrentUrl();
        if (fromUrl) {
            try {
                sessionStorage.setItem(WORLD_STORAGE_KEY, fromUrl);
            } catch {
                /* ignore */
            }
            return fromUrl;
        }
        try {
            const stored = sessionStorage.getItem(WORLD_STORAGE_KEY);
            return stored && String(stored).trim() ? String(stored).trim() : null;
        } catch {
            return null;
        }
    }

    function clearPendingSpawnToken() {
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }

    function clearPendingWorldId() {
        try {
            sessionStorage.removeItem(WORLD_STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }

    /**
     * path（/login/ や /index.html 等）に spawn / world クエリを付与
     * @param {string} pathAndSearch
     * @returns {string}
     */
    function appendSpawnQuery(pathAndSearch) {
        const token = getPendingSpawnToken();
        const worldId = getPendingWorldId();
        if (!token && !worldId) return pathAndSearch;

        const path = String(pathAndSearch || '/');
        const origin = window.location.origin;
        const u = new URL(path.startsWith('http') ? path : origin + (path.startsWith('/') ? path : `/${path}`));
        if (token) u.searchParams.set('spawn', token);
        if (worldId) u.searchParams.set('world', worldId);
        return u.pathname + u.search + u.hash;
    }

    /**
     * ページ内の login 系リンクに spawn / world を付与
     */
    function patchLoginLinks() {
        const token = getPendingSpawnToken();
        const worldId = getPendingWorldId();
        if (!token && !worldId) return;
        document.querySelectorAll('a[href^="/login"], a[href^="/student"], a[href^="/teacher"]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            a.setAttribute('href', appendSpawnQuery(href));
        });
    }

    window.metaverseSpawnPending = {
        STORAGE_KEY,
        WORLD_STORAGE_KEY,
        captureSpawnFromUrl,
        getPendingSpawnToken,
        getPendingWorldId,
        clearPendingSpawnToken,
        clearPendingWorldId,
        appendSpawnQuery,
        patchLoginLinks,
    };
})();
