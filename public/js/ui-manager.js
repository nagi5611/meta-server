/**
 * UIManager - Manages UI elements for the game
 */

import { t } from './metaverse-i18n.js';

/**
 * innerHTML 向けに文字列をエスケープする（表示名 XSS 対策）
 * @param {string} s
 * @returns {string}
 */
function escapeHtmlForUi(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

class UIManager {
    constructor() {
        this.teleportPrompt = null;
        this.onWatchVideo = null;
        /** @type {((playerId: string, displayName: string, anchorEl: HTMLElement) => void)|null} */
        this.onPlayerListNameMenu = null;
        /** @type {((playerId: string) => boolean)|null} */
        this._playerBlockedCheck = null;
        /** @type {((playerId: string) => void)|null} */
        this.onPlayerListBlockedClick = null;
        this.worldLoadOverlay = null;
        this.worldLoadLabel = null;
        this.worldLoadAsset = null;
        this.worldLoadBarFill = null;
        this.worldLoadPct = null;
        /** @type {HTMLElement|null} */
        this.aircraftBoardPrompt = null;
        /** @type {HTMLElement|null} */
        this.aircraftHud = null;
        /** @type {HTMLElement|null} */
        this.menuBar = null;
        /** @type {(() => void)|null} */
        this._aircraftBoardHandler = null;
        /** @type {(() => void)|null} */
        this._aircraftHudExit = null;
        /** @type {(() => void)|null} */
        this._aircraftHudCamera = null;
        /** @type {HTMLElement|null} */
        this.mobileInteractBtn = null;
        /** @type {(() => void)|null} */
        this._mobileInteractAction = null;
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
     * プレイヤー一覧の名前クリック時（通報・ブロックメニュー用）
     * @param {((playerId: string, displayName: string, anchorEl: HTMLElement) => void)|null} fn
     */
    setOnPlayerListNameMenu(fn) {
        this.onPlayerListNameMenu = typeof fn === 'function' ? fn : null;
    }

    /**
     * プレイヤー一覧でブロック済みを分離表示するための判定
     * @param {((playerId: string) => boolean)|null} fn
     */
    setPlayerBlockedCheck(fn) {
        this._playerBlockedCheck = typeof fn === 'function' ? fn : null;
    }

    /**
     * 一覧下部「ブロック済み」行の名前クリックでブロック解除
     * @param {((playerId: string) => void)|null} fn
     */
    setOnPlayerListBlockedClick(fn) {
        this.onPlayerListBlockedClick = typeof fn === 'function' ? fn : null;
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
                const blockedRow = e.target.closest('.player-list-item--blocked');
                if (blockedRow && this.onPlayerListBlockedClick) {
                    const pid = blockedRow.getAttribute('data-blocked-player-id');
                    if (pid) {
                        e.stopPropagation();
                        this.onPlayerListBlockedClick(pid);
                    }
                    return;
                }
                const btn = e.target.closest('.player-watch-video-btn');
                if (btn && this.onWatchVideo) {
                    const peerId = btn.getAttribute('data-peer-id');
                    if (peerId) {
                        console.log('[視聴] ボタンクリック - peerId:', peerId);
                        this.onWatchVideo(peerId);
                    }
                    return;
                }
                const nameTrig = e.target.closest('.player-list-name-trigger');
                if (nameTrig && this.onPlayerListNameMenu) {
                    const pid = nameTrig.getAttribute('data-player-id');
                    if (pid) {
                        const rawDisplay =
                            nameTrig.getAttribute('data-player-display-name') || nameTrig.textContent || '';
                        const displayName = rawDisplay.trim() || 'Player';
                        e.stopPropagation();
                        this.onPlayerListNameMenu(pid, displayName, nameTrig);
                    }
                }
            });
        }

        this.worldLoadOverlay = document.getElementById('world-load-overlay');
        this.worldLoadLabel = document.getElementById('world-load-label');
        this.worldLoadAsset = document.getElementById('world-load-asset');
        this.worldLoadBarFill = document.getElementById('world-load-bar-fill');
        this.worldLoadPct = document.getElementById('world-load-pct');

        this.menuBar = document.getElementById('menu-bar');

        this.mobileInteractBtn = document.getElementById('mobile-interact-btn');
        if (this.mobileInteractBtn && !this.mobileInteractBtn.dataset.wiredInteract) {
            this.mobileInteractBtn.dataset.wiredInteract = '1';
            const triggerInteract = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this._mobileInteractAction) this._mobileInteractAction();
            };
            this.mobileInteractBtn.addEventListener('click', triggerInteract);
            this.mobileInteractBtn.addEventListener('touchend', triggerInteract, { passive: false });
        }
    }

    /**
     * モバイル用インタラクトボタン押下時（E キー相当）
     * @param {(() => void) | null} fn
     */
    setMobileInteractAction(fn) {
        this._mobileInteractAction = typeof fn === 'function' ? fn : null;
    }

    /**
     * モバイル用インタラクトボタンを表示（GLB アニメ近接など）
     * @param {string} [hintLabel] - title / aria-label 用（ワールド設定のラベル）
     */
    showMobileInteractButton(hintLabel) {
        if (!this.mobileInteractBtn) return;
        if (this.teleportPrompt) this.teleportPrompt.style.display = 'none';
        const hint = (hintLabel && String(hintLabel).trim()) || t('ui.mobileAnimDefault');
        if (this.mobileInteractBtn.style.display === 'block' && this.mobileInteractBtn.getAttribute('title') === hint) {
            return;
        }
        this.mobileInteractBtn.textContent = t('mobile.interact');
        this.mobileInteractBtn.setAttribute('title', hint);
        this.mobileInteractBtn.setAttribute('aria-label', hint);
        this.mobileInteractBtn.setAttribute('aria-hidden', 'false');
        this.mobileInteractBtn.style.display = 'block';
    }

    /**
     * モバイル用インタラクトボタンを隠す
     */
    hideMobileInteractButton() {
        if (!this.mobileInteractBtn) return;
        this.mobileInteractBtn.style.display = 'none';
        this.mobileInteractBtn.setAttribute('aria-hidden', 'true');
        this.mobileInteractBtn.removeAttribute('title');
        this.mobileInteractBtn.removeAttribute('aria-label');
    }

    /**
     * 飛行機パイロット操縦中はメニューバーを半透明にする（降りる・同乗のみでは戻す）
     * @param {boolean} piloting
     */
    setMenuBarAircraftPiloting(piloting) {
        if (!this.menuBar) return;
        this.menuBar.classList.toggle('aircraft-piloting', !!piloting);
    }

    /**
     * ワールドアセット読み込み開始時にオーバーを表示する
     * @param {number} totalBytes - 読み込み予定の総バイト数（準備フェーズでは 0）
     * @param {{ preparing?: boolean }} [opts] - preparing: planWorldLoadBytes 前（署名・HEAD 等）
     */
    showWorldLoadProgress(totalBytes, opts = {}) {
        if (!this.worldLoadOverlay || !this.worldLoadLabel || !this.worldLoadBarFill) return;
        const preparing = !!opts.preparing;
        this.worldLoadOverlay.style.display = 'flex';
        this.worldLoadOverlay.setAttribute('aria-busy', 'true');
        this.worldLoadOverlay.setAttribute('aria-hidden', 'false');
        if (preparing) {
            this.worldLoadLabel.textContent = t('worldLoad.preparingLabel');
            if (this.worldLoadAsset) {
                this.worldLoadAsset.textContent = t('worldLoad.preparingAsset');
            }
            this.worldLoadBarFill.style.width = '0%';
            if (this.worldLoadPct) {
                this.worldLoadPct.textContent = '—';
            }
            return;
        }
        this.worldLoadLabel.textContent = t('worldLoad.loading');
        if (this.worldLoadAsset) {
            this.worldLoadAsset.textContent = '';
        }
        const initialPct = totalBytes > 0 ? 0 : 100;
        this.worldLoadBarFill.style.width = `${initialPct}%`;
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = `${initialPct}%`;
        }
    }

    /**
     * 読み込み中ファイル名とプログレスバーを更新する（総バイトベース）
     * @param {{ fileName: string, loadedBytes: number, totalBytes: number, loadKind?: string, prefabTitle?: string }} detail
     */
    updateWorldLoadProgress(detail) {
        if (!this.worldLoadLabel || !this.worldLoadBarFill) return;
        const { fileName, loadedBytes, totalBytes, loadKind, prefabTitle } = detail || {};
        const name = (fileName && String(fileName).trim()) || '—';
        this.worldLoadLabel.textContent = t('worldLoad.loading');
        if (this.worldLoadAsset) {
            if (loadKind === 'prefab' && prefabTitle && String(prefabTitle).trim()) {
                const pTitle = String(prefabTitle).trim();
                this.worldLoadAsset.textContent =
                    name && name !== '—'
                        ? t('worldLoad.prefabLine', { title: pTitle, name })
                        : t('worldLoad.prefabTitleOnly', { title: pTitle });
            } else {
                this.worldLoadAsset.textContent = name;
            }
        }
        const totalB = Math.max(1, Math.floor(Number(totalBytes)) || 1);
        const c = Math.min(Math.max(0, Number(loadedBytes) || 0), totalB);
        const pct = Math.round((c / totalB) * 100);
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
        if (this.worldLoadAsset) {
            this.worldLoadAsset.textContent = '';
        }
    }

    /**
     * Show teleport prompt with destination name（タップ/クリックでテレポート）
     * @param {string} destinationName - Name of destination world
     */
    showTeleportPrompt(destinationName) {
        if (!this.teleportPrompt) return;
        this.hideMobileInteractButton();
        this.teleportPrompt.textContent = `${t('ui.teleportPrefix')}${destinationName}`;
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * Hide teleport prompt
     */
    hideTeleportPrompt() {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.style.display = 'none';
        this.hideMobileInteractButton();
    }

    /**
     * Show "太鼓をたたく" when near a taiko object
     */
    showTaikoPrompt() {
        if (!this.teleportPrompt) return;
        this.hideMobileInteractButton();
        this.teleportPrompt.textContent = t('ui.taikoPrompt');
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * Show "PDFを表示" when near a PDF object（タップ/クリックで開く）
     */
    showPdfPrompt() {
        if (!this.teleportPrompt) return;
        this.hideMobileInteractButton();
        this.teleportPrompt.textContent = t('ui.pdfPrompt');
        this.teleportPrompt.style.display = 'block';
    }

    /**
     * GLB アニメーション用インタラクト（文言はワールド設定の label をそのまま表示）
     * @param {string} label
     */
    showGlbAnimInteractPrompt(label) {
        if (!this.teleportPrompt) return;
        this.hideMobileInteractButton();
        this.teleportPrompt.textContent = label || t('ui.glbAnimDefault');
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
            el.textContent = t('ui.pingNone');
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

        const isBlocked = (id) =>
            id != null &&
            typeof this._playerBlockedCheck === 'function' &&
            this._playerBlockedCheck(String(id));

        // ビデオON > マイクON > その他 の順でソート
        const sorted = [...players].sort((a, b) => {
            const va = (b.vcVideoOn ? 2 : 0) + (b.vcMicOn ? 1 : 0);
            const vb = (a.vcVideoOn ? 2 : 0) + (a.vcMicOn ? 1 : 0);
            return va - vb;
        });
        const activeDisplayed = sorted.filter((p) => !isBlocked(p.id));
        const blockedDisplayed = sorted.filter((p) => isBlocked(p.id));

        const rowSig = (p) =>
            `${p.id}:${p.vcVideoOn}|${p.vcMicOn}|${p.vcSpeakerOn}|${p.pingMs}|${p.fpsSample}|${p.perfTier}|${p.role || ''}`;

        // プレイヤー一覧: 変更時のみ DOM 更新（毎フレーム差し替えするとクリックが奪われる）
        const listHash = `a:${activeDisplayed.map(rowSig).join(';')}|b:${blockedDisplayed.map(rowSig).join(';')}`;
        if (listEl.dataset.listHash !== listHash) {
            listEl.dataset.listHash = listHash;

            const buildRow = (p, i, opts) => {
                const blocked = opts.blocked === true;
                const videoOnCount = opts.videoOnCount;
                const micOnCount = opts.micOnCount;
                const hasSegments = opts.hasSegments;

                let showSeparator = false;
                if (!blocked && hasSegments) {
                    if (videoOnCount > 0 && i === videoOnCount) showSeparator = true;
                    else if (videoOnCount === 0 && micOnCount > 0 && i === micOnCount) showSeparator = true;
                }
                const micClass = p.vcVideoOn ? 'video-on' : (p.vcMicOn ? 'mic-on' : 'mic-off');
                const sep = showSeparator ? '<div class="player-list-separator"></div>' : '';
                const videoIcon = p.vcVideoOn
                    ? `<i class="bi bi-camera-video-fill vc-status-icon video-on" title="${escapeHtmlForUi(t('ui.videoOnTitle'))}"></i>`
                    : '';
                const micIcon = p.vcMicOn
                    ? `<i class="bi bi-mic vc-status-icon mic-on" title="${escapeHtmlForUi(t('ui.micOnTitle'))}"></i>`
                    : `<i class="bi bi-mic-mute vc-status-icon mic-off" title="${escapeHtmlForUi(t('ui.micOffTitle'))}"></i>`;
                const spkIcon =
                    p.vcSpeakerOn === true
                        ? `<i class="bi bi-megaphone vc-status-icon speaker-on" title="${escapeHtmlForUi(t('ui.spkOnTitle'))}"></i>`
                        : `<i class="bi bi-megaphone-fill vc-status-icon speaker-off" title="${escapeHtmlForUi(t('ui.spkOffTitle'))}"></i>`;
                const name = escapeHtmlForUi((p.displayName || p.username || 'Guest').trim() || 'Player');
                const ping = p.pingMs != null ? p.pingMs : null;
                const pingClass = ping == null ? 'ping-none' : (ping <= 100 ? 'ping-green' : ping <= 300 ? 'ping-yellow' : 'ping-red');
                const pingText = ping != null ? `${ping}ms` : t('ui.pingNone');
                const pingSpan = `<span class="player-ping ${pingClass}" title="${escapeHtmlForUi(t('ui.pingTitle'))}">${pingText}</span>`;
                const tier = p.perfTier != null ? String(p.perfTier) : '';
                const fpsTxt = p.fpsSample != null ? `${p.fpsSample}fps` : '';
                const perfSpan = (tier || fpsTxt)
                    ? `<span class="player-perf" title="${escapeHtmlForUi(t('ui.perfTitle'))}">${tier}${tier && fpsTxt ? ' ' : ''}${fpsTxt}</span>`
                    : '';
                const roleLabel =
                    p.role === 'student'
                        ? t('ui.roleStudent')
                        : p.role === 'teacher'
                          ? t('ui.roleTeacher')
                          : p.role === 'admin'
                            ? t('ui.roleAdmin')
                            : '';
                const roleSpan = roleLabel
                    ? `<span class="player-role" title="${escapeHtmlForUi(t('ui.roleTitle'))}">${escapeHtmlForUi(roleLabel)}</span>`
                    : '';
                const safePeerId = escapeHtmlForUi(String(p.id ?? ''));
                const watchBtn =
                    !blocked && p.vcVideoOn
                        ? `<button type="button" class="player-watch-video-btn" data-peer-id="${safePeerId}" title="${escapeHtmlForUi(t('ui.watchVideoTitle'))}">${escapeHtmlForUi(t('ui.watchVideoBtn'))}</button>`
                        : '';
                const safeId = escapeHtmlForUi(String(p.id ?? ''));
                const blockedBadge = blocked
                    ? `<span class="player-blocked-badge" title="${escapeHtmlForUi(t('ui.blockedBadgeTitle'))}"><i class="bi bi-slash-circle" aria-hidden="true"></i></span>`
                    : '';
                const nameClasses = blocked
                    ? 'player-list-name-trigger player-list-name--blocked'
                    : 'player-list-name-trigger';
                const itemClass = blocked ? `player-list-item ${micClass} player-list-item--blocked` : `player-list-item ${micClass}`;
                const rowBlockedAttr = blocked ? ` data-blocked-player-id="${safeId}"` : '';
                const playerInfo = `<span class="player-info">${blockedBadge}<span class="player-vc-status">${videoIcon}${micIcon}${spkIcon}</span> <span class="${nameClasses}" role="button" tabindex="0" data-player-id="${safeId}" data-player-display-name="${name}">${name}</span></span>`;
                return `${sep}<div class="${itemClass}"${rowBlockedAttr}>${playerInfo}${watchBtn}${pingSpan}${perfSpan}${roleSpan}</div>`;
            };

            const videoOnCount = activeDisplayed.filter((p) => p.vcVideoOn).length;
            const micOnCount = activeDisplayed.filter((p) => p.vcMicOn && !p.vcVideoOn).length;
            const hasSegments =
                videoOnCount > 0 ||
                (micOnCount > 0 && micOnCount < activeDisplayed.length - videoOnCount);

            let html = activeDisplayed
                .map((p, i) =>
                    buildRow(p, i, {
                        blocked: false,
                        videoOnCount,
                        micOnCount,
                        hasSegments,
                    })
                )
                .join('');

            if (blockedDisplayed.length > 0) {
                html += `<div class="player-list-blocked-heading" role="presentation">${escapeHtmlForUi(t('ui.blockedHeading'))}</div>`;
                html += blockedDisplayed
                    .map((p, i) =>
                        buildRow(p, i, {
                            blocked: true,
                            videoOnCount,
                            micOnCount,
                            hasSegments,
                        })
                    )
                    .join('');
            }

            listEl.innerHTML = html;
        }
    }

    /**
     * @param {string} [label]
     * @param {'pilot'|'passenger'} [mode]
     */
    showAircraftBoardPrompt(label, mode = 'pilot') {
        if (!this.aircraftBoardPrompt) return;
        this.hideMobileInteractButton();
        const name = (label || '').trim();
        const verb = mode === 'passenger' ? t('ui.aircraftPassenger') : t('ui.aircraftPilot');
        const head = name ? `${name} — ${verb}` : verb;
        this.aircraftBoardPrompt.textContent = `${head}${t('ui.aircraftBoardSuffix')}`;
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
<button type="button" id="aircraft-hud-exit">${escapeHtmlForUi(t('ui.aircraftExit'))}</button>
<button type="button" id="aircraft-hud-camera">${escapeHtmlForUi(t('ui.aircraftCamera'))}</button>
</div>
<div class="aircraft-hud-telemetry">
${t('ui.aircraftHudLinesHtml')}
</div>`;
        this.aircraftHud.style.display = 'flex';
    }

    /**
     * 飛行機操縦中の計器表示（showAircraftHud 後・毎フレーム）
     * @param {{ speedMs: number, pitchDeg: number, yawDeg: number, rollDeg: number, omegaYaw: number, omegaPitch: number, omegaRoll: number, grounded: boolean, throttle?: number, flapLabel?: string, vfeMs?: number, vfeWarn?: boolean }|null} snap
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
        if (g) g.textContent = snap.grounded ? t('ui.aircraftGrounded') : t('ui.aircraftAirborne');
        const th = el('aircraft-hud-throttle');
        if (th) th.textContent = typeof snap.throttle === 'number' && Number.isFinite(snap.throttle)
            ? (snap.throttle * 100).toFixed(0)
            : '—';
        const fl = el('aircraft-hud-flap');
        if (fl) fl.textContent = snap.flapLabel != null ? String(snap.flapLabel) : '—';
        const vf = el('aircraft-hud-vfe');
        if (vf) {
            const lab = snap.flapLabel != null ? String(snap.flapLabel) : '';
            if (lab === 'UP' || typeof snap.vfeMs !== 'number' || !Number.isFinite(snap.vfeMs)) vf.textContent = '—';
            else vf.textContent = q(snap.vfeMs, 0);
        }
        const vw = el('aircraft-hud-vfewarn');
        if (vw) vw.textContent = snap.vfeWarn ? t('ui.aircraftVfeWarn') : '';
    }

    hideAircraftHud() {
        if (!this.aircraftHud) return;
        this.aircraftHud.style.display = 'none';
        this.aircraftHud.innerHTML = '';
    }
}

export default UIManager;
