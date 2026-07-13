// public/js/admin-camera-recorder.js — カメラログイン: 写真撮影・動画録画と自動ダウンロード
/**
 * タイムスタンプ付きファイル名を生成
 * @param {string} prefix
 * @param {string} ext
 * @returns {string}
 */
function buildCaptureFilename(prefix, ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `${prefix}_${stamp}.${ext}`;
}

/**
 * Blob をブラウザでダウンロード
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 管理者カメラの撮影・録画 UI
 */
export class AdminCameraRecorder {
    /**
     * @param {{
     *   renderer: THREE.WebGLRenderer,
     *   scene: THREE.Scene,
     *   camera: THREE.PerspectiveCamera,
     *   hudRoot?: HTMLElement|null,
     *   flashEl?: HTMLElement|null,
     *   recIndicator?: HTMLElement|null,
     * }} opts
     */
    constructor(opts) {
        this.renderer = opts.renderer;
        this.scene = opts.scene;
        this.camera = opts.camera;
        this.hudRoot = opts.hudRoot || document.getElementById('admin-camera-hud');
        this.flashEl = opts.flashEl || document.getElementById('admin-camera-flash');
        this.recIndicator = opts.recIndicator || document.getElementById('admin-camera-rec-indicator');

        /** @type {'photo'|'video'} */
        this.mode = 'photo';
        /** @type {MediaRecorder|null} */
        this.mediaRecorder = null;
        /** @type {Blob[]} */
        this.recordedChunks = [];
        this.isRecording = false;

        this._photoBtn = document.getElementById('admin-camera-mode-photo');
        this._videoBtn = document.getElementById('admin-camera-mode-video');
        this._shutterBtn = document.getElementById('admin-camera-shutter');
        this._zoomSlider = document.getElementById('admin-camera-zoom');
        this._boundEnter = (e) => this.onEnterKey(e);

        this._wireUi();
    }

    _wireUi() {
        if (this.hudRoot) {
            this.hudRoot.style.display = 'flex';
            this.hudRoot.setAttribute('aria-hidden', 'false');
        }

        this._photoBtn?.addEventListener('click', () => this.setMode('photo'));
        this._videoBtn?.addEventListener('click', () => this.setMode('video'));
        this._shutterBtn?.addEventListener('click', () => {
            void this.capture();
        });

        document.addEventListener('keydown', this._boundEnter);
    }

    /**
     * @param {'photo'|'video'} mode
     */
    setMode(mode) {
        if (this.isRecording) return;
        this.mode = mode === 'video' ? 'video' : 'photo';
        this._photoBtn?.classList.toggle('active', this.mode === 'photo');
        this._videoBtn?.classList.toggle('active', this.mode === 'video');
        if (this._shutterBtn) {
            this._shutterBtn.textContent = this.mode === 'video' ? '録画 (Enter)' : '撮影 (Enter)';
        }
    }

    /**
     * @param {(factor: number) => void} onZoom
     */
    bindZoomSlider(onZoom) {
        if (!this._zoomSlider || typeof onZoom !== 'function') return;
        const valueEl = document.getElementById('admin-camera-zoom-value');
        const updateLabel = (v) => {
            if (valueEl) valueEl.textContent = `${v.toFixed(1)}×`;
        };
        this._zoomSlider.addEventListener('input', () => {
            const v = parseFloat(this._zoomSlider.value);
            if (Number.isFinite(v)) {
                onZoom(v);
                updateLabel(v);
            }
        });
        updateLabel(parseFloat(this._zoomSlider.value) || 1);
    }

    /**
     * @param {KeyboardEvent} e
     */
    onEnterKey(e) {
        if (e.code !== 'Enter' || e.repeat) return;
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        e.preventDefault();
        void this.capture();
    }

    /** シャッター演出 */
    async playShutterFlash() {
        if (!this.flashEl) return;
        this.flashEl.hidden = false;
        this.flashEl.classList.add('admin-camera-flash-active');
        await new Promise((r) => setTimeout(r, 120));
        this.flashEl.classList.remove('admin-camera-flash-active');
        this.flashEl.hidden = true;
    }

    /**
     * Enter / シャッターボタン
     */
    async capture() {
        if (this.mode === 'photo') {
            await this.capturePhoto();
            return;
        }
        if (this.isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    /** 現在フレームを PNG 保存 */
    async capturePhoto() {
        await this.playShutterFlash();
        this.renderer.render(this.scene, this.camera);
        const canvas = this.renderer.domElement;
        await new Promise((resolve) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    downloadBlob(blob, buildCaptureFilename('metaverse-photo', 'png'));
                }
                resolve();
            }, 'image/png');
        });
    }

    /** キャンバスから動画録画開始 */
    startRecording() {
        if (this.isRecording) return;
        const canvas = this.renderer.domElement;
        const stream = canvas.captureStream(30);
        const mimeCandidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
        ];
        let mimeType = '';
        for (const m of mimeCandidates) {
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
                mimeType = m;
                break;
            }
        }
        try {
            this.mediaRecorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);
        } catch (err) {
            console.error('[Camera] MediaRecorder failed:', err);
            return;
        }

        this.recordedChunks = [];
        this.mediaRecorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) this.recordedChunks.push(ev.data);
        };
        this.mediaRecorder.onstop = () => {
            const type = this.mediaRecorder?.mimeType || 'video/webm';
            const blob = new Blob(this.recordedChunks, { type });
            const ext = type.includes('webm') ? 'webm' : 'mp4';
            downloadBlob(blob, buildCaptureFilename('metaverse-video', ext));
            this.recordedChunks = [];
        };

        this.mediaRecorder.start(200);
        this.isRecording = true;
        if (this.recIndicator) this.recIndicator.hidden = false;
        if (this._shutterBtn) this._shutterBtn.textContent = '停止 (Enter)';
        void this.playShutterFlash();
    }

    /** 録画停止して自動ダウンロード */
    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        this.isRecording = false;
        if (this.recIndicator) this.recIndicator.hidden = true;
        if (this._shutterBtn) this._shutterBtn.textContent = '録画 (Enter)';
        try {
            this.mediaRecorder.stop();
        } catch (err) {
            console.warn('[Camera] stop recording:', err);
        }
        this.mediaRecorder = null;
        void this.playShutterFlash();
    }

    dispose() {
        if (this.isRecording) this.stopRecording();
        document.removeEventListener('keydown', this._boundEnter);
        if (this.hudRoot) {
            this.hudRoot.style.display = 'none';
            this.hudRoot.setAttribute('aria-hidden', 'true');
        }
    }
}

export default AdminCameraRecorder;
