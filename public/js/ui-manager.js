/**
 * UIManager - Manages UI elements for the game
 */

import { t } from './metaverse-i18n.js';
import { isDeveloperModeEnabled } from './metaverse-client-settings.js';

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
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._aircraftViewpointFlashTimer = null;
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
        } else if (this.aircraftBoardPrompt.parentElement !== document.body) {
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
            this.aircraftHud.className = 'aircraft-hud';
            this.aircraftHud.hidden = true;
            document.body.appendChild(this.aircraftHud);
        } else if (this.aircraftHud.parentElement !== document.body) {
            document.body.appendChild(this.aircraftHud);
        }
        if (!this.aircraftHud.dataset.wiredHud) {
            this.aircraftHud.dataset.wiredHud = '1';
            this.aircraftHud.addEventListener('click', (e) => {
                const exitBtn = e.target.closest('#aircraft-hud-exit');
                const camBtn = e.target.closest('#aircraft-hud-camera');
                if (exitBtn && this._aircraftHudExit) {
                    e.preventDefault();
                    this._aircraftHudExit();
                }
                if (camBtn && this._aircraftHudCamera) {
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
     * @param {number} totalCount - 読み込み予定のオブジェクト数（準備フェーズでは 0）
     * @param {{ preparing?: boolean }} [opts] - preparing: マニフェスト読込フェーズ
     */
    showWorldLoadProgress(totalCount, opts = {}) {
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
        const initialPct = totalCount > 0 ? 0 : 100;
        this.worldLoadBarFill.style.width = `${initialPct}%`;
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = `${initialPct}%`;
        }
    }

    /**
     * 読み込み種別に応じた表示用ラベルを返す
     * @param {string | undefined} loadKind
     * @returns {string}
     */
    _worldLoadKindLabel(loadKind) {
        if (loadKind === 'prefab') return t('worldLoad.prefab');
        if (loadKind === 'pdf') return t('worldLoad.pdf');
        if (loadKind === 'model') return t('worldLoad.model');
        return t('worldLoad.loading');
    }

    /**
     * ダウンロード進捗を 0–99% にマップする（表示完了まで 100% にしない）
     * @param {number} completedCount
     * @param {number} totalCount
     * @returns {number}
     */
    _worldLoadDownloadPct(completedCount, totalCount) {
        const totalB = Math.max(1, Math.floor(Number(totalCount)) || 1);
        const c = Math.min(Math.max(0, Number(completedCount) || 0), totalB);
        if (c >= totalB) return 99;
        return Math.round((c / totalB) * 99);
    }

    /**
     * プログレスバーとパーセント表示を更新する
     * @param {number} pct
     */
    _setWorldLoadPct(pct) {
        const clamped = Math.min(100, Math.max(0, Math.round(pct)));
        this.worldLoadBarFill.style.width = `${clamped}%`;
        if (this.worldLoadPct) {
            this.worldLoadPct.textContent = `${clamped}%`;
        }
    }

    /**
     * 開発者モード時の詳細ロード表示（プレハブ名・ファイル名）
     * @param {{ fileName?: string, loadKind?: string, prefabTitle?: string }} detail
     */
    _applyWorldLoadDeveloperLabels(detail) {
        const { fileName, loadKind, prefabTitle } = detail || {};
        const name = (fileName && String(fileName).trim()) || '—';
        this.worldLoadLabel.textContent = t('worldLoad.loading');
        if (!this.worldLoadAsset) return;
        if (loadKind === 'prefab' && prefabTitle && String(prefabTitle).trim()) {
            const pTitle = String(prefabTitle).trim();
            this.worldLoadAsset.textContent =
                name && name !== '—'
                    ? t('worldLoad.prefabLine', { title: pTitle, name })
                    : t('worldLoad.prefabTitleOnly', { title: pTitle });
            return;
        }
        this.worldLoadAsset.textContent = name;
    }

    /**
     * 読み込み中の種別ラベルとプログレスバーを更新する（オブジェクト数ベース、最大 99%）
     * @param {{ fileName: string, completedCount: number, totalCount: number, loadKind?: string, prefabTitle?: string }} detail
     */
    updateWorldLoadProgress(detail) {
        if (!this.worldLoadLabel || !this.worldLoadBarFill) return;
        const { completedCount, totalCount, loadKind } = detail || {};
        if (isDeveloperModeEnabled()) {
            this._applyWorldLoadDeveloperLabels(detail);
        } else {
            this.worldLoadLabel.textContent = this._worldLoadKindLabel(loadKind);
            if (this.worldLoadAsset) {
                this.worldLoadAsset.textContent = '';
            }
        }
        this._setWorldLoadPct(this._worldLoadDownloadPct(completedCount, totalCount));
    }

    /**
     * 全ダウンロード完了後、表示が整うまで 99% を維持してから 100% でオーバーを閉じる
     * @param {() => void} [beforePaint] 初回描画前に呼ぶ（例: renderer.render）
     */
    async finalizeWorldLoadProgress(beforePaint) {
        if (!this.worldLoadOverlay || !this.worldLoadBarFill) return;
        if (this.worldLoadLabel) {
            this.worldLoadLabel.textContent = t('worldLoad.finalizing');
        }
        if (this.worldLoadAsset) {
            this.worldLoadAsset.textContent = '';
        }
        this._setWorldLoadPct(99);
        beforePaint?.();
        await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        this._setWorldLoadPct(100);
        await new Promise((resolve) => setTimeout(resolve, 120));
        this.hideWorldLoadProgress();
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
        this.teleportPrompt.setAttribute('aria-hidden', 'false');
    }

    /**
     * Hide teleport prompt
     */
    hideTeleportPrompt() {
        if (!this.teleportPrompt) return;

        this.teleportPrompt.style.display = 'none';
        this.teleportPrompt.setAttribute('aria-hidden', 'true');
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
     * 100ms以内: 緑, 300ms以内: 黄, それ以上: 赤, 3秒応答なし: 応答なし
     * @param {{ pingMs: number|null, noResponse: boolean, connecting?: boolean, reconnecting?: boolean }} status
     */
    updatePingDisplay(status) {
        const el = document.getElementById('ping-value');
        const container = document.getElementById('ping-display');
        if (!el || !container) return;

        const { pingMs, noResponse, connecting, reconnecting } = status || {};

        container.classList.remove('ping-green', 'ping-yellow', 'ping-red', 'ping-none', 'ping-connecting');
        if (reconnecting) {
            el.textContent = t('ui.pingReconnecting');
            container.classList.add('ping-connecting');
        } else if (connecting) {
            el.textContent = t('ui.pingConnecting');
            container.classList.add('ping-connecting');
        } else if (noResponse) {
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
        const name = escapeHtmlForUi((label || '').trim());
        const verb = escapeHtmlForUi(
            mode === 'passenger' ? t('ui.aircraftPassenger') : t('ui.aircraftPilot')
        );
        const main = name ? `${name} — ${verb}` : verb;
        this.aircraftBoardPrompt.innerHTML = `
<span class="aircraft-board-beacon" aria-hidden="true"></span>
<span class="aircraft-board-label">${main}</span>`;
        this.aircraftBoardPrompt.setAttribute('aria-label', `${(label || '').trim() || verb} E`);
        this.aircraftBoardPrompt.style.display = 'flex';
    }

    hideAircraftBoardPrompt() {
        if (!this.aircraftBoardPrompt) return;
        this.aircraftBoardPrompt.style.display = 'none';
        this.aircraftBoardPrompt.innerHTML = '';
    }

    /**
     * @param {'hard'|'easy'} [mode]
     */
    showAircraftHud(mode = 'hard') {
        if (!this.aircraftHud) return;
        const isEasy = mode === 'easy';
        this.aircraftHud.classList.toggle('is-easy', isEasy);
        if (isEasy) {
            this.aircraftHud.innerHTML = `
<div class="aircraft-hud-easy-panel">
<div class="aircraft-hud-easy-actions">
<button type="button" class="aircraft-hud-btn" id="aircraft-hud-exit">${escapeHtmlForUi(t('ui.aircraftExitShort'))}</button>
<button type="button" class="aircraft-hud-btn" id="aircraft-hud-camera">${escapeHtmlForUi(t('ui.aircraftCameraShort'))}</button>
</div>
<div class="aircraft-hud-easy-grid" aria-live="polite">
<div class="aircraft-hud-easy-view"><span id="aircraft-hud-easy-view">—</span><span class="aircraft-hud-easy-ground" id="aircraft-hud-easy-ground">—</span></div>
<div class="aircraft-hud-easy-row" id="aircraft-hud-easy-pos-att">—</div>
<div class="aircraft-hud-easy-row" id="aircraft-hud-easy-omega-speed">—</div>
</div>
</div>`;
        } else {
            this.aircraftHud.innerHTML = `
<div class="aircraft-hud-bar">
<div class="aircraft-hud-actions">
<button type="button" class="aircraft-hud-btn" id="aircraft-hud-exit">${escapeHtmlForUi(t('ui.aircraftExitShort'))}</button>
<button type="button" class="aircraft-hud-btn" id="aircraft-hud-camera">${escapeHtmlForUi(t('ui.aircraftCameraShort'))}</button>
</div>
<div class="aircraft-hud-stats" aria-live="polite">
<span class="aircraft-hud-speed"><strong id="aircraft-hud-speed">0</strong> km/h</span>
<span class="aircraft-hud-stat" id="aircraft-hud-throttle-wrap" hidden><span id="aircraft-hud-throttle">0</span>%</span>
<span class="aircraft-hud-stat" id="aircraft-hud-flap-wrap" hidden><span id="aircraft-hud-flap">UP</span></span>
<span class="aircraft-hud-stat" id="aircraft-hud-ground">—</span>
<span class="aircraft-hud-warn" id="aircraft-hud-vfewarn"></span>
</div>
</div>
<div class="aircraft-hud-viewpoint" id="aircraft-hud-viewpoint" aria-live="polite"></div>`;
        }
        this.aircraftHud.hidden = false;
        this.aircraftHud.classList.add('is-active');
    }

    /**
     * 視点切替時に HUD 計器の上へ視点名を約2秒表示する（同乗時は固定トースト）
     * @param {string} name
     */
    flashAircraftViewpointName(name) {
        const label = String(name || '').trim();
        if (!label) return;
        let el = document.getElementById('aircraft-hud-viewpoint');
        if (!el) {
            el = document.getElementById('aircraft-viewpoint-flash');
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'aircraft-viewpoint-flash';
            el.className = 'aircraft-viewpoint-flash';
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
        }
        el.textContent = label;
        el.classList.add('is-visible');
        if (this._aircraftViewpointFlashTimer) {
            clearTimeout(this._aircraftViewpointFlashTimer);
        }
        this._aircraftViewpointFlashTimer = setTimeout(() => {
            el.classList.remove('is-visible');
            this._aircraftViewpointFlashTimer = null;
        }, 2000);
    }

    /**
     * 飛行機操縦中の計器表示（showAircraftHud 後・毎フレーム）
     * @param {{ speedMs: number, pitchDeg: number, yawDeg: number, rollDeg: number, omegaYaw: number, omegaPitch: number, omegaRoll: number, grounded: boolean, throttle?: number, engineRpm?: number, flapLabel?: string, vfeMs?: number, vfeWarn?: boolean }|null} snap
     */
    updateAircraftHudTelemetry(snap) {
        if (!this.aircraftHud || this.aircraftHud.hidden || !snap) return;
        const q = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
        const el = (id) => document.getElementById(id);

        if (snap.controlMode === 'easy') {
            const posAtt = el('aircraft-hud-easy-pos-att');
            if (posAtt) {
                const pos = `X ${q(snap.worldX, 1)}  Y ${q(snap.worldY, 1)}  Z ${q(snap.worldZ, 1)}`;
                const att = `P ${q(snap.pitchDeg, 1)}°  Y ${q(snap.yawDeg, 1)}°  R ${q(snap.rollDeg, 1)}°`;
                posAtt.textContent = `${pos} / ${att}`;
            }
            const omegaSpeed = el('aircraft-hud-easy-omega-speed');
            if (omegaSpeed) {
                const omega = `${t('ui.aircraftOmegaPitch')} ${q(snap.omegaPitch, 2)}  ${t('ui.aircraftOmegaRoll')} ${q(snap.omegaRoll, 2)}  ${t('ui.aircraftOmegaYaw')} ${q(snap.omegaYaw, 2)} rad/s`;
                const kmh = Number.isFinite(snap.speedMs) ? snap.speedMs * 3.6 : NaN;
                const knots = Number.isFinite(snap.speedMs) ? snap.speedMs * 1.94384 : NaN;
                omegaSpeed.textContent = `${omega} / ${q(kmh, 0)} km/h - ${q(knots, 0)} ${t('ui.aircraftKnots')}`;
            }
            const view = el('aircraft-hud-easy-view');
            if (view) view.textContent = snap.viewpointName ? String(snap.viewpointName) : '—';
            const ground = el('aircraft-hud-easy-ground');
            if (ground) {
                ground.textContent = snap.grounded ? t('ui.aircraftGrounded') : t('ui.aircraftAirborne');
            }
            return;
        }

        const s = el('aircraft-hud-speed');
        if (s) {
            const kmh = Number.isFinite(snap.speedMs) ? snap.speedMs * 3.6 : NaN;
            s.textContent = q(kmh, 0);
        }
        const thWrap = el('aircraft-hud-throttle-wrap');
        const th = el('aircraft-hud-throttle');
        const hasThrottle = typeof snap.throttle === 'number' && Number.isFinite(snap.throttle);
        if (thWrap) thWrap.hidden = !hasThrottle;
        if (th && hasThrottle) th.textContent = (snap.throttle * 100).toFixed(0);
        const flapWrap = el('aircraft-hud-flap-wrap');
        const fl = el('aircraft-hud-flap');
        const flapLabel = snap.flapLabel != null ? String(snap.flapLabel) : '';
        const showFlap = flapLabel && flapLabel !== 'UP';
        if (flapWrap) flapWrap.hidden = !showFlap;
        if (fl && showFlap) fl.textContent = flapLabel;
        const g = el('aircraft-hud-ground');
        if (g) g.textContent = snap.grounded ? t('ui.aircraftGrounded') : t('ui.aircraftAirborne');
        const vw = el('aircraft-hud-vfewarn');
        if (vw) vw.textContent = snap.vfeWarn ? t('ui.aircraftVfeWarnShort') : '';
    }

    hideAircraftHud() {
        if (!this.aircraftHud) return;
        this.aircraftHud.hidden = true;
        this.aircraftHud.classList.remove('is-active', 'is-easy');
        this.aircraftHud.innerHTML = '';
        const flash = document.getElementById('aircraft-viewpoint-flash');
        if (flash) {
            flash.classList.remove('is-visible');
            flash.textContent = '';
        }
        if (this._aircraftViewpointFlashTimer) {
            clearTimeout(this._aircraftViewpointFlashTimer);
            this._aircraftViewpointFlashTimer = null;
        }
    }
}

export default UIManager;
