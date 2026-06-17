// addons/webxr-vr/client/vr-entry-button.js — WebXR 入室ボタン（local-floor / dom-overlay 対応）

/**
 * Metaverse 用 VR 入室ボタンを生成する。
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ domOverlayRoot?: HTMLElement|null }} [options]
 * @returns {HTMLElement}
 */
export function createMetaverseVRButton(renderer, options = {}) {
    const domOverlayRoot = options.domOverlayRoot || null;

    const optionalFeatures = ['local-floor'];
    if (domOverlayRoot) {
        optionalFeatures.push('dom-overlay');
    }

    /** @type {XRSessionInit} */
    const sessionInit = { optionalFeatures };
    if (domOverlayRoot) {
        sessionInit.domOverlay = { root: domOverlayRoot };
    }

    const button = document.createElement('button');
    button.id = 'metaverse-vr-button';

    function stylizeElement(el) {
        el.style.position = 'fixed';
        el.style.bottom = '20px';
        el.style.left = 'calc(50% - 50px)';
        el.style.width = '100px';
        el.style.padding = '12px 6px';
        el.style.border = '1px solid #fff';
        el.style.borderRadius = '4px';
        el.style.background = 'rgba(0,0,0,0.35)';
        el.style.color = '#fff';
        el.style.font = 'normal 13px sans-serif';
        el.style.textAlign = 'center';
        el.style.opacity = '0.85';
        el.style.outline = 'none';
        el.style.zIndex = '10000';
        el.style.cursor = 'pointer';
    }

    function disableButton() {
        button.style.cursor = 'auto';
        button.onclick = null;
        button.onmouseenter = null;
        button.onmouseleave = null;
    }

    if (!('xr' in navigator)) {
        const hidden = document.createElement('span');
        hidden.style.display = 'none';
        return hidden;
    }

    stylizeElement(button);
    button.style.display = 'none';
    button.textContent = 'VR';

    let currentSession = null;

    async function onSessionStarted(session) {
        session.addEventListener('end', onSessionEnded);
        await renderer.xr.setSession(session);
        button.textContent = 'VR 終了';
        currentSession = session;
    }

    function onSessionEnded() {
        if (currentSession) {
            currentSession.removeEventListener('end', onSessionEnded);
        }
        button.textContent = 'VR';
        currentSession = null;
    }

    function tryEnterVR() {
        if (currentSession === null) {
            navigator.xr.requestSession('immersive-vr', sessionInit).then(onSessionStarted).catch((err) => {
                console.warn('[WebXR] requestSession failed, retry without dom-overlay:', err);
                const fallbackInit = { optionalFeatures: ['local-floor'] };
                navigator.xr.requestSession('immersive-vr', fallbackInit).then(onSessionStarted).catch((e) => {
                    console.warn('[WebXR] retry without local-floor:', e);
                    navigator.xr.requestSession('immersive-vr', { optionalFeatures: [] }).then(onSessionStarted).catch((e2) => {
                        console.error('[WebXR] session failed:', e2);
                    });
                });
            });
        } else {
            currentSession.end();
        }
    }

    navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        if (!supported) {
            button.style.display = 'none';
            disableButton();
            return;
        }
        button.style.display = '';
        button.onclick = tryEnterVR;
        button.onmouseenter = () => { button.style.opacity = '1'; };
        button.onmouseleave = () => { button.style.opacity = '0.85'; };

        if (navigator.xr.offerSession !== undefined) {
            navigator.xr.offerSession('immersive-vr', sessionInit).then(onSessionStarted).catch(() => {});
        }
    }).catch((e) => {
        console.warn('[WebXR] isSessionSupported:', e);
        button.style.display = 'none';
        disableButton();
    });

    return button;
}
