// addons/nfc-spawn/client/init.js — NFC スポーン解決とテレポート適用

const SPAWN_API_BASE = '/api/addons/nfc-spawn/spawn';

/**
 * @param {string} token
 * @returns {Promise<{ worldId: string, position: { x: number, y: number, z: number }, yaw: number, label: string }|null>}
 */
export async function resolveSpawnToken(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    const res = await fetch(`${SPAWN_API_BASE}/${encodeURIComponent(t)}`, {
        credentials: 'same-origin',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[nfc-spawn] spawn resolve failed:', res.status, err.error || res.statusText);
        return null;
    }
    const data = await res.json();
    if (!data?.ok || !data.world || !data.position) return null;
    const { x, y, z } = data.position;
    if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return {
        worldId: String(data.world),
        position: { x, y, z },
        yaw: typeof data.yaw === 'number' && Number.isFinite(data.yaw) ? data.yaw : 0,
        label: typeof data.label === 'string' ? data.label : '',
    };
}

/**
 * @param {object} app MetaverseApp
 * @param {{ worldId: string, position: { x: number, y: number, z: number }, yaw?: number }} plan
 */
export async function applySpawnPlanToApp(app, plan) {
    if (!app || !plan?.worldId || !plan.position) return;
    if (app.aircraftManager) app.aircraftManager.forceLocalPilotingReset();

    const { worldId, position } = plan;
    const { x, y, z } = position;
    const currentWorldId = app.worldManager?.getCurrentWorldId?.();

    if (worldId !== currentWorldId) {
        const world = app.worldManager?.getWorld?.(worldId);
        if (!world) {
            console.error(`[nfc-spawn] World not found: ${worldId}`);
            return;
        }
        await new Promise((resolve) => {
            app.worldManager.loadWorld(worldId, () => resolve());
        });
        app.updateTeleportZones?.();
        app.updateTaikoZones?.();
        app.updateGlbInteractZones?.();
        app.networkManager?.changeWorld?.(worldId);
    }

    if (app.characterController) {
        if (typeof plan.yaw === 'number' && Number.isFinite(plan.yaw)) {
            app.characterController.cameraYaw = (plan.yaw * Math.PI) / 180;
        }
        app.characterController.setPosition(x, y, z);
        app.characterController.resetVelocity();
    }

    if (app.playerManager) {
        app.playerManager.updateLocalPlayer(
            { x, y, z },
            app.characterController?.getRotation?.() ?? { x: 0, y: 0, z: 0 }
        );
    }

    console.log(`[nfc-spawn] Spawned at ${worldId} (${x}, ${y}, ${z})`);
}
