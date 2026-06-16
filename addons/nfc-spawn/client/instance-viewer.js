// addons/nfc-spawn/client/instance-viewer.js — A-Frame インスタンス閲覧
const API_BASE = '/api/addons/nfc-spawn';
const ASSETS_BASE = `${API_BASE}/instance-assets`;

/**
 * @returns {string}
 */
function getTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return String(params.get('token') || '').trim();
}

/**
 * @param {string} msg
 * @param {boolean} [isError]
 */
function setOverlayMessage(msg, isError = false) {
    const el = document.getElementById('instance-overlay');
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
    el.classList.toggle('error', isError);
}

/**
 * @param {[number,number,number]} arr
 */
function vec3Str(arr) {
    return `${arr[0]} ${arr[1]} ${arr[2]}`;
}

/**
 * @param {string} spawnId
 * @param {string} rel
 */
function assetUrl(spawnId, rel) {
    const clean = String(rel || '').replace(/^\//, '');
    return `${ASSETS_BASE}/${spawnId}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * @param {HTMLElement} scene
 * @param {string} spawnId
 * @param {object} entry
 */
async function addManifestEntry(scene, spawnId, entry) {
    const pos = vec3Str(entry.position || [0, 0, 0]);
    const rot = vec3Str(entry.rotation || [0, 0, 0]);
    const scale = vec3Str(entry.scale || [1, 1, 1]);

    if (entry.kind === 'glb' && entry.file) {
        const ent = document.createElement('a-entity');
        ent.setAttribute('position', pos);
        ent.setAttribute('rotation', rot);
        ent.setAttribute('scale', scale);
        ent.setAttribute('gltf-model', `url(${assetUrl(spawnId, entry.file)})`);
        scene.appendChild(ent);
        return;
    }

    if (entry.kind === 'prefab' && entry.manifest) {
        const manRes = await fetch(assetUrl(spawnId, entry.manifest));
        if (!manRes.ok) throw new Error('prefab_manifest_failed');
        const man = await manRes.json();
        const root = document.createElement('a-entity');
        root.setAttribute('position', pos);
        root.setAttribute('rotation', rot);
        root.setAttribute('scale', scale);
        const parts = Array.isArray(man.parts) ? man.parts : [];
        for (const part of parts) {
            const file = String(part.file || '').trim();
            if (!file) continue;
            const rel = file.startsWith('models/') ? file : `models/${file}`;
            const child = document.createElement('a-entity');
            child.setAttribute('gltf-model', `url(${assetUrl(spawnId, rel)})`);
            root.appendChild(child);
        }
        scene.appendChild(root);
    }
}

/**
 * @param {object} manifest
 * @param {number} spawnId
 */
async function loadInstanceManifest(manifest, spawnId) {
    const scene = document.querySelector('a-scene');
    if (!scene) throw new Error('no_scene');
    const cam = manifest.camera || {};
    const camPos = cam.position || [0, 1.6, 4];
    const lookAt = cam.lookAt || [0, 1, 0];
    const camera = document.getElementById('instance-camera');
    if (camera) {
        camera.setAttribute('position', vec3Str(camPos));
        camera.setAttribute('look-at', vec3Str(lookAt));
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    for (const entry of entries) {
        await addManifestEntry(scene, spawnId, entry);
    }
    setOverlayMessage('');
}

async function bootstrap() {
    const token = getTokenFromUrl();
    if (!token) {
        setOverlayMessage('token パラメータがありません', true);
        return;
    }
    if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) === false) {
        const hint = document.getElementById('instance-desktop-hint');
        if (hint) hint.hidden = false;
    }
    setOverlayMessage('読み込み中…');
    try {
        const res = await fetch(`${API_BASE}/instance/${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            setOverlayMessage(data.error || `エラー (${res.status})`, true);
            return;
        }
        const manifestUrl = String(data.manifestUrl || '');
        const spawnId = Number(data.spawnId);
        if (!manifestUrl || !Number.isFinite(spawnId)) {
            setOverlayMessage('マニフェスト URL が無効です', true);
            return;
        }
        const manRes = await fetch(manifestUrl);
        if (!manRes.ok) {
            setOverlayMessage('マニフェストの取得に失敗しました', true);
            return;
        }
        const manifest = await manRes.json();
        document.title = `${data.label || 'Instance'} — Metaverse`;
        await loadInstanceManifest(manifest, spawnId);
    } catch (e) {
        setOverlayMessage(e instanceof Error ? e.message : '読み込み失敗', true);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void bootstrap());
} else {
    void bootstrap();
}
