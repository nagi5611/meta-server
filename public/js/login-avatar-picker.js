// public/js/login-avatar-picker.js — ログイン画面で選択可能アバター一覧・プレビュー（THREE を CDN から動的 import）
const THREE_MOD = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const GLTF_LOADER_MOD =
    'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

/** @type {{ THREE: typeof import('three'), GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader } | null} */
let threeModulesPromise = null;

function loadThreeModules() {
    if (!threeModulesPromise) {
        threeModulesPromise = (async () => {
            const THREE = await import(/* @vite-ignore */ THREE_MOD);
            const { GLTFLoader } = await import(/* @vite-ignore */ GLTF_LOADER_MOD);
            return { THREE, GLTFLoader };
        })();
    }
    return threeModulesPromise;
}

/**
 * メタバース共通のモデル URL 解決
 * @param {string} pathRel
 * @returns {Promise<string>}
 */
async function resolveAvatarUrlForPreview(pathRel) {
    try {
        const { resolveModelAssetHref } = await import('./asset-resolve.js');
        return resolveModelAssetHref(pathRel);
    } catch {
        const p = String(pathRel || '').replace(/^\/+/, '');
        return p.startsWith('http') ? p : `/${p}`;
    }
}

/** @typedef {{ id: string, glbPath?: string, signedUrl?: string|null, canonicalUrl?: string|null, isDefault?: boolean }} LoginAvatarDto */

/** @typedef {{ dispose: () => void }} LoginAvatarPickerHandle */

/**
 * ログインコンテナ直下にマウントし、アバター選択 UI を構築する
 * @param {HTMLElement|null} mount
 * @param {{ onSelectionChange?: (id: string) => void }} [opts]
 * @returns {Promise<LoginAvatarPickerHandle|null>}
 */
