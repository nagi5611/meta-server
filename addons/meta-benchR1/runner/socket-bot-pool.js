// addons/meta-benchR1/runner/socket-bot-pool.js — Socket.IO 負荷 bot プール（要件 §7.3）
import { io } from 'socket.io-client';

const CONNECT_STAGGER_MS = 50;
const UPDATE_HZ = 30;
const PING_INTERVAL_MS = 2000;
const MAX_BOT_LIFETIME_MS = 120_000;
const SPAWN_RANGE = 30;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.benchToken
 * @param {string} opts.runId
 * @param {number} opts.botCount
 * @param {string[]} [opts.worlds]
 * @param {number} opts.durationMs
 */
export async function runSocketBotPool(opts) {
    const {
        serverUrl,
        benchToken,
        runId,
        botCount,
        worlds = ['default'],
        durationMs = MAX_BOT_LIFETIME_MS,
    } = opts;

    /** @type {Promise<{ connected: boolean, retentionRatio: number, pings: number[] }>[]} */
    const botTasks = [];

    for (let i = 0; i < botCount; i++) {
        if (i > 0) await sleep(CONNECT_STAGGER_MS);
        botTasks.push(
            runSingleBot({
                serverUrl,
                benchToken,
                runId,
                index: i,
                worlds,
                durationMs,
            })
        );
    }

    const settled = await Promise.allSettled(botTasks);
    /** @type {number[]} */
    const pings = [];
    let connected = 0;
    let retentionSum = 0;

    for (const result of settled) {
        if (result.status === 'fulfilled' && result.value.connected) {
            connected++;
            retentionSum += result.value.retentionRatio;
            pings.push(...result.value.pings);
        }
    }

    const retainPct = connected > 0 ? (retentionSum / connected) * 100 : 0;
    const pingP95Ms = percentile(pings, 95);

    return { connected, requested: botCount, retainPct, pingP95Ms };
}

/**
 * @param {object} opts
 */
async function runSingleBot(opts) {
    const { serverUrl, benchToken, runId, index, worlds, durationMs } = opts;
    const worldId = pickRandom(worlds);
    const lifetimeMs = randomInt(0, MAX_BOT_LIFETIME_MS + 1);
    const sessionMs = Math.min(lifetimeMs, durationMs);
    const username = `bench-${runId}-${index + 1}`;
    const spawn = randomSpawn();
    /** @type {number[]} */
    const pings = [];

    const socket = io(serverUrl, {
        transports: ['websocket'],
        auth: { benchToken },
        reconnection: false,
    });

    try {
        await waitConnect(socket);
        socket.emit('set-username', username);
        await changeWorld(socket, worldId);

        let t = Math.random() * Math.PI * 2;
        let animState = 'walk';
        let jumpUntil = 0;

        const updateIv = setInterval(() => {
            t += 0.05;
            const now = Date.now();
            if (now >= jumpUntil && animState !== 'jump') {
                if (Math.random() < 0.02) {
                    animState = 'jump';
                    jumpUntil = now + 400;
                }
            } else if (animState === 'jump' && now >= jumpUntil) {
                animState = 'walk';
            }

            socket.emit('player-update', {
                position: {
                    x: spawn.x + Math.sin(t + index) * 3,
                    y: spawn.y,
                    z: spawn.z + Math.cos(t + index) * 3,
                },
                rotation: { x: 0, y: t, z: 0 },
                quaternion: { x: 0, y: 0, z: 0, w: 1 },
                animState,
                timestamp: now,
                world: worldId,
                adminInvisible: false,
                passengeringAircraftId: null,
            });
        }, 1000 / UPDATE_HZ);

        const pingIv = setInterval(() => {
            measurePing(socket, pings);
        }, PING_INTERVAL_MS);

        measurePing(socket, pings);
        await sleep(sessionMs);

        clearInterval(updateIv);
        clearInterval(pingIv);

        const plannedMs = Math.max(1, Math.min(lifetimeMs, durationMs));
        const retentionRatio = Math.min(1, sessionMs / plannedMs);

        return { connected: true, retentionRatio, pings };
    } catch {
        return { connected: false, retentionRatio: 0, pings };
    } finally {
        socket.disconnect();
    }
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {string} worldId
 */
function changeWorld(socket, worldId) {
    return new Promise((resolve) => {
        socket.emit('change-world', { worldId }, () => resolve(undefined));
        setTimeout(resolve, 500);
    });
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {number[]} pings
 */
function measurePing(socket, pings) {
    const sent = Date.now();
    socket.emit('ping', { ts: sent }, (res) => {
        if (res?.ts == null) return;
        const rtt = Math.max(0, Date.now() - sent);
        pings.push(rtt);
        socket.emit('report-ping', { pingMs: rtt, perfTier: 'high' });
    });
}

/**
 * @param {import('socket.io-client').Socket} socket
 */
function waitConnect(socket) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('connect timeout')), 15_000);
        socket.once('connect', () => {
            clearTimeout(to);
            resolve(undefined);
        });
        socket.once('connect_error', (e) => {
            clearTimeout(to);
            reject(e);
        });
    });
}

/**
 * @returns {{ x: number, y: number, z: number }}
 */
function randomSpawn() {
    return {
        x: randomFloat(-SPAWN_RANGE, SPAWN_RANGE),
        y: randomFloat(2, 8),
        z: randomFloat(-SPAWN_RANGE, SPAWN_RANGE),
    };
}

/**
 * @param {string[]} items
 */
function pickRandom(items) {
    if (!items.length) return 'default';
    return items[Math.floor(Math.random() * items.length)];
}

/**
 * @param {number} min
 * @param {number} max
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * @param {number} min
 * @param {number} max
 */
function randomFloat(min, max) {
    return min + Math.random() * (max - min);
}

/**
 * @param {number[]} arr
 * @param {number} p
 */
function percentile(arr, p) {
    if (!arr.length) return 300;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
