// public/js/prefab-glb-fetch-worker.js — Prefab GLB の fetch のみ（parse はメインスレッド）
'use strict';

self.onmessage = async (event) => {
    const data = event.data;
    if (!data || typeof data.jobId !== 'number' || typeof data.url !== 'string') {
        return;
    }
    const { jobId, url, credentials } = data;
    try {
        const res = await fetch(url, { credentials: credentials || 'omit' });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const buffer = await res.arrayBuffer();
        self.postMessage({ jobId, ok: true, buffer }, [buffer]);
    } catch (err) {
        const message = err && err.message ? String(err.message) : String(err);
        self.postMessage({ jobId, ok: false, error: message });
    }
};
