// addons/matsuyama-flights/client/init.js — 本番ワールドへの発着板配置
import {
    createFlightBoardMesh,
    startFlightBoardPolling,
} from './flight-board-mesh.js';

/** @type {(() => void)|null} */
let stopPolling = null;

/**
 * ワールドの flightBoards をシーンに載せる
 * @param {object} app MetaverseApp
 * @param {object} world
 */
async function loadWorldFlightBoards(app, world) {
    if (stopPolling) {
        stopPolling();
        stopPolling = null;
    }

    const boards = Array.isArray(world?.flightBoards) ? world.flightBoards : [];
    const group = app.sceneManager?.environmentGroup;
    if (!group) return;

    for (const child of [...group.children]) {
        if (child.userData?.flightBoardConfig) {
            group.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                const m = child.material;
                if (m.map) m.map.dispose();
                m.dispose();
            }
        }
    }

    const meshes = [];
    for (const cfg of boards) {
        const mesh = createFlightBoardMesh(cfg);
        group.add(mesh);
        meshes.push(mesh);
    }

    if (meshes.length) {
        stopPolling = startFlightBoardPolling(meshes);
    }
}

/**
 * @param {object} app MetaverseApp
 */
export async function initMatsuyamaFlightsSubsystem(app) {
    if (app.worldManager) {
        app.worldManager._loadWorldFlightBoards = (world) => loadWorldFlightBoards(app, world);
    }

    const current = app.worldManager?.getCurrentWorld?.();
    if (current) {
        await loadWorldFlightBoards(app, current);
    }

    const prev = app.worldManager?.onWorldChangeCallback;
    app.worldManager.onWorldChangeCallback = (world) => {
        if (typeof prev === 'function') prev(world);
        loadWorldFlightBoards(app, world).catch((e) => {
            console.warn('[matsuyama-flights] load boards failed', e);
        });
    };
}
