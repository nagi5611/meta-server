// addons/meta-benchR1/runner/socket-bot-pool.js — Socket.IO 負荷 bot プール
import { io } from 'socket.io-client';

const CONNECT_STAGGER_MS = 50;
const UPDATE_HZ = 30;
const PING_INTERVAL_MS = 2000;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.benchToken
 * @param {number} opts.botCount
 * @param {string[]} [opts.worlds]
 * @param {number} opts.durationMs
 */
export async function runSocketBotPool(opts) {
    const { serverUrl, benchToken, botCount, worlds = ['default'], durationMs } = opts;
    /** @type {import('socket.io-client').Socket[]} */
    const sockets = [];
    /** @type {number[]} */
    const pings = [];
    let connected = 0;

    const worldId = worlds[0] || 'default';
    let t = 0;

    for (let i = 0; i < botCount; i++) {
        const socket = io(serverUrl, {
            transports: ['websocket'],
            auth: { benchToken },
            reconnection: false,
        });

        await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('connect timeout')), 15_000);
            socket.once('connect', () => {
                clearTimeout(to);
                connected++;
                resolve(undefined);
            });
            socket.once('connect_error', (e) => {
                clearTimeout(to);
                reject(e);
            });
        });

        socket.emit('change-world', { worldId }, () => {});

        const updateIv = setInterval(() => {
            t += 0.05;
            socket.emit('player-update', {
                position: { x: Math.sin(t + i) * 3, y: 2, z: Math.cos(t + i) * 3 },
                rotation: { x: 0, y: t, z: 0 },
                quaternion: { x: 0, y: 0, z: 0, w: 1 },
                animState: 'walk',
                timestamp: Date.now(),
                world: worldId,
                adminInvisible: false,
                passengeringAircraftId: null,
            });
        }, 1000 / UPDATE_HZ);

        const pingIv = setInterval(() => {
            const sent = Date.now();
            socket.emit('ping', { ts: sent }, () => {
                pings.push(Date.now() - sent);
            });
            socket.emit('report-ping', { pingMs: pings[pings.length - 1] ?? 50, perfTier: 'high' });
        }, PING_INTERVAL_MS);

        socket.data = { updateIv, pingIv };
        sockets.push(socket);

        if (i < botCount - 1) await sleep(CONNECT_STAGGER_MS);
    }

    await sleep(durationMs);

    for (const s of sockets) {
        clearInterval(s.data?.updateIv);
        clearInterval(s.data?.pingIv);
        s.disconnect();
    }

    const retainPct = botCount > 0 ? (connected / botCount) * 100 : 0;
    const pingP95Ms = percentile(pings, 95);

    return { connected, requested: botCount, retainPct, pingP95Ms };
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
