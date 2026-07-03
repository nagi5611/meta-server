// addons/meta-benchR1/runner/aiortc-worker.js — mediasoup-client-aiortc 共有 Worker
import os from 'node:os';

/** @type {import('mediasoup-client-aiortc').Worker | null} */
let worker = null;
/** @type {import('mediasoup-client').HandlerFactory | null} */
let handlerFactory = null;
/** @type {'aiortc' | 'fake'} */
let mode = 'fake';
/** @type {Promise<void> | null} */
let initPromise = null;

/**
 * @returns {'aiortc' | 'fake'}
 */
export function getMediasoupMode() {
    return mode;
}

/**
 * aiortc Worker と handlerFactory を初期化する
 * @returns {Promise<{ worker: import('mediasoup-client-aiortc').Worker | null, handlerFactory: import('mediasoup-client').HandlerFactory, mode: 'aiortc' | 'fake' }>}
 */
export async function getMediasoupHandlerContext() {
    await ensureMediasoupWorker();
    if (!handlerFactory) {
        throw new Error('mediasoup handler factory unavailable');
    }
    return { worker, handlerFactory, mode };
}

/**
 * @returns {Promise<void>}
 */
export async function ensureMediasoupWorker() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
        if (os.platform() === 'win32') {
            await initFakeHandler('Windows is not supported by mediasoup-client-aiortc');
            return;
        }

        try {
            const { createWorker } = await import('mediasoup-client-aiortc');
            worker = await createWorker({ logLevel: 'warn' });
            handlerFactory = await worker.createHandlerFactory();
            mode = 'aiortc';
            console.log('[bench-protocol] using mediasoup-client-aiortc (production WebRTC)');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await initFakeHandler(msg);
        }
    })();

    return initPromise;
}

/**
 * @param {string} reason
 */
async function initFakeHandler(reason) {
    mode = 'fake';
    const { FakeHandler } = await import('mediasoup-client');
    const fakeParameters = (await import('mediasoup-client/lib/test/fakeParameters.js')).default;
    handlerFactory = FakeHandler.createFactory(fakeParameters);
    console.warn(
        `[bench-protocol] FakeHandler fallback (${reason}). audio-vc packetLoss is not production-grade.`
    );
}

/**
 * produce 用オーディオトラックを取得する
 * @param {'audio' | 'video'} [kind]
 * @returns {Promise<import('mediasoup-client').MediaStreamTrack>}
 */
export async function createMediaTrack(kind = 'audio') {
    await ensureMediasoupWorker();

    if (mode === 'aiortc' && worker) {
        if (kind === 'video') {
            const stream = await worker.getUserMedia({
                video: { source: 'device' },
            });
            const track = stream.getVideoTracks()[0];
            if (!track) throw new Error('aiortc: no video track');
            return track;
        }
        const stream = await worker.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error('aiortc: no audio track');
        return track;
    }

    const { FakeMediaStreamTrack } = await import('fake-mediastreamtrack');
    return new FakeMediaStreamTrack({ kind });
}

/**
 * Worker を終了する
 * @returns {Promise<void>}
 */
export async function closeMediasoupWorker() {
    if (!worker) {
        initPromise = null;
        handlerFactory = null;
        mode = 'fake';
        return;
    }

    const w = worker;
    worker = null;
    handlerFactory = null;
    initPromise = null;
    mode = 'fake';

    await new Promise((resolve) => {
        w.once('subprocessclose', resolve);
        w.close();
        setTimeout(resolve, 2000);
    });
}
