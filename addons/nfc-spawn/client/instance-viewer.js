// addons/nfc-spawn/client/instance-viewer.js — A-Frame インスタンス閲覧
const API_BASE = '/api/addons/nfc-spawn';
const ASSETS_BASE = `${API_BASE}/instance-assets`;

/** 同時 GLB 読込数（サーバー・端末負荷軽減） */
const MODEL_LOAD_CONCURRENCY = 8;

/**
 * @returns {boolean}
 */
function isMobileDevice() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * カメラ位置と注視点から初期回転（度）を算出
 * @param {[number, number, number]} camPos
 * @param {[number, number, number]} target
 */
function lookAtToRotation(camPos, target) {
    const dx = target[0] - camPos[0];
    const dy = target[1] - camPos[1];
    const dz = target[2] - camPos[2];
    const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const pitch = (-Math.atan2(dy, horiz) * 180) / Math.PI;
    return { x: pitch, y: yaw, z: 0 };
}

/**
 * ジャイロ許可（iOS）と look-controls の有効化
 */
async function enableCameraControls() {
    const camera = document.getElementById('instance-camera');
    if (!camera) return;

    if (isMobileDevice()) {
        if (
            typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function'
        ) {
            try {
                const perm = await DeviceOrientationEvent.requestPermission();
                if (perm !== 'granted') {
                    setOverlayMessage(
                        'ジャイロが許可されていません。ドラッグ操作のみ利用できます',
                        true
                    );
                    setTimeout(() => setOverlayMessage(''), 3500);
                }
            } catch (e) {
                console.warn('[instance-viewer] orientation permission', e);
            }
        }
    }

    camera.setAttribute('look-controls', {
        magicWindowTrackingEnabled: isMobileDevice(),
        touchEnabled: true,
        pointerLockEnabled: false,
    });

    const lc = camera.components?.['look-controls'];
    if (lc?.pause && lc?.play) {
        lc.pause();
        lc.play();
    }
}

/**
 * 開始案内を表示し、ユーザー操作後にコントロールを有効化
 */
function showExperienceStartGuide() {
    return new Promise((resolve) => {
        const guide = document.getElementById('instance-start-guide');
        const btn = document.getElementById('instance-start-btn');
        const gyroLine = document.getElementById('instance-guide-gyro');
        const touchLine = document.getElementById('instance-guide-touch');
        if (!guide || !btn) {
            void enableCameraControls().then(resolve);
            return;
        }

        if (gyroLine) gyroLine.hidden = !isMobileDevice();
        if (touchLine) {
            touchLine.textContent = isMobileDevice()
                ? '画面をドラッグしても視点を変えられます'
                : 'マウスドラッグで視点を変えられます';
        }
        guide.hidden = false;

        btn.addEventListener(
            'click',
            () => {
                guide.hidden = true;
                void enableCameraControls().then(resolve);
            },
            { once: true }
        );
    });
}

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
 * @template T
 * @param {number} concurrency
 * @param {Array<() => Promise<T>>} factories
 */
async function runWithConcurrency(concurrency, factories) {
    const n = factories.length;
    const results = new Array(n);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= n) break;
            results[i] = await factories[i]();
        }
    }
    const workers = Math.min(Math.max(1, concurrency), Math.max(1, n));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

/**
 * @param {HTMLElement} parent
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.position]
 * @param {string} [opts.rotation]
 * @param {string} [opts.scale]
 */
function attachGlbEntity(parent, opts) {
    return new Promise((resolve, reject) => {
        const ent = document.createElement('a-entity');
        if (opts.position) ent.setAttribute('position', opts.position);
        if (opts.rotation) ent.setAttribute('rotation', opts.rotation);
        if (opts.scale) ent.setAttribute('scale', opts.scale);
        const onLoaded = () => {
            cleanup();
            resolve(ent);
        };
        const onError = () => {
            cleanup();
            reject(new Error(`model_load_failed:${opts.url}`));
        };
        const cleanup = () => {
            ent.removeEventListener('model-loaded', onLoaded);
            ent.removeEventListener('model-error', onError);
        };
        ent.addEventListener('model-loaded', onLoaded);
        ent.addEventListener('model-error', onError);
        ent.setAttribute('gltf-model', `url(${opts.url})`);
        parent.appendChild(ent);
    });
}

/**
 * @param {HTMLElement} scene
 * @param {string} spawnId
 * @param {object} manifest
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
        camera.removeAttribute('look-at');
        const rot = lookAtToRotation(camPos, lookAt);
        camera.setAttribute('rotation', vec3Str([rot.x, rot.y, rot.z]));
    }

    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    /** @type {Array<() => Promise<void>>} */
    const loadTasks = [];

    for (const entry of entries) {
        const pos = vec3Str(entry.position || [0, 0, 0]);
        const rot = vec3Str(entry.rotation || [0, 0, 0]);
        const scale = vec3Str(entry.scale || [1, 1, 1]);

        if (entry.kind === 'glb' && entry.file) {
            const url = assetUrl(spawnId, entry.file);
            loadTasks.push(async () => {
                await attachGlbEntity(scene, { url, position: pos, rotation: rot, scale });
            });
            continue;
        }

        if (entry.kind === 'prefab' && entry.manifest) {
            const manRes = await fetch(assetUrl(spawnId, entry.manifest));
            if (!manRes.ok) throw new Error('prefab_manifest_failed');
            const man = await manRes.json();
            const root = document.createElement('a-entity');
            root.setAttribute('position', pos);
            root.setAttribute('rotation', rot);
            root.setAttribute('scale', scale);
            scene.appendChild(root);
            const parts = Array.isArray(man.parts) ? man.parts : [];
            for (const part of parts) {
                const file = String(part.file || '').trim();
                if (!file) continue;
                const rel = file.startsWith('models/') ? file : `models/${file}`;
                const url = assetUrl(spawnId, rel);
                loadTasks.push(async () => {
                    await attachGlbEntity(root, { url });
                });
            }
        }
    }

    const total = loadTasks.length;
    if (!total) {
        setOverlayMessage('');
        await showExperienceStartGuide();
        return;
    }

    let loaded = 0;
    setOverlayMessage(`モデル読込 0/${total}…`);
    await runWithConcurrency(
        MODEL_LOAD_CONCURRENCY,
        loadTasks.map((task) => async () => {
            try {
                await task();
            } catch (e) {
                console.warn('[instance-viewer] model load failed', e);
            }
            loaded += 1;
            if (loaded % 20 === 0 || loaded === total) {
                setOverlayMessage(`モデル読込 ${loaded}/${total}…`);
            }
        })
    );
    setOverlayMessage('');
    await showExperienceStartGuide();
}

async function bootstrap() {
    const token = getTokenFromUrl();
    if (!token) {
        setOverlayMessage('token パラメータがありません', true);
        return;
    }
    if (!isMobileDevice()) {
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
