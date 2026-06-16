// public/js/spawn-pending-storage.js — NFC ?spawn= をログイン跨ぎで保持（classic script）
(function () {
    const STORAGE_KEY = 'metaverse_pending_spawn';

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
     * URL の spawn を sessionStorage に保存
     * @returns {string|null}
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

    function clearPendingSpawnToken() {
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }

    /**
     * path（/login/ や /index.html 等）に spawn クエリを付与
     * @param {string} pathAndSearch
     * @returns {string}
     */
    function appendSpawnQuery(pathAndSearch) {
        const token = getPendingSpawnToken();
        if (!token) return pathAndSearch;
        const path = String(pathAndSearch || '/');
        const origin = window.location.origin;
        const u = new URL(path.startsWith('http') ? path : origin + (path.startsWith('/') ? path : `/${path}`));
        u.searchParams.set('spawn', token);
        return u.pathname + u.search + u.hash;
    }

    /**
     * ページ内の login 系リンクに spawn を付与
     */
    function patchLoginLinks() {
        const token = getPendingSpawnToken();
        if (!token) return;
        document.querySelectorAll('a[href^="/login"], a[href^="/student"], a[href^="/teacher"]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            a.setAttribute('href', appendSpawnQuery(href));
        });
    }

    window.metaverseSpawnPending = {
        STORAGE_KEY,
        captureSpawnFromUrl,
        getPendingSpawnToken,
        clearPendingSpawnToken,
        appendSpawnQuery,
        patchLoginLinks,
    };
})();
