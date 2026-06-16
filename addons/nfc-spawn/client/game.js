// addons/nfc-spawn/client/game.js — registry-game から import され resolver を登録
import {
    registerClientSpawnApplier,
    registerClientSpawnResolver,
} from '../../../lib/client-spawn-registry.js';
import { applySpawnPlanToApp, resolveSpawnToken } from './init.js';
import { getSpawnTokenFromUrl, clearPendingSpawnToken } from './spawn-url.js';

registerClientSpawnResolver(async () => {
    const token = getSpawnTokenFromUrl();
    if (!token) return null;
    return resolveSpawnToken(token);
});

registerClientSpawnApplier(async (app, plan) => {
    await applySpawnPlanToApp(app, plan);
    clearPendingSpawnToken();
});

console.info('[addon:nfc-spawn] client loaded');
