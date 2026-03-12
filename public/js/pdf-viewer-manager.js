/**
 * PdfViewerManager - Full-screen PDF viewer when near a PDF object (E key).
 * Gray overlay, × close, zoom via wheel, pan via left-drag, pen mode with shared red lines (5s then 1s fade).
 */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.15;
const PEN_FADE_START_MS = 5000;
const PEN_FADE_DURATION_MS = 1000;

export default class PdfViewerManager {
    constructor() {
        this.overlay = null;
        this.closeBtn = null;
        this.content = null;
        this.canvasWrap = null;
        this.canvas = null;
        this.drawCanvas = null;
        this.penBtn = null;
        this.pdfPath = null;
        this.pdfDoc = null;
        this.currentPage = 1;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this.isPenMode = false;
        this._lastClientX = 0;
        this._lastClientY = 0;
        this.pdfjsLib = null;
        this.socket = null;
        this.penLineWidth = 3;
        /** @type {{ points: {x:number,y:number}[], drawnAt: number, id?: string, lineWidth?: number }[]} */
        this.penLines = [];
        this._currentLine = null;
        this._drawAnimId = null;
        this._boundPdfDraw = null;
        this._boundWheel = null;
        this._boundKeyDown = null;
        this._boundMouseDown = null;
        this._boundMouseMove = null;
        this._boundMouseUp = null;
        this._boundTouchStart = null;
        this._boundTouchMove = null;
        this._boundTouchEnd = null;
        /** 1本指パン/ペン用タッチ識別子 */
        this._touchId = null;
        /** 2本指ピンチ・2本指パン用 */
        this._pinchStartDistance = null;
        this._pinchStartZoom = null;
        this._pinchStartCenter = null;   // { x, y } 2本指の中心
        this._pinchStartPanX = null;
        this._pinchStartPanY = null;
        /** @type {(() => void | Promise<void>) | null} */
        this.onClose = null;
        /** @type {import('./pdf-viewer-voice-chat-manager.js').default | null} */
        this.pdfViewerVoiceChatManager = null;
    }

    setSocket(socket) {
        this.socket = socket;
    }

    setOnClose(callback) {
        this.onClose = callback;
    }

    setPdfViewerVoiceChatManager(manager) {
        this.pdfViewerVoiceChatManager = manager;
    }

    init() {
        this.overlay = document.getElementById('pdf-viewer-overlay');
        this.closeBtn = document.getElementById('pdf-viewer-close');
        this.content = document.getElementById('pdf-viewer-content');
        this.canvasWrap = document.getElementById('pdf-viewer-canvas-wrap');
        this.canvas = document.getElementById('pdf-viewer-canvas');
        this.drawCanvas = document.getElementById('pdf-viewer-draw-canvas');
        this.penBtn = document.getElementById('pdf-viewer-pen-btn');
        this.penSampleLine = document.getElementById('pdf-viewer-pen-sample-line');
        this.penThicknessSlider = document.getElementById('pdf-viewer-pen-thickness');
        this.pdfMicBtn = document.getElementById('pdf-viewer-mic-btn');
        this.pdfSpeakerBtn = document.getElementById('pdf-viewer-speaker-btn');
        if (!this.overlay || !this.canvas) return;

        this.closeBtn.addEventListener('click', () => this.close());
        this.penBtn.addEventListener('click', () => this.togglePenMode());
        if (this.pdfMicBtn) {
            this.pdfMicBtn.addEventListener('click', () => this.togglePdfVcMic());
        }
        if (this.pdfSpeakerBtn) {
            this.pdfSpeakerBtn.addEventListener('click', () => this.togglePdfVcSpeaker());
        }
        if (this.penThicknessSlider) {
            this.penThicknessSlider.addEventListener('input', () => {
                this.penLineWidth = Math.max(1, Math.min(20, Number(this.penThicknessSlider.value) || 3));
                this.updatePenSample();
            });
        }
        this._boundKeyDown = (e) => {
            if (e.key === 'Escape') this.close();
        };
        this._boundWheel = (e) => this.onWheel(e);
        this._boundMouseDown = (e) => this.onPanStart(e);
        this._boundMouseMove = (e) => this.onPanMove(e);
        this._boundMouseUp = () => this.onPanEnd();
        this._boundPdfDraw = (data) => this.onPdfDraw(data);
        // モバイル: タッチでペン描画・パン・2本指ピンチズーム
        this._boundTouchStart = (e) => this.onTouchStart(e);
        this._boundTouchMove = (e) => this.onTouchMove(e);
        this._boundTouchEnd = (e) => this.onTouchEnd(e);
    }

