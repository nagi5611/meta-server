// addons/aircraft/client/init.js — MetaverseApp へのエアークラフト結線（main から呼び出し）

import AircraftController from './aircraft-controller.js';
import AircraftManager from './aircraft-manager.js';
import MobileAircraftControls from '../../../public/js/mobile-aircraft-controls.js';
import MobileJoystickManager from '../../../public/js/mobile-joystick-manager.js';

/**
 * エアークラフトのコントローラ・マネージャを生成し UI / ネットワークと結線する。
 * @param {object} app MetaverseApp インスタンス（init 内で this）
 * @returns {Promise<void>}
 */
export async function initAircraftSubsystem(app) {
    app.aircraftController = new AircraftController(
        app.sceneManager.getCamera(),
        app.physicsManager
    );
    const initialWorldForAircraft = app.worldManager.getCurrentWorld();
    if (initialWorldForAircraft) {
        app.aircraftController.applyWorldPhysics(initialWorldForAircraft.aircraftPhysics);
    }
    app.aircraftManager = new AircraftManager(
        app.sceneManager,
        app.aircraftController,
        app.characterController,
        app.networkManager,
        app.uiManager
    );
    app.aircraftManager.setMobileMode(app.isMobileMode);
    app.aircraftManager.minimap.bindSceneManager(app.sceneManager);
    app.aircraftManager.setWorldIdProvider(() => app.worldManager?.getCurrentWorldId?.() || null);
    app.worldManager?.onWorldChange?.((world) => {
        if (app.aircraftManager?.isPiloting) {
            void app.aircraftManager.loadFlightMapForWorld(world?.id);
        }
    });
    try {
        await app.sceneManager.hydrateAircraftSlotsFromLibrary();
    } catch (e) {
        console.warn('[Aircraft] hydrateAircraftSlotsFromLibrary failed', e);
    }
    app.aircraftManager.refreshSlotsFromScene();

    const tryBoardFromUi = () => app.aircraftManager?.tryBoardNearest();
    app.uiManager.setAircraftBoardHandler(() => {
        void tryBoardFromUi();
    });
    app.teleportManager.setAircraftBoardHandler(async () => {
        if (app.characterController.isInputActive()) return false;
        if (!app.aircraftManager?.nearestSlot || !app.aircraftManager.canBoard()) return false;
        return app.aircraftManager.tryBoardNearest();
    });
    app.uiManager.setAircraftHudHandlers({
        onExit: () => {
            if (app.aircraftManager?.isPassenger) {
                app.aircraftManager.exitPassenger();
                return;
            }
            void app.aircraftManager.exitPiloting();
        },
        onToggleCamera: () => app.aircraftManager.toggleCameraMode()
    });

    app.networkManager.setAircraftNetworkBridge({
        getPose: () => app.aircraftManager.getAircraftPoseForNetwork(),
        getPilotCameraWorldPose: () =>
            app.aircraftManager?.isPiloting && app.aircraftController
                ? app.aircraftController.getNetworkCameraPose()
                : null,
        getPassengeringAircraftId: () => {
            const m = app.aircraftManager;
            if (!m?.isPassenger || !m.passengerSlot?.id) return null;
            return String(m.passengerSlot.id);
        },
        onSnapshot: (list) => app.aircraftManager.applyNetworkAircraftSnapshot(
            list,
            app.networkManager.myPlayerId
        ),
        onReleased: (slotId) => app.aircraftManager.onAircraftReleased(slotId)
    });

    /**
     * Easy 操縦中のモバイル UI と歩行ジョイスティックの切り替え
     */
    app.syncMobileAircraftControls = () => {
        if (!app.aircraftManager) return;
        const mgr = app.aircraftManager;

        if (!app.isMobileMode) {
            MobileAircraftControls.hide();
            MobileAircraftControls.destroy();
            MobileJoystickManager.destroy();
            return;
        }

        const isEasyPilot = mgr.isPiloting && mgr.activeSlot?.controlMode === 'easy';

        if (isEasyPilot) {
            MobileJoystickManager.destroy();
            MobileAircraftControls.show();
            MobileAircraftControls.init(app.aircraftController);
            return;
        }

        MobileAircraftControls.hide();
        MobileAircraftControls.destroy();
        if (!mgr.isPiloting && !mgr.isPassenger) {
            MobileJoystickManager.init(app.characterController);
        }
    };
}
