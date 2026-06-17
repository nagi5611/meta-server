// addons/avator-scalable-animations/client/init.js — 環境変数由来のキー割当でローカルアバターの追加クリップを再生

import * as THREE from 'three';

const SETTINGS_URL = '/api/addons/avator-scalable-animations/settings';

/**
 * 設定の key 表記を KeyboardEvent.code に近い形へ変換する（例: B → KeyB）。
 * @param {string} key
 * @returns {string}
 */
function keySpecToCode(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length === 1) {
        const u = k.toUpperCase();
        if (/^[A-Z]$/.test(u)) return `Key${u}`;
        if (/^[0-9]$/.test(k)) return `Digit${k}`;
    }
    return k;
}

/**
 * bindings からクリップを解決する。
 * @param {import('three').AnimationClip[]} clips
 * @param {{ clipIndex?: number, clipName?: string }} binding
 * @returns {import('three').AnimationClip | null}
 */
function resolveClip(clips, binding) {
    if (!clips?.length) return null;
    if (typeof binding.clipIndex === 'number' && Number.isFinite(binding.clipIndex)) {
        const ix = Math.trunc(binding.clipIndex);
        return clips[ix] || null;
    }
    if (typeof binding.clipName === 'string' && binding.clipName.trim()) {
        const want = binding.clipName.trim();
        const exact = clips.find((c) => c.name === want);
        if (exact) return exact;
        const lower = want.toLowerCase();
        return clips.find((c) => String(c.name || '').toLowerCase().includes(lower)) || null;
    }
    return null;
}

/**
 * アバター registry の scalable_* インデックスを優先してクリップを解決する。
 * @param {import('three').AnimationClip[]} clips
 * @param {Record<string, number>|undefined} avatarMap
 * @param {{ slotKey?: string, clipIndex?: number, clipName?: string }} binding
 * @returns {import('three').AnimationClip | null}
 */
function resolveClipForBinding(clips, avatarMap, binding) {
    const sk = binding.slotKey;
    if (sk && avatarMap && typeof avatarMap === 'object') {
        const ix = avatarMap[sk];
        if (typeof ix === 'number' && Number.isFinite(ix)) {
            const clip = clips[Math.trunc(ix)] || null;
            if (clip) return clip;
        }
    }
    return resolveClip(clips, binding);
}

/**
 * アドオン用の追加アニメーションを再生する。
 * @param {{ playerManager?: { localPlayer?: import('three').Object3D }, characterController: { getAnimationState: () => string } }} app
 * @param {{ name: string, key: string, slotKey?: string, clipIndex?: number, clipName?: string }} binding
 */
function playAddonClip(app, binding) {
    const lp = app.playerManager?.localPlayer;
    const clips = lp?.userData?.avatarAnimationClips;
    const mixer = lp?.userData?.mixer;
    if (!lp || !mixer || !clips?.length) return;

    const avatarMap = lp.userData.avatarAnimationMap;
    const clip = resolveClipForBinding(clips, avatarMap, binding);
    if (!clip) return;

    const actions = lp.userData.avatarActions;

    if (lp.userData._addonCustomFinishedHandler) {
        mixer.removeEventListener('finished', lp.userData._addonCustomFinishedHandler);
        lp.userData._addonCustomFinishedHandler = null;
    }
    if (lp.userData._addonCustomAction) {
        lp.userData._addonCustomAction.fadeOut(0.12);
        lp.userData._addonCustomAction = null;
    }

    const custom = mixer.clipAction(clip);
    custom.reset();
    custom.setLoop(THREE.LoopOnce, 1);
    custom.clampWhenFinished = true;

    lp.userData.addonCustomAnimActive = true;

    const curState = lp.userData.animationState || 'idle';
    const curAction = actions?.[curState];
    if (curAction) curAction.fadeOut(0.12);
    custom.fadeIn(0.12);
    custom.play();

    lp.userData._addonCustomAction = custom;

    const onFinished = (/** @type {{ action?: import('three').AnimationAction }} */ ev) => {
        if (ev?.action !== custom) return;
        mixer.removeEventListener('finished', onFinished);
        lp.userData._addonCustomFinishedHandler = null;
        lp.userData._addonCustomAction = null;
        custom.fadeOut(0.12);
        lp.userData.addonCustomAnimActive = false;

        const targetState = app.characterController.getAnimationState();
        lp.userData.animationState = targetState;
        const nextAction = actions?.[targetState];
        if (nextAction) {
            nextAction.reset().play();
            nextAction.fadeIn(0.12);
        }
    };
    lp.userData._addonCustomFinishedHandler = onFinished;
    mixer.addEventListener('finished', onFinished);
}

/**
 * MetaverseApp にキー割当アニメを結線する。
 * @param {object} app
 */
export function initAvatorScalableAnimations(app) {
    /** @type {Map<string, { name: string, key: string, clipIndex?: number, clipName?: string }>} */
    let codeToBinding = new Map();

    const refresh = async () => {
        try {
            const r = await fetch(SETTINGS_URL, { credentials: 'include' });
            if (!r.ok) return;
            const j = await r.json().catch(() => ({}));
            if (!j.ok || !Array.isArray(j.bindings)) return;
            const next = new Map();
            for (const b of j.bindings) {
                if (!b || typeof b !== 'object') continue;
                const code = keySpecToCode(b.key);
                if (code) next.set(code, b);
            }
            codeToBinding = next;
        } catch {
            /* ignore */
        }
    };

    void refresh();

    /**
     * @param {KeyboardEvent} e
     */
    const onKeyDown = (e) => {
        if (e.repeat) return;
        if (app.aircraftManager?.isPiloting || app.aircraftManager?.isPassenger) return;
        if (app.characterController?.isInputActive()) return;
        if (app.isImmersivePresenting?.()) return;

        const binding = codeToBinding.get(e.code);
        if (!binding) return;

        e.preventDefault();
        playAddonClip(app, binding);
    };

    document.addEventListener('keydown', onKeyDown);
}