    _touchDistance(touches) {
        if (!touches || touches.length < 2) return 0;
        const a = touches[0];
        const b = touches[1];
        return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    }

    /** 2本指の中心座標（ピンチ時のパン用） */
    _touchCenter(touches) {
        if (!touches || touches.length < 2) return null;
        const a = touches[0];
        const b = touches[1];
        return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }

    onTouchStart(e) {
        if (!this.isOpen()) return;
        const n = e.touches.length;
        if (n === 2) {
            this._touchId = null;
            this._pinchStartDistance = this._touchDistance(e.touches);
            this._pinchStartZoom = this.zoom;
            this._pinchStartCenter = this._touchCenter(e.touches);
            this._pinchStartPanX = this.panX;
            this._pinchStartPanY = this.panY;
            e.preventDefault();
            return;
        }
        if (n === 1 && e.changedTouches.length > 0) {
            const t = e.changedTouches[0];
            const target = e.target;
            // 右側サイドバー・閉じるボタンはタップで操作できるよう、キャンバス領域のみパン/描画に使う
            const inCanvasArea = this.canvasWrap && this.canvasWrap.contains(target);
            if (!inCanvasArea) return;
            this._touchId = t.identifier;
            if (this.isPenMode) {
                // ペンモード: パンは使わず描画のみ。1本指で必ず線を開始する
                const pt = this.clientToDrawCanvas(t.clientX, t.clientY);
                if (pt && this.drawCanvas) {
                    const x = Math.max(0, Math.min(this.drawCanvas.width, pt.x));
                    const y = Math.max(0, Math.min(this.drawCanvas.height, pt.y));
                    this._currentLine = [{ x, y }];
                }
                e.preventDefault();
                return;
            }
            this.onPanStart({ clientX: t.clientX, clientY: t.clientY, button: 0 });
            e.preventDefault();
        }
    }

