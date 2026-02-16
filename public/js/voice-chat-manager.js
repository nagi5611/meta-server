import * as mediasoupClient from 'mediasoup-client';
import { getMediaUnavailableMessage, getMediaErrorMessage } from './media-support.js';

class VoiceChatManager {
    constructor(socket) {
        this.socket = socket;
        this.device = null;
        this.sendTransport = null;
        this.recvTransport = null;
        this.audioProducer = null;
        this.consumers = new Map();
        this.currentRoomId = null;
        this.iceServers = [];
        
        // State
        this.isMicEnabled = false;
        this.isSpeakerEnabled = true; // Default: speaker ON
        this.isJoined = false;
        
        // Device settings
        this.selectedMicDeviceId = null;
        this.selectedSpeakerDeviceId = null;
        this.micVolume = 33; // 0-100 (0=0%, 33=100%等倍, 100=300%), スライダー位置
        
        // Audio elements container
        this.audioContainer = document.createElement('div');
        this.audioContainer.id = 'vc-audio-container';
        this.audioContainer.style.display = 'none';
        document.body.appendChild(this.audioContainer);
        
        // Audio analyzer
        this.audioContext = null;
        this.micAnalyzer = null;
        this.micAnalyzerInterval = null;
        this.producerMonitoringInterval = null;
        this.audioUnlocked = false; // Track if browser audio policy is unlocked
        this.micTestLoopback = false; // 設定画面のマイクテストでサーバー経由ループバック中
        this.micTestProducerId = null; // ループバック用プロデューサーID（停止時にconsumerを閉じる用）
        this.micTestAudioProducer = null; // マイクテスト用プロデューサー（本番 audioProducer と分離）
        this.setupAudioAnalyzer();
        
        this.setupEventListeners();
    }
    
