/**
 * PdfViewerVoiceChatManager - Voice chat for PDF viewer only (same PDF open = same room).
 * Uses pdf-vc-* socket events and a separate mediasoup port range (e.g. 20000-20100).
 */
import * as mediasoupClient from 'mediasoup-client';
import { getMediaUnavailableMessage, getMediaErrorMessage } from './media-support.js';

const EVENT_PREFIX = 'pdf-vc-';
const ID_PREFIX = 'pdf-vc-';

class PdfViewerVoiceChatManager {
    constructor(socket) {
        this.socket = socket;
        this.device = null;
        this.sendTransport = null;
        this.recvTransport = null;
        this.audioProducer = null;
        this.consumers = new Map();
        this.currentPdfPath = null;
        this.iceServers = [];

        this.isMicEnabled = false;
        this.isSpeakerEnabled = true;
        this.isJoined = false;

        this.selectedMicDeviceId = null;
        this.selectedSpeakerDeviceId = null;

        this.audioContainer = document.createElement('div');
        this.audioContainer.id = ID_PREFIX + 'audio-container';
        this.audioContainer.style.display = 'none';
        document.body.appendChild(this.audioContainer);

        this.audioContext = null;
        this.micAnalyzer = null;
        this.micAnalyzerInterval = null;
        this.producerMonitoringInterval = null;
        this.audioUnlocked = false;
        this.setupAudioAnalyzer();

        if (this.socket) this.setupEventListeners();
    }

    setSocket(socket) {
        this.socket = socket;
        if (socket) this.setupEventListeners();
    }

    setupAudioAnalyzer() {
        const analyzerContainer = document.createElement('div');
        analyzerContainer.id = ID_PREFIX + 'audio-analyzer';
        analyzerContainer.style.cssText = `
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            padding: 10px 20px;
            border-radius: 20px;
            display: none;
            z-index: 10001;
            color: white;
            font-size: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;
        analyzerContainer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-weight: bold;">🎤 PDF通話:</span>
                <div id="${ID_PREFIX}mic-level-bar" style="width: 120px; height: 8px; background: #333; border-radius: 4px; overflow: hidden;">
                    <div id="${ID_PREFIX}mic-level-fill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #FFC107); transition: width 0.1s;"></div>
                </div>
                <span id="${ID_PREFIX}mic-level-text" style="min-width: 32px;">0%</span>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">受信: <span id="${ID_PREFIX}active-speakers">0</span>人</div>
        `;
        document.body.appendChild(analyzerContainer);
        this.analyzerContainer = analyzerContainer;
    }

    async unlockAudio() {
        if (this.audioUnlocked) return;
        try {
            const silentAudio = document.createElement('audio');
            silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
            silentAudio.volume = 0;
            await silentAudio.play();
            silentAudio.pause();
            silentAudio.remove();
            this.audioUnlocked = true;
        } catch (e) { console.warn('[PDF VC] Failed to unlock audio:', e); }
    }

    setupEventListeners() {
        this.socket.on(EVENT_PREFIX + 'new-producer', async ({ producerId, peerId }) => {
            if (this.isSpeakerEnabled && this.recvTransport) {
                await this.consume(producerId, peerId);
            }
        });
        this.socket.on(EVENT_PREFIX + 'producer-closed', ({ producerId }) => {
            this.closeConsumerByProducerId(producerId);
        });
        this.socket.on(EVENT_PREFIX + 'consumer-closed', ({ consumerId }) => {
            this.closeConsumer(consumerId);
        });
    }

    async joinRoom(pdfPath) {
        if (!this.socket || !pdfPath) return;
        try {
            this.currentPdfPath = pdfPath;
            const { rtpCapabilities, iceServers, error } = await this.emitAsync(EVENT_PREFIX + 'join', { pdfPath });
            if (error) throw new Error(error);

            if (iceServers && iceServers.length > 0) this.iceServers = iceServers;

            if (!this.device) this.device = new mediasoupClient.Device();
            await this.device.load({ routerRtpCapabilities: rtpCapabilities });

            if (this.isSpeakerEnabled) {
                await this.unlockAudio();
                await this.createRecvTransport();
                // 既にマイクONの参加者がいる場合、その音声を受信するために set-speaker で既存プロデューサーを取得
                const { existingProducers } = await this.emitAsync(EVENT_PREFIX + 'set-speaker', { enabled: true });
                if (existingProducers && existingProducers.length > 0) {
                    for (const { producerId, peerId } of existingProducers) {
                        await this.consume(producerId, peerId);
                    }
                }
            }

            this.isJoined = true;
        } catch (error) {
            console.error('[PDF VC] Failed to join:', error);
            throw error;
        }
    }

