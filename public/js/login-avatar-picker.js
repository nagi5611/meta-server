// public/js/login-avatar-picker.js — ログイン: アバター横スクロールカルーセル（中央が選択・CDN の three）
const THREE_MOD = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const GLTF_LOADER_MOD =
    'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
const DRACO_LOADER_MOD =
    'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';
const DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/';

const STYLE_ID = 'login-avatar-picker-carousel-styles';

/** @type {Promise<{ THREE: typeof import('three'), GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader, DRACOLoader: typeof import('three/examples/jsm/loaders/DRACOLoader.js').DRACOLoader }> | null} */
let threeModulesPromise = null;

function loadThreeModules() {
    if (!threeModulesPromise) {
        threeModulesPromise = (async () => {
            const THREE = await import(/* @vite-ignore */ THREE_MOD);
            const { GLTFLoader } = await import(/* @vite-ignore */ GLTF_LOADER_MOD);
            const { DRACOLoader } = await import(/* @vite-ignore */ DRACO_LOADER_MOD);
            return { THREE, GLTFLoader, DRACOLoader };
        })();
    }
    return threeModulesPromise;
}

function ensureCarouselStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
.lap-root { margin-bottom: 20px; user-select: none; -webkit-user-select: none; }
.lap-carousel-label {
  font-weight: 600;
  font-size: 14px;
  color: #555;
  margin: 0 0 6px 4px;
  text-align: left;
}
.lap-viewport {
  position: relative;
  width: 100%;
  height: 168px;
  overflow: hidden;
  border-radius: 16px;
  background: #fafafa;
  border: 1px solid #e0e0e0;
  touch-action: none;
  cursor: grab;
}
.lap-viewport:active { cursor: grabbing; }
.lap-diamond {
  position: absolute;
  left: 50%;
  width: 10px;
  height: 10px;
  background: #0288d1;
  transform: translateX(-50%) rotate(45deg);
  z-index: 3;
  pointer-events: none;
  opacity: 0.85;
}
.lap-diamond--top { top: 10px; }
.lap-diamond--bottom { bottom: 10px; }
.lap-track {
  position: absolute;
  left: 0;
  top: 50%;
  display: flex;
  flex-direction: row;
  align-items: center;
  will-change: transform;
  height: 100%;
  padding: 0;
}
.lap-card {
  flex-shrink: 0;
  width: 86px;
  height: 86px;
  margin-right: 14px;
  border-radius: 16px;
  background: linear-gradient(145deg, #ececec, #f7f7f7);
  border: 2px solid #ddd;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.18s ease-out, box-shadow 0.18s ease-out, border-color 0.18s ease-out;
  position: relative;
  z-index: 1;
}
.lap-card:last-child { margin-right: 0; }
.lap-card--center {
  z-index: 2;
  box-shadow: 0 8px 24px rgba(2, 136, 209, 0.18);
  border-color: #0288d1;
}
.lap-card-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  background: #0288d1;
  color: #fff;
  font-weight: 600;
}
.lap-card-canvas-wrap {
  width: 100%;
  height: 100%;
  border-radius: 12px;
  overflow: hidden;
}
.lap-card-canvas-wrap canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.lap-card-hint {
  font-size: 11px;
  color: #888;
  text-align: center;
  padding: 4px;
  line-height: 1.2;
}
`;
    document.head.appendChild(st);
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

/** @typedef {{ id: string, glbPath?: string, signedUrl?: string|null, canonicalUrl?: string|null, isDefault?: boolean, displayScale?: number }} LoginAvatarDto */
/** @typedef {{ animationMap?: Record<string, string>, displayScale?: number }} LoginAvatarDetailDto */

/** @typedef {{ dispose: () => void }} LoginAvatarPickerHandle */

/**
 * @param {LoginAvatarDto} entry
 * @returns {Promise<string>}
 */
async function resolveAvatarModelUrl(entry) {
    const gp = typeof entry.glbPath === 'string' ? entry.glbPath.trim() : '';
    if (gp) return resolveAvatarUrlForPreview(gp);
    const su = typeof entry.signedUrl === 'string' ? entry.signedUrl.trim() : '';
    if (su) return su;
    return '';
}

/** @type {Map<string, LoginAvatarDetailDto>} */
const avatarDetailCache = new Map();

/**
 * アバター詳細（animationMap）を取得してキャッシュする
 * @param {string} avatarId
 * @returns {Promise<LoginAvatarDetailDto>}
 */
async function fetchAvatarDetail(avatarId) {
    const id = String(avatarId || '').trim();
    if (!id) return {};
    if (avatarDetailCache.has(id)) {
        return avatarDetailCache.get(id) || {};
    }
    try {
        const res = await fetch(`/api/avatar/${encodeURIComponent(id)}`, { credentials: 'include' });
        if (!res.ok) {
            avatarDetailCache.set(id, {});
            return {};
        }
        const j = await res.json().catch(() => ({}));
        const detail =
            j && typeof j === 'object' ? /** @type {LoginAvatarDetailDto} */ (j) : /** @type {LoginAvatarDetailDto} */ ({});
        avatarDetailCache.set(id, detail);
        return detail;
    } catch {
        avatarDetailCache.set(id, {});
        return {};
    }
}

/**
 * 指定名に一致する AnimationClip を返す（完全一致優先、部分一致フォールバック）
 * @param {import('three').AnimationClip[]} clips
 * @param {string[]} preferredNames
 * @returns {import('three').AnimationClip | null}
 */
function findClipByPreferredNames(clips, preferredNames) {
    if (!Array.isArray(clips) || clips.length === 0) return null;
    const exact = preferredNames
        .map((n) => String(n || '').trim().toLowerCase())
        .filter((n) => n.length > 0);
    for (const name of exact) {
        const clip = clips.find((c) => String(c?.name || '').trim().toLowerCase() === name);
        if (clip) return clip;
    }
    for (const name of exact) {
        const clip = clips.find((c) => String(c?.name || '').trim().toLowerCase().includes(name));
        if (clip) return clip;
    }
    return null;
}

/**
 * idle/walk/run/jump の順で再生クリップ列を作る（欠損時は先頭クリップへフォールバック）
 * @param {import('three').AnimationClip[]} clips
 * @param {Record<string, string> | undefined} animationMap
 * @returns {import('three').AnimationClip[]}
 */
function buildPreviewClipSequence(clips, animationMap) {
    if (!Array.isArray(clips) || clips.length === 0) return [];
    const map = animationMap && typeof animationMap === 'object' ? animationMap : {};
    const keyCandidates = {
        idle: [String(map.idle || ''), 'idle', 'wait', 'stand'],
        walk: [String(map.walk || ''), 'walk', 'walking'],
        run: [String(map.run || ''), 'run', 'running'],
        jump: [String(map.jump || ''), 'jump', 'jumping'],
    };
    /** @type {import('three').AnimationClip[]} */
    const seq = [];
    for (const k of ['idle', 'walk', 'run', 'jump']) {
        const clip = findClipByPreferredNames(
            clips,
            keyCandidates[/** @type {'idle'|'walk'|'run'|'jump'} */ (k)]
        );
        if (clip) seq.push(clip);
    }
    if (seq.length === 0) seq.push(clips[0]);
    return seq;
}

/**
 * ログインコンテナ直下にマウントし、アバター選択 UI を構築する
 * @param {HTMLElement|null} mount
 * @param {{ onSelectionChange?: (id: string) => void }} [opts]
 * @returns {Promise<LoginAvatarPickerHandle|null>}
 */
export async function mountLoginAvatarPicker(mount, opts = {}) {
    if (!mount) return null;
    mount.innerHTML = '';
    mount.classList.add('lap-root');
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
    ensureCarouselStyles();

    const LS_AVATAR = 'metaverseAvatarId';
    const entries = /** @type {LoginAvatarDto[]} */ (list);
    const defaultEntry = entries.find((a) => a.isDefault) || entries[0];
    let saved = localStorage.getItem(LS_AVATAR);
    if (!saved || !entries.some((a) => a.id === saved)) {
        saved = defaultEntry?.id || '';
    }
    if (!saved) saved = defaultEntry.id;

    let selectedIndex = Math.max(0, entries.findIndex((e) => e.id === saved));
    const onChangeCb = typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : null;

    const CARD = 86;
    const GAP = 14;
    const STEP = CARD + GAP;

    const label = document.createElement('div');
    label.className = 'lap-carousel-label';
    label.textContent = 'アバターを選択';

    const viewport = document.createElement('div');
    viewport.className = 'lap-viewport';
    viewport.setAttribute('role', 'listbox');
    viewport.setAttribute('aria-label', 'アバター一覧');

    const diamondTop = document.createElement('div');
    diamondTop.className = 'lap-diamond lap-diamond--top';
    const diamondBot = document.createElement('div');
    diamondBot.className = 'lap-diamond lap-diamond--bottom';

    const track = document.createElement('div');
    track.className = 'lap-track';

    /** @type {HTMLElement[]} */
    const cards = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const card = document.createElement('div');
        card.className = 'lap-card';
        card.dataset.index = String(i);
        card.setAttribute('role', 'option');
        card.setAttribute('aria-selected', entry.id === saved ? 'true' : 'false');
        if (entry.isDefault) {
            const b = document.createElement('span');
            b.className = 'lap-card-badge';
            b.textContent = '既定';
            card.appendChild(b);
        }
        const wrap = document.createElement('div');
        wrap.className = 'lap-card-canvas-wrap';
        wrap.style.display = 'block';
        const hint = document.createElement('div');
        hint.className = 'lap-card-hint';
        hint.textContent = '読み込み中';
        card.appendChild(hint);
        card.appendChild(wrap);
        track.appendChild(card);
        cards.push(card);
    }

    viewport.appendChild(diamondTop);
    viewport.appendChild(track);
    viewport.appendChild(diamondBot);

    mount.appendChild(label);
    mount.appendChild(viewport);

    let translateX = 0;
    let dragging = false;
    let startPointerX = 0;
    let startTranslate = 0;
    let rafLayout = 0;
    let disposed = false;

    /** @type {Array<{avatarId: string, canvas: HTMLCanvasElement, renderer: import('three').WebGLRenderer, scene: import('three').Scene, camera: import('three').PerspectiveCamera, mixer: import('three').AnimationMixer | null, raf: number | null, disposeExtra: (() => void) | null } | null>} */
    const previewStates = Array.from({ length: entries.length }, () => null);

    function getViewportWidth() {
        return viewport.clientWidth || 320;
    }

    function translateForIndex(idx) {
        const V = getViewportWidth();
        return V / 2 - CARD / 2 - idx * STEP;
    }

    function clampTranslate(tx) {
        const V = getViewportWidth();
        const maxIdx = entries.length - 1;
        const minT = translateForIndex(maxIdx);
        const maxT = translateForIndex(0);
        return Math.min(maxT, Math.max(minT, tx));
    }

    function applyTrackTransform(animate) {
        track.style.transition = animate ? 'transform 0.22s ease-out' : 'none';
        track.style.transform = `translate3d(${translateX}px, -50%, 0)`;
    }

    function updateCardScales() {
        const V = getViewportWidth();
        const cx = V / 2;
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const cardLeft = translateX + i * STEP;
            const cardCenter = cardLeft + CARD / 2;
            const dist = Math.abs(cardCenter - cx);
            const t = Math.min(1, dist / (STEP * 0.95));
            const scale = 1.15 - t * 0.38;
            card.style.transform = `scale(${scale.toFixed(3)})`;
            const isCenter = dist < CARD * 0.35;
            card.classList.toggle('lap-card--center', isCenter);
            card.setAttribute('aria-selected', isCenter ? 'true' : 'false');
        }
    }

    function scheduleLayout() {
        if (rafLayout) cancelAnimationFrame(rafLayout);
        rafLayout = requestAnimationFrame(() => {
            rafLayout = 0;
            updateCardScales();
        });
    }

    function snapToIndex(idx, animate) {
        const i = Math.max(0, Math.min(entries.length - 1, idx));
        selectedIndex = i;
        translateX = translateForIndex(i);
        applyTrackTransform(animate);
        scheduleLayout();
        const id = entries[i].id;
        localStorage.setItem(LS_AVATAR, id);
        onChangeCb?.(id);
    }

    /**
     * 指定カードのGLBプレビューを破棄
     * @param {number} idx
     */
    function disposeCardPreview(idx) {
        const st = previewStates[idx];
        if (!st) return;
        if (st.raf != null) {
            cancelAnimationFrame(st.raf);
            st.raf = null;
        }
        if (typeof st.disposeExtra === 'function') st.disposeExtra();
        st.renderer.dispose();
        if (st.canvas.parentElement) st.canvas.parentElement.removeChild(st.canvas);
        previewStates[idx] = null;
    }

    function disposeAllCardPreviews() {
        for (let i = 0; i < previewStates.length; i++) disposeCardPreview(i);
    }

    /**
     * 各カードの GLB プレビューを表示する（Draco 圧縮対応）
     * @param {LoginAvatarDto} entry
     * @param {number} idx
     */
    async function loadCardPreview(entry, idx) {
        if (disposed || !entry) return;
        if (idx < 0 || idx >= cards.length) return;
        if (previewStates[idx] && previewStates[idx].avatarId === entry.id) return;

        disposeCardPreview(idx);
        const card = cards[idx];
        const wrap = card.querySelector('.lap-card-canvas-wrap');
        const hint = card.querySelector('.lap-card-hint');
        if (!wrap || !hint) return;
        hint.style.display = '';
        wrap.style.display = 'block';
        wrap.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        wrap.appendChild(canvas);

        const [url, avatarDetail] = await Promise.all([
            resolveAvatarModelUrl(entry),
            fetchAvatarDetail(entry.id),
        ]);
        if (!url || disposed) {
            return;
        }

        const { THREE, GLTFLoader, DRACOLoader } = await loadThreeModules();
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(canvas.width, canvas.height, false);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, canvas.width / canvas.height, 0.1, 100);
        camera.position.set(0, 1.2, 2.1);
        camera.lookAt(0, 0.85, 0);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
        const dir = new THREE.DirectionalLight(0xffffff, 0.55);
        dir.position.set(2, 4, 5);
        scene.add(dir);

        const loader = new GLTFLoader();
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        loader.setDRACOLoader(dracoLoader);
        /** @type {import('three').AnimationMixer | null} */
        let mixer = null;

        previewStates[idx] = {
            avatarId: entry.id,
            canvas,
            renderer,
            scene,
            camera,
            mixer: null,
            raf: null,
            disposeExtra: null,
        };
        loader.load(
            url,
            (gltf) => {
                const st = previewStates[idx];
                if (disposed || !st || st.avatarId !== entry.id) return;
                const root = new THREE.Group();
                const model = gltf.scene;
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const sz = Math.max(size.x, size.y, size.z) || 1;
                const ds =
                    typeof entry.displayScale === 'number' && Number.isFinite(entry.displayScale)
                        ? entry.displayScale
                        : 1;
                model.scale.multiplyScalar((0.35 / sz) * ds);
                root.add(model);
                root.position.set(0, 0.02, 0);
                scene.add(root);
                if (gltf.animations && gltf.animations.length) {
                    mixer = new THREE.AnimationMixer(root);
                    const clipSequence = buildPreviewClipSequence(gltf.animations, avatarDetail.animationMap);
                    let sequenceIndex = 0;
                    /** @type {import('three').AnimationAction | null} */
                    let currentAction = null;
                    const playSequenceAt = (idxAction) => {
                        if (!mixer || clipSequence.length === 0) return;
                        sequenceIndex = idxAction % clipSequence.length;
                        const clip = clipSequence[sequenceIndex];
                        const action = mixer.clipAction(clip);
                        action.reset();
                        action.setLoop(THREE.LoopRepeat, 5);
                        action.clampWhenFinished = false;
                        action.enabled = true;
                        action.fadeIn(0.15);
                        action.play();
                        if (currentAction && currentAction !== action) {
                            currentAction.fadeOut(0.15);
                        }
                        currentAction = action;
                    };
                    const handleFinished = (ev) => {
                        if (!currentAction || ev?.action !== currentAction) return;
                        playSequenceAt(sequenceIndex + 1);
                    };
                    mixer.addEventListener('finished', handleFinished);
                    playSequenceAt(0);
                    st.disposeExtra = () => {
                        if (mixer) mixer.removeEventListener('finished', handleFinished);
                    };
                    st.mixer = mixer;
                }
                hint.style.display = 'none';
            },
            undefined,
            () => {
                if (!disposed) {
                    hint.textContent = '読み込み失敗';
                }
            }
        );

        const tick = () => {
            const st = previewStates[idx];
            if (disposed || !st) return;
            st.raf = requestAnimationFrame(tick);
            if (st.mixer) st.mixer.update(1 / 60);
            st.renderer.render(st.scene, st.camera);
        };
        tick();
    }

    translateX = translateForIndex(selectedIndex);
    applyTrackTransform(false);
    scheduleLayout();
    for (let i = 0; i < entries.length; i++) {
        void loadCardPreview(entries[i], i);
    }

    function nearestIndexFromTranslate(tx) {
        const V = getViewportWidth();
        const ideal = V / 2 - CARD / 2 - tx;
        const idx = Math.round(ideal / STEP);
        return Math.max(0, Math.min(entries.length - 1, idx));
    }

    viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = true;
        startPointerX = e.clientX;
        startTranslate = translateX;
        viewport.setPointerCapture(e.pointerId);
        track.style.transition = 'none';
    });

    viewport.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        translateX = clampTranslate(startTranslate + (e.clientX - startPointerX));
        applyTrackTransform(false);
        scheduleLayout();
    });

    viewport.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        try {
            viewport.releasePointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
        const idx = nearestIndexFromTranslate(translateX);
        snapToIndex(idx, true);
    });

    viewport.addEventListener('pointercancel', () => {
        dragging = false;
        snapToIndex(selectedIndex, true);
    });

    const onResize = () => {
        translateX = translateForIndex(selectedIndex);
        applyTrackTransform(false);
        scheduleLayout();
    };
    window.addEventListener('resize', onResize);

    return {
        dispose() {
            disposed = true;
            window.removeEventListener('resize', onResize);
            if (rafLayout) cancelAnimationFrame(rafLayout);
            disposeAllCardPreviews();
            mount.innerHTML = '';
            mount.classList.remove('lap-root');
            mount.style.display = 'none';
        },
    };
}
