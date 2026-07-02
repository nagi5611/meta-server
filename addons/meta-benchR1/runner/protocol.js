// addons/meta-benchR1/runner/protocol.js — mediasoup VC イベント列（Node / FakeHandler）
import { Device, FakeHandler } from 'mediasoup-client';
import fakeParameters from 'mediasoup-client/lib/test/fakeParameters.js';
import { FakeMediaStreamTrack } from 'fake-mediastreamtrack';

/**
 * Socket emit with ack
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {object} payload
 */
function emitAsync(socket, event, payload = {}) {
    return new Promise((resolve, reject) => {
        socket.emit(event, payload, (res) => {
            if (!res) return reject(new Error(`${event}: empty response`));
            if (res.error) return reject(new Error(res.error));
            resolve(res);
        });
        setTimeout(() => reject(new Error(`${event}: timeout`)), 30_000);
    });
}

/**
 * @param {string} prefix e.g. 'vc', 'pdf-vc', 'video-vc'
 */
export class MediasoupBenchClient {
    /**
     * @param {import('socket.io-client').Socket} socket
     * @param {string} prefix
     */
    constructor(socket, prefix = 'vc') {
        this.socket = socket;
        this.prefix = prefix;
        this.device = null;
        this.sendTransport = null;
        this.recvTransport = null;
        this.producer = null;
        /** @type {Map<string, object>} */
        this.consumers = new Map();
        /** @type {number[]} */
        this.lossSamples = [];
    }

    /**
     * @param {object} opts
     * @param {string} [opts.roomId]
     * @param {string} [opts.pdfPath]
     */
    async join(opts = {}) {
        const joinEvent = `${this.prefix}-join`;
        const joinPayload =
            this.prefix === 'pdf-vc'
                ? { pdfPath: opts.pdfPath || '/pdfs/bench-sample.pdf' }
                : { roomId: opts.roomId || 'default' };

        const joinRes = await emitAsync(this.socket, joinEvent, joinPayload);
        const rtpCapabilities = joinRes.rtpCapabilities;
        if (!rtpCapabilities) throw new Error(`${joinEvent}: missing rtpCapabilities`);

        this.device = new Device({
            handlerFactory: FakeHandler.createFactory(fakeParameters),
        });
        await this.device.load({ routerRtpCapabilities: rtpCapabilities });

        await this._createSendTransport();
        await this._createRecvTransport();

        if (this.prefix === 'pdf-vc') {
            await emitAsync(this.socket, 'pdf-vc-set-speaker', { enabled: true });
        } else if (this.prefix === 'video-vc') {
            await emitAsync(this.socket, 'video-vc-set-recv', { enabled: true });
        } else {
            await emitAsync(this.socket, 'vc-set-speaker', { enabled: true });
        }

        const audioTrack = new FakeMediaStreamTrack({ kind: 'audio' });
        this.producer = await this.sendTransport.produce({ track: audioTrack });

        this.socket.on(`${this.prefix}-new-producer`, async ({ producerId, peerId }) => {
            if (peerId === this.socket.id) return;
            try {
                await this._consume(producerId);
            } catch (e) {
                console.warn(`[bench-protocol] consume failed:`, e);
            }
        });
    }

    async _createSendTransport() {
        const res = await emitAsync(this.socket, `${this.prefix}-create-transport`, {
            direction: 'send',
        });
        this.sendTransport = this.device.createSendTransport({
            id: res.id,
            iceParameters: res.iceParameters,
            iceCandidates: res.iceCandidates,
            dtlsParameters: res.dtlsParameters,
        });
        this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            emitAsync(this.socket, `${this.prefix}-connect-transport`, {
                transportId: this.sendTransport.id,
                dtlsParameters,
            })
                .then(() => callback())
                .catch((e) => errback(e));
        });
        this.sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            const produceEvent =
                this.prefix === 'pdf-vc'
                    ? 'pdf-vc-produce-audio'
                    : this.prefix === 'video-vc'
                      ? 'video-vc-produce-audio'
                      : 'vc-produce-audio';
            emitAsync(this.socket, produceEvent, {
                transportId: this.sendTransport.id,
                rtpParameters,
            })
                .then((r) => callback({ id: r.producerId }))
                .catch((e) => errback(e));
        });
    }

    async _createRecvTransport() {
        const res = await emitAsync(this.socket, `${this.prefix}-create-transport`, {
            direction: 'recv',
        });
        this.recvTransport = this.device.createRecvTransport({
            id: res.id,
            iceParameters: res.iceParameters,
            iceCandidates: res.iceCandidates,
            dtlsParameters: res.dtlsParameters,
        });
        this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            emitAsync(this.socket, `${this.prefix}-connect-transport`, {
                transportId: this.recvTransport.id,
                dtlsParameters,
            })
                .then(() => callback())
                .catch((e) => errback(e));
        });
    }

    /**
     * @param {string} producerId
     */
    async _consume(producerId) {
        if (!this.recvTransport || !this.device) return;
        const res = await emitAsync(this.socket, `${this.prefix}-consume`, {
            producerId,
            rtpCapabilities: this.device.rtpCapabilities,
        });
        const consumer = await this.recvTransport.consume({
            id: res.consumerId,
            producerId: res.producerId,
            kind: res.kind,
            rtpParameters: res.rtpParameters,
        });
        this.consumers.set(consumer.id, consumer);
        await emitAsync(this.socket, `${this.prefix}-consumer-resume`, { consumerId: consumer.id });
    }

    /**
     * transport stats から packet loss % をサンプル
     */
    async samplePacketLoss() {
        const transport = this.recvTransport || this.sendTransport;
        if (!transport || typeof transport.getStats !== 'function') return;
        try {
            const stats = await transport.getStats();
            for (const s of stats.values()) {
                if (s.type === 'inbound-rtp' && s.packetsReceived != null && s.packetsLost != null) {
                    const total = s.packetsReceived + s.packetsLost;
                    if (total > 0) {
                        this.lossSamples.push((s.packetsLost / total) * 100);
                    }
                }
            }
        } catch {
            /* FakeHandler may not provide real stats */
            this.lossSamples.push(0);
        }
    }

    /**
     * @returns {number} median loss %
     */
    getMedianLossPct() {
        if (!this.lossSamples.length) return 0;
        const sorted = [...this.lossSamples].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    async close() {
        for (const c of this.consumers.values()) {
            try {
                c.close?.();
            } catch {
                /* ignore */
            }
        }
        this.consumers.clear();
        try {
            this.producer?.close?.();
        } catch {
            /* ignore */
        }
        try {
            this.sendTransport?.close?.();
            this.recvTransport?.close?.();
        } catch {
            /* ignore */
        }
        const leaveEvent = `${this.prefix}-leave`;
        try {
            await emitAsync(this.socket, leaveEvent, {});
        } catch {
            /* ignore */
        }
    }
}
