/**
 * MenuManager - メニューバーと設定管理
 */
class MenuManager {
    constructor() {
        // Menu buttons
        this.micBtn = document.getElementById('mic-btn');
        this.speakerBtn = document.getElementById('speaker-btn');
        this.stampBtn = document.getElementById('stamp-btn');
        this.videoBtn = document.getElementById('video-btn');
        this.settingsBtn = document.getElementById('settings-btn');
        this.logoutBtn = document.getElementById('logout-btn');
        
        // Modals
        this.logoutModal = document.getElementById('logout-modal');
        this.returnToLobbyBtn = document.getElementById('return-to-lobby-btn');
        this.logoutConfirmBtn = document.getElementById('logout-confirm-btn');
        this.onReturnToLobbyCallback = null;
        
        this.settingsModal = document.getElementById('settings-modal');
        this.settingsCloseBtn = document.getElementById('settings-close-btn');
        
        this.videoModal = document.getElementById('video-modal');
        this.videoModalCloseBtn = document.getElementById('video-modal-close-btn');
        this.videoStartBtn = document.getElementById('video-start-btn');
        this.videoStopBtn = document.getElementById('video-stop-btn');
        this.videoErrorEl = document.getElementById('video-modal-error');
        
        // Icons
        this.micIcon = document.getElementById('mic-icon');
        this.speakerIcon = document.getElementById('speaker-icon');
        
        // State (default: mic OFF, speaker ON)
        this.isMicMuted = true;
        this.isSpeakerMuted = false;
        
        // VoiceChat manager reference
        this.voiceChatManager = null;
        this.videoChatManager = null;
        this.previewStream = null;
        this.settingsAnalyzerStream = null;
        this.settingsAnalyzerInterval = null;
        this.settingsAudioContext = null;
        this.settingsMicTestGainNode = null;

        // Settings
        this.settings = {
            language: 'ja',
            micVolume: 33, // 0=0%, 33=100%等倍, 100=300%
            speakerVolume: 50,
            micDevice: '',
            speakerDevice: ''
        };
        
        this.init();
    }
    
    init() {
        this.loadSettings();
        this.setupEventListeners();
        this.setupVideoEventListeners();
        this.updateSettingsUI();
        this.updateButtonStates();
        this.loadAudioDevices();
        this.loadVideoDevices();
    }
    
    setVoiceChatManager(voiceChatManager) {
        this.voiceChatManager = voiceChatManager;

        if (voiceChatManager) {
            if (this.settings.micDevice) voiceChatManager.setMicDevice(this.settings.micDevice);
            if (this.settings.speakerDevice) voiceChatManager.setSpeakerDevice(this.settings.speakerDevice);
            voiceChatManager.setMicVolume(this.settings.micVolume);
        }
    }
    
    setVideoChatManager(videoChatManager) {
        this.videoChatManager = videoChatManager;
    }

    /**
     * 退出モーダルで「ロビーに戻る」を選んだときに呼ばれるコールバックを登録する
     * @param {function} callback - ロビーに戻る処理（例: worldManager.loadWorld('lobby')）
     */
    setReturnToLobbyCallback(callback) {
        this.onReturnToLobbyCallback = callback;
    }
    
