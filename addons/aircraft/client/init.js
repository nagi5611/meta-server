// addons/aircraft/client/init.js — MetaverseApp へのエアークラフト結線（main から呼び出し）

import AircraftController from './aircraft-controller.js';
import AircraftManager from './aircraft-manager.js';

/**
 * エアークラフトのコントローラ・マネージャを生成し UI / ネットワークと結線する。
 * @param {object} app MetaverseApp インスタンス（init 内で this）
 */
export function initAircraftSubsystem(app) {
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
    app.aircraftManager.refreshSlotsFromScene();

    app.uiManager.setAircraftBoardHandler(() => {
        app.aircraftManager.tryBoardNearest();
    });
    app.teleportManager.setAircraftBoardHandler(() => {
        if (app.characterController.isInputActive()) return false;
        if (!app.aircraftManager?.nearestSlot || !app.aircraftManager.canBoard()) return false;
        void app.aircraftManager.tryBoardNearest();
        return true;
    });
    app.uiManager.setAircraftHudHandlers({
        onExit: () => app.aircraftManager.exitPiloting(),
        onToggleCamera: () => app.aircraftManager.toggleCameraMode()
    });

    app.networkManager.setAircraftNetworkBridge({
        getPose: () => app.aircraftManager.getAircraftPoseForNetwork(),
        onSnapshot: (list) => app.aircraftManager.applyNetworkAircraftSnapshot(
            list,
            app.networkManager.myPlayerId
        ),
        onReleased: (slotId) => app.aircraftManager.onAircraftReleased(slotId)
    });
}
