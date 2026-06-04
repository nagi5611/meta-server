// addons/aircraft/client/init.js — MetaverseApp へのエアークラフト結線（main から呼び出し）

import AircraftController from './aircraft-controller.js';
import AircraftManager from './aircraft-manager.js';

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
        onExit: () => app.aircraftManager.exitPiloting(),
        onToggleCamera: () => app.aircraftManager.toggleCameraMode()
    });

    app.networkManager.setAircraftNetworkBridge({
        getPose: () => app.aircraftManager.getAircraftPoseForNetwork(),
        getPilotCameraWorldPose: () =>
            app.aircraftManager?.isPiloting && app.aircraftController
                ? app.aircraftController.getNetworkCameraPose()
                : null,
        onSnapshot: (list) => app.aircraftManager.applyNetworkAircraftSnapshot(
            list,
            app.networkManager.myPlayerId
        ),
        onReleased: (slotId) => app.aircraftManager.onAircraftReleased(slotId)
    });
}
