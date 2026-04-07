/**
 * UIManager - Manages UI elements for the game
 */

class UIManager {
    constructor() {
        this.teleportPrompt = null;
        this.onWatchVideo = null;
        this.worldLoadOverlay = null;
        this.worldLoadLabel = null;
        this.worldLoadBarFill = null;
        this.worldLoadPct = null;
        /** @type {HTMLElement|null} */
        this.aircraftBoardPrompt = null;
        /** @type {HTMLElement|null} */
        this.aircraftHud = null;
        /** @type {(() => void)|null} */
        this._aircraftBoardHandler = null;
        /** @type {(() => void)|null} */
        this._aircraftHudExit = null;
        /** @type {(() => void)|null} */
        this._aircraftHudCamera = null;
        this.init();
    }

    /**
     * @param {() => void} fn
     */
    setAircraftBoardHandler(fn) {
        this._aircraftBoardHandler = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {{ onExit?: () => void, onToggleCamera?: () => void }} handlers
     */
    setAircraftHudHandlers(handlers) {
        const h = handlers && typeof handlers === 'object' ? handlers : {};
        this._aircraftHudExit = typeof h.onExit === 'function' ? h.onExit : null;
        this._aircraftHudCamera = typeof h.onToggleCamera === 'function' ? h.onToggleCamera : null;
    }

    /**
     * ビデオ視聴ボタンクリック時のコールバックを設定
     * @param {(peerId: string) => void} fn
     */
    setOnWatchVideo(fn) {
        this.onWatchVideo = fn;
    }

    /**
     * Initialize UI elements
     */
    init() {
        // Get or create teleport prompt element
        this.teleportPrompt = document.getElementById('teleport-prompt');

        if (!this.teleportPrompt) {
            this.teleportPrompt = document.createElement('div');
            this.teleportPrompt.id = 'teleport-prompt';
            this.teleportPrompt.style.display = 'none';
            document.body.appendChild(this.teleportPrompt);
        }

        this.aircraftBoardPrompt = document.getElementById('aircraft-board-prompt');
        if (!this.aircraftBoardPrompt) {
            this.aircraftBoardPrompt = document.createElement('div');
            this.aircraftBoardPrompt.id = 'aircraft-board-prompt';
            this.aircraftBoardPrompt.style.display = 'none';
            document.body.appendChild(this.aircraftBoardPrompt);
        }
        if (!this.aircraftBoardPrompt.dataset.wiredBoard) {
            this.aircraftBoardPrompt.dataset.wiredBoard = '1';
            const triggerBoard = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this._aircraftBoardHandler) this._aircraftBoardHandler();
            };
            this.aircraftBoardPrompt.addEventListener('click', triggerBoard);
            this.aircraftBoardPrompt.addEventListener('touchend', triggerBoard, { passive: false });
        }

        this.aircraftHud = document.getElementById('aircraft-hud');
        if (!this.aircraftHud) {
            this.aircraftHud = document.createElement('div');
            this.aircraftHud.id = 'aircraft-hud';
            this.aircraftHud.style.display = 'none';
            document.body.appendChild(this.aircraftHud);
        }
        if (!this.aircraftHud.dataset.wiredHud) {
            this.aircraftHud.dataset.wiredHud = '1';
            this.aircraftHud.addEventListener('click', (e) => {
                const t = e.target;
                if (t && t.id === 'aircraft-hud-exit' && this._aircraftHudExit) {
                    e.preventDefault();
                    this._aircraftHudExit();
                }
                if (t && t.id === 'aircraft-hud-camera' && this._aircraftHudCamera) {
                    e.preventDefault();
                    this._aircraftHudCamera();
                }
            });
        }

        // プレイヤー一覧のイベント委譲（ビデオ視聴ボタン）
        const listContainer = document.getElementById('player-list-container');
        if (listContainer) {
            listContainer.addEventListener('click', (e) => {
                const btn = e.target.closest('.player-watch-video-btn');
                if (btn && this.onWatchVideo) {
                    const peerId = btn.getAttribute('data-peer-id');
                    if (peerId) {
                        console.log('[視聴] ボタンクリック - peerId:', peerId);
                        this.onWatchVideo(peerId);
                    }
                }
            });
        }