export async function mountLoginAvatarPicker(mount, opts = {}) {
    if (!mount) return null;
    mount.innerHTML = '';
    await fetch('/api/client-config', { credentials: 'include' }).catch(() => {});
    const status = document.createElement('p');
    status.className = 'login-avatar-msg';
    status.setAttribute('role', 'status');
    mount.appendChild(status);

    let list = [];
    try {
        const r = await fetch('/api/avatars', { credentials: 'include' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            status.textContent = '';
            mount.style.display = 'none';
            return { dispose() {} };
        }
        list = Array.isArray(data.avatars) ? data.avatars : [];
    } catch (_) {
        status.textContent = '';
        mount.style.display = 'none';
        return { dispose() {} };
    }

    if (list.length === 0) {
        status.textContent = '';
        mount.style.display = 'none';
        return { dispose() {} };
    }

    mount.style.display = 'block';

    const title = document.createElement('div');
    title.className = 'login-avatar-heading';
    title.textContent = 'アバターを選択';

    /** @type {HTMLDivElement} */
    const previewWrap = document.createElement('div');
    previewWrap.className = 'login-avatar-preview-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'login-avatar-canvas';
    canvas.width = 220;
    canvas.height = 220;
    previewWrap.appendChild(canvas);

    /** @type {HTMLDivElement} */
    const listEl = document.createElement('div');
    listEl.className = 'login-avatar-choice-list';

    const LS_AVATAR = 'metaverseAvatarId';
    const defaultEntry = list.find((a) => a.isDefault) || list[0];
    let saved = localStorage.getItem(LS_AVATAR);
    if (!saved || !list.some((a) => a.id === saved)) {
        saved = defaultEntry?.id || '';
    }
    if (!saved) {
        saved = defaultEntry?.id || list[0].id;
    }

    /** @type {LoginAvatarDto[]} */
    const entries = list;
    /** @type {string} */
    let selectedId = saved;

    const onChangeCb = typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : null;

    entries.forEach((entry) => {
        const lab = document.createElement('label');
        lab.className = 'login-avatar-choice-item';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'login-avatar-choice';
        radio.value = entry.id;
        radio.checked = entry.id === selectedId;
        const cap = document.createElement('span');
        cap.innerHTML = `${entry.isDefault ? '<strong>[既定]</strong> ' : ''}<code>${String(entry.id).slice(0, 8)}…</code>`;
        lab.appendChild(radio);
        lab.appendChild(cap);
        listEl.appendChild(lab);
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            selectedId = entry.id;
            localStorage.setItem(LS_AVATAR, selectedId);
            void renderPreview(entry);
            onChangeCb?.(selectedId);
        });
    });

    mount.appendChild(title);
    mount.appendChild(previewWrap);
    mount.appendChild(listEl);

    let rafWatch = null;
    let disposed = false;
    /** @type {import('three').WebGLRenderer | null} */
    let renderer = null;
    /** @type {import('three').PerspectiveCamera | null} */
    let camera = null;
    /** @type {import('three').Scene | null} */
    let scene = null;
    /** @type {ReturnType<import('three').AnimationMixer>|null} */
    let mixer = null;
    /** @type {{ scene: import('three').Group } | null} */
    let pivot = null;
    /** @type {Promise<void> | null} */
    let loadSeq = null;

    async function ensureRenderer() {
        if (renderer) return;
        const { THREE } = await loadThreeModules();
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setSize(canvas.width, canvas.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
        camera.position.set(0, 1.35, 2.25);
        camera.lookAt(0, 0.9, 0);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
        const dir = new THREE.DirectionalLight(0xffffff, 0.6);
        dir.position.set(2, 4, 5);
        scene.add(dir);

        function tick() {
            if (disposed || !renderer || !scene || !camera) return;
            rafWatch = requestAnimationFrame(tick);
            const dt = 1 / 60;
            if (mixer) mixer.update(dt);
            renderer.render(scene, camera);
        }
        tick();
    }

    /**
     * 選択中モデルをプレビューに読み込む
     * @param {LoginAvatarDto} entry
     */
    async function renderPreview(entry) {
        if (!entry || disposed) return;
        await ensureRenderer();
        const { THREE, GLTFLoader } = await loadThreeModules();

        /** @returns {Promise<string>} */
        const resolveUrl = async () => {
            const su = typeof entry.signedUrl === 'string' ? entry.signedUrl.trim() : '';
            if (su) return su;
            const gp = typeof entry.glbPath === 'string' ? entry.glbPath.trim() : '';
            if (gp) return resolveAvatarUrlForPreview(gp);
            return '';
        };

        /** @returns {Promise<void>} */
        const run = async () => {
            const url = await resolveUrl();
            if (!url || !scene || !THREE) return;
            loadSeq = (async () => {
                mixer = null;
                if (pivot) {
                    scene.remove(pivot);
                    pivot.scene.traverse((ch) => {
                        if (!ch.geometry) return;
                        ch.geometry.dispose();
                        const m = ch.material;
                        if (Array.isArray(m)) {
                            for (const mm of m) mm.dispose();
                        } else if (m) m.dispose();
                    });
                    pivot = null;
                }
                const loader = new GLTFLoader();
                loader.load(url, (gltf) => {
                    if (disposed) return;
                    const rootGroup = new THREE.Group();
                    const model = gltf.scene;
                    const box = new THREE.Box3().setFromObject(model);
                    const size = box.getSize(new THREE.Vector3());
                    const sz = Math.max(size.x, size.y, size.z) || 1;
                    model.scale.multiplyScalar(1.6 / sz);
                    rootGroup.add(model);
                    rootGroup.position.set(0, 0.05, 0);
                    pivot = { scene: rootGroup };
                    scene.add(rootGroup);
                    if (gltf.animations && gltf.animations.length && pivot.scene) {
                        mixer = new THREE.AnimationMixer(rootGroup);
                        mixer.clipAction(gltf.animations[0]).play();
                    }
                });
            })();
            await loadSeq;
        };

        void run().catch(() => {});
    }

    selectedId =
        [...listEl.querySelectorAll('input[name="login-avatar-choice"]:checked')]?.[0]?.value ||
        selectedId;

    localStorage.setItem(LS_AVATAR, selectedId);

    await renderPreview(entries.find((e) => e.id === selectedId) || defaultEntry || entries[0]);
    onChangeCb?.(selectedId);

    return {
        dispose() {
            disposed = true;
            if (rafWatch) cancelAnimationFrame(rafWatch);
            if (renderer) {
                renderer.dispose();
                renderer = null;
            }
            mixer = null;
            pivot = null;
            scene = null;
            camera = null;
            mount.innerHTML = '';
            mount.style.display = 'none';
        },
    };
}
