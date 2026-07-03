// addons/meta-benchR1/runner/mediasoup-bot-pool.js — VC / PDF VC / Video VC bot
import { io } from 'socket.io-client';
import { MediasoupBenchClient, getMediasoupMode } from './protocol.js';
import { closeMediasoupWorker } from './aiortc-worker.js';

const STATS_INTERVAL_MS = 1000;
const CONNECT_STAGGER_MS = 200;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.benchToken
 * @param {string} [opts.runId]
 * @param {number} opts.vcBotCount
 * @param {string[]} [opts.worlds]
 * @param {string} opts.pdfPath
 * @param {number} opts.durationMs
 */
export async function runMediasoupBotPool(opts) {
    const {
        serverUrl,
        benchToken,
        runId = 'run',
        vcBotCount,
        worlds = ['default'],
        pdfPath,
        durationMs,
    } = opts;
    const n = Math.min(vcBotCount, 10);
    const worldId = worlds[Math.floor(Math.random() * worlds.length)] || 'default';
    /** @type {import('socket.io-client').Socket[]} */
    const sockets = [];
    /** @type {MediasoupBenchClient[]} */
    const voiceClients = [];
    /** @type {MediasoupBenchClient[]} */
    const pdfClients = [];
    /** @type {MediasoupBenchClient[]} */
    const videoClients = [];

    try {
        for (let i = 0; i < n; i++) {
            const socket = await createBenchSocket(serverUrl, benchToken, runId, i, worldId);
            sockets.push(socket);

            const voice = new MediasoupBenchClient(socket, 'vc');
            await voice.join({ roomId: worldId });
            voiceClients.push(voice);

            const pdfSocket =
                i === 0 ? socket : await createBenchSocket(serverUrl, benchToken, runId, i, worldId, '-pdf');
            if (pdfSocket !== socket) sockets.push(pdfSocket);
            const pdf = new MediasoupBenchClient(pdfSocket, 'pdf-vc');
            await pdf.join({ pdfPath });
            pdfClients.push(pdf);

            const videoSocket =
                i === 0 ? socket : await createBenchSocket(serverUrl, benchToken, runId, i, worldId, '-vid');
            if (videoSocket !== socket && !sockets.includes(videoSocket)) sockets.push(videoSocket);
            const video = new MediasoupBenchClient(videoSocket, 'video-vc');
            await video.join({ roomId: worldId });
            videoClients.push(video);

            if (i < n - 1) await sleep(CONNECT_STAGGER_MS);
        }

        const statsEnd = Date.now() + durationMs;
        while (Date.now() < statsEnd) {
            for (const c of [...voiceClients, ...pdfClients, ...videoClients]) {
                await c.samplePacketLoss();
            }
            await sleep(STATS_INTERVAL_MS);
        }

        const voiceLoss = median(voiceClients.map((c) => c.getMedianLossPct()));
        const pdfLoss = median(pdfClients.map((c) => c.getMedianLossPct()));
        const videoLoss = median(videoClients.map((c) => c.getMedianLossPct()));

        return {
            voiceLossPct: voiceLoss,
            pdfLossPct: pdfLoss,
            videoLossPct: videoLoss,
            handlerMode: getMediasoupMode(),
        };
    } finally {
        for (const c of [...voiceClients, ...pdfClients, ...videoClients]) {
            await c.close();
        }
        for (const s of sockets) s.disconnect();
        await closeMediasoupWorker();
    }
}

/**
 * @param {string} serverUrl
 * @param {string} benchToken
 * @param {string} runId
 * @param {number} index
 * @param {string} worldId
 * @param {string} [suffix]
 */
async function createBenchSocket(serverUrl, benchToken, runId, index, worldId, suffix = '') {
    const socket = io(serverUrl, {
        transports: ['websocket'],
        auth: { benchToken },
        reconnection: false,
    });
    await waitConnect(socket);
    socket.emit('set-username', `bench-${runId}-${index + 1}${suffix}`);
    socket.emit('change-world', { worldId }, () => {});
    return socket;
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
 * @param {number[]} arr
 */
function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