        this.worldLoadOverlay = document.getElementById('world-load-overlay');
        this.worldLoadLabel = document.getElementById('world-load-label');
        this.worldLoadBarFill = document.getElementById('world-load-bar-fill');
        this.worldLoadPct = document.getElementById('world-load-pct');
    }

    /**
     * ワールドアセット読み込み開始時にオーバーを表示する
     * @param {number} totalBytes - 読み込み予定の総バイト数（0 のときは空ワールド扱い）
     */
    showWorldLoadProgress(totalBytes) {
        if (!this.worldLoadOverlay || !this.worldLoadLabel || !this.worldLoadBarFill) return;
        this.worldLoadOverlay.style.display = 'flex';
        this.worldLoadOverlay.setAttribute('aria-busy', 'true');
        this.worldLoadOverlay.setAttribute('aria-hidden', 'false');
        this.worldLoadLabel.textContent = '読み込み中…';
        const initialPct = totalBytes > 0 ? 0 : 100;
        this.worldLoadBarFill.style.width = `${initialPct}%`;
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = `${initialPct}%`;
        }
    }

    /**
     * 読み込み中ファイル名とプログレスバーを更新する（総バイトベース）
     * @param {string} fileName - 例: xxx.glb
     * @param {number} loadedBytes - 現在までに読み込んだバイト相当
     * @param {number} totalBytes - 見積もり総バイト数
     */
    updateWorldLoadProgress(fileName, loadedBytes, totalBytes) {
        if (!this.worldLoadLabel || !this.worldLoadBarFill) return;
        const name = (fileName && String(fileName).trim()) || '—';
        this.worldLoadLabel.textContent = `読み込み中（${name}）`;
        const t = Math.max(1, Math.floor(Number(totalBytes)) || 1);
        const c = Math.min(Math.max(0, Number(loadedBytes) || 0), t);
        const pct = Math.round((c / t) * 100);
        this.worldLoadBarFill.style.width = `${pct}%`;
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = `${pct}%`;
        }
    }

    /**
     * ワールド読み込みオーバーを閉じる
     */
    hideWorldLoadProgress() {
        if (!this.worldLoadOverlay || !this.worldLoadBarFill) return;
        this.worldLoadOverlay.style.display = 'none';
        this.worldLoadOverlay.setAttribute('aria-busy', 'false');
        this.worldLoadOverlay.setAttribute('aria-hidden', 'true');
        this.worldLoadBarFill.style.width = '0%';
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = '0%';
        }
    }

    /**
     * Show teleport prompt with destination name（タップ/クリックでテレポート）
     * @param {string} destinationName - Name of destination world
     */
    showTeleportPrompt(destinationName) {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.textContent = `テレポート - ${destinationName}`;
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * Hide teleport prompt
     */
    hideTeleportPrompt() {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.style.display = 'none';
    }

    /**
     * Show "太鼓をたたく" when near a taiko object
     */
    showTaikoPrompt() {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.textContent = '[E] 太鼓をたたく';
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * Show "PDFを表示" when near a PDF object（タップ/クリックで開く）
     */
    showPdfPrompt() {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.textContent = 'PDFを表示';
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * Update player count display
     * @param {number} count - Number of players
     */
    updatePlayerCount(count) {
        const countElement = document.getElementById('player-count');
        if (countElement) {
            countElement.textContent = count;
        }
    }

    /**
     * Update ping display: 応答時間を色分けで表示
     * 100ms以内: 緑, 300ms以内: 黄, それ以上: 赤, 10秒応答なし: 応答なし
     * @param {{ pingMs: number|null, noResponse: boolean }} status
     */
    updatePingDisplay(status) {
        const el = document.getElementById('ping-value');
        const container = document.getElementById('ping-display');
        if (!el || !container) return;

        const { pingMs, noResponse } = status || {};

        container.classList.remove('ping-green', 'ping-yellow', 'ping-red', 'ping-none');
        if (noResponse) {
            el.textContent = '応答なし';
            container.classList.add('ping-none');
        } else if (pingMs != null) {
            el.textContent = `${pingMs}ms`;
            if (pingMs <= 100) container.classList.add('ping-green');
            else if (pingMs <= 300) container.classList.add('ping-yellow');
            else container.classList.add('ping-red');
        } else {
            el.textContent = '-';
        }
    }

    /**
     * Update info panel: ワールド名、座標、プレイヤー数、プレイヤー一覧
     * プレイヤー一覧はデータ変更時のみ更新（毎フレームのDOM差し替えでクリックが奪われるのを防ぐ）
     */
    updateInfoPanel(worldName, position, playerCount, players = []) {
        const worldEl = document.getElementById('world-name');
        const posEl = document.getElementById('position-display');
        const countEl = document.getElementById('player-count');
        const listEl = document.getElementById('player-list');

        if (worldEl) worldEl.textContent = worldName || '-';
        if (posEl) posEl.textContent = position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}` : '-';
        if (countEl) countEl.textContent = playerCount;

        if (!listEl) return;

        // ビデオON > マイクON > その他 の順でソート
        const sorted = [...players].sort((a, b) => {
            const va = (b.vcVideoOn ? 2 : 0) + (b.vcMicOn ? 1 : 0);
            const vb = (a.vcVideoOn ? 2 : 0) + (a.vcMicOn ? 1 : 0);
            return va - vb;
        });
        const displayed = sorted;

        // プレイヤー一覧: 変更時のみ DOM 更新（毎フレーム差し替えするとクリックが奪われる）
        const listHash = displayed.map(p => `${p.id}:${p.vcVideoOn}|${p.vcMicOn}|${p.vcSpeakerOn}|${p.pingMs}|${p.fpsSample}|${p.perfTier}|${p.role || ''}`).join(';');
        if (listEl.dataset.listHash !== listHash) {
            listEl.dataset.listHash = listHash;
            const videoOnCount = displayed.filter(p => p.vcVideoOn).length;
            const micOnCount = displayed.filter(p => p.vcMicOn && !p.vcVideoOn).length;
            const hasSegments = videoOnCount > 0 || (micOnCount > 0 && micOnCount < displayed.length - videoOnCount);
            listEl.innerHTML = displayed.map((p, i) => {
                let showSeparator = false;
                if (hasSegments) {
                    if (videoOnCount > 0 && i === videoOnCount) showSeparator = true;
                    else if (videoOnCount === 0 && micOnCount > 0 && i === micOnCount) showSeparator = true;
                }
                const micClass = p.vcVideoOn ? 'video-on' : (p.vcMicOn ? 'mic-on' : 'mic-off');
                const sep = showSeparator ? '<div class="player-list-separator"></div>' : '';
                const videoIcon = p.vcVideoOn ? '<i class="bi bi-camera-video-fill vc-status-icon video-on" title="ビデオON"></i>' : '';
                const micIcon = p.vcMicOn ? '<i class="bi bi-mic vc-status-icon mic-on" title="マイクON"></i>' : '<i class="bi bi-mic-mute vc-status-icon mic-off" title="マイクOFF"></i>';
                const spkIcon = p.vcSpeakerOn === true ? '<i class="bi bi-megaphone vc-status-icon speaker-on" title="スピーカーON"></i>' : '<i class="bi bi-megaphone-fill vc-status-icon speaker-off" title="スピーカーOFF"></i>';
                const name = (p.displayName || p.username || 'Guest').trim() || 'Player';
                const ping = p.pingMs != null ? p.pingMs : null;
                const pingClass = ping == null ? 'ping-none' : (ping <= 100 ? 'ping-green' : ping <= 300 ? 'ping-yellow' : 'ping-red');
                const pingText = ping != null ? `${ping}ms` : '応答なし';
                const pingSpan = `<span class="player-ping ${pingClass}" title="応答時間">${pingText}</span>`;
                const tier = p.perfTier != null ? String(p.perfTier) : '';
                const fpsTxt = p.fpsSample != null ? `${p.fpsSample}fps` : '';
                const perfSpan = (tier || fpsTxt)
                    ? `<span class="player-perf" title="性能ティア / 直近FPSサンプル">${tier}${tier && fpsTxt ? ' ' : ''}${fpsTxt}</span>`
                    : '';
                const roleLabel = p.role === 'student' ? '[生徒]' : p.role === 'teacher' ? '[教師]' : p.role === 'admin' ? '[管理者]' : '';
                const roleSpan = roleLabel ? `<span class="player-role" title="種別">${roleLabel}</span>` : '';
                const watchBtn = p.vcVideoOn ? `<button type="button" class="player-watch-video-btn" data-peer-id="${p.id}" title="ビデオを視聴">視聴</button>` : '';
                const playerInfo = `<span class="player-info"><span class="player-vc-status">${videoIcon}${micIcon}${spkIcon}</span> ${name}</span>`;
                return `${sep}<div class="player-list-item ${micClass}">${playerInfo}${watchBtn}${pingSpan}${perfSpan}${roleSpan}</div>`;
            }).join('');
        }
    }

    /**
     * @param {string} [label]
     */
    showAircraftBoardPrompt(label) {
        if (!this.aircraftBoardPrompt) return;
        const t = (label || '操縦する').trim();
        this.aircraftBoardPrompt.textContent = `${t}（クリック / E）`;
        this.aircraftBoardPrompt.style.display = 'block';
    }

    hideAircraftBoardPrompt() {
        if (!this.aircraftBoardPrompt) return;
        this.aircraftBoardPrompt.style.display = 'none';
    }

    showAircraftHud() {
        if (!this.aircraftHud) return;
        this.aircraftHud.innerHTML = `
<div class="aircraft-hud-actions">
<button type="button" id="aircraft-hud-exit">降りる (F)</button>
<button type="button" id="aircraft-hud-camera">視点 (V)</button>
</div>
<div class="aircraft-hud-telemetry">
<span class="aircraft-hud-line">速度 <strong id="aircraft-hud-speed">0</strong> m/s　姿勢 P <strong id="aircraft-hud-pitch">0</strong>° R <strong id="aircraft-hud-roll">0</strong>° Y <strong id="aircraft-hud-yaw">0</strong>°</span>
<span class="aircraft-hud-line">角速度 ヨー <strong id="aircraft-hud-omegay">0</strong>　ピッチ <strong id="aircraft-hud-omegap">0</strong>　ロール <strong id="aircraft-hud-omegar">0</strong> rad/s　<strong id="aircraft-hud-ground">—</strong></span>
</div>`;
        this.aircraftHud.style.display = 'flex';
    }

    /**
     * 飛行機操縦中の計器表示（showAircraftHud 後・毎フレーム）
     * @param {{ speedMs: number, pitchDeg: number, yawDeg: number, rollDeg: number, omegaYaw: number, omegaPitch: number, omegaRoll: number, grounded: boolean }|null} snap
     */
    updateAircraftHudTelemetry(snap) {
        if (!this.aircraftHud || !snap) return;
        const q = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
        const el = (id) => document.getElementById(id);
        const s = el('aircraft-hud-speed');
        const p = el('aircraft-hud-pitch');
        const r = el('aircraft-hud-roll');
        const y = el('aircraft-hud-yaw');
        if (s) s.textContent = q(snap.speedMs, 1);
        if (p) p.textContent = q(snap.pitchDeg, 1);
        if (r) r.textContent = q(snap.rollDeg, 1);
        if (y) {
            const deg = snap.yawDeg;
            const norm = Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : NaN;
            y.textContent = q(norm, 0);
        }
        const wy = el('aircraft-hud-omegay');
        const wp = el('aircraft-hud-omegap');
        const wr = el('aircraft-hud-omegar');
        const g = el('aircraft-hud-ground');
        if (wy) wy.textContent = q(snap.omegaYaw, 2);
        if (wp) wp.textContent = q(snap.omegaPitch, 2);
        if (wr) wr.textContent = q(snap.omegaRoll, 2);
        if (g) g.textContent = snap.grounded ? '接地' : '空中';
    }

    hideAircraftHud() {
        if (!this.aircraftHud) return;
        this.aircraftHud.style.display = 'none';
        this.aircraftHud.innerHTML = '';
    }
}

export default UIManager;
