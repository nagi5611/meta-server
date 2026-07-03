// addons/meta-bench-r1/runner/mediasoup-bot-pool.js — VC / PDF VC / Video VC bot
import { io } from 'socket.io-client';
import { MediasoupBenchClient, getMediasoupMode } from './protocol.js';
import { closeMediasoupWorker } from './aiortc-worker.js';
import { runVoiceE2eBench } from './voice-e2e-bench.js';
import { runnerDebug, runnerInfo, runnerWarn, formatError } from './debug.js';
import { buildSocketIoOptions } from './socket-client-options.js';

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
 * @param {string} [opts.audioFilePath]
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
        audioFilePath,
        durationMs,
    } = opts;
    const n = Math.min(vcBotCount, 10);
    const worldId = worlds[Math.floor(Math.random() * worlds.length)] || 'default';
    runnerInfo('vc-pool', 'start', { n, worldId, pdfPath, durationMs, mode: getMediasoupMode() });
    if (getMediasoupMode() === 'fake') {
        runnerWarn(
            'vc-pool',
            'FakeHandler モード（Windows 等）。voice E2E はスキップ、pdf/video packetLoss は参考値。'
        );
    }
    /** @type {import('socket.io-client').Socket[]} */
    const sockets = [];
    /** @type {MediasoupBenchClient[]} */
    const pdfClients = [];
    /** @type {MediasoupBenchClient[]} */
    const videoClients = [];

    try {
        const voiceE2e = await runVoiceE2eBench({
            serverUrl,
            benchToken,
            runId,
            worldId,
            audioFilePath,
        });

        for (let i = 0; i < n; i++) {
            runnerDebug('vc-pool', `pdf/video bot ${i + 1}/${n} connecting`);
            try {
                const pdfSocket = await createBenchSocket(serverUrl, benchToken, runId, i, worldId, '-pdf');
                sockets.push(pdfSocket);
                const pdf = new MediasoupBenchClient(pdfSocket, 'pdf-vc');
                await pdf.join({ pdfPath });
                pdfClients.push(pdf);

                const videoSocket =
                    i === 0 ? pdfSocket : await createBenchSocket(serverUrl, benchToken, runId, i, worldId, '-vid');
                if (videoSocket !== pdfSocket && !sockets.includes(videoSocket)) sockets.push(videoSocket);
                const video = new MediasoupBenchClient(videoSocket, 'video-vc');
                await video.join({ roomId: worldId });
                videoClients.push(video);
            } catch (e) {
                runnerWarn('vc-pool', `bot ${i + 1} setup failed`, formatError(e));
                throw e;
            }

            if (i < n - 1) await sleep(CONNECT_STAGGER_MS);
        }

        const statsEnd = Date.now() + durationMs;
        while (Date.now() < statsEnd) {
            for (const c of [...pdfClients, ...videoClients]) {
                await c.samplePacketLoss();
            }
            await sleep(STATS_INTERVAL_MS);
        }

        const pdfLoss = median(pdfClients.map((c) => c.getMedianLossPct()));
        const videoLoss = median(videoClients.map((c) => c.getMedianLossPct()));

        const result = {
            voiceMatchPct: voiceE2e.voiceMatchPct,
            voiceE2eSkipped: voiceE2e.voiceE2eSkipped,
            voiceE2eRef: voiceE2e.voiceE2eRef,
            pdfLossPct: pdfLoss,
            videoLossPct: videoLoss,
            handlerMode: getMediasoupMode(),
        };
        runnerInfo('vc-pool', 'done', result);
        return result;
    } finally {
        for (const c of [...pdfClients, ...videoClients]) {
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
    const label = `vc-bot-${index + 1}${suffix}`;
    const socket = io(serverUrl, buildSocketIoOptions(serverUrl, { benchToken }, { reconnection: false }));
    await waitConnect(socket, label);
    runnerDebug('vc-pool', `${label} connected`, { socketId: socket.id, worldId });
    socket.emit('set-username', `bench-${runId}-${index + 1}${suffix}`);
    socket.emit('change-world', { worldId }, () => {});
    return socket;
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {string} [label]
 */
function waitConnect(socket, label = 'vc-socket') {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`${label}: connect timeout (15s)`)), 15_000);
        socket.once('connect', () => {
            clearTimeout(to);
            resolve(undefined);
        });
        socket.once('connect_error', (e) => {
            clearTimeout(to);
            const msg = e?.message || e?.description || String(e);
            reject(new Error(`${label}: ${msg}`));
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