    async loadVideoDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameraSelect = document.getElementById('video-camera-device');
            if (!cameraSelect) return;
            cameraSelect.innerHTML = '<option value="">デフォルト</option>';
            devices.forEach(device => {
                if (device.kind === 'videoinput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.textContent = device.label || `カメラ ${cameraSelect.options.length}`;
                    cameraSelect.appendChild(option);
                }
            });
        } catch (error) {
            console.error('[Menu] Failed to load video devices:', error);
        }
    }
    
    setupVideoEventListeners() {
        if (!this.videoBtn) return;
        this.videoBtn.addEventListener('click', () => this.openVideoModal());
        this.videoModalCloseBtn?.addEventListener('click', () => this.closeVideoModal());
        this.videoModal?.addEventListener('click', (e) => {
            if (e.target === this.videoModal) this.closeVideoModal();
        });
        
        document.querySelectorAll('input[name="video-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const mode = e.target.value;
                document.getElementById('video-camera-options').style.display = mode === 'camera' ? 'block' : 'none';
                document.getElementById('video-screen-options').style.display = mode === 'screen' ? 'block' : 'none';
                this.updateVideoPreview();
            });
        });
        
        this.videoStartBtn?.addEventListener('click', () => this.startVideo());
        this.videoStopBtn?.addEventListener('click', () => this.stopVideo());

        document.getElementById('video-camera-device')?.addEventListener('change', () => this.updateVideoPreview());
        document.getElementById('video-camera-resolution')?.addEventListener('change', () => this.updateVideoPreview());
        document.getElementById('video-screen-resolution')?.addEventListener('change', () => this.updateVideoPreview());
    }
    
    openVideoModal() {
        this.videoModal?.classList.add('visible');
        this.videoErrorEl.style.display = 'none';
        const mode = document.querySelector('input[name="video-mode"]:checked')?.value || 'camera';
        document.getElementById('video-camera-options').style.display = mode === 'camera' ? 'block' : 'none';
        document.getElementById('video-screen-options').style.display = mode === 'screen' ? 'block' : 'none';
        const isActive = this.videoChatManager?.isVideoActive();
        this.videoStartBtn.style.display = isActive ? 'none' : 'block';
        this.videoStopBtn.style.display = isActive ? 'block' : 'none';
        this.updateVideoPreview();
    }

    /** 配信プレビューを更新（カメラモード時はライブプレビュー、画面共有時は設定要約） */
    async updateVideoPreview() {
        const wrap = document.getElementById('video-preview-wrap');
        const video = document.getElementById('video-preview');
        const placeholder = document.getElementById('video-preview-placeholder');
        if (!wrap || !video || !placeholder) return;

        await this.stopPreviewStream();

        const mode = document.querySelector('input[name="video-mode"]:checked')?.value || 'camera';
        if (mode === 'camera') {
            const res = document.getElementById('video-camera-resolution')?.value || '360p';
            const resMap = { '360p': [640, 360], '480p': [854, 480], '540p': [960, 540], '720p': [1280, 720] };
            const [w, h] = resMap[res] || [640, 360];
            const deviceId = document.getElementById('video-camera-device')?.value || undefined;
            const constraints = { video: { width: { ideal: w }, height: { ideal: h } } };
            if (deviceId) constraints.video.deviceId = { exact: deviceId };
            try {
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                this.previewStream = stream;
                video.srcObject = stream;
                video.style.display = 'block';
                placeholder.style.display = 'none';
            } catch (e) {
                video.style.display = 'none';
                placeholder.textContent = 'カメラにアクセスできません';
                placeholder.style.display = 'block';
            }
        } else {
            if (this.videoChatManager?.isVideoActive() && this.videoChatManager.currentMode === 'screen') {
                const stream = this.videoChatManager.currentStream;
                const videoTrack = stream?.getVideoTracks()[0];
                if (videoTrack) {
                    video.srcObject = new MediaStream([videoTrack]);
                    video.style.display = 'block';
                    placeholder.style.display = 'none';
                } else {
                    video.style.display = 'none';
                    placeholder.textContent = '配信中';
                    placeholder.style.display = 'block';
                }
                return;
            }
            const res = document.getElementById('video-screen-resolution')?.value || '360p';
            const resMap = { '360p': [640, 360], '480p': [854, 480], '540p': [960, 540], '720p': [1280, 720] };
            const [w, h] = resMap[res] || [640, 360];
            const options = {
                video: { width: { ideal: w }, height: { ideal: h } },
                audio: false
            };
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia(options);
                this.previewStream = stream;
                video.srcObject = stream;
                video.style.display = 'block';
                placeholder.style.display = 'none';
                stream.getVideoTracks()[0]?.addEventListener('ended', () => {
                    this.stopPreviewStream();
                    video.style.display = 'none';
                    placeholder.textContent = '画面共有が終了しました';
                    placeholder.style.display = 'block';
                });
            } catch (e) {
                video.style.display = 'none';
                placeholder.textContent = e.name === 'NotAllowedError' ? '画面共有がキャンセルされました' : '画面の取得に失敗しました';
                placeholder.style.display = 'block';
            }
        }
    }

    /** プレビュー用ストリームを停止 */
    async stopPreviewStream() {
        if (this.previewStream) {
            this.previewStream.getTracks().forEach(t => t.stop());
            this.previewStream = null;
        }
        const video = document.getElementById('video-preview');
        if (video) {
            video.srcObject = null;
        }
    }

    closeVideoModal() {
        this.stopPreviewStream();
        this.videoModal?.classList.remove('visible');
    }

    
    async startVideo() {
        if (!this.videoChatManager) return;
        this.videoErrorEl.style.display = 'none';
        const mode = document.querySelector('input[name="video-mode"]:checked')?.value || 'camera';
        const reuseStream = mode === 'screen' && this.previewStream;
        if (!reuseStream) await this.stopPreviewStream();
        const resolution = mode === 'camera'
            ? document.getElementById('video-camera-resolution').value
            : document.getElementById('video-screen-resolution').value;
        const { width, height } = { '360p': { width: 640, height: 360 }, '480p': { width: 854, height: 480 }, '540p': { width: 960, height: 540 }, '720p': { width: 1280, height: 720 } }[resolution] || { width: 640, height: 360 };

        try {
            if (mode === 'camera') {
                const deviceId = document.getElementById('video-camera-device').value || undefined;
                const includeAudio = document.getElementById('video-camera-audio').checked;
                await this.videoChatManager.startCamera({ deviceId, width, height, includeAudio });
            } else {
                await this.videoChatManager.startScreenShare({
                    width,
                    height,
                    includeAudio: false,
                    stream: reuseStream || undefined
                });
                if (reuseStream) {
                    this.previewStream = null;
                }
            }
            this.videoStartBtn.style.display = 'none';
            this.videoStopBtn.style.display = 'block';
            this.videoBtn?.classList.add('active');
        } catch (error) {
            this.videoErrorEl.textContent = error.message || 'ビデオの開始に失敗しました';
            this.videoErrorEl.style.display = 'block';
        }
    }
    
    async stopVideo() {
        if (!this.videoChatManager) return;
        try {
            await this.videoChatManager.stop();
            this.videoStartBtn.style.display = 'block';
            this.videoStopBtn.style.display = 'none';
            this.videoBtn?.classList.remove('active');
        } catch (error) {
            console.error('[Menu] Failed to stop video:', error);
        }
    }
    
    async loadAudioDevices() {
        try {
            // Request permission first
            await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            
            // Get device list
            const devices = await navigator.mediaDevices.enumerateDevices();
            
            // Populate mic devices
            const micSelect = document.getElementById('micDevice');
            const speakerSelect = document.getElementById('speakerDevice');
            
            // Clear existing options (keep default)
            micSelect.innerHTML = '<option value="">デフォルト</option>';
            speakerSelect.innerHTML = '<option value="">デフォルト</option>';
            
            devices.forEach(device => {
                if (device.kind === 'audioinput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.textContent = device.label || `マイク ${micSelect.options.length}`;
                    micSelect.appendChild(option);
                } else if (device.kind === 'audiooutput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.textContent = device.label || `スピーカー ${speakerSelect.options.length}`;
                    speakerSelect.appendChild(option);
                }
            });
            
            // Restore saved selections
            if (this.settings.micDevice) {
                micSelect.value = this.settings.micDevice;
            }
            if (this.settings.speakerDevice) {
                speakerSelect.value = this.settings.speakerDevice;
            }
            
            console.log('[Menu] Audio devices loaded');
        } catch (error) {
            console.error('[Menu] Failed to load audio devices:', error);
        }
    }
    
    updateButtonStates() {
        // Update mic button to show muted state initially
        if (this.isMicMuted) {
            this.micBtn.classList.add('muted');
            this.micIcon.innerHTML = `
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
            `;
        }
    }
    
    setupEventListeners() {
        // Mic button
        this.micBtn.addEventListener('click', () => this.toggleMic());
        
        // Speaker button
        this.speakerBtn.addEventListener('click', () => this.toggleSpeaker());
        
        // Settings button
        this.settingsBtn.addEventListener('click', () => this.openSettings());
        this.settingsCloseBtn.addEventListener('click', () => this.closeSettings());
        
        // Exit button (退出: ロビーに戻る / ログアウト選択)
        this.logoutBtn.addEventListener('click', () => this.openLogoutModal());
        this.returnToLobbyBtn.addEventListener('click', () => this.returnToLobby());
        this.logoutConfirmBtn.addEventListener('click', () => this.logout());
        
        // Close modals on background click
        this.logoutModal.addEventListener('click', (e) => {
            if (e.target === this.logoutModal) {
                this.closeLogoutModal();
            }
        });
        
        this.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) {
                this.closeSettings();
            }
        });
        
        // Settings tabs
        const categoryButtons = document.querySelectorAll('.settings-category');
        categoryButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.getAttribute('data-section');
                this.switchSettingsSection(section);
            });
        });
        
        // Settings inputs
        document.getElementById('language').addEventListener('change', (e) => {
            this.settings.language = e.target.value;
            this.saveSettings();
        });
        
        document.getElementById('micVolume').addEventListener('input', (e) => {
            this.settings.micVolume = parseInt(e.target.value);
            document.getElementById('micVolumeValue').textContent = this.settings.micVolume * 3; // 0%〜300%表示
            this.saveSettings();
            if (this.voiceChatManager) this.voiceChatManager.setMicVolume(this.settings.micVolume);
            // マイクテスト中はリアルタイムでgainを反映
            if (this.settingsMicTestGainNode) {
                this.settingsMicTestGainNode.gain.value = (this.settings.micVolume / 100) * 3;
            }
        });
        
        document.getElementById('speakerVolume').addEventListener('input', (e) => {
            this.settings.speakerVolume = parseInt(e.target.value);
            document.getElementById('speakerVolumeValue').textContent = this.settings.speakerVolume;
            this.saveSettings();
        });
        
        document.getElementById('micDevice').addEventListener('change', (e) => {
            this.settings.micDevice = e.target.value;
            this.saveSettings();
            if (this.settingsAnalyzerInterval) this.stopMicTest();

            // Update VoiceChatManager
            if (this.voiceChatManager) {
                this.voiceChatManager.setMicDevice(e.target.value);

                if (this.voiceChatManager.isMicEnabled) {
                    this.showDeviceChangeNotification('マイクデバイスを変更しました。マイクを一度OFFにしてから再度ONにしてください。');
                }
            }
        });
        
        document.getElementById('mic-test-btn')?.addEventListener('click', () => {
            if (this.settingsAnalyzerInterval) this.stopMicTest();
            else this.startMicTest();
        });

        document.getElementById('speakerDevice').addEventListener('change', (e) => {
            this.settings.speakerDevice = e.target.value;
            this.saveSettings();
            
            // Update VoiceChatManager
            if (this.voiceChatManager) {
                this.voiceChatManager.setSpeakerDevice(e.target.value);
            }
        });

        // ESC key to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.settingsModal?.classList.contains('visible')) {
                    this.closeSettings();
                }
                if (this.logoutModal?.classList.contains('visible')) {
                    this.closeLogoutModal();
                }
                if (this.videoModal?.classList.contains('visible')) {
                    this.closeVideoModal();
                }
            }
        });
    }
    
    async toggleMic() {
        const newMutedState = !this.isMicMuted;
        
        // Call VoiceChat manager if available
        if (this.voiceChatManager) {
            const success = await this.voiceChatManager.setMicEnabled(!newMutedState);
            if (!success && !newMutedState) {
                // Failed to enable mic (probably max 10 limit)
                return;
            }
        }
        
        this.isMicMuted = newMutedState;
        
        if (this.isMicMuted) {
            this.micBtn.classList.add('muted');
            this.micIcon.innerHTML = `
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
            `;
            console.log('Microphone muted');
        } else {
            this.micBtn.classList.remove('muted');
            this.micIcon.innerHTML = `
                <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
            `;
            console.log('Microphone unmuted');
        }
    }
    
    async toggleSpeaker() {
        const newMutedState = !this.isSpeakerMuted;
        
        // Call VoiceChat manager if available
        if (this.voiceChatManager) {
            await this.voiceChatManager.setSpeakerEnabled(!newMutedState);
        }
        
        this.isSpeakerMuted = newMutedState;
        
        if (this.isSpeakerMuted) {
            this.speakerBtn.classList.add('muted');
            this.speakerIcon.innerHTML = `
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.20.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            `;
            console.log('Speaker muted');
        } else {
            this.speakerBtn.classList.remove('muted');
            this.speakerIcon.innerHTML = `
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            `;
            console.log('Speaker unmuted');
        }
    }
    
    openLogoutModal() {
        this.logoutModal.classList.add('visible');
    }
    
    closeLogoutModal() {
        this.logoutModal.classList.remove('visible');
    }

    /**
     * 退出モーダルで「ロビーに戻る」を実行。モーダルを閉じ、登録済みコールバックを呼ぶ。
     */
    returnToLobby() {
        this.closeLogoutModal();
        if (typeof this.onReturnToLobbyCallback === 'function') {
            this.onReturnToLobbyCallback();
        }
    }
    
    logout() {
        localStorage.removeItem('username');
        localStorage.removeItem('userRole');
        sessionStorage.removeItem('metaverseAdminToken');
        window.location.href = window.location.pathname === '/admin' ? '/admin.html' : '/login/';
    }
    
    openSettings() {
        this.settingsModal.classList.add('visible');
        this.ensureMicAnalyzerSegments();
    }

    closeSettings() {
        this.stopMicTest();
        this.settingsModal.classList.remove('visible');
    }

    switchSettingsSection(sectionName) {
        const wasAudio = document.getElementById('audio-section')?.classList.contains('active');
        const willBeAudio = sectionName === 'audio';

        document.querySelectorAll('.settings-category').forEach(cat => {
            cat.classList.remove('active');
        });
        document.querySelector(`[data-section="${sectionName}"]`)?.classList.add('active');

        document.querySelectorAll('.settings-section').forEach(sec => {
            sec.classList.remove('active');
        });
        document.getElementById(`${sectionName}-section`)?.classList.add('active');

        if (wasAudio && !willBeAudio) this.stopMicTest();
        if (willBeAudio) this.ensureMicAnalyzerSegments();
    }

    /** マイクアナライザーの40セグメントを生成 */
    ensureMicAnalyzerSegments() {
        const container = document.getElementById('settings-mic-analyzer');
        if (!container || container.children.length > 0) return;
        for (let i = 0; i < 40; i++) {
            const seg = document.createElement('div');
            seg.className = 'mic-analyzer-segment';
            seg.dataset.idx = i;
            container.appendChild(seg);
        }
    }

    /** マイクテスト開始。サーバー経由ループバック可能ならそれを使用（他者と同経路）、できなければローカル再生 */
    async startMicTest() {
        this.stopMicTest();
        const btn = document.getElementById('mic-test-btn');
        const statusEl = document.getElementById('mic-test-status');
        const segments = document.querySelectorAll('#settings-mic-analyzer .mic-analyzer-segment');
        if (!btn || !statusEl || !segments.length) return;

        try {
            const deviceId = document.getElementById('micDevice')?.value || undefined;
            const constraints = deviceId
                ? { audio: { deviceId: { exact: deviceId } } }
                : { audio: true };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.settingsAnalyzerStream = stream;

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.settingsAudioContext = audioContext;
            if (audioContext.state === 'suspended') await audioContext.resume();

            const source = audioContext.createMediaStreamSource(stream);
            const gainNode = audioContext.createGain();
            const micVol = parseInt(document.getElementById('micVolume')?.value ?? 33);
            gainNode.gain.value = (micVol / 100) * 3; // 0%〜300%
            this.settingsMicTestGainNode = gainNode;
            source.connect(gainNode);

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            gainNode.connect(analyser);

            const destination = audioContext.createMediaStreamDestination();
            gainNode.connect(destination);
            const streamToSend = destination.stream;

            const useServerLoopback = this.voiceChatManager && await this.voiceChatManager.startMicTestLoopback(streamToSend);
            if (!useServerLoopback) {
                gainNode.connect(audioContext.destination);
            }
            this.settingsMicTestUseServerLoopback = useServerLoopback;

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const colors = ['#f97316', '#ea580c', '#f59e0b', '#eab308', '#facc15', '#a3e635', '#84cc16', '#22c55e', '#16a34a'];

            btn.textContent = 'テストを中止';
            btn.classList.add('stop');
            statusEl.textContent = useServerLoopback ? '声を再生中です（サーバー経由）' : '声を再生中です';

            this.settingsAnalyzerInterval = setInterval(() => {
                const vol = parseInt(document.getElementById('micVolume')?.value ?? 33);
                if (this.settingsMicTestGainNode) this.settingsMicTestGainNode.gain.value = (vol / 100) * 3;
                analyser.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
                const level = Math.min(40, Math.floor((average / 160) * 40));
                segments.forEach((seg, i) => {
                    if (i < level) {
                        seg.classList.add('active');
                        seg.style.background = colors[Math.min(Math.floor((i / 40) * colors.length), colors.length - 1)];
                        seg.style.opacity = '1';
                    } else {
                        seg.classList.remove('active');
                        seg.style.background = '#e2e8f0';
                    }
                });
            }, 60);
        } catch (e) {
            statusEl.textContent = 'マイクにアクセスできません';
        }
    }

    stopMicTest() {
        if (this.settingsMicTestUseServerLoopback && this.voiceChatManager) {
            this.voiceChatManager.stopMicTestLoopback();
            this.settingsMicTestUseServerLoopback = false;
        }
        if (this.settingsAnalyzerInterval) {
            clearInterval(this.settingsAnalyzerInterval);
            this.settingsAnalyzerInterval = null;
        }
        if (this.settingsAnalyzerStream) {
            this.settingsAnalyzerStream.getTracks().forEach(t => t.stop());
            this.settingsAnalyzerStream = null;
        }
        this.settingsMicTestGainNode = null;
        if (this.settingsAudioContext) {
            this.settingsAudioContext.close();
            this.settingsAudioContext = null;
        }
        const btn = document.getElementById('mic-test-btn');
        const statusEl = document.getElementById('mic-test-status');
        const segments = document.querySelectorAll('#settings-mic-analyzer .mic-analyzer-segment');
        if (btn) {
            btn.textContent = 'テストを開始';
            btn.classList.remove('stop');
        }
        if (statusEl) statusEl.textContent = '';
        segments.forEach(seg => {
            seg.classList.remove('active');
            seg.style.background = '#e2e8f0';
        });
    }
    
    loadSettings() {
        const saved = localStorage.getItem('metaverse-settings');
        if (saved) {
            try {
                this.settings = { ...this.settings, ...JSON.parse(saved) };
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        }
    }
    
    saveSettings() {
        localStorage.setItem('metaverse-settings', JSON.stringify(this.settings));
    }
    
    updateSettingsUI() {
        document.getElementById('language').value = this.settings.language;
        document.getElementById('micVolume').value = this.settings.micVolume;
        document.getElementById('speakerVolume').value = this.settings.speakerVolume;
        document.getElementById('micVolumeValue').textContent = this.settings.micVolume * 3; // 倍率0%〜300%
        document.getElementById('speakerVolumeValue').textContent = this.settings.speakerVolume;

        if (this.settings.micDevice) {
            document.getElementById('micDevice').value = this.settings.micDevice;
        }
        if (this.settings.speakerDevice) {
            document.getElementById('speakerDevice').value = this.settings.speakerDevice;
        }
    }
    
    showDeviceChangeNotification(message) {
        // Create notification
        const notification = document.createElement('div');
        notification.className = 'device-change-notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            padding: 15px 20px;
            background: #3498db;
            color: white;
            border-radius: 5px;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            max-width: 300px;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.transition = 'opacity 0.3s';
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 4000);
    }
}

export default MenuManager;
