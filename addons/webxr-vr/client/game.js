// addons/webxr-vr/client/game.js — registry-game から import（登録のみ、throw しない）

import './webxr-vr.css';
import { registerClientInit, registerFrameUpdate } from '../../../lib/client-addon-registry.js';
import { initWebXrVrSubsystem } from './init.js';
import { ThreeMeshUI } from './vr-quick-menu.js';

/** @type {boolean|null} */
let enabledCache = null;

/**
 * @returns {Promise<boolean>}
 */
async function isWebxrVrEnabled() {
    if (enabledCache !== null) return enabledCache;
    try {
        const res = await fetch('/api/addons/enabled', { credentials: 'same-origin' });
        if (!res.ok) {
            enabledCache = false;
            return false;
        }
        const data = await res.json();
        enabledCache = data?.['webxr-vr'] === true;
        return enabledCache;
    } catch (e) {
        console.warn('[addon:webxr-vr] enabled check failed, skipping XR init:', e);
        enabledCache = false;
        return false;
    }
}

registerClientInit(async (app) => {
    const enabled = await isWebxrVrEnabled();
    if (!enabled) {
        console.info('[addon:webxr-vr] disabled or unavailable, skipping init');
        return;
    }
    initWebXrVrSubsystem(app);
});

registerFrameUpdate((app, deltaTime) => {
    if (app._webxrVrLocomotion) {
        app._webxrVrLocomotion.update(deltaTime);
    }
    if (app._webxrVrRig?.isAttached?.() && app.sceneManager?.getRenderer?.()?.xr?.isPresenting) {
        app._webxrVrRig.sync(app.characterController);
    }
}, { order: 10 });

registerFrameUpdate((app, deltaTime) => {
    if (app._vrQuickMenu && app.sceneManager?.getRenderer?.()?.xr?.isPresenting) {
        app._vrQuickMenu.update(deltaTime);
        ThreeMeshUI.update();
        app._vrQuickMenu.updateRaycast();
    }
}, { order: 15 });

console.info('[addon:webxr-vr] client registered');