    setupAudioAnalyzer() {
        // Create analyzer UI
        const analyzerContainer = document.createElement('div');
        analyzerContainer.id = 'vc-audio-analyzer';
        analyzerContainer.style.cssText = `
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            padding: 10px 20px;
            border-radius: 20px;
            display: none;
            z-index: 9999;
            color: white;
            font-size: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        `;
        
        analyzerContainer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-weight: bold;">🎤 マイク:</span>
                <div id="vc-mic-level-bar" style="
                    width: 200px;
                    height: 8px;
                    background: #333;
                    border-radius: 4px;
                    overflow: hidden;
                    position: relative;
                ">
                    <div id="vc-mic-level-fill" style="
                        width: 0%;
                        height: 100%;
                        background: linear-gradient(90deg, #4CAF50, #FFC107, #F44336);
                        transition: width 0.1s;
                    "></div>
                </div>
                <span id="vc-mic-level-text" style="min-width: 40px;">0%</span>
                <span id="vc-mic-status" style="margin-left: 10px; color: #4CAF50;">●送信中</span>
            </div>
            <div id="vc-speaker-info" style="margin-top: 8px; font-size: 11px; opacity: 0.8;">
                受信: <span id="vc-active-speakers">0</span>人
            </div>
        `;
        
        document.body.appendChild(analyzerContainer);
        this.analyzerContainer = analyzerContainer;
    }
    
    // Unlock browser audio policy (must be called on user interaction)
    async unlockAudio() {
        if (this.audioUnlocked) return;
        
        try {
            // Create a silent audio element and play it to unlock browser policy
            const silentAudio = document.createElement('audio');
            silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
            silentAudio.volume = 0;
            await silentAudio.play();
            silentAudio.pause();
            silentAudio.remove();
            
            this.audioUnlocked = true;
            console.log('[VC] 🔓 Browser audio policy unlocked');
        } catch (error) {
            console.warn('[VC] Failed to unlock audio policy:', error);
        }
    }
    
    setupEventListeners() {
        // VC: Receive RTP capabilities
        this.socket.on('vc-new-producer', async ({ producerId, peerId }) => {
            console.log(`[VC RECV] 📢 New producer detected: ${producerId} from ${peerId}`);
            console.log(`[VC RECV] 📊 Current state:`, {
                speakerEnabled: this.isSpeakerEnabled,
                recvTransport: !!this.recvTransport,
                micEnabled: this.isMicEnabled,
                sendTransport: !!this.sendTransport,
                isJoined: this.isJoined,
                currentRoomId: this.currentRoomId,
                micTestLoopback: this.micTestLoopback
            });
            
            const isLoopbackSelf = this.micTestLoopback && peerId === this.socket.id;
            if (isLoopbackSelf && this.recvTransport) {
                this.micTestProducerId = producerId;
                console.log(`[VC RECV] ✅ Mic test loopback: consuming own producer ${producerId}`);
                await this.consume(producerId, peerId);
            } else if (this.isSpeakerEnabled && this.recvTransport && !isLoopbackSelf) {
                console.log(`[VC RECV] ✅ Starting to consume from peer ${peerId}...`);
                await this.consume(producerId, peerId);
            } else if (!isLoopbackSelf) {
                console.error(`[VC RECV] ❌ Cannot consume: speakerEnabled=${this.isSpeakerEnabled}, recvTransport=${!!this.recvTransport}`);
                if (!this.isSpeakerEnabled) {
                    console.error(`[VC RECV] → Speaker is DISABLED`);
                }
                if (!this.recvTransport) {
                    console.error(`[VC RECV] → RecvTransport does NOT exist`);
                }
            }
        });
        
        // VC: Producer closed
        this.socket.on('vc-producer-closed', ({ producerId }) => {
            console.log(`[VC] Producer closed: ${producerId}`);
            this.closeConsumerByProducerId(producerId);
        });
        
        // VC: Consumer closed
        this.socket.on('vc-consumer-closed', ({ consumerId }) => {
            console.log(`[VC] Consumer closed: ${consumerId}`);
            this.closeConsumer(consumerId);
        });
        
        // VC: Room changed
        this.socket.on('vc-room-changed', async ({ roomId }) => {
            console.log(`[VC] Room changed to: ${roomId}`);
            await this.changeRoom(roomId);
        });
    }
    
    async joinRoom(roomId) {
        try {
            console.log(`[VC] Joining room: ${roomId}`);
            this.currentRoomId = roomId;
            
            // Get router RTP capabilities and ICE servers
            const { rtpCapabilities, iceServers, error } = await this.emitAsync('vc-join', { roomId });
            if (error) {
                throw new Error(error);
            }
            
            // Store ICE servers
            if (iceServers && iceServers.length > 0) {
                this.iceServers = iceServers;
                console.log(`[VC] ICE servers configured:`, iceServers.map(s => s.urls));
            }
            
            // Load device
            if (!this.device) {
                this.device = new mediasoupClient.Device();
            }
            
            await this.device.load({ routerRtpCapabilities: rtpCapabilities });
            console.log(`[VC] Device loaded`);
            
            // Create recv transport (speaker ON by default)
            if (this.isSpeakerEnabled) {
                await this.createRecvTransport();
                // Note: Audio unlock will happen on first user interaction (mic/speaker button click)
            }
            
            this.isJoined = true;
            console.log(`[VC] Joined room successfully`);
            console.log(`[VC] 📊 State after joining:`, {
                isJoined: this.isJoined,
                micEnabled: this.isMicEnabled,
                sendTransport: !!this.sendTransport,
                speakerEnabled: this.isSpeakerEnabled,
                recvTransport: !!this.recvTransport,
                currentRoomId: this.currentRoomId
            });
        } catch (error) {
            console.error(`[VC] Failed to join room:`, error);
            throw error;
        }
    }
    
    async changeRoom(newRoomId) {
        // Cleanup current room
        await this.leaveRoom();
        
        // Join new room
        await this.joinRoom(newRoomId);
    }
    
    async leaveRoom() {
        if (!this.isJoined) return;
        
        console.log(`[VC] Leaving room`);
        
        // Stop monitoring
        this.stopMicAnalyzer();
        this.stopProducerMonitoring();
        
        // Close all consumers
        for (const [consumerId, consumerData] of this.consumers) {
            if (consumerData.consumer) {
                // Clear monitoring
                if (consumerData.consumer._monitoringInterval) {
                    clearInterval(consumerData.consumer._monitoringInterval);
                }
                consumerData.consumer.track.stop();
                consumerData.consumer.close();
            }
        }
        this.consumers.clear();
        
        // Close audio producer
        if (this.audioProducer) {
            this.audioProducer.close();
            this.audioProducer = null;
        }
        
        // Close transports
        if (this.sendTransport) {
            this.sendTransport.close();
            this.sendTransport = null;
        }
        if (this.recvTransport) {
            this.recvTransport.close();
            this.recvTransport = null;
        }
        
        // Clear audio elements
        this.audioContainer.innerHTML = '';
        
        this.isJoined = false;
        this.isMicEnabled = false;
        
        // Notify server
        await this.emitAsync('vc-leave', {});
        
        console.log(`[VC] Left room`);
    }
    
    async createSendTransport() {
        try {
            const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync('vc-create-transport', { direction: 'send' });
            if (error) {
                throw new Error(error);
            }
            
            console.log(`[VC SEND] Received transport params from server:`, {
                transportId: id,
                iceCandidates: iceCandidates.map(c => `${c.protocol} ${c.ip}:${c.port} (${c.type})`),
                iceServers: this.iceServers.length
            });
            
            this.sendTransport = this.device.createSendTransport({
                id,
                iceParameters,
                iceCandidates,
                dtlsParameters,
                iceServers: this.iceServers,
            });
            
            this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log(`[VC SEND] 🔗 'connect' event fired, sending dtlsParameters to server...`);
                    await this.emitAsync('vc-connect-transport', { transportId: this.sendTransport.id, dtlsParameters });
                    console.log(`[VC SEND] ✅ Server accepted connection`);
                    callback();
                } catch (error) {
                    console.error(`[VC SEND] ❌ Connection failed:`, error);
                    errback(error);
                }
            });
            
            this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
                try {
                    console.log(`[VC SEND] 🎤 'produce' event fired (kind=${kind}), requesting producer from server...`);
                    const { producerId, error } = await this.emitAsync('vc-produce-audio', {
                        transportId: this.sendTransport.id,
                        rtpParameters,
                        loopback: this.micTestLoopback || undefined,
                    });
                    if (error) {
                        console.error(`[VC SEND] ❌ Server returned error:`, error);
                        throw new Error(error);
                    }
                    console.log(`[VC SEND] ✅ Server created producer: ${producerId}`);
                    callback({ id: producerId });
                } catch (error) {
                    console.error(`[VC SEND] ❌ Produce failed:`, error);
                    errback(error);
                }
            });
            
            this.sendTransport.on('connectionstatechange', (state) => {
                console.log(`[VC SEND] 🔌 Transport connection state: ${state}`);
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    console.error(`[VC SEND] ❌ Transport connection FAILED: ${state}`);
                }
            });
            
            this.sendTransport.on('icestatechange', (state) => {
                console.log(`[VC SEND] 🧊 ICE state: ${state}`);
            });
            
            this.sendTransport.on('iceconnectionstatechange', (state) => {
                console.log(`[VC SEND] 🧊 ICE connection state: ${state}`);
            });
            
            this.sendTransport.on('dtlsstatechange', (state) => {
                console.log(`[VC SEND] 🔐 DTLS state: ${state}`);
            });
            
            console.log(`[VC] Send transport created`);
        } catch (error) {
            console.error(`[VC] Failed to create send transport:`, error);
            throw error;
        }
    }
    
    async createRecvTransport() {
        try {
            const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync('vc-create-transport', { direction: 'recv' });
            if (error) {
                throw new Error(error);
            }
            
            console.log(`[VC RECV] Received transport params from server:`, {
                transportId: id,
                iceCandidates: iceCandidates.map(c => `${c.protocol} ${c.ip}:${c.port} (${c.type})`),
                iceServers: this.iceServers.length
            });
            
            this.recvTransport = this.device.createRecvTransport({
                id,
                iceParameters,
                iceCandidates,
                dtlsParameters,
                iceServers: this.iceServers,
            });
            
            this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log(`[VC RECV] 🔗 'connect' event fired, sending dtlsParameters to server...`);
                    await this.emitAsync('vc-connect-transport', { transportId: this.recvTransport.id, dtlsParameters });
                    console.log(`[VC RECV] ✅ Server accepted connection`);
                    callback();
                } catch (error) {
                    console.error(`[VC RECV] ❌ Connection failed:`, error);
                    errback(error);
                }
            });
            
            this.recvTransport.on('connectionstatechange', (state) => {
                console.log(`[VC RECV] 🔌 Transport connection state: ${state}`);
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    console.error(`[VC RECV] ❌ Transport connection FAILED: ${state}`);
                }
            });
            
            this.recvTransport.on('icestatechange', (state) => {
                console.log(`[VC RECV] 🧊 ICE state: ${state}`);
            });
            
            this.recvTransport.on('iceconnectionstatechange', (state) => {
                console.log(`[VC RECV] 🧊 ICE connection state: ${state}`);
            });
            
            this.recvTransport.on('dtlsstatechange', (state) => {
                console.log(`[VC RECV] 🔐 DTLS state: ${state}`);
            });
            
            console.log(`[VC] Recv transport created`);
        } catch (error) {
            console.error(`[VC] Failed to create recv transport:`, error);
            throw error;
        }
    }
    
    async setMicEnabled(enabled) {
        try {
            if (enabled === this.isMicEnabled) return;
            
            if (enabled) {
                // Unlock browser audio policy on first user interaction
                await this.unlockAudio();
                
                // Mic ON: Check if allowed by server (max 10)
                const { allowed, denied, reason } = await this.emitAsync('vc-set-mic', { enabled: true });
                
                if (denied) {
                    console.warn(`[VC] Mic denied: ${reason}`);
                    // Show UI notification
                    this.showNotification(reason, 'warning');
                    return false;
                }
                
                // Create send transport if not exists
                if (!this.sendTransport) {
                    await this.createSendTransport();
                }
                
                // Get microphone stream
                const audioConstraints = {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                };
                
                // Use selected device if available
                if (this.selectedMicDeviceId) {
                    audioConstraints.deviceId = { exact: this.selectedMicDeviceId };
                }
                const mediaUnavailable = getMediaUnavailableMessage();
                if (mediaUnavailable) {
                    this.showNotification(mediaUnavailable, 'error');
                    return false;
                }
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: audioConstraints,
                });

                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                if (audioContext.state === 'suspended') await audioContext.resume();
                this.micProcessingContext = audioContext;

                const source = audioContext.createMediaStreamSource(stream);
                const gainNode = audioContext.createGain();
                gainNode.gain.value = (this.micVolume / 100) * 3; // 0%〜300%
                this.micGainNode = gainNode;

                const destination = audioContext.createMediaStreamDestination();
                source.connect(gainNode);
                gainNode.connect(destination);

                const gainedTrack = destination.stream.getAudioTracks()[0];
                this.micSourceNode = source;
                this.micDestinationNode = destination;

                console.log(`[VC] Audio track obtained (gain: ${gainNode.gain.value}x):`, { micVolume: this.micVolume });

                this.startMicAnalyzerFromGainNode(gainNode);

                console.log(`[VC SEND] 🔍 Transport state BEFORE produce:`, {
                    id: this.sendTransport.id,
                    connectionState: this.sendTransport.connectionState,
                    iceConnectionState: this.sendTransport.iceConnectionState,
                    iceGatheringState: this.sendTransport.iceGatheringState
                });

                console.log(`[VC SEND] 📤 Calling sendTransport.produce()...`);
                this.audioProducer = await this.sendTransport.produce({
                    track: gainedTrack,
                });
                console.log(`[VC SEND] ✅ sendTransport.produce() completed`);
                
                console.log(`[VC SEND] Audio producer created:`, {
                    id: this.audioProducer.id,
                    kind: this.audioProducer.kind,
                    paused: this.audioProducer.paused,
                    closed: this.audioProducer.closed,
                    track: {
                        id: this.audioProducer.track.id,
                        enabled: this.audioProducer.track.enabled,
                        muted: this.audioProducer.track.muted,
                        readyState: this.audioProducer.track.readyState
                    }
                });
                
                // Log transport state when producer is created
                if (this.sendTransport) {
                    console.log(`[VC SEND] Transport state at producer creation:`, {
                        id: this.sendTransport.id,
                        connectionState: this.sendTransport.connectionState,
                        iceConnectionState: this.sendTransport.iceConnectionState,
                        iceGatheringState: this.sendTransport.iceGatheringState
                    });
                }
                
                // Monitor producer stats
                this.startProducerMonitoring();
                
                // Monitor transport connection progress
                this.monitorTransportConnection();
                
                this.isMicEnabled = true;
                console.log(`[VC] Mic enabled - SENDING AUDIO`);
                console.log(`[VC] 📊 State after mic ON:`, {
                    micEnabled: this.isMicEnabled,
                    sendTransport: !!this.sendTransport,
                    speakerEnabled: this.isSpeakerEnabled,
                    recvTransport: !!this.recvTransport,
                    consumers: this.consumers.size
                });
                
                // Show analyzer
                if (this.analyzerContainer) {
                    this.analyzerContainer.style.display = 'block';
                }
                
                return true;
            } else {
                // Mic OFF: Close producer and sendTransport
                this.stopMicAnalyzer();
                this.stopProducerMonitoring();
                this.micGainNode = null;
                this.micSourceNode = null;
                this.micDestinationNode = null;
                if (this.micProcessingContext) {
                    this.micProcessingContext.close();
                    this.micProcessingContext = null;
                }
                if (this.audioProducer) {
                    this.audioProducer.track.stop();
                    this.audioProducer.close();
                    this.audioProducer = null;
                }
                
                // Close sendTransport (to match server-side state)
                if (this.sendTransport) {
                    this.sendTransport.close();
                    this.sendTransport = null;
                    console.log(`[VC] Send transport closed`);
                }
                
                // Hide analyzer
                if (this.analyzerContainer) {
                    this.analyzerContainer.style.display = 'none';
                }
                
                // Notify server
                await this.emitAsync('vc-set-mic', { enabled: false });
                
                this.isMicEnabled = false;
                console.log(`[VC] Mic disabled - STOPPED SENDING`);
                console.log(`[VC] 📊 State after mic OFF:`, {
                    micEnabled: this.isMicEnabled,
                    sendTransport: !!this.sendTransport,
                    speakerEnabled: this.isSpeakerEnabled,
                    recvTransport: !!this.recvTransport,
                    consumers: this.consumers.size
                });
                return true;
            }
        } catch (error) {
            console.error(`[VC] Failed to set mic:`, error);
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
                // Unlock browser audio policy on first user interaction
                await this.unlockAudio();
                
                // Speaker ON: Create recv transport and consume existing producers
                this.isSpeakerEnabled = true;
                
                if (!this.recvTransport) {
                    await this.createRecvTransport();
                }
                
                const { existingProducers } = await this.emitAsync('vc-set-speaker', { enabled: true });
                
                console.log(`[VC RECV] Speaker enabled, ${existingProducers?.length || 0} existing producers found`);
                console.log(`[VC] 📊 State after speaker ON:`, {
                    speakerEnabled: this.isSpeakerEnabled,
                    recvTransport: !!this.recvTransport,
                    micEnabled: this.isMicEnabled,
                    sendTransport: !!this.sendTransport,
                    consumers: this.consumers.size
                });
                
                // Consume existing producers
                if (existingProducers && existingProducers.length > 0) {
                    for (const { producerId, peerId } of existingProducers) {
                        console.log(`[VC RECV] Consuming existing producer ${producerId} from peer ${peerId}`);
                        await this.consume(producerId, peerId);
                    }
                }
            } else {
                // Speaker OFF: Close all consumers and recvTransport
                for (const [consumerId, consumerData] of this.consumers) {
                    if (consumerData.consumer) {
                        // Clear monitoring
                        if (consumerData.consumer._monitoringInterval) {
                            clearInterval(consumerData.consumer._monitoringInterval);
                        }
                        consumerData.consumer.track.stop();
                        consumerData.consumer.close();
                    }
                }
                this.consumers.clear();
                
                // Close recvTransport (to match server-side state)
                if (this.recvTransport) {
                    this.recvTransport.close();
                    this.recvTransport = null;
                    console.log(`[VC] Recv transport closed`);
                }
                
                // Clear audio elements
                this.audioContainer.innerHTML = '';
                
                // Update count
                this.updateActiveSpeakersCount();
                
                // Notify server
                await this.emitAsync('vc-set-speaker', { enabled: false });
                
                this.isSpeakerEnabled = false;
                console.log(`[VC RECV] Speaker disabled - STOPPED RECEIVING`);
                console.log(`[VC] 📊 State after speaker OFF:`, {
                    speakerEnabled: this.isSpeakerEnabled,
                    recvTransport: !!this.recvTransport,
                    micEnabled: this.isMicEnabled,
                    sendTransport: !!this.sendTransport,
                    consumers: this.consumers.size
                });
            }
        } catch (error) {
            console.error(`[VC] Failed to set speaker:`, error);
            this.showNotification('スピーカーの操作に失敗しました', 'error');
        }
    }
    
    async consume(producerId, peerId) {
        try {
            console.log(`[VC RECV] consume() called for producer ${producerId} from peer ${peerId}`);
            
            if (!this.recvTransport) {
                console.warn(`[VC RECV] Cannot consume: recv transport not ready`);
                return;
            }
            
            console.log(`[VC RECV] Requesting consumer from server...`);
            const { consumerId, kind, rtpParameters, error } = await this.emitAsync('vc-consume', {
                producerId,
                rtpCapabilities: this.device.rtpCapabilities,
            });
            
            if (error) {
                console.error(`[VC RECV] Server returned error:`, error);
                throw new Error(error);
            }
            
            console.log(`[VC RECV] Server responded with consumerId: ${consumerId}, kind: ${kind}`);
            
            console.log(`[VC RECV] Creating consumer on recvTransport...`);
            const consumer = await this.recvTransport.consume({
                id: consumerId,
                producerId,
                kind,
                rtpParameters,
            });
            
            console.log(`[VC RECV] Consumer created successfully: ${consumer.id}`);
            
            this.consumers.set(consumerId, { consumer, peerId, producerId });

            // Track-level events (mute/unmute/ended) to detect "silent but connected"
            try {
                consumer.track.addEventListener('mute', () => {
                    console.warn(`[VC RECV] 🔇 Track muted (consumerId=${consumerId}, peer=${peerId})`);
                });
                consumer.track.addEventListener('unmute', () => {
                    console.log(`[VC RECV] 🔊 Track unmuted (consumerId=${consumerId}, peer=${peerId})`);
                });
                consumer.track.addEventListener('ended', () => {
                    console.warn(`[VC RECV] 🛑 Track ended (consumerId=${consumerId}, peer=${peerId})`);
                });
            } catch (e) {
                console.warn('[VC RECV] Failed to attach track event listeners:', e);
            }
            
            // Resume consumer
            console.log(`[VC RECV] Resuming consumer...`);
            await this.emitAsync('vc-consumer-resume', { consumerId });
            console.log(`[VC RECV] Consumer resumed`);
            
            // Create audio element
            const audio = document.createElement('audio');
            audio.id = `vc-audio-${consumerId}`;
            audio.srcObject = new MediaStream([consumer.track]);
            audio.autoplay = true;
            audio.playsInline = true;
            audio.volume = 1.0; // Ensure volume is at max
            audio.muted = false; // Ensure not muted
            
            console.log(`[VC RECV] Audio element created, autoplay=${audio.autoplay}, volume=${audio.volume}, muted=${audio.muted}`);
            
            // Set speaker device if selected
            if (this.selectedSpeakerDeviceId && typeof audio.setSinkId === 'function') {
                try {
                    await audio.setSinkId(this.selectedSpeakerDeviceId);
                    console.log(`[VC RECV] Audio element sink set to: ${this.selectedSpeakerDeviceId}`);
                } catch (err) {
                    console.warn('[VC RECV] Failed to set speaker device for audio element:', err);
                }
            }
            
            this.audioContainer.appendChild(audio);
            console.log(`[VC RECV] Audio element appended to DOM`);
            
            // Listen to audio element events
            audio.addEventListener('play', () => {
                console.log(`[VC RECV] ▶️ Audio element ${consumerId} started playing`);
            });
            audio.addEventListener('pause', () => {
                console.log(`[VC RECV] ⏸️ Audio element ${consumerId} paused`);
            });
            audio.addEventListener('error', (e) => {
                console.error(`[VC RECV] ❌ Audio element ${consumerId} error:`, e);
            });
            audio.addEventListener('loadedmetadata', () => {
                console.log(`[VC RECV] 📊 Audio element ${consumerId} metadata loaded`);
            });
            audio.addEventListener('volumechange', () => {
                console.log(`[VC RECV] 🔧 Audio element ${consumerId} volumechange: volume=${audio.volume}, muted=${audio.muted}`);
            });
            
            // Explicitly try to play (autoplay might be blocked)
            try {
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        console.log(`[VC RECV] ✅ Audio element ${consumerId} play() succeeded`);
                    }).catch(async (error) => {
                        console.error(`[VC RECV] ❌ Audio element ${consumerId} play() failed (autoplay blocked?):`, error);
                        
                        // Try to unlock audio and retry
                        if (!this.audioUnlocked) {
                            console.log(`[VC RECV] Attempting to unlock audio policy...`);
                            await this.unlockAudio();
                            
                            // Retry play
                            try {
                                await audio.play();
                                console.log(`[VC RECV] ✅ Audio element ${consumerId} play() succeeded after unlock`);
                            } catch (retryError) {
                                console.error(`[VC RECV] ❌ Audio element ${consumerId} still failed after unlock:`, retryError);
                                this.showNotification('音声の再生にはページをクリックしてください', 'warning');
                            }
                        } else {
                            this.showNotification('音声の再生に失敗しました', 'error');
                        }
                    });
                }
            } catch (error) {
                console.error(`[VC RECV] ❌ Audio element ${consumerId} play() threw error:`, error);
            }
            
            // Update active speakers count
            this.updateActiveSpeakersCount();
            
            // Monitor consumer stats
            this.startConsumerMonitoring(consumer, peerId);
            
            console.log(`[VC RECV] ✅ Successfully consuming audio from peer ${peerId}`, {
                consumerId: consumer.id,
                kind: consumer.kind,
                paused: consumer.paused,
                track: {
                    id: consumer.track.id,
                    enabled: consumer.track.enabled,
                    muted: consumer.track.muted,
                    readyState: consumer.track.readyState
                },
                audioElement: {
                    id: audio.id,
                    autoplay: audio.autoplay,
                    muted: audio.muted,
                    volume: audio.volume
                }
            });
        } catch (error) {
            console.error(`[VC RECV] ❌ Failed to consume:`, error);
        }
    }
    
    startConsumerMonitoring(consumer, peerId) {
        // Monitor every 5 seconds
        const monitoringInterval = setInterval(async () => {
            if (consumer.closed) {
                clearInterval(monitoringInterval);
                return;
            }
            
            try {
                const stats = await consumer.getStats();
                stats.forEach(stat => {
                    if (stat.type === 'inbound-rtp') {
                        console.log(`[VC RECV from ${peerId}] Packets received: ${stat.packetsReceived}, Bytes received: ${stat.bytesReceived}, Packets lost: ${stat.packetsLost}`);
                    }
                });
            } catch (error) {
                console.error('[VC] Failed to get consumer stats:', error);
            }
        }, 5000);
        
        // Store interval for cleanup
        if (!consumer._monitoringInterval) {
            consumer._monitoringInterval = monitoringInterval;
        }
    }
    
    updateActiveSpeakersCount() {
        const count = this.consumers.size;
        const element = document.getElementById('vc-active-speakers');
        if (element) {
            element.textContent = count;
        }
        console.log(`[VC] Active speakers receiving from: ${count}`);
    }
    
    closeConsumer(consumerId) {
        const consumerData = this.consumers.get(consumerId);
        if (!consumerData) return;
        
        if (consumerData.consumer) {
            // Clear monitoring
            if (consumerData.consumer._monitoringInterval) {
                clearInterval(consumerData.consumer._monitoringInterval);
            }
            
            consumerData.consumer.track.stop();
            consumerData.consumer.close();
        }
        this.consumers.delete(consumerId);
        
        // Remove audio element
        const audioEl = document.getElementById(`vc-audio-${consumerId}`);
        if (audioEl) {
            audioEl.remove();
        }
        
        // Update count
        this.updateActiveSpeakersCount();
        
        console.log(`[VC RECV] Closed consumer: ${consumerId}`);
    }
    
    closeConsumerByProducerId(producerId) {
        for (const [consumerId, consumerData] of this.consumers) {
            if (consumerData.producerId === producerId) {
                this.closeConsumer(consumerId);
                break;
            }
        }
    }
    
    startMicAnalyzerFromGainNode(gainNode) {
        try {
            const ctx = gainNode.context;
            this.micAnalyzer = ctx.createAnalyser();
            this.micAnalyzer.fftSize = 256;
            gainNode.connect(this.micAnalyzer);
            
            const dataArray = new Uint8Array(this.micAnalyzer.frequencyBinCount);
            
            this.micAnalyzerInterval = setInterval(() => {
                this.micAnalyzer.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
                const percentage = Math.min(100, (average / 128) * 100);
                
                const fillElement = document.getElementById('vc-mic-level-fill');
                const textElement = document.getElementById('vc-mic-level-text');
                
                if (fillElement) {
                    fillElement.style.width = `${percentage}%`;
                }
                if (textElement) {
                    textElement.textContent = `${Math.round(percentage)}%`;
                }
                
                // Log if sound detected
                if (percentage > 5) {
                    console.log(`[VC] Mic level: ${Math.round(percentage)}% - SOUND DETECTED`);
                }
            }, 100);
            
            console.log('[VC] Mic analyzer started');
        } catch (error) {
            console.error('[VC] Failed to start mic analyzer:', error);
        }
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
        
        console.log('[VC] Mic analyzer stopped');
    }
    
    startProducerMonitoring() {
        if (this.producerMonitoringInterval) {
            clearInterval(this.producerMonitoringInterval);
        }
        
        this.producerMonitoringInterval = setInterval(async () => {
            if (this.audioProducer) {
                try {
                    const stats = await this.audioProducer.getStats();
                    stats.forEach(stat => {
                        if (stat.type === 'outbound-rtp') {
                            console.log(`[VC SEND] Packets sent: ${stat.packetsSent}, Bytes sent: ${stat.bytesSent}`);
                        }
                    });
                } catch (error) {
                    console.error('[VC] Failed to get producer stats:', error);
                }
            }
        }, 5000); // Every 5 seconds
    }
    
    stopProducerMonitoring() {
        if (this.producerMonitoringInterval) {
            clearInterval(this.producerMonitoringInterval);
            this.producerMonitoringInterval = null;
        }
    }
    
    monitorTransportConnection() {
        // Monitor transport connection state every second for 10 seconds
        let attempts = 0;
        const maxAttempts = 10;
        
        const checkConnection = () => {
            attempts++;
            
            if (this.sendTransport) {
                const state = {
                    connectionState: this.sendTransport.connectionState,
                    iceConnectionState: this.sendTransport.iceConnectionState,
                    iceGatheringState: this.sendTransport.iceGatheringState
                };
                
                console.log(`[VC SEND] 🔍 Connection check #${attempts}:`, state);
                
                if (state.connectionState === 'connected') {
                    console.log(`[VC SEND] ✅ Transport CONNECTED successfully!`);
                    return; // Stop monitoring
                } else if (state.connectionState === 'failed' || state.connectionState === 'disconnected') {
                    console.error(`[VC SEND] ❌ Transport FAILED:`, state);
                    return; // Stop monitoring
                }
            }
            
            if (attempts < maxAttempts) {
                setTimeout(checkConnection, 1000);
            } else {
                console.error(`[VC SEND] ❌ Transport did NOT connect after ${maxAttempts} seconds:`, {
                    connectionState: this.sendTransport?.connectionState,
                    iceConnectionState: this.sendTransport?.iceConnectionState,
                    iceGatheringState: this.sendTransport?.iceGatheringState
                });
            }
        };
        