    onTouchMove(e) {
        if (!this.isOpen()) return;
        const n = e.touches.length;
        if (n === 2 && this._pinchStartDistance != null && this._pinchStartDistance > 0 && this._pinchStartCenter) {
            const dist = this._touchDistance(e.touches);
            const ratio = dist / this._pinchStartDistance;
            this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._pinchStartZoom * ratio));
            const center = this._touchCenter(e.touches);
            if (center) {
                this.panX = this._pinchStartPanX + (center.x - this._pinchStartCenter.x);
                this.panY = this._pinchStartPanY + (center.y - this._pinchStartCenter.y);
            }
            this.applyTransform();
            e.preventDefault();
            return;
        }
        if (n === 1 && this._touchId != null) {
            const t = Array.from(e.touches).find((x) => x.identifier === this._touchId);
            if (t) {
                this.onPanMove({ clientX: t.clientX, clientY: t.clientY });
                e.preventDefault();
            }
        }
    }

    onTouchEnd(e) {
        if (!this.isOpen()) return;
        const n = e.touches.length;
        const inGesture = this.isPanning || this._currentLine != null;
        if (n < 2) {
            this._pinchStartDistance = null;
            this._pinchStartZoom = null;
            this._pinchStartCenter = null;
            this._pinchStartPanX = null;
            this._pinchStartPanY = null;
        }
        if (e.changedTouches.length > 0) {
            const ourTouch = Array.from(e.changedTouches).find((x) => x.identifier === this._touchId);
            if (ourTouch) {
                this.onPanEnd();
                this._touchId = null;
            }
            if (inGesture) e.preventDefault();
        }
    }

    togglePenMode() {
        this.isPenMode = !this.isPenMode;
        if (this.penBtn) this.penBtn.classList.toggle('active', this.isPenMode);
        if (this.content) this.content.classList.toggle('pdf-viewer-pen-mode', this.isPenMode);
        this._currentLine = null;
    }

    async togglePdfVcMic() {
        const vc = this.pdfViewerVoiceChatManager;
        if (!vc) return;
        const next = !vc.isMicEnabled;
        const ok = await vc.setMicEnabled(next);
        if (this.pdfMicBtn) {
            this.pdfMicBtn.classList.toggle('active', vc.isMicEnabled);
            this.pdfMicBtn.classList.toggle('muted', !vc.isMicEnabled);
            this.updatePdfMicIcon(vc.isMicEnabled);
        }
    }

    async togglePdfVcSpeaker() {
        const vc = this.pdfViewerVoiceChatManager;
        if (!vc) return;
        const next = !vc.isSpeakerEnabled;
        await vc.setSpeakerEnabled(next);
        if (this.pdfSpeakerBtn) this.pdfSpeakerBtn.classList.toggle('active', vc.isSpeakerEnabled);
    }

    updatePdfVcButtonState() {
        const vc = this.pdfViewerVoiceChatManager;
        if (!vc) return;
        if (this.pdfMicBtn) {
            this.pdfMicBtn.classList.toggle('active', vc.isMicEnabled);
            this.pdfMicBtn.classList.toggle('muted', !vc.isMicEnabled);
            this.updatePdfMicIcon(vc.isMicEnabled);
        }
        if (this.pdfSpeakerBtn) this.pdfSpeakerBtn.classList.toggle('active', vc.isSpeakerEnabled);
    }

    /** メニューバーと同様: ミュート時=斜線付き、ON時=通常マイク */
    updatePdfMicIcon(isMicOn) {
        const icon = document.getElementById('pdf-viewer-mic-icon');
        if (!icon) return;
        if (isMicOn) {
            icon.innerHTML = `<path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>`;
        } else {
            icon.innerHTML = `<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>`;
        }
    }

    updatePenSample() {
        if (!this.penSampleLine) return;
        this.penSampleLine.style.height = Math.max(1, this.penLineWidth) + 'px';
    }

    clientToDrawCanvas(clientX, clientY) {
        if (!this.drawCanvas) return null;
        const rect = this.drawCanvas.getBoundingClientRect();
        const scaleX = this.drawCanvas.width / rect.width;
        const scaleY = this.drawCanvas.height / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    }

    isOpen() {
        return this.overlay && this.overlay.style.display !== 'none';
    }

    /**
     * Open viewer and load PDF.
     * @param {string} pdfPath - e.g. 'pdfs/xxx.pdf'
     */
    async open(pdfPath) {
        if (!this.overlay || !this.canvas) return;
        this.pdfPath = pdfPath;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.currentPage = 1;
        this.penLines = [];
        this.isPenMode = false;
        this._currentLine = null;
        this._touchId = null;
        this._pinchStartDistance = null;
        this._pinchStartZoom = null;
        this._pinchStartCenter = null;
        this._pinchStartPanX = null;
        this._pinchStartPanY = null;
        if (this.penBtn) this.penBtn.classList.remove('active');
        if (this.content) this.content.classList.remove('pdf-viewer-pen-mode');
        if (this.penThicknessSlider) this.penLineWidth = Math.max(1, Math.min(20, Number(this.penThicknessSlider.value) || 3));
        this.updatePenSample();
        this.overlay.style.display = 'flex';
        document.body.dataset.pdfViewerOpen = '1';
        this.applyTransform();
        document.addEventListener('keydown', this._boundKeyDown);
        this.content.addEventListener('wheel', this._boundWheel, { passive: false });
        this.content.addEventListener('mousedown', this._boundMouseDown);
        document.addEventListener('mousemove', this._boundMouseMove);
        document.addEventListener('mouseup', this._boundMouseUp);
        document.addEventListener('mouseleave', this._boundMouseUp);
        this.content.addEventListener('touchstart', this._boundTouchStart, { passive: false });
        document.addEventListener('touchmove', this._boundTouchMove, { passive: false });
        document.addEventListener('touchend', this._boundTouchEnd, { passive: false });
        document.addEventListener('touchcancel', this._boundTouchEnd, { passive: false });
        if (this.socket) {
            this.socket.emit('pdf-viewer-open', pdfPath);
            this.socket.on('pdf-draw', this._boundPdfDraw);
        }
        this.startDrawLoop();

        // 日本語など非ASCIIのファイル名をURLエンコードする（Invalid PDF structure を防ぐ）
        const pathStr = pdfPath.startsWith('/') ? pdfPath.slice(1) : pdfPath;
        const encodedPath = pathStr.split('/').map(seg => encodeURIComponent(seg)).join('/');
        const url = '/' + encodedPath;
        try {
            this.pdfjsLib = this.pdfjsLib || await import('pdfjs-dist');
            if (!this.pdfjsLib.GlobalWorkerOptions.workerSrc) {
                try {
                    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
                    this.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
                } catch (_) {
                    this.pdfjsLib.GlobalWorkerOptions.workerSrc =
                        `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${this.pdfjsLib.version || '4.8.69'}/pdf.worker.min.mjs`;
                }
            }
            const loadingTask = this.pdfjsLib.getDocument(url);
            this.pdfDoc = await loadingTask.promise;
            await this.renderPage(this.currentPage);
        } catch (err) {
            console.error('PDF viewer load error:', err);
            const ctx = this.canvas.getContext('2d');
            this.canvas.width = 400;
            this.canvas.height = 200;
            ctx.fillStyle = '#333';
            ctx.fillRect(0, 0, 400, 200);
            ctx.fillStyle = '#fff';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('PDF の読み込みに失敗しました', 200, 100);
        }
    }

    async close() {
        if (!this.overlay) return;
        // PDF通話を切断し、ポップアップを消す（閉じる直前に実行）
        if (this.pdfViewerVoiceChatManager) {
            await this.pdfViewerVoiceChatManager.leaveRoom();
        }
        if (this.onClose) await this.onClose();
        this.overlay.style.display = 'none';
        delete document.body.dataset.pdfViewerOpen;
        document.removeEventListener('keydown', this._boundKeyDown);
        this.content.removeEventListener('wheel', this._boundWheel, { passive: false });
        this.content.removeEventListener('mousedown', this._boundMouseDown);
        document.removeEventListener('mousemove', this._boundMouseMove);
        document.removeEventListener('mouseup', this._boundMouseUp);
        document.removeEventListener('mouseleave', this._boundMouseUp);
        this.content.removeEventListener('touchstart', this._boundTouchStart);
        document.removeEventListener('touchmove', this._boundTouchMove);
        document.removeEventListener('touchend', this._boundTouchEnd);
        document.removeEventListener('touchcancel', this._boundTouchEnd);
        if (this.socket && this.pdfPath) {
            this.socket.emit('pdf-viewer-close', this.pdfPath);
            this.socket.off('pdf-draw', this._boundPdfDraw);
        }
        this.stopDrawLoop();
        this.isPanning = false;
        this._currentLine = null;
        this._touchId = null;
        this._pinchStartDistance = null;
        this._pinchStartZoom = null;
        this._pinchStartCenter = null;
        this._pinchStartPanX = null;
        this._pinchStartPanY = null;
        this.pdfDoc = null;
    }

    applyTransform() {
        if (!this.canvasWrap) return;
        this.canvasWrap.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    onPanStart(e) {
        if (!this.isOpen() || e.button !== 0) return;
        if (this.isPenMode) {
            const pt = this.clientToDrawCanvas(e.clientX, e.clientY);
            if (pt && this.drawCanvas && pt.x >= 0 && pt.x <= this.drawCanvas.width && pt.y >= 0 && pt.y <= this.drawCanvas.height) {
                this._currentLine = [pt];
            }
            return;
        }
        this.isPanning = true;
        this._lastClientX = e.clientX;
        this._lastClientY = e.clientY;
        if (this.content) this.content.classList.add('pdf-viewer-panning');
    }

    onPanMove(e) {
        if (this._currentLine) {
            const pt = this.clientToDrawCanvas(e.clientX, e.clientY);
            if (pt) this._currentLine.push(pt);
            this.redrawPenCanvas();
            return;
        }
        if (!this.isPanning) return;
        this.panX += e.clientX - this._lastClientX;
        this.panY += e.clientY - this._lastClientY;
        this._lastClientX = e.clientX;
        this._lastClientY = e.clientY;
        this.applyTransform();
    }

    onPanEnd() {
        if (this._currentLine && this._currentLine.length >= 2) {
            const drawnAt = Date.now();
            const id = 'l' + drawnAt + '-' + Math.random().toString(36).slice(2);
            this.penLines.push({ points: this._currentLine, drawnAt, id, lineWidth: this.penLineWidth });
            if (this.socket && this.pdfPath) {
                this.socket.emit('pdf-draw', { pdfPath: this.pdfPath, points: this._currentLine, id, lineWidth: this.penLineWidth });
            }
            this._currentLine = null;
            this.redrawPenCanvas();
        }
        this.isPanning = false;
        if (this.content) this.content.classList.remove('pdf-viewer-panning');
    }

    onPdfDraw(data) {
        if (!data.points || data.points.length < 2) return;
        this.penLines.push({
            points: data.points,
            drawnAt: data.drawnAt ?? Date.now(),
            id: data.id,
            lineWidth: data.lineWidth ?? 3
        });
        this.redrawPenCanvas();
    }

    startDrawLoop() {
        const tick = () => {
            if (!this.isOpen()) {
                this._drawAnimId = null;
                return;
            }
            this._drawAnimId = requestAnimationFrame(tick);
            if (this.penLines.length > 0 || this._currentLine) this.redrawPenCanvas();
        };
        tick();
    }

    stopDrawLoop() {
        if (this._drawAnimId) {
            cancelAnimationFrame(this._drawAnimId);
            this._drawAnimId = null;
        }
    }

    redrawPenCanvas() {
        if (!this.drawCanvas) return;
        const ctx = this.drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
        const now = Date.now();
        const drawLine = (points, opacity, lineWidth) => {
            if (!points || points.length < 2) return;
            ctx.strokeStyle = `rgba(255, 0, 0, ${opacity})`;
            ctx.lineWidth = lineWidth ?? this.penLineWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            ctx.stroke();
        };
        for (const line of this.penLines) {
            const age = (now - line.drawnAt) / 1000;
            if (age > 6) continue;
            const opacity = age <= 5 ? 1 : Math.max(0, 1 - (age - 5) / 1);
            drawLine(line.points, opacity, line.lineWidth);
        }
        if (this._currentLine && this._currentLine.length >= 2) {
            drawLine(this._currentLine, 1, this.penLineWidth);
        }
    }

    onWheel(e) {
        if (!this.isOpen()) return;
        e.preventDefault();
        const zoomOld = this.zoom;
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom + delta));
        // 視点の中央（表示領域の中心）を基準にズーム: パンを倍率比で補正
        const ratio = this.zoom / zoomOld;
        this.panX *= ratio;
        this.panY *= ratio;
        this.applyTransform();
    }

    async renderPage(pageNum) {
        if (!this.pdfDoc || !this.canvas) return;
        const page = await this.pdfDoc.getPage(pageNum);
        // 720p相当に制限して軽くする（最長辺 1280px）
        const baseViewport = page.getViewport({ scale: 1 });
        const maxDim = 1280;
        const scale = Math.min(2, maxDim / Math.max(baseViewport.width, baseViewport.height));
        const viewport = page.getViewport({ scale });
        this.canvas.width = Math.floor(viewport.width);
        this.canvas.height = Math.floor(viewport.height);
        const ctx = this.canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (this.drawCanvas) {
            this.drawCanvas.width = this.canvas.width;
            this.drawCanvas.height = this.canvas.height;
            this.redrawPenCanvas();
        }
        this.applyTransform();
    }
}
