// addons/webxr-vr/client/init.js — WebXR VR サブシステム初期化

import { createMetaverseVRButton } from './vr-entry-button.js';
import WebXRLocomotion from './webxr-locomotion.js';
import { XrPlayerRig } from './xr-player-rig.js';
import { WebXrMovementDelegate } from './movement-delegate.js';
import { VrQuickMenu } from './vr-quick-menu.js';
import {
    registerMovementDelegate,
    registerInputGuard,
    registerImmersiveStateProvider,
    registerGraphicsTierOverride,
    registerPixelRatioOverride,
} from '../../../lib/client-addon-registry.js';

/**
 * @param {object} app MetaverseApp
 */
export function initWebXrVrSubsystem(app) {
    const renderer = app.sceneManager.getRenderer();
    renderer.xr.enabled = true;

    const overlayRoot = document.getElementById('immersive-overlay-root')
        || document.getElementById('xr-dom-overlay-root');

    const movementDelegate = new WebXrMovementDelegate(app.sceneManager.getCamera());
    registerMovementDelegate(movementDelegate);
    app.characterController.setMovementDelegate(movementDelegate);

    registerInputGuard(() => movementDelegate.blocksDesktopInput());
    registerImmersiveStateProvider(() => movementDelegate.isActive());

    let immersiveGraphicsActive = false;
    registerGraphicsTierOverride((baseTier) => {
        if (immersiveGraphicsActive) return 'low';
        return baseTier;
    });
    registerPixelRatioOverride((computed) => {
        if (immersiveGraphicsActive) return Math.min(1, computed);
        return computed;
    });

    renderer.xr.addEventListener('sessionstart', () => {
        immersiveGraphicsActive = true;
        app.sceneManager.applyGraphicsSettings(app.sceneManager.graphicsOptions);
    });
    renderer.xr.addEventListener('sessionend', () => {
        immersiveGraphicsActive = false;
        app.sceneManager.applyGraphicsSettings(app.sceneManager.graphicsOptions);
    });

    const vrBtn = createMetaverseVRButton(renderer, {
        domOverlayRoot: overlayRoot || null
    });
    if (overlayRoot) overlayRoot.appendChild(vrBtn);
    else document.body.appendChild(vrBtn);

    const xrPlayerRig = new XrPlayerRig({
        scene: app.sceneManager.getScene(),
        camera: app.sceneManager.getCamera(),
        renderer,
        shouldApplyRig: () => !!app.characterController?.isWalkingCharacter(),
        getRigYaw: () => movementDelegate.getRigYaw()
    });

    const webxrLocomotion = new WebXRLocomotion({
        renderer,
        sceneManager: app.sceneManager,
        physicsManager: app.physicsManager,
        characterController: app.characterController,
        movementDelegate,
        xrPlayerRig,
        domOverlayRoot: overlayRoot || null,
        getQuickMenuVisible: () => !!app._vrQuickMenu?.isMainVisible?.(),
        onVrSessionStart: () => {
            const vm = app.menuManager.settings.viewMode;
            app._viewModeBeforeVr = (vm === 'first' || vm === 'third') ? vm : 'third';
            app.characterController.setViewMode('first');
            app.playerManager.setLocalPlayerVisible(false);
        },
        onVrSessionEnd: () => {
            const mode = app._viewModeBeforeVr != null ? app._viewModeBeforeVr : 'third';
            app._viewModeBeforeVr = null;
            app.characterController.setViewMode(mode);
            app.playerManager.setLocalPlayerVisible(mode !== 'first');
        }
    });

    let vrQuickMenu = null;
    try {
        vrQuickMenu = new VrQuickMenu({
            app,
            renderer,
            camera: app.sceneManager.getCamera(),
            scene: app.sceneManager.getScene(),
            domOverlayRoot: overlayRoot || null,
        });
        app._vrQuickMenu = vrQuickMenu;

        const origSessionStart = webxrLocomotion.onVrSessionStart;
        webxrLocomotion.onVrSessionStart = () => {
            if (origSessionStart) origSessionStart();
            try {
                vrQuickMenu?.attach();
            } catch (e) {
                console.error('[VR QuickMenu] attach failed:', e);
            }
        };

        const origSessionEnd = webxrLocomotion.onVrSessionEnd;
        webxrLocomotion.onVrSessionEnd = () => {
            try {
                vrQuickMenu?.detach();
            } catch (e) {
                console.error('[VR QuickMenu] detach failed:', e);
            }
            if (origSessionEnd) origSessionEnd();
        };
    } catch (e) {
        console.error('[VR QuickMenu] init failed (VR locomotion continues):', e);
        app._vrQuickMenu = null;
    }

    app._webxrVrLocomotion = webxrLocomotion;
    app._webxrVrRig = xrPlayerRig;

    app._webxrVrDispose = () => {
        try {
            app._vrQuickMenu?.dispose();
        } catch (e) {
            console.error('[VR QuickMenu] dispose:', e);
        }
        app._vrQuickMenu = null;
        webxrLocomotion.dispose();
        xrPlayerRig.dispose();
        registerMovementDelegate(null);
    };
}