        setTimeout(checkConnection, 1000);
    }
    
    setMicDevice(deviceId) {
        this.selectedMicDeviceId = deviceId;
        console.log(`[VC] Microphone device set to: ${deviceId}`);
    }

    /** マイク音量を設定 (0-100: 0=0%, 33=100%等倍, 100=300%) */
    setMicVolume(volume) {
        this.micVolume = Math.max(0, Math.min(100, volume));
        const gain = (this.micVolume / 100) * 3;
        if (this.micGainNode) this.micGainNode.gain.value = gain;
    }

    /**
     * マイクテスト用: サーバー経由で自分の音声をループバック再生（他者が聞くのと同じ経路）。
     * ルーム参加済み・device 読み込み済みである必要がある。
     * @param {MediaStream} stream - 送信する音声ストリーム（gain適用済み）
     * @returns {Promise<boolean>} 開始できた場合 true
     */
    async startMicTestLoopback(stream) {
        if (!this.currentRoomId || !this.device) {
            console.warn('[VC] Mic test loopback: not joined or device not loaded');
            return false;
        }
        try {
            await this.unlockAudio();
            this.micTestLoopback = true;
            this.micTestProducerId = null;
            if (!this.recvTransport) await this.createRecvTransport();
            if (!this.sendTransport) await this.createSendTransport();
            const track = stream.getAudioTracks()[0];
            if (!track) throw new Error('No audio track in stream');
            this.micTestAudioProducer = await this.sendTransport.produce({ track });
            console.log('[VC] Mic test loopback: producing', this.micTestAudioProducer.id);
            return true;
        } catch (e) {
            console.error('[VC] Mic test loopback start failed:', e);
            this.micTestLoopback = false;
            return false;
        }
    }

    /** マイクテストのサーバー経由ループバックを停止 */
    stopMicTestLoopback() {
        if (this.micTestProducerId) {
            this.closeConsumerByProducerId(this.micTestProducerId);
            this.micTestProducerId = null;
        }
        if (this.micTestAudioProducer) {
            try {
                this.micTestAudioProducer.track.stop();
                this.micTestAudioProducer.close();
            } catch (e) { /* ignore */ }
            this.micTestAudioProducer = null;
        }
        this.micTestLoopback = false;
    }

    setSpeakerDevice(deviceId) {
        this.selectedSpeakerDeviceId = deviceId;
        console.log(`[VC] Speaker device set to: ${deviceId}`);
        
        // Update all existing audio elements
        const audioElements = this.audioContainer.querySelectorAll('audio');
        audioElements.forEach(audio => {
            if (typeof audio.setSinkId === 'function') {
                audio.setSinkId(deviceId).catch(err => {
                    console.error('[VC] Failed to set speaker device:', err);
                });
            }
        });
    }
    
    showNotification(message, type = 'info') {
        // Create simple notification (can be replaced with better UI)
        const notification = document.createElement('div');
        notification.className = `vc-notification vc-notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'error' ? '#e74c3c' : type === 'warning' ? '#f39c12' : '#3498db'};
            color: white;
            border-radius: 5px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            animation: slideIn 0.3s ease-out;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    // Helper: Promise-based socket emit
    emitAsync(event, data) {
        return new Promise((resolve) => {
            this.socket.emit(event, data, (response) => {
                resolve(response || {});
            });
        });
    }
}

export default VoiceChatManager;
