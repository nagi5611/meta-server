/**
 * VideoChatManager - ビデオ通話管理（カメラ/画面共有）
 * mediasoup-client を使用、ルームVC・PDF VC と別チャンネル
 */
import * as mediasoupClient from 'mediasoup-client';

// 解像度プリセット (width x height)
export const VIDEO_RESOLUTIONS = {
    '360p': { width: 640, height: 360 },
    '480p': { width: 854, height: 480 },
    '540p': { width: 960, height: 540 },
    '720p': { width: 1280, height: 720 },
};

class VideoChatManager {
    constructor(socket) {
        this.socket = socket;
        this.device = null;
        this.sendTransport = null;
        this.recvTransport = null;
        this.producers = new Map(); // producerId -> producer
        this.consumers = new Map(); // consumerId -> { consumer, peerId, kind, videoEl? }
        this.currentRoomId = null;
        this.iceServers = [];
        this.isJoined = false;

        // State: 'camera' | 'screen' | null
        this.currentMode = null;
        this.currentStream = null;

        // 視聴ボタンで開くまでパネルを表示しない
        this.userOpenedVideoPanel = false;
        // 視聴を選択した peerId の一覧（この peer の配信だけ consume する）
        this.watchedPeerIds = new Set();

        // Video display: ミニプレイヤー（横400px固定、縦は16:9に従う）＋ UIオーバーレイ
        this.videoPopup = document.createElement('div');
        this.videoPopup.id = 'video-vc-popup';
        this.videoPopup.className = 'video-vc-popup';
        this.videoPopup.style.cssText = `
            position: fixed;
            bottom: 60px;
            right: 20px;
            width: 300px;
            aspect-ratio: 16/9;
            display: none;
            flex-direction: column;
            background: #000;
            border-radius: 8px;
            z-index: 50;
            overflow: hidden;
        `;

        const header = document.createElement('div');
        header.className = 'video-vc-header';
        header.style.cssText = `
            position: absolute;
            top: 12px;
            right: 12px;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            z-index: 10;
        `;
        // ミニプレイヤーではアップアイコンのみ（画面全体へ）
        const fullBtn = document.createElement('button');
        fullBtn.type = 'button';
        fullBtn.className = 'video-vc-toolbar-btn video-vc-toolbar-full';
        fullBtn.title = '画面全体で表示';
        fullBtn.innerHTML = '<i class="bi bi-arrow-up-right-square"></i>';
        fullBtn.addEventListener('click', () => this.showFullscreen());
        header.appendChild(fullBtn);
        const fsBtnMini = document.createElement('button');
        fsBtnMini.type = 'button';
        fsBtnMini.className = 'video-vc-toolbar-btn video-vc-toolbar-browser-fs';
        fsBtnMini.title = '全画面表示';
        fsBtnMini.innerHTML = '<i class="bi bi-fullscreen"></i>';
        fsBtnMini.addEventListener('click', () => this.toggleBrowserFullscreen(this.videoPopup));
        header.appendChild(fsBtnMini);
        const closeBtnMini = document.createElement('button');
        closeBtnMini.type = 'button';
        closeBtnMini.className = 'video-vc-toolbar-btn video-vc-toolbar-close';
        closeBtnMini.title = '閉じて配信を切断';
        closeBtnMini.innerHTML = '×';
        closeBtnMini.addEventListener('click', () => this.closeFullscreenAndDisconnect());
        header.appendChild(closeBtnMini);

        this.videoContainer = document.createElement('div');
        this.videoContainer.id = 'video-vc-container';
        this.videoContainer.className = 'video-vc-container';
        this.videoContainer.style.cssText = `
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        `;

        this.videoPopup.appendChild(this.videoContainer);
        this.videoPopup.appendChild(header);
        document.body.appendChild(this.videoPopup);

        // 配信者用セルフプレビュー（ボタンなし、右下）
        this.selfPreview = document.createElement('div');
        this.selfPreview.id = 'video-vc-self-preview';
        this.selfPreview.className = 'video-vc-self-preview';
        this.selfPreview.style.cssText = `
            position: fixed;
            bottom: 60px;
            right: 20px;
            width: 300px;
            aspect-ratio: 16/9;
            display: none;
            background: #000;
            border-radius: 8px;
            z-index: 49;
            overflow: hidden;
        `;
        this.selfPreviewVideo = document.createElement('video');
        this.selfPreviewVideo.autoplay = true;
        this.selfPreviewVideo.playsInline = true;
        this.selfPreviewVideo.muted = true;
        this.selfPreviewVideo.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#111;';
        this.selfPreview.appendChild(this.selfPreviewVideo);
        document.body.appendChild(this.selfPreview);

        // フルスクリーンオーバーレイ
        this.fullscreenOverlay = document.createElement('div');
        this.fullscreenOverlay.id = 'video-vc-fullscreen';
        this.fullscreenOverlay.className = 'video-vc-fullscreen';
        this.fullscreenOverlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: #000;
            z-index: 99999;
            display: none;
            flex-direction: column;
            padding: 0;
        `;

        const fsToolbar = document.createElement('div');
        fsToolbar.className = 'video-vc-fullscreen-toolbar';
        fsToolbar.style.cssText = `
            position: absolute;
            top: 12px;
            right: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            z-index: 10;
        `;
        // 画面全体表示ではミニプレイヤーアイコンのみ
        const fsMiniBtn = document.createElement('button');
        fsMiniBtn.type = 'button';
        fsMiniBtn.className = 'video-vc-toolbar-btn video-vc-toolbar-mini';
        fsMiniBtn.title = 'ミニプレイヤー';
        fsMiniBtn.innerHTML = '<i class="bi bi-arrow-down-right-square"></i>';
        fsMiniBtn.addEventListener('click', () => this.showMiniPlayer());
        fsToolbar.appendChild(fsMiniBtn);
        const fsBrowserFsBtn = document.createElement('button');
        fsBrowserFsBtn.type = 'button';
        fsBrowserFsBtn.className = 'video-vc-toolbar-btn video-vc-toolbar-browser-fs';
        fsBrowserFsBtn.title = '全画面表示';
        fsBrowserFsBtn.innerHTML = '<i class="bi bi-fullscreen"></i>';
        fsBrowserFsBtn.addEventListener('click', () => this.toggleBrowserFullscreen(this.fullscreenOverlay));
        fsToolbar.appendChild(fsBrowserFsBtn);
        const fsCloseBtn = document.createElement('button');
        fsCloseBtn.type = 'button';
        fsCloseBtn.className = 'video-vc-toolbar-btn video-vc-toolbar-close';
        fsCloseBtn.title = '閉じて配信を切断';
        fsCloseBtn.innerHTML = '×';
        fsCloseBtn.addEventListener('click', () => this.closeFullscreenAndDisconnect());
        fsToolbar.appendChild(fsCloseBtn);

        this.fullscreenVideoWrap = document.createElement('div');
        this.fullscreenVideoWrap.className = 'video-vc-fullscreen-videos';
        this.fullscreenVideoWrap.style.cssText = `
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        `;

        this.fullscreenOverlay.appendChild(fsToolbar);
        this.fullscreenOverlay.appendChild(this.fullscreenVideoWrap);
        document.body.appendChild(this.fullscreenOverlay);

        this.browserFsBtns = [fsBtnMini, fsBrowserFsBtn];
        document.addEventListener('fullscreenchange', () => this.updateBrowserFullscreenIcons());

        this.setupEventListeners();
    }

    emitAsync(event, data) {
        return new Promise((resolve) => {
            this.socket.emit(event, data, (response) => resolve(response || {}));
        });
    }

    setupEventListeners() {
        this.socket.on('video-vc-new-producer', async ({ producerId, peerId, kind }) => {
            if (this.recvTransport && this.watchedPeerIds.has(peerId)) {
                await this.consume(producerId, peerId, kind);
            }
        });

        this.socket.on('video-vc-producer-closed', ({ producerId }) => {
            this.closeConsumersByProducerId(producerId);
        });

        this.socket.on('video-vc-consumer-closed', ({ consumerId }) => {
            this.closeConsumer(consumerId);
        });

        this.socket.on('video-vc-room-changed', async ({ roomId }) => {
            await this.changeRoom(roomId);
        });
    }

    async joinRoom(roomId) {
        try {
            this.currentRoomId = roomId;

            const { rtpCapabilities, iceServers, error } = await this.emitAsync('video-vc-join', { roomId });
            if (error) throw new Error(error);

            if (iceServers?.length > 0) this.iceServers = iceServers;

            if (!this.device) this.device = new mediasoupClient.Device();
            await this.device.load({ routerRtpCapabilities: rtpCapabilities });

            // recv transport は視聴ボタン押下時にオンデマンドで作成（リソース節約）
            this.isJoined = true;
        } catch (error) {
            throw error;
        }
    }

    async changeRoom(newRoomId) {
        await this.stop();
        await this.leaveRoom();
        await this.joinRoom(newRoomId);
    }

    async leaveRoom() {
        if (!this.isJoined) return;

        await this.stop();

        for (const [id, data] of this.consumers) {
            if (data.videoWrap) data.videoWrap.remove();
            if (data.consumer) {
                data.consumer.track.stop();
                data.consumer.close();
            }
        }
        this.consumers.clear();
        this.watchedPeerIds.clear();
        this.videoContainer.innerHTML = '';
        this.fullscreenVideoWrap.innerHTML = '';
        this.videoPopup.style.display = 'none';
        this.fullscreenOverlay.style.display = 'none';
        this.userOpenedVideoPanel = false;

        if (this.recvTransport) {
            this.recvTransport.close();
            this.recvTransport = null;
        }

        this.isJoined = false;
        await this.emitAsync('video-vc-leave', {});
    }

    async createSendTransport() {
        const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync('video-vc-create-transport', { direction: 'send' });
        if (error) throw new Error(error);

        this.sendTransport = this.device.createSendTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters,
            iceServers: this.iceServers,
        });

        this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitAsync('video-vc-connect-transport', { transportId: this.sendTransport.id, dtlsParameters });
                callback();
            } catch (e) {
                errback(e);
            }
        });

        this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            try {
                const event = kind === 'video' ? 'video-vc-produce-video' : 'video-vc-produce-audio';
                console.log('[Video VC] sendTransport.produce イベント発火:', event, 'transportId:', this.sendTransport.id);
                const { producerId, error: err } = await this.emitAsync(event, {
                    transportId: this.sendTransport.id,
                    rtpParameters,
                });
                console.log('[Video VC] サーバーからの produce レスポンス:', { producerId, error: err });
                if (err) throw new Error(err);
                callback({ id: producerId });
            } catch (e) {
                console.error('[Video VC] produce エラー:', e);
                errback(e);
            }
        });

        this.sendTransport.on('connectionstatechange', (state) => {
            console.log('[Video VC] sendTransport 接続状態変化:', state);
            if (state === 'failed' || state === 'closed') {
                console.error('[Video VC] sendTransport が失敗/切断されました:', state);
            }
        });
    }

    async createRecvTransport() {
        const { id, iceParameters, iceCandidates, dtlsParameters, error } = await this.emitAsync('video-vc-create-transport', { direction: 'recv' });
        if (error) throw new Error(error);

        this.recvTransport = this.device.createRecvTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters,
            iceServers: this.iceServers,
        });

        this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await this.emitAsync('video-vc-connect-transport', { transportId: this.recvTransport.id, dtlsParameters });
                callback();
            } catch (e) {
                errback(e);
            }
        });

        this.recvTransport.on('connectionstatechange', (state) => {
            console.log('[Video VC] recvTransport 接続状態変化:', state);
            if (state === 'failed' || state === 'closed') {
                console.error('[Video VC] recvTransport が失敗/切断されました:', state);
            }
        });

        // 入室時は接続しない。視聴ボタンで showVideoContainer(peerId) が呼ばれたときのみ set-recv する
    }

    async consume(producerId, peerId, kind) {
        if (!this.recvTransport || !this.device?.rtpCapabilities) return;

        try {
            const { consumerId, rtpParameters, error } = await this.emitAsync('video-vc-consume', {
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

            consumer.on('transportclose', () => this.consumers.delete(consumerId));
            consumer.on('producerclose', () => {
                const data = this.consumers.get(consumerId);
                if (data?.videoWrap) data.videoWrap.remove();
                if (data?.audioEl) data.audioEl.remove();
                if (data?.consumer) {
                    data.consumer.track.stop();
                    data.consumer.close();
                }
                this.consumers.delete(consumerId);
            });

            this.consumers.set(consumerId, { consumer, peerId, kind });

            if (kind === 'video') {
                const wrap = document.createElement('div');
                wrap.style.cssText = 'flex:1;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;';
                const videoEl = document.createElement('video');
                videoEl.autoplay = true;
                videoEl.playsInline = true;
                videoEl.muted = true;
                videoEl.srcObject = new MediaStream([consumer.track]);
                videoEl.style.cssText = 'max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;background:#111;';
                wrap.appendChild(videoEl);
                this.videoContainer.appendChild(wrap);
                if (this.userOpenedVideoPanel) {
                    this.videoPopup.style.display = 'flex';
                    this.updateSelfPreviewVisibility();
                }
                this.consumers.get(consumerId).videoEl = videoEl;
                this.consumers.get(consumerId).videoWrap = wrap;
            } else {
                const audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.srcObject = new MediaStream([consumer.track]);
                document.body.appendChild(audioEl);
                this.consumers.get(consumerId).audioEl = audioEl;
            }

            await this.emitAsync('video-vc-consumer-resume', { consumerId });
        } catch (error) {
        }
    }

    closeConsumersByProducerId(producerId) {
        const toClose = [];
        for (const [consumerId, data] of this.consumers) {
            if (data.consumer && data.consumer.producerId === producerId) {
                toClose.push(consumerId);
            }
        }
        toClose.forEach(id => this.closeConsumer(id));
    }

    closeConsumer(consumerId) {
        const data = this.consumers.get(consumerId);
        if (!data) return;
        if (data.videoWrap) data.videoWrap.remove();
        if (data.audioEl) data.audioEl.remove();
        if (data.consumer) {
            data.consumer.track.stop();
            data.consumer.close();
        }
        this.consumers.delete(consumerId);
        if (this.consumers.size === 0) {
            this.videoPopup.style.display = 'none';
            this.updateSelfPreviewVisibility();
        }
    }

    async startCamera({ deviceId, width, height, includeAudio }) {
        console.log('[Video VC] startCamera 呼び出し:', { deviceId, width, height, includeAudio });
        await this.stop();

        const { allowed, denied, reason } = await this.emitAsync('video-vc-set-video', { enabled: true });
        console.log('[Video VC] set-video レスポンス:', { allowed, denied, reason });
        if (denied) {
            throw new Error(reason || 'ビデオを開始できません');
        }

        const constraints = {
            video: {
                width: { ideal: width },
                height: { ideal: height },
            },
            audio: includeAudio,
        };
        if (deviceId) constraints.video.deviceId = { exact: deviceId };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('[Video VC] getUserMedia 成功:', stream.getTracks().map(t => ({kind: t.kind, enabled: t.enabled})));
        this.currentStream = stream;
        this.currentMode = 'camera';

        console.log('[Video VC] createSendTransport 開始...');
        await this.createSendTransport();
        console.log('[Video VC] createSendTransport 完了');

        const videoTrack = stream.getVideoTracks()[0];
        const videoProducer = await this.sendTransport.produce({ track: videoTrack });
        this.producers.set(videoProducer.id, videoProducer);

        if (includeAudio) {
            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
                const audioProducer = await this.sendTransport.produce({ track: audioTrack });
                this.producers.set(audioProducer.id, audioProducer);
            }
        }

        if (this.userOpenedVideoPanel) this.videoPopup.style.display = 'flex';
        this.showSelfPreview(stream);
    }

    async startScreenShare({ width, height, includeAudio, stream: existingStream }) {
        await this.stop();

        const { allowed, denied, reason } = await this.emitAsync('video-vc-set-video', { enabled: true });
        if (denied) {
            throw new Error(reason || '画面共有を開始できません');
        }

        let stream = existingStream;
        if (!stream) {
            const options = {
                video: { width: { ideal: width }, height: { ideal: height } },
                audio: includeAudio,
            };
            stream = await navigator.mediaDevices.getDisplayMedia(options);
        }
        this.currentStream = stream;
        this.currentMode = 'screen';

        stream.getVideoTracks()[0].onended = () => this.stop();

        await this.createSendTransport();

        const videoTrack = stream.getVideoTracks()[0];
        const videoProducer = await this.sendTransport.produce({ track: videoTrack });
        this.producers.set(videoProducer.id, videoProducer);

        if (includeAudio) {
            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
                const audioProducer = await this.sendTransport.produce({ track: audioTrack });
                this.producers.set(audioProducer.id, audioProducer);
            }
        }

        if (this.userOpenedVideoPanel) this.videoPopup.style.display = 'flex';
        this.showSelfPreview(stream);
    }

    showSelfPreview(stream) {
        if (!stream || !this.selfPreview || !this.selfPreviewVideo) return;
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) return;
        this.selfPreviewVideo.srcObject = new MediaStream([videoTrack]);
        this.selfPreviewVideo.play().catch(() => {});
        this.selfPreview.style.display = 'block';
        this.updateSelfPreviewVisibility();
    }

    hideSelfPreview() {
        if (this.selfPreview) this.selfPreview.style.display = 'none';
        if (this.selfPreviewVideo) this.selfPreviewVideo.srcObject = null;
    }

    updateSelfPreviewVisibility() {
        if (!this.selfPreview || this.selfPreview.style.display === 'none') return;
        const viewing = this.videoPopup.style.display === 'flex' || this.fullscreenOverlay.style.display === 'flex';
        this.selfPreview.style.visibility = viewing ? 'hidden' : 'visible';
    }

    async stop() {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach((t) => t.stop());
            this.currentStream = null;
        }
        this.currentMode = null;

        const hadProducers = this.producers.size > 0;
        if (hadProducers) {
            await this.emitAsync('video-vc-set-video', { enabled: false });
            for (const [id, p] of this.producers) {
                try { p.close(); } catch (e) { /* already closed */ }
            }
            this.producers.clear();
        }

        if (this.sendTransport) {
            this.sendTransport.close();
            this.sendTransport = null;
        }

        if (this.consumers.size === 0) {
            this.videoPopup.style.display = 'none';
        }
        this.hideSelfPreview();
    }

    /**
     * フルスクリーンオーバーレイで配信を大きく表示
     */
    showFullscreen() {
        this.fullscreenVideoWrap.innerHTML = '';
        const videoConsumers = [...this.consumers.values()].filter(d => d.videoEl);
        if (videoConsumers.length === 0) return;

        for (const { videoEl } of videoConsumers) {
            const clone = document.createElement('video');
            clone.autoplay = true;
            clone.playsInline = true;
            clone.muted = true;
            if (videoEl.srcObject) clone.srcObject = videoEl.srcObject;
            clone.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
            this.fullscreenVideoWrap.appendChild(clone);
            clone.play().catch(() => {});
        }
        if (document.fullscreenElement) document.exitFullscreen();
        this.fullscreenOverlay.style.display = 'flex';
        this.videoPopup.style.display = 'none';
        if (document.pointerLockElement) document.exitPointerLock();
        this.updateSelfPreviewVisibility();
    }

    /**
     * ミニプレイヤー表示に切り替え
     */
    showMiniPlayer() {
        if (document.fullscreenElement) document.exitFullscreen();
        this.fullscreenOverlay.style.display = 'none';
        this.videoPopup.style.display = 'flex';
        this.updateSelfPreviewVisibility();
    }

    /**
     * ブラウザ全画面のトグル
     */
    toggleBrowserFullscreen(element) {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            element.requestFullscreen().catch(() => {});
        }
    }

    updateBrowserFullscreenIcons() {
        const inFs = !!document.fullscreenElement;
        const icon = inFs ? 'bi-fullscreen-exit' : 'bi-fullscreen';
        const title = inFs ? '全画面の終了' : '全画面表示';
        (this.browserFsBtns || []).forEach(btn => {
            if (btn) {
                btn.innerHTML = `<i class="bi ${icon}"></i>`;
                btn.title = title;
            }
        });
    }

    /**
     * フルスクリーンを閉じ、全 consumer を切断
     */
    async closeFullscreenAndDisconnect() {
        if (document.fullscreenElement) document.exitFullscreen();
        this.fullscreenOverlay.style.display = 'none';
        this.fullscreenVideoWrap.innerHTML = '';

        for (const [id, data] of this.consumers) {
            if (data.videoWrap) data.videoWrap.remove();
            if (data.audioEl) data.audioEl.remove();
            if (data.consumer) {
                data.consumer.track.stop();
                data.consumer.close();
            }
        }
        this.consumers.clear();
        this.watchedPeerIds.clear();
        this.videoContainer.innerHTML = '';
        this.videoPopup.style.display = 'none';
        this.userOpenedVideoPanel = false;
        this.updateSelfPreviewVisibility();

        // サーバーに recv 無効化を通知 → サーバー側 recv transport を閉じてポート解放
        if (this.recvTransport && this.isJoined) {
            await this.emitAsync('video-vc-set-recv', { enabled: false });
            try { this.recvTransport.close(); } catch (e) { /* ignore */ }
            this.recvTransport = null;
        }
    }

    isVideoActive() {
        return this.currentMode !== null && this.producers.size > 0;
    }

    /**
     * ビデオ表示を開く（プレイヤー一覧の「視聴」ボタンから呼ばれる）
     * 指定 peerId の配信に接続し、フルスクリーン表示する
     * @param {string} peerId - 視聴するユーザーの socket id
     */
    async showVideoContainer(peerId) {
        console.log('[Video VC] showVideoContainer 呼び出し - peerId:', peerId, 'recvTransport:', !!this.recvTransport, 'isJoined:', this.isJoined);
        if (!peerId || !this.isJoined) {
            console.log('[Video VC] 条件不成立で終了');
            return;
        }

        // 視聴ボタン押下時に recv transport をオンデマンドで作成（ポートを節約）
        if (!this.recvTransport) {
            try {
                await this.createRecvTransport();
            } catch (e) {
                console.error('[Video VC] createRecvTransport 失敗:', e);
                return;
            }
        }

        this.userOpenedVideoPanel = true;
        this.watchedPeerIds.add(peerId);
        console.log('[Video VC] watchedPeerIds に追加:', Array.from(this.watchedPeerIds));

        const tryShowFullscreen = () => {
            const videoConsumers = [...this.consumers.values()].filter(d => d.videoEl);
            console.log('[Video VC] tryShowFullscreen - videoConsumers:', videoConsumers.length, '件');
            if (videoConsumers.length > 0) {
                console.log('[Video VC] フルスクリーン表示');
                this.showFullscreen();
                return;
            }
            console.log('[Video VC] パネル表示（ビデオなし）');
            this.videoPopup.style.display = 'flex';
            this.updateSelfPreviewVisibility();
        };

        this.emitAsync('video-vc-set-recv', { enabled: true }).then(async (res) => {
            if (res?.error) {
                console.log('[Video VC] set-recv エラー:', res.error);
                return tryShowFullscreen();
            }
            const existingProducers = res?.existingProducers || [];
            console.log('[Video VC] existingProducers 取得:', existingProducers.length, '件');
            const forPeer = existingProducers.filter(p => p.peerId === peerId);
            console.log('[Video VC] 対象 peer の producers:', forPeer.length, '件', forPeer);
            for (const { producerId, peerId: p, kind } of forPeer) {
                console.log('[Video VC] consume 開始 - producerId:', producerId, 'kind:', kind);
                await this.consume(producerId, p, kind);
            }
            console.log('[Video VC] consume 完了、フルスクリーン表示へ');
            tryShowFullscreen();
        });
    }
}

export default VideoChatManager;
