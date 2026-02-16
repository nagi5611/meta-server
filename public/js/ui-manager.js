/**
 * UIManager - Manages UI elements for the game
 */

class UIManager {
    constructor() {
        this.teleportPrompt = null;
        this.onWatchVideo = null;
        this.init();
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
        const listHash = displayed.map(p => `${p.id}:${p.vcVideoOn}|${p.vcMicOn}|${p.vcSpeakerOn}|${p.pingMs}|${p.role || ''}`).join(';');
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
                const roleLabel = p.role === 'student' ? '[生徒]' : p.role === 'teacher' ? '[教師]' : p.role === 'admin' ? '[管理者]' : '';
                const roleSpan = roleLabel ? `<span class="player-role" title="種別">${roleLabel}</span>` : '';
                const watchBtn = p.vcVideoOn ? `<button type="button" class="player-watch-video-btn" data-peer-id="${p.id}" title="ビデオを視聴">視聴</button>` : '';
                const playerInfo = `<span class="player-info"><span class="player-vc-status">${videoIcon}${micIcon}${spkIcon}</span> ${name}</span>`;
                return `${sep}<div class="player-list-item ${micClass}">${playerInfo}${watchBtn}${pingSpan}${roleSpan}</div>`;
            }).join('');
        }
    }
}

export default UIManager;