    async leaveRoom() {
        if (!this.isJoined) return;
        if (this.analyzerContainer) this.analyzerContainer.style.display = 'none';
        this.stopMicAnalyzer();
        this.stopProducerMonitoring();
        for (const [consumerId, consumerData] of this.consumers) {
            if (consumerData.consumer) {
                if (consumerData.consumer._monitoringInterval) clearInterval(consumerData.consumer._monitoringInterval);
                consumerData.consumer.track.stop();
                consumerData.consumer.close();
            }
        }
        this.consumers.clear();
        if (this.audioProducer) {
            this.audioProducer.close();
            this.audioProducer = null;
        }
        if (this.sendTransport) { this.sendTransport.close(); this.sendTransport = null; }
        if (this.recvTransport) { this.recvTransport.close(); this.recvTransport = null; }
        this.audioContainer.innerHTML = '';
        this.device = null; // mediasoup Device は load が1回限りのため、次回 join で新規作成する
        this.isJoined = false;
        this.isMicEnabled = false;
        await this.emitAsync(EVENT_PREFIX + 'leave', {});
    }

    async createSendTransport() {
        const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync(EVENT_PREFIX + 'create-transport', { direction: 'send' });
        if (error) throw new Error(error);
        this.sendTransport = this.device.createSendTransport({
            id, iceParameters, iceCandidates, dtlsParameters, iceServers: this.iceServers,
        });
        this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitAsync(EVENT_PREFIX + 'connect-transport', { transportId: this.sendTransport.id, dtlsParameters });
                callback();
            } catch (e) { errback(e); }
        });
        this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            try {
                const { producerId, error } = await this.emitAsync(EVENT_PREFIX + 'produce-audio', {
                    transportId: this.sendTransport.id,
                    rtpParameters,
                });
                if (error) throw new Error(error);
                callback({ id: producerId });
            } catch (e) { errback(e); }
        });
    }

    async createRecvTransport() {
        const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync(EVENT_PREFIX + 'create-transport', { direction: 'recv' });
        if (error) throw new Error(error);
        this.recvTransport = this.device.createRecvTransport({
            id, iceParameters, iceCandidates, dtlsParameters, iceServers: this.iceServers,
        });
        this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitAsync(EVENT_PREFIX + 'connect-transport', { transportId: this.recvTransport.id, dtlsParameters });
                callback();
            } catch (e) { errback(e); }
        });
    }

    async setMicEnabled(enabled) {
        try {
            if (enabled === this.isMicEnabled) return;

            if (enabled) {
                await this.unlockAudio();
                const { allowed, denied, reason } = await this.emitAsync(EVENT_PREFIX + 'set-mic', { enabled: true });
                if (denied) {
                    this.showNotification(reason || 'マイクをONにできません', 'warning');
                    return false;
                }
                if (!this.sendTransport) await this.createSendTransport();

                const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
                if (this.selectedMicDeviceId) audioConstraints.deviceId = { exact: this.selectedMicDeviceId };
                const mediaUnavailable = getMediaUnavailableMessage();
                if (mediaUnavailable) {
                    this.showNotification(mediaUnavailable, 'error');
                    return false;
                }
                const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
                const audioTrack = stream.getAudioTracks()[0];

                this.startMicAnalyzer(stream);
                this.audioProducer = await this.sendTransport.produce({ track: audioTrack });
                this.startProducerMonitoring();
                this.isMicEnabled = true;
                if (this.analyzerContainer) this.analyzerContainer.style.display = 'block';
                return true;
            } else {
                this.stopMicAnalyzer();
                this.stopProducerMonitoring();
                if (this.audioProducer) {
                    this.audioProducer.track.stop();
                    this.audioProducer.close();
                    this.audioProducer = null;
                }
                if (this.sendTransport) {
                    this.sendTransport.close();
                    this.sendTransport = null;
                }
                if (this.analyzerContainer) this.analyzerContainer.style.display = 'none';
                await this.emitAsync(EVENT_PREFIX + 'set-mic', { enabled: false });
                this.isMicEnabled = false;
                return true;
            }
        } catch (error) {
            console.error('[PDF VC] setMicEnabled failed:', error);
            const isPermissionDenied = error?.name === 'NotAllowedError' || (error instanceof DOMException && error.name === 'NotAllowedError');
            const base = isPermissionDenied
                ? 'マイクが許可されていません。ブラウザのアドレスバーまたは設定でこのサイトのマイクを許可してください。'
                : 'マイクの操作に失敗しました。';
            const message = getMediaErrorMessage(error, base);
            this.showNotification(message, 'error');
            return false;
        }
    }

    async setSpeakerEnabled(enabled) {
        try {
            if (enabled === this.isSpeakerEnabled) return;

            if (enabled) {
                await this.unlockAudio();
                this.isSpeakerEnabled = true;
                if (!this.recvTransport) await this.createRecvTransport();
                const { existingProducers } = await this.emitAsync(EVENT_PREFIX + 'set-speaker', { enabled: true });
                if (existingProducers && existingProducers.length > 0) {
                    for (const { producerId, peerId } of existingProducers) {
                        await this.consume(producerId, peerId);
                    }
                }
            } else {
                for (const [consumerId, consumerData] of this.consumers) {
                    if (consumerData.consumer) {
                        if (consumerData.consumer._monitoringInterval) clearInterval(consumerData.consumer._monitoringInterval);
                        consumerData.consumer.track.stop();
                        consumerData.consumer.close();
                    }
                }
                this.consumers.clear();
                if (this.recvTransport) {
                    this.recvTransport.close();
                    this.recvTransport = null;
                }
                this.audioContainer.innerHTML = '';
                await this.emitAsync(EVENT_PREFIX + 'set-speaker', { enabled: false });
                this.isSpeakerEnabled = false;
            }
        } catch (error) {
            console.error('[PDF VC] setSpeakerEnabled failed:', error);
            this.showNotification('スピーカーの操作に失敗しました', 'error');
        }
    }

    async consume(producerId, peerId) {
        try {
            if (!this.recvTransport) return;
            const { consumerId, kind, rtpParameters, error } = await this.emitAsync(EVENT_PREFIX + 'consume', {
                producerId,
                rtpCapabilities: this.device.rtpCapabilities,
            });
            if (error) throw new Error(error);

            const consumer = await this.recvTransport.consume({
                id: consumerId,
                producerId,
                kind,
                rtpParameters,
            });
            this.consumers.set(consumerId, { consumer, peerId, producerId });

            await this.emitAsync(EVENT_PREFIX + 'consumer-resume', { consumerId });

            const audio = document.createElement('audio');
            audio.id = ID_PREFIX + 'audio-' + consumerId;
            audio.srcObject = new MediaStream([consumer.track]);
            audio.autoplay = true;
            audio.playsInline = true;
            audio.volume = 1.0;
            audio.muted = false;
            if (this.selectedSpeakerDeviceId && typeof audio.setSinkId === 'function') {
                try { await audio.setSinkId(this.selectedSpeakerDeviceId); } catch (_) {}
            }
            this.audioContainer.appendChild(audio);
            try {
                await audio.play();
            } catch (e) {
                if (!this.audioUnlocked) {
                    await this.unlockAudio();
                    try { await audio.play(); } catch (_) {
                        this.showNotification('音声の再生にはページをクリックしてください', 'warning');
                    }
                }
            }
            this.updateActiveSpeakersCount();
        } catch (error) {
            console.error('[PDF VC] consume failed:', error);
        }
    }

    updateActiveSpeakersCount() {
        const el = document.getElementById(ID_PREFIX + 'active-speakers');
        if (el) el.textContent = this.consumers.size;
    }

    closeConsumer(consumerId) {
        const consumerData = this.consumers.get(consumerId);
        if (!consumerData) return;
        if (consumerData.consumer) {
            if (consumerData.consumer._monitoringInterval) clearInterval(consumerData.consumer._monitoringInterval);
            consumerData.consumer.track.stop();
            consumerData.consumer.close();
        }
        this.consumers.delete(consumerId);
        const audioEl = document.getElementById(ID_PREFIX + 'audio-' + consumerId);
        if (audioEl) audioEl.remove();
        this.updateActiveSpeakersCount();
    }

    closeConsumerByProducerId(producerId) {
        for (const [consumerId, consumerData] of this.consumers) {
            if (consumerData.producerId === producerId) {
                this.closeConsumer(consumerId);
                break;
            }
        }
    }

    startMicAnalyzer(stream) {
        try {
            if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioContext.createMediaStreamSource(stream);
            this.micAnalyzer = this.audioContext.createAnalyser();
            this.micAnalyzer.fftSize = 256;
            source.connect(this.micAnalyzer);
            const dataArray = new Uint8Array(this.micAnalyzer.frequencyBinCount);
            this.micAnalyzerInterval = setInterval(() => {
                this.micAnalyzer.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
                const percentage = Math.min(100, (average / 128) * 100);
                const fillEl = document.getElementById(ID_PREFIX + 'mic-level-fill');
                const textEl = document.getElementById(ID_PREFIX + 'mic-level-text');
                if (fillEl) fillEl.style.width = percentage + '%';
                if (textEl) textEl.textContent = Math.round(percentage) + '%';
            }, 100);
        } catch (e) { console.warn('[PDF VC] Mic analyzer failed:', e); }
    }

    stopMicAnalyzer() {
        if (this.micAnalyzerInterval) {
            clearInterval(this.micAnalyzerInterval);
            this.micAnalyzerInterval = null;
        }
        if (this.micAnalyzer) {
            this.micAnalyzer.disconnect();
            this.micAnalyzer = null;
        }
    }

    startProducerMonitoring() {
        if (this.producerMonitoringInterval) clearInterval(this.producerMonitoringInterval);
        this.producerMonitoringInterval = setInterval(async () => {
            if (this.audioProducer) {
                try { await this.audioProducer.getStats(); } catch (_) {}
            }
        }, 5000);
    }

    stopProducerMonitoring() {
        if (this.producerMonitoringInterval) {
            clearInterval(this.producerMonitoringInterval);
            this.producerMonitoringInterval = null;
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'error' ? '#e74c3c' : type === 'warning' ? '#f39c12' : '#3498db'};
            color: white;
            border-radius: 5px;
            z-index: 10002;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    emitAsync(event, data) {
        return new Promise((resolve) => {
            this.socket.emit(event, data, (response) => resolve(response || {}));
        });
    }
}

export default PdfViewerVoiceChatManager;
