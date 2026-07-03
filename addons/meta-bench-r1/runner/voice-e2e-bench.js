// addons/meta-bench-r1/runner/voice-e2e-bench.js — Voice VC E2E 照合（送信 MP3 ↔ 受信録音）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { MediasoupBenchClient } from './protocol.js';
import { getMediasoupMode, recordRemoteTrack } from './aiortc-worker.js';
import { resolveBenchAudioPath } from '../lib/bench-audio-path.js';
import { decodeAudioToMono48k } from './audio-decode.js';
import { computeAudioMatchPct } from './audio-match.js';
import { runnerDebug, runnerInfo, runnerWarn, formatError } from './debug.js';
import { buildSocketIoOptions } from './socket-client-options.js';

const VOICE_E2E_DURATION_MS = 30_000;
const CONSUMER_WAIT_MS = 20_000;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.benchToken
 * @param {string} opts.runId
 * @param {string} opts.worldId
 * @param {string} [opts.audioFilePath]
 */
export async function runVoiceE2eBench(opts) {
    const { serverUrl, benchToken, runId, worldId, audioFilePath } = opts;
    const refPath = resolveBenchAudioPath(audioFilePath);
    const mode = getMediasoupMode();

    if (mode !== 'aiortc') {
        runnerWarn('voice-e2e', 'aiortc 未使用のため E2E 照合をスキップ（FakeHandler）');
        return {
            voiceMatchPct: null,
            voiceE2eSkipped: 'fake_handler',
            handlerMode: mode,
        };
    }

    if (!fs.existsSync(refPath)) {
        throw new Error(`bench audio not found: ${refPath}`);
    }

    runnerInfo('voice-e2e', 'start', { worldId, refPath, durationMs: VOICE_E2E_DURATION_MS });

    /** @type {import('socket.io-client').Socket[]} */
    const sockets = [];
    let receiver = null;
    let sender = null;
    const recordedWav = path.join(os.tmpdir(), `bench-voice-${runId}-${Date.now()}.wav`);

    try {
        const recvSocket = await createBenchSocket(serverUrl, benchToken, runId, worldId, '-rx');
        sockets.push(recvSocket);
        receiver = new MediasoupBenchClient(recvSocket, 'vc');
        const consumerReady = receiver.waitForAudioConsumer(CONSUMER_WAIT_MS);
        await receiver.join({ roomId: worldId, skipProduce: true });
        runnerDebug('voice-e2e', 'receiver joined');

        const sendSocket = await createBenchSocket(serverUrl, benchToken, runId, worldId, '-tx');
        sockets.push(sendSocket);
        sender = new MediasoupBenchClient(sendSocket, 'vc');
        await sender.join({ roomId: worldId, audioFilePath: refPath });
        runnerDebug('voice-e2e', 'sender joined with MP3');

        const consumer = await consumerReady;
        const trackId = consumer.track?.id;
        if (!trackId) throw new Error('voice-e2e: consumer track id missing');

        runnerInfo('voice-e2e', 'recording', { trackId, recordedWav, durationMs: VOICE_E2E_DURATION_MS });
        await recordRemoteTrack(trackId, recordedWav, VOICE_E2E_DURATION_MS);

        const [refPcm, recPcm] = await Promise.all([
            decodeAudioToMono48k(refPath),
            decodeAudioToMono48k(recordedWav),
        ]);
        const voiceMatchPct = computeAudioMatchPct(refPcm, recPcm);

        const result = {
            voiceMatchPct,
            voiceE2eDurationMs: VOICE_E2E_DURATION_MS,
            voiceE2eRef: path.basename(refPath),
            handlerMode: mode,
        };
        runnerInfo('voice-e2e', 'done', result);
        return result;
    } catch (e) {
        runnerWarn('voice-e2e', 'failed', formatError(e));
        throw e;
    } finally {
        if (sender) await sender.close();
        if (receiver) await receiver.close();
        for (const s of sockets) s.disconnect();
        try {
            if (fs.existsSync(recordedWav)) fs.unlinkSync(recordedWav);
        } catch {
            /* ignore */
        }
    }
}

/**
 * @param {string} serverUrl
 * @param {string} benchToken
 * @param {string} runId
 * @param {string} worldId
 * @param {string} suffix
 */
async function createBenchSocket(serverUrl, benchToken, runId, worldId, suffix) {
    const label = `voice-e2e${suffix}`;
    const socket = io(serverUrl, buildSocketIoOptions(serverUrl, { benchToken }, { reconnection: false }));
    await waitConnect(socket, label);
    socket.emit('set-username', `bench-${runId}-voice${suffix}`);
    socket.emit('change-world', { worldId }, () => {});
    return socket;
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {string} label
 */
function waitConnect(socket, label) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`${label}: connect timeout (15s)`)), 15_000);
        socket.once('connect', () => {
            clearTimeout(to);
            resolve(undefined);
        });
        socket.once('connect_error', (e) => {
            clearTimeout(to);
            reject(new Error(`${label}: ${e?.message || String(e)}`));
        });
    });
}
