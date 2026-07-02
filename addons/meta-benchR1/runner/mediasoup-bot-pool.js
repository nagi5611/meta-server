// addons/meta-benchR1/runner/mediasoup-bot-pool.js — VC / PDF VC / Video VC bot
import { io } from 'socket.io-client';
import { MediasoupBenchClient } from './protocol.js';

const STATS_INTERVAL_MS = 1000;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.benchToken
 * @param {number} opts.vcBotCount
 * @param {string} opts.worldId
 * @param {string} opts.pdfPath
 * @param {number} opts.durationMs
 */
export async function runMediasoupBotPool(opts) {
    const { serverUrl, benchToken, vcBotCount, worldId, pdfPath, durationMs } = opts;
    const n = Math.min(vcBotCount, 10);
    /** @type {import('socket.io-client').Socket[]} */
    const sockets = [];
    /** @type {MediasoupBenchClient[]} */
    const voiceClients = [];
    /** @type {MediasoupBenchClient[]} */
    const pdfClients = [];
    /** @type {MediasoupBenchClient[]} */
    const videoClients = [];

    for (let i = 0; i < n; i++) {
        const socket = io(serverUrl, {
            transports: ['websocket'],
            auth: { benchToken },
            reconnection: false,
        });
        await waitConnect(socket);
        socket.emit('change-world', { worldId }, () => {});
        sockets.push(socket);

        const voice = new MediasoupBenchClient(socket, 'vc');
        await voice.join({ roomId: worldId });
        voiceClients.push(voice);

        const pdfSocket = i === 0 ? socket : await createExtraSocket(serverUrl, benchToken, worldId);
        if (pdfSocket !== socket) sockets.push(pdfSocket);
        const pdf = new MediasoupBenchClient(pdfSocket, 'pdf-vc');
        await pdf.join({ pdfPath });
        pdfClients.push(pdf);

        const videoSocket = i === 0 ? socket : await createExtraSocket(serverUrl, benchToken, worldId);
        if (videoSocket !== socket && !sockets.includes(videoSocket)) sockets.push(videoSocket);
        const video = new MediasoupBenchClient(videoSocket, 'video-vc');
        await video.join({ roomId: worldId });
        videoClients.push(video);
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

    for (const c of [...voiceClients, ...pdfClients, ...videoClients]) {
        await c.close();
    }
    for (const s of sockets) s.disconnect();

    return { voiceLossPct: voiceLoss, pdfLossPct: pdfLoss, videoLossPct: videoLoss };
}

/**
 * @param {string} serverUrl
 * @param {string} benchToken
 * @param {string} worldId
 */
async function createExtraSocket(serverUrl, benchToken, worldId) {
    const socket = io(serverUrl, {
        transports: ['websocket'],
        auth: { benchToken },
        reconnection: false,
    });
    await waitConnect(socket);
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
