let currentAlertTarget = null;
/** セレクター補完用のプレイヤー一覧（loadPlayers で更新） */
let cachedPlayersForCompletion = [];
/** tp コマンド用ワールドID一覧（loadWorldsForCompletion で更新） */
let cachedWorldIdsForCompletion = [];

// Update interval (2 seconds)
const UPDATE_INTERVAL = 2000;
// Bandwidth graph poll (1 second for smooth graph)
const BANDWIDTH_POLL_INTERVAL = 1000;
const BANDWIDTH_HISTORY_MAX = 60; // 60 points = 1 min at 1s poll

let lastTrafficSample = null;
let bandwidthHistory = [];
let worldEditInitialized = false;

/** ログインユーザー一覧の現在ページ（1始まり） */
let currentLoginUsersPage = 1;
const LOGIN_USERS_PAGE_SIZE = 50;

/**
 * 指定したパネル ID を表示し、サイドメニューの active を更新する。
 * ワールド編集パネルは初表示時に setting.js を動的 import して init する。
 */
function switchPanel(panelId) {
    document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById(panelId);
    const navItem = document.querySelector(`.admin-nav-item[data-panel="${panelId}"]`);
    if (panel) panel.classList.add('active');
    if (navItem) navItem.classList.add('active');

    if (panelId === 'panel-world-edit' && !worldEditInitialized) {
        worldEditInitialized = true;
        import('/js/setting.js').then((m) => m.initSettingEditor()).catch((e) => console.error('Setting editor init failed:', e));
    }
    if (panelId === 'panel-user-register') {
        loadUsers();
    }
    if (panelId === 'panel-logs') {
        loadLoginUsers(currentLoginUsersPage);
    }
}

/** 保存キー: 管理画面テーマ 'light' | 'dark' */
const ADMIN_THEME_KEY = 'adminTheme';

/**
 * テーマを適用し、トグルボタンのアイコンを更新する
 */
function applyAdminTheme(isDark) {
    if (isDark) {
        document.body.classList.add('admin-dark');
        const icon = document.getElementById('admin-theme-icon');
        if (icon) {
            icon.className = 'bi bi-sun-fill';
            document.getElementById('admin-theme-toggle')?.setAttribute('title', 'ライトモードに切替');
        }
    } else {
        document.body.classList.remove('admin-dark');
        const icon = document.getElementById('admin-theme-icon');
        if (icon) {
            icon.className = 'bi bi-moon-fill';
            document.getElementById('admin-theme-toggle')?.setAttribute('title', 'ダークモードに切替');
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem(ADMIN_THEME_KEY);
    applyAdminTheme(savedTheme === 'dark');

    document.getElementById('admin-theme-toggle')?.addEventListener('click', () => {
        const isDark = !document.body.classList.contains('admin-dark');
        localStorage.setItem(ADMIN_THEME_KEY, isDark ? 'dark' : 'light');
        applyAdminTheme(isDark);
    });

    // サイドメニュー: クリックでパネル切り替え
    document.querySelectorAll('.admin-nav-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const panelId = btn.getAttribute('data-panel');
            if (panelId) switchPanel(panelId);
        });
    });

    // URL の ?panel= で初期表示パネルを指定（例: ?panel=world-edit）
    const params = new URLSearchParams(location.search);
    const initialPanel = params.get('panel');
    const validPanels = ['panel-status', 'panel-players', 'panel-comm', 'panel-logs', 'panel-user-register', 'panel-world-edit'];
    if (initialPanel && validPanels.includes(initialPanel)) {
        switchPanel(initialPanel);
    }

    loadStats();
    loadPlayers();
    loadWorldsForCompletion();
    loadLogs();
    loadChatLogs();
    updateRoomFilter();

    // Auto-refresh
    setInterval(() => {
        loadStats();
        loadPlayers();
        loadWorldsForCompletion();
        loadLogs();
        loadChatLogs();
        if (document.getElementById('panel-user-register')?.classList.contains('active')) {
            loadUsers();
        }
        if (document.getElementById('panel-logs')?.classList.contains('active')) {
            loadLoginUsers(currentLoginUsersPage);
        }
    }, UPDATE_INTERVAL);

    // 通信帯域グラフ用（1秒ごと）
    updateBandwidth();
    setInterval(updateBandwidth, BANDWIDTH_POLL_INTERVAL);
    
    // Alert modal handlers
    setupAlertModal();
    
    // Chat logs controls
    document.getElementById('room-filter').addEventListener('change', () => {
        loadChatLogs();
    });
    document.getElementById('refresh-chat-logs').addEventListener('click', () => {
        loadChatLogs();
    });

    document.getElementById('chat-logs-container').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-log-username-link');
        if (btn && btn.dataset.username) {
            e.preventDefault();
            openUserSessionModal(btn.dataset.username);
        }
    });

    document.getElementById('refresh-login-users').addEventListener('click', () => loadLoginUsers(currentLoginUsersPage));
    document.getElementById('login-users-prev').addEventListener('click', () => {
        if (currentLoginUsersPage > 1) loadLoginUsers(currentLoginUsersPage - 1);
    });
    document.getElementById('login-users-next').addEventListener('click', () => {
        loadLoginUsers(currentLoginUsersPage + 1);
    });
    document.getElementById('user-session-modal-close').addEventListener('click', () => {
        document.getElementById('user-session-modal').classList.remove('show');
    });
    document.getElementById('user-session-modal').addEventListener('click', (e) => {
        if (e.target.id === 'user-session-modal') document.getElementById('user-session-modal').classList.remove('show');
    });
    document.getElementById('login-users-tbody')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.login-user-name-link');
        if (btn && btn.dataset.username) {
            e.preventDefault();
            openUserSessionModal(btn.dataset.username);
        }
    });

    // ユーザー登録パネル: 新規登録・編集・削除
    setupUserRegisterPanel();

    // Command execution (Enter to execute) + selector tab completion
    setupCommandCompletion();

    // メタバースへ入る（管理者）: Basic認証済みでトークン取得しメタバースへ遷移
    document.getElementById('back-to-metaverse').addEventListener('click', async () => {
        const btn = document.getElementById('back-to-metaverse');
        btn.disabled = true;
        btn.textContent = '読み込み中...';
        try {
            const res = await fetch('/admin/enter-metaverse', { credentials: 'include' });
            if (!res.ok) {
                alert('認証に失敗しました。再度ログインしてください。');
                btn.disabled = false;
                btn.textContent = 'メタバースへ入る（管理者）';
                return;
            }
            const { token, username } = await res.json();
            sessionStorage.setItem('metaverseAdminToken', token);
            localStorage.setItem('username', username);
            window.location.href = '/admin';
        } catch (err) {
            console.error('Failed to enter metaverse as admin:', err);
            alert('メタバースへの入室に失敗しました。');
            btn.disabled = false;
            btn.textContent = 'メタバースへ入る（管理者）';
        }
    });
});

function updateLastUpdateTime() {
    const now = new Date();
    document.getElementById('last-update').textContent = now.toLocaleTimeString('ja-JP');
}

async function loadStats() {
    try {
        const response = await fetch('/admin/stats', { credentials: 'include' });
        const data = await response.json();
        
        document.getElementById('total-players').textContent = data.totalPlayers;
        document.getElementById('total-rooms').textContent = data.totalRooms;
        document.getElementById('vc-rooms').textContent = data.activeVCRooms;
        document.getElementById('vc-peers').textContent = data.activeVCPeers;
        document.getElementById('bytes-sent').textContent = data.traffic.bytesSentFormatted;
        document.getElementById('bytes-received').textContent = data.traffic.bytesReceivedFormatted;
        document.getElementById('packets-sent').textContent = data.traffic.packetsSent.toLocaleString();
        document.getElementById('packets-received').textContent = data.traffic.packetsReceived.toLocaleString();

        const cpuEl = document.getElementById('cpu-usage');
        const ramEl = document.getElementById('ram-usage');
        const degEl = document.getElementById('degradation-index');
        if (cpuEl) cpuEl.textContent = data.cpuUsagePercent != null ? `${data.cpuUsagePercent.toFixed(1)}%` : '-';
        if (ramEl) ramEl.textContent = data.ramUsagePercent != null ? `${data.ramUsagePercent.toFixed(1)}%` : '-';
        if (degEl) degEl.textContent = data.degradationIndex != null ? data.degradationIndex.toFixed(2) : '-';
        
        // Update VC ports
        const portList = document.getElementById('port-list');
        const portCount = document.getElementById('port-count');
        portCount.textContent = data.vcPorts.portCount;
        portList.innerHTML = (data.vcPorts.uniquePorts.length > 0)
            ? data.vcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
            : '<span style="color: #999;">使用中のポートなし</span>';

        // Update PDF VC ports
        const pdfPortList = document.getElementById('pdf-port-list');
        const pdfPortCount = document.getElementById('pdf-port-count');
        if (pdfPortList && pdfPortCount) {
            pdfPortCount.textContent = data.pdfVcPorts?.portCount ?? 0;
            pdfPortList.innerHTML = (data.pdfVcPorts?.uniquePorts?.length > 0)
                ? data.pdfVcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
                : '<span style="color: #999;">使用中のポートなし</span>';
        }

        // Update Video VC ports
        const videoPortList = document.getElementById('video-port-list');
        const videoPortCount = document.getElementById('video-port-count');
        if (videoPortList && videoPortCount) {
            videoPortCount.textContent = data.videoVcPorts?.portCount ?? 0;
            videoPortList.innerHTML = (data.videoVcPorts?.uniquePorts?.length > 0)
                ? data.videoVcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
                : '<span style="color: #999;">使用中のポートなし</span>';
        }

        updateLastUpdateTime();
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

function formatBps(bps) {
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' MB/s';
    if (bps >= 1e3) return (bps / 1e3).toFixed(2) + ' KB/s';
    return Math.round(bps) + ' B/s';
}

function updateBandwidthFromStats(data) {
    const now = Date.now();
    const sent = data.traffic.bytesSent;
    const recv = data.traffic.bytesReceived;
    const limitBps = data.bandwidthLimitBps || 1;

    let sentBps = 0, recvBps = 0;
    if (lastTrafficSample) {
        const dtSec = (now - lastTrafficSample.ts) / 1000;
        if (dtSec > 0) {
            sentBps = (sent - lastTrafficSample.bytesSent) / dtSec;
            recvBps = (recv - lastTrafficSample.bytesReceived) / dtSec;
        }
    }
    lastTrafficSample = { bytesSent: sent, bytesReceived: recv, ts: now };

    bandwidthHistory.push({
        t: now,
        sentBps: Math.max(0, sentBps),
        recvBps: Math.max(0, recvBps)
    });
    if (bandwidthHistory.length > BANDWIDTH_HISTORY_MAX) {
        bandwidthHistory.shift();
    }

    const totalBps = sentBps + recvBps;
    const usagePct = Math.min(100, (totalBps / limitBps) * 100);

    document.getElementById('bandwidth-limit').textContent = formatBps(limitBps) + ' (' + (data.bandwidthLimitMbps || 0) + ' Mbps)';
    document.getElementById('bandwidth-current').textContent = formatBps(totalBps);
    const usageEl = document.getElementById('bandwidth-usage');
    usageEl.textContent = usagePct.toFixed(1) + '%';
    usageEl.className = 'bandwidth-value bandwidth-usage-' + (usagePct >= 90 ? 'high' : usagePct >= 50 ? 'mid' : 'low');

    drawBandwidthGraph(limitBps);
}

function updateBandwidth() {
    fetch('/admin/stats', { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            if (data.bandwidthLimitBps != null && data.traffic) {
                updateBandwidthFromStats(data);
            }
        })
        .catch(() => {});
}

function drawBandwidthGraph(limitBps) {
    const canvas = document.getElementById('bandwidth-graph');
    if (!canvas || bandwidthHistory.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const padding = { top: 20, right: 20, bottom: 24, left: 50 };
    const graphW = w - padding.left - padding.right;
    const graphH = h - padding.top - padding.bottom;

    const isDark = document.body.classList.contains('admin-dark');
    ctx.fillStyle = isDark ? '#1f1e19' : '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // 縦軸オートスケール: 実データの最大値に余白を加算
    const dataMax = Math.max(...bandwidthHistory.flatMap(p => [p.sentBps + p.recvBps, p.sentBps, p.recvBps]), 1);
    const maxBps = dataMax * 1.1;
    const scale = graphH / maxBps;

    // Grid
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
        const y = padding.top + graphH - (graphH * i / 5);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphW, y);
        ctx.stroke();
    }

    // Limit line (データ範囲内にある場合のみ表示)
    const limitY = padding.top + graphH - (limitBps * scale);
    if (limitY > padding.top && limitY < padding.top + graphH && limitBps <= maxBps) {
        ctx.strokeStyle = 'rgba(2, 136, 209, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padding.left, limitY);
        ctx.lineTo(padding.left + graphW, limitY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    const firstT = bandwidthHistory[0].t;
    const lastT = bandwidthHistory[bandwidthHistory.length - 1].t;
    const timeSpan = Math.max(1, lastT - firstT);

    function xFor(i) {
        return padding.left + (bandwidthHistory[i].t - firstT) / timeSpan * graphW;
    }

    // Recv area (bottom, アクセントブルー)
    ctx.fillStyle = 'rgba(2, 136, 209, 0.3)';
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH);
    for (let i = 0; i < bandwidthHistory.length; i++) {
        const y = padding.top + graphH - bandwidthHistory[i].recvBps * scale;
        ctx.lineTo(xFor(i), y);
    }
    ctx.lineTo(xFor(bandwidthHistory.length - 1), padding.top + graphH);
    ctx.closePath();
    ctx.fill();

    // Sent area (top, ブルー濃淡)
    ctx.fillStyle = 'rgba(2, 136, 209, 0.5)';
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH);
    for (let i = 0; i < bandwidthHistory.length; i++) {
        const stacked = bandwidthHistory[i].recvBps + bandwidthHistory[i].sentBps;
        const y = padding.top + graphH - stacked * scale;
        ctx.lineTo(xFor(i), y);
    }
    ctx.lineTo(xFor(bandwidthHistory.length - 1), padding.top + graphH);
    ctx.closePath();
    ctx.fill();

    // Recv line (アクセントブルー)
    ctx.strokeStyle = '#0288d1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH - bandwidthHistory[0].recvBps * scale);
    for (let i = 1; i < bandwidthHistory.length; i++) {
        ctx.lineTo(xFor(i), padding.top + graphH - bandwidthHistory[i].recvBps * scale);
    }
    ctx.stroke();

    // Sent line (stacked, アクセントブルー濃いめ)
    ctx.strokeStyle = '#01579b';
    ctx.beginPath();
    let sy0 = padding.top + graphH - (bandwidthHistory[0].recvBps + bandwidthHistory[0].sentBps) * scale;
    ctx.moveTo(xFor(0), sy0);
    for (let i = 1; i < bandwidthHistory.length; i++) {
        const sy = padding.top + graphH - (bandwidthHistory[i].recvBps + bandwidthHistory[i].sentBps) * scale;
        ctx.lineTo(xFor(i), sy);
    }
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = isDark ? 'rgba(230,228,223,0.8)' : 'rgba(0,0,0,0.6)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
        const val = (maxBps * (5 - i) / 5);
        const lab = formatBps(val);
        ctx.fillText(lab, padding.left - 8, padding.top + graphH * i / 5 + 4);
    }
}

async function loadWorldsForCompletion() {
    try {
        const response = await fetch('/admin/worlds', { credentials: 'include' });
        const worlds = await response.json();
        cachedWorldIdsForCompletion = Object.keys(worlds || {}).sort();
    } catch (e) {
        cachedWorldIdsForCompletion = [];
    }
}

async function loadPlayers() {
    try {
        const response = await fetch('/admin/players', { credentials: 'include' });
        const players = await response.json();
        cachedPlayersForCompletion = players;

        const tbody = document.getElementById('players-tbody');

        if (players.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="loading">接続中のプレイヤーなし</td></tr>';
            // Update room filter when players are loaded
            updateRoomFilter();
            return;
        }
        
        tbody.innerHTML = players.map(player => {
            const connectedTime = formatDuration(player.connectedDuration);
            
            let vcStatus = '<span class="vc-badge mic-off"><i class="bi bi-mic-mute"></i> マイクOFF</span>';
            if (player.vcMicOn) {
                vcStatus = '<span class="vc-badge mic-on"><i class="bi bi-mic"></i> マイクON</span>';
            }
            
            if (player.vcSpeakerOn) {
                vcStatus += '<span class="vc-badge speaker-on"><i class="bi bi-megaphone"></i> スピーカーON</span>';
            } else {
                vcStatus += '<span class="vc-badge speaker-off"><i class="bi bi-megaphone-fill"></i> スピーカーOFF</span>';
            }

            const ping = player.pingMs != null ? player.pingMs : null;
            const pingClass = ping == null ? 'ping-none' : (ping <= 100 ? 'ping-green' : ping <= 300 ? 'ping-yellow' : 'ping-red');
            const pingText = ping != null ? `${ping}ms` : '応答なし';
            const pingCell = `<span class="ping-badge ${pingClass}">${pingText}</span>`;

            const roleLabel = player.role === 'student' ? '[生徒]' : player.role === 'teacher' ? '[教師]' : player.role === 'admin' ? '[管理者]' : '';

            return `
                <tr>
                    <td><span class="socket-id">${player.socketId}</span></td>
                    <td><span class="username">${escapeHtml(player.username)}</span></td>
                    <td><span class="room-badge">${escapeHtml(player.room)}</span></td>
                    <td>${connectedTime}</td>
                    <td>${pingCell}</td>
                    <td><span class="role-badge">${roleLabel}</span></td>
                    <td><div class="vc-status">${vcStatus}</div></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-kick" onclick="kickPlayer('${player.socketId}')">Kick</button>
                            <button class="btn btn-mute" onclick="muteMic('${player.socketId}')" ${!player.vcMicOn ? 'disabled' : ''}>強制ミュート</button>
                            <button class="btn btn-alert" onclick="showAlertModal('${player.socketId}')">メッセージ</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        
        // Update room filter after loading players
        updateRoomFilter();
    } catch (error) {
        console.error('Failed to load players:', error);
        document.getElementById('players-tbody').innerHTML = 
            '<tr><td colspan="8" class="loading">エラー: プレイヤー情報の取得に失敗しました</td></tr>';
    }
}

async function loadChatLogs() {
    try {
        const roomFilter = document.getElementById('room-filter').value;
        const url = roomFilter 
            ? `/admin/chat-logs?room=${encodeURIComponent(roomFilter)}&limit=200`
            : '/admin/chat-logs?limit=200';
        
        const response = await fetch(url, { credentials: 'include' });
        const logs = await response.json();
        
        const container = document.getElementById('chat-logs-container');
        
        if (logs.length === 0) {
            container.innerHTML = '<div class="loading">チャットログなし</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => {
            const timestamp = new Date(log.timestamp).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const roomId = log.roomId || 'unknown';
            const name = escapeHtml(log.senderName);
            const usernameAttr = escapeHtml(log.senderName).replace(/"/g, '&quot;');
            return `
                <div class="chat-log-entry">
                    <span class="chat-log-timestamp">${timestamp}</span>
                    <span class="chat-log-room">[${escapeHtml(roomId)}]</span>
                    <button type="button" class="chat-log-username-link" data-username="${usernameAttr}" title="ユーザー情報を表示">${name}</button>
                    <span class="chat-log-message">${escapeHtml(log.message)}</span>
                </div>
            `;
        }).join('');
        
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    } catch (error) {
        console.error('Failed to load chat logs:', error);
        document.getElementById('chat-logs-container').innerHTML = 
            '<div class="loading">エラー: チャットログの取得に失敗しました</div>';
    }
}

/**
 * チャットログのユーザー名クリック時: ユーザー情報（ログイン時間・IP・ブラウザ・OS）を取得してモーダル表示
 */
async function openUserSessionModal(username) {
    const modal = document.getElementById('user-session-modal');
    const titleEl = document.getElementById('user-session-modal-title');
    const emptyEl = document.getElementById('user-session-empty');
    const dlEl = document.getElementById('user-session-dl');
    titleEl.textContent = `ユーザー情報: ${escapeHtml(username)}`;
    emptyEl.style.display = 'block';
    dlEl.style.display = 'none';
    modal.classList.add('show');

    try {
        const res = await fetch(`/admin/user-sessions/by-username/${encodeURIComponent(username)}`, { credentials: 'include' });
        const session = await res.json();
        if (session && session.login_time != null) {
            emptyEl.style.display = 'none';
            dlEl.style.display = '';
            document.getElementById('user-session-username').textContent = session.username || '-';
            document.getElementById('user-session-login-time').textContent = new Date(session.login_time).toLocaleString('ja-JP');
            document.getElementById('user-session-ip').textContent = session.ip || '-';
            document.getElementById('user-session-browser').textContent = session.browser || '-';
            document.getElementById('user-session-os').textContent = session.os || '-';
        }
    } catch (err) {
        console.error('Failed to load user session:', err);
    }
}

/**
 * ログインユーザー一覧を取得して表示（ページネーション対応・最大50件/ページ）
 */
async function loadLoginUsers(page) {
    const tbody = document.getElementById('login-users-tbody');
    const infoEl = document.getElementById('login-users-pagination-info');
    const prevBtn = document.getElementById('login-users-prev');
    const nextBtn = document.getElementById('login-users-next');
    if (!tbody) return;

    currentLoginUsersPage = Math.max(1, parseInt(page, 10) || 1);

    try {
        const res = await fetch(
            `/admin/user-sessions?page=${currentLoginUsersPage}&limit=${LOGIN_USERS_PAGE_SIZE}`,
            { credentials: 'include' }
        );
        const data = await res.json();
        const { sessions, total } = data;

        if (!sessions || sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="loading">ログインユーザーはいません</td></tr>';
        } else {
            tbody.innerHTML = sessions.map((s) => {
                const loginTime = new Date(s.login_time).toLocaleString('ja-JP');
                return `
                    <tr>
                        <td><button type="button" class="login-user-name-link" data-username="${escapeHtml(s.username).replace(/"/g, '&quot;')}">${escapeHtml(s.username)}</button></td>
                        <td>${escapeHtml(loginTime)}</td>
                        <td>${escapeHtml(s.ip)}</td>
                        <td>${escapeHtml(s.browser)}</td>
                        <td>${escapeHtml(s.os)}</td>
                    </tr>
                `;
            }).join('');
        }

        const from = total === 0 ? 0 : (currentLoginUsersPage - 1) * LOGIN_USERS_PAGE_SIZE + 1;
        const to = Math.min(currentLoginUsersPage * LOGIN_USERS_PAGE_SIZE, total);
        infoEl.textContent = `全 ${total} 件中 ${from}–${to} 件目`;
        prevBtn.disabled = currentLoginUsersPage <= 1;
        nextBtn.disabled = to >= total;
    } catch (err) {
        console.error('Failed to load login users:', err);
        tbody.innerHTML = '<tr><td colspan="5" class="loading">エラー: 取得に失敗しました</td></tr>';
    }
}

/** ユーザー登録パネル: 取得した生徒・教師一覧のキャッシュ（検索フィルタ用） */
let cachedStudentList = [];
let cachedTeacherList = [];

/** ユーザー一覧で現在表示している種別（'student' | 'teacher'） */
let currentUserListRole = 'student';

/** 一斉選択用: 選択中のユーザー "role:id" の Set */
let selectedUserIds = new Set();

/** 現在表示中の行の並び（Shift範囲選択用） */
let visibleUserList = [];

/** Shift+クリック用の最後にクリックした行インデックス */
let lastClickedRowIndex = null;

/**
 * 1件のユーザーを行のHTMLに変換する（先頭にチェック列を付与）
 */
function renderUserRow(u, role, rowIndex) {
    const created = u.created_at ? new Date(u.created_at).toLocaleDateString('ja-JP') : '-';
    const key = `${role}:${u.id}`;
    const checked = selectedUserIds.has(key) ? ' checked' : '';
    return `
        <tr data-role="${role}" data-id="${u.id}" data-row-index="${rowIndex}">
            <td class="td-checkbox"><input type="checkbox" class="user-row-cb" data-role="${role}" data-id="${u.id}" data-row-index="${rowIndex}"${checked}></td>
            <td>${u.id}</td>
            <td><span class="username">${escapeHtml(u.username)}</span></td>
            <td>${escapeHtml(u.display_name)}</td>
            <td>${created}</td>
            <td>
                <div class="action-buttons">
                    <button type="button" class="btn-edit" data-role="${role}" data-id="${u.id}" data-username="${escapeHtml(u.username)}" data-display-name="${escapeHtml(u.display_name)}">編集</button>
                    <button type="button" class="btn-delete" data-role="${role}" data-id="${u.id}">削除</button>
                </div>
            </td>
        </tr>
    `;
}

/**
 * 検索キーワードでユーザー配列をフィルタする（ログインID・表示名の部分一致）
 */
function filterUsersBySearch(users, searchTerm) {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => {
        const un = (u.username || '').toLowerCase();
        const dn = (u.display_name || '').toLowerCase();
        return un.includes(term) || dn.includes(term);
    });
}

/**
 * 選択状態に合わせてチェックボックス・一斉選択・一斉削除バーの表示を更新する
 */
function updateUserSelectionUI() {
    const selectAll = document.getElementById('user-select-all');
    const bulkActions = document.getElementById('user-bulk-actions');
    const selectionCount = document.getElementById('user-selection-count');
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    const rowCbs = tbody.querySelectorAll('.user-row-cb');
    rowCbs.forEach((cb) => {
        const key = `${cb.getAttribute('data-role')}:${cb.getAttribute('data-id')}`;
        cb.checked = selectedUserIds.has(key);
    });

    if (selectAll) {
        const visibleKeys = visibleUserList.map((u) => `${u.role}:${u.id}`);
        const visibleSelected = visibleKeys.filter((k) => selectedUserIds.has(k)).length;
        selectAll.checked = visibleKeys.length > 0 && visibleSelected === visibleKeys.length;
        selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleKeys.length;
    }

    const total = selectedUserIds.size;
    if (bulkActions && selectionCount) {
        if (total > 0) {
            bulkActions.style.display = 'flex';
            selectionCount.textContent = `${total}件選択中`;
        } else {
            bulkActions.style.display = 'none';
        }
    }
}

/**
 * キャッシュと検索キーワードに基づき、現在選択中の種別のユーザー一覧テーブルを描画する
 */
function renderUserTables(searchTerm) {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    const list = currentUserListRole === 'teacher' ? cachedTeacherList : cachedStudentList;
    const filtered = filterUsersBySearch(list, searchTerm);
    const label = currentUserListRole === 'teacher' ? '教師' : '生徒';

    visibleUserList = filtered.map((u) => ({ role: currentUserListRole, id: u.id }));

    if (filtered.length === 0) {
        const emptyMsg = list.length === 0 ? `${label}はいません` : `該当する${label}がいません`;
        tbody.innerHTML = '<tr><td colspan="6" class="loading">' + emptyMsg + '</td></tr>';
    } else {
        tbody.innerHTML = filtered.map((u, i) => renderUserRow(u, currentUserListRole, i)).join('');
    }
    updateUserSelectionUI();
}

/**
 * ユーザー登録パネル: 生徒・教師一覧の読み込み
 */
async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    try {
        const [studentsRes, teachersRes] = await Promise.all([
            fetch('/admin/users/students', { credentials: 'include' }),
            fetch('/admin/users/teachers', { credentials: 'include' })
        ]);
        cachedStudentList = studentsRes.ok ? await studentsRes.json() : [];
        cachedTeacherList = teachersRes.ok ? await teachersRes.json() : [];

        const searchInput = document.getElementById('user-search');
        const searchTerm = searchInput ? searchInput.value : '';
        renderUserTables(searchTerm);
    } catch (error) {
        console.error('Failed to load users:', error);
        cachedStudentList = [];
        cachedTeacherList = [];
        tbody.innerHTML = '<tr><td colspan="6" class="loading">エラー: 取得に失敗しました</td></tr>';
    }
}

/**
 * CSV 1行をパースする（ダブルクォート囲み・エスケープ対応）
 */
function parseCSVLine(line) {
    const result = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === '"') {
            let end = i + 1;
            let s = '';
            while (end < line.length) {
                if (line[end] === '"') {
                    if (line[end + 1] === '"') {
                        s += '"';
                        end += 2;
                        continue;
                    }
                    break;
                }
                s += line[end];
                end++;
            }
            result.push(s);
            i = end + 1;
            if (line[i] === ',') i++;
        } else {
            let end = line.indexOf(',', i);
            if (end === -1) end = line.length;
            result.push(line.slice(i, end).trim());
            i = end + 1;
        }
    }
    return result;
}

/**
 * インポート用CSVテキストをパースし、{ role, username, password, display_name } の配列を返す
 */
function parseCSVForImport(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    const roleIdx = header.indexOf('role');
    const userIdx = header.indexOf('username');
    const passIdx = header.indexOf('password');
    const dispIdx = header.indexOf('display_name');
    if (roleIdx === -1 || userIdx === -1 || passIdx === -1) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const arr = parseCSVLine(lines[i]);
        const role = (arr[roleIdx] || '').trim().toLowerCase();
        const username = (arr[userIdx] || '').trim();
        const password = (arr[passIdx] || '').trim();
        const displayName = dispIdx >= 0 ? (arr[dispIdx] || '').trim() : '';
        if (username && password && (role === 'student' || role === 'teacher')) {
            rows.push({ role, username, password, displayName });
        }
    }
    return rows;
}

/**
 * CSVフィールドをエスケープ（改行・カンマ・ダブルクォートを含む場合は囲む）
 */
function escapeCSVField(str) {
    const s = String(str ?? '');
    if (/[\r\n,"]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/**
 * CSV一斉追加: ファイルを読み取りパースし、1件ずつAPIで登録する
 */
async function handleCsvImport(fileInput, statusEl, btnEl) {
    const file = fileInput.files?.[0];
    if (!file) {
        statusEl.textContent = 'ファイルを選択してください';
        statusEl.className = 'status-text error';
        return;
    }
    btnEl.disabled = true;
    statusEl.textContent = '読み込み中...';
    statusEl.className = 'status-text';
    let text;
    try {
        text = await file.text();
    } catch (e) {
        statusEl.textContent = 'ファイルの読み込みに失敗しました';
        statusEl.className = 'status-text error';
        btnEl.disabled = false;
        return;
    }
    const rows = parseCSVForImport(text);
    if (rows.length === 0) {
        statusEl.textContent = '有効な行がありません。形式: role,username,password,display_name（1行目ヘッダー、roleはstudent/teacher）';
        statusEl.className = 'status-text error';
        btnEl.disabled = false;
        return;
    }
    statusEl.textContent = `登録中 (0/${rows.length})...`;
    let ok = 0;
    let ng = 0;
    let firstError = '';
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const url = r.role === 'teacher' ? '/admin/users/teacher' : '/admin/users/student';
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username: r.username,
                    password: r.password,
                    displayName: r.displayName || undefined
                })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                ok++;
            } else {
                ng++;
                if (!firstError) firstError = data.error === 'username_exists' ? `${r.username}: 既に登録済み` : (data.error || '登録失敗');
            }
        } catch (err) {
            ng++;
            if (!firstError) firstError = '通信エラー';
        }
        statusEl.textContent = `登録中 (${i + 1}/${rows.length})...`;
    }
    if (ng === 0) {
        statusEl.textContent = `${ok}件を登録しました`;
        statusEl.className = 'status-text success';
        fileInput.value = '';
        document.getElementById('user-csv-filename').textContent = '';
        btnEl.disabled = true;
        loadUsers();
    } else {
        statusEl.textContent = `完了: 成功 ${ok}件、失敗 ${ng}件${firstError ? '（例: ' + firstError + '）' : ''}`;
        statusEl.className = 'status-text error';
        loadUsers();
    }
    btnEl.disabled = false;
    if (statusEl.className.includes('success')) {
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
}

/**
 * 既存ユーザー一覧をCSVでダウンロードする
 */
async function handleCsvExport() {
    const btn = document.getElementById('btn-export-csv');
    if (btn) btn.disabled = true;
    try {
        const [studentsRes, teachersRes] = await Promise.all([
            fetch('/admin/users/students', { credentials: 'include' }),
            fetch('/admin/users/teachers', { credentials: 'include' })
        ]);
        const students = studentsRes.ok ? await studentsRes.json() : [];
        const teachers = teachersRes.ok ? await teachersRes.json() : [];
        const header = ['role', 'id', 'username', 'display_name', 'created_at'];
        const lines = [header.map(escapeCSVField).join(',')];
        for (const u of students) {
            lines.push(['student', u.id, u.username, u.display_name, u.created_at ?? ''].map(escapeCSVField).join(','));
        }
        for (const u of teachers) {
            lines.push(['teacher', u.id, u.username, u.display_name, u.created_at ?? ''].map(escapeCSVField).join(','));
        }
        const csv = lines.join('\r\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        console.error('CSV export failed:', err);
        const statusEl = document.getElementById('user-csv-import-status');
        if (statusEl) {
            statusEl.textContent = 'エクスポートに失敗しました';
            statusEl.className = 'status-text error';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * ユーザー登録パネル: 新規登録・編集モーダル・削除のイベント設定
 */
function setupUserRegisterPanel() {
    const searchInput = document.getElementById('user-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            renderUserTables(searchInput.value);
        });
    }

    /** 画面全体の種別を切り替え（左パネル・ユーザー一覧を同期） */
    function applyUserRegisterRole(role) {
        if (role !== 'student' && role !== 'teacher') return;
        currentUserListRole = role;
        document.querySelectorAll('.ur-category-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-ur-category') === role);
        });
        const term = searchInput ? searchInput.value : '';
        renderUserTables(term);
    }

    document.querySelectorAll('.ur-category-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const category = btn.getAttribute('data-ur-category');
            applyUserRegisterRole(category);
        });
    });

    const btnAdd = document.getElementById('btn-add-user');
    const statusAdd = document.getElementById('user-add-status');
    const modal = document.getElementById('user-edit-modal');
    const editId = document.getElementById('user-edit-id');
    const editRole = document.getElementById('user-edit-role');
    const editUsername = document.getElementById('user-edit-username');
    const editDisplayName = document.getElementById('user-edit-display-name');
    const editPassword = document.getElementById('user-edit-password');
    const editStatus = document.getElementById('user-edit-status');
    const editSaveBtn = document.getElementById('user-edit-save-btn');
    const editCancelBtn = document.getElementById('user-edit-cancel-btn');

    if (btnAdd) {
        btnAdd.addEventListener('click', async () => {
            const role = currentUserListRole;
            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value;
            const displayName = document.getElementById('new-display-name').value.trim();

            if (!username || !password) {
                statusAdd.textContent = 'ログインIDとパスワードを入力してください';
                statusAdd.className = 'status-text error';
                return;
            }

            btnAdd.disabled = true;
            statusAdd.textContent = '登録中...';
            statusAdd.className = 'status-text';

            try {
                const url = role === 'teacher' ? '/admin/users/teacher' : '/admin/users/student';
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ username, password, displayName: displayName || undefined })
                });
                const data = await res.json();

                if (res.ok && data.success) {
                    statusAdd.textContent = '登録しました';
                    statusAdd.className = 'status-text success';
                    document.getElementById('new-username').value = '';
                    document.getElementById('new-password').value = '';
                    document.getElementById('new-display-name').value = '';
                    loadUsers();
                } else {
                    statusAdd.textContent = data.error === 'username_exists' ? 'このログインIDは既に使われています' : (data.error || '登録に失敗しました');
                    statusAdd.className = 'status-text error';
                }
            } catch (err) {
                statusAdd.textContent = '通信エラー';
                statusAdd.className = 'status-text error';
            } finally {
                btnAdd.disabled = false;
                if (statusAdd.textContent && statusAdd.className.includes('success')) {
                    setTimeout(() => { statusAdd.textContent = ''; }, 3000);
                }
            }
        });
    }

    if (modal) {
        editCancelBtn?.addEventListener('click', () => {
            modal.classList.remove('show');
            editPassword.value = '';
            editStatus.textContent = '';
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
                editPassword.value = '';
            }
        });

        editSaveBtn?.addEventListener('click', async () => {
            const id = editId.value;
            const role = editRole.value;
            const username = editUsername.value.trim();
            const displayName = editDisplayName.value.trim();
            const password = editPassword.value;

            if (!username) {
                editStatus.textContent = 'ログインIDを入力してください';
                editStatus.className = 'status-text error';
                return;
            }

            editSaveBtn.disabled = true;
            editStatus.textContent = '保存中...';
            editStatus.className = 'status-text';

            try {
                const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                const body = { username, displayName: displayName || username };
                if (password) body.password = password;

                const res = await fetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                if (res.ok && data.success) {
                    editStatus.textContent = '保存しました';
                    editStatus.className = 'status-text success';
                    loadUsers();
                    setTimeout(() => {
                        modal.classList.remove('show');
                        editPassword.value = '';
                        editStatus.textContent = '';
                    }, 800);
                } else {
                    editStatus.textContent = data.error === 'username_exists' ? 'このログインIDは既に使われています' : (data.error || '保存に失敗しました');
                    editStatus.className = 'status-text error';
                }
            } catch (err) {
                editStatus.textContent = '通信エラー';
                editStatus.className = 'status-text error';
            } finally {
                editSaveBtn.disabled = false;
            }
        });
    }

    // CSV一斉追加: ファイル選択
    const csvFileInput = document.getElementById('user-csv-file');
    const btnChooseCsv = document.getElementById('btn-choose-csv');
    const csvFilenameSpan = document.getElementById('user-csv-filename');
    const btnImportCsv = document.getElementById('btn-import-csv');
    const csvImportStatus = document.getElementById('user-csv-import-status');
    if (btnChooseCsv && csvFileInput) {
        btnChooseCsv.addEventListener('click', () => csvFileInput.click());
        csvFileInput.addEventListener('change', () => {
            const file = csvFileInput.files?.[0];
            if (file) {
                csvFilenameSpan.textContent = file.name;
                btnImportCsv.disabled = false;
            } else {
                csvFilenameSpan.textContent = '';
                btnImportCsv.disabled = true;
            }
        });
    }
    if (btnImportCsv && csvFileInput) {
        btnImportCsv.addEventListener('click', () => handleCsvImport(csvFileInput, csvImportStatus, btnImportCsv));
    }
    const btnExportCsv = document.getElementById('btn-export-csv');
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', handleCsvExport);
    }

    // 一斉選択チェックボックス
    const selectAllEl = document.getElementById('user-select-all');
    if (selectAllEl) {
        selectAllEl.addEventListener('change', () => {
            const visibleKeys = visibleUserList.map((u) => `${u.role}:${u.id}`);
            if (selectAllEl.checked) {
                visibleKeys.forEach((k) => selectedUserIds.add(k));
            } else {
                visibleKeys.forEach((k) => selectedUserIds.delete(k));
            }
            lastClickedRowIndex = null;
            updateUserSelectionUI();
        });
    }

    // 行チェック: クリックでトグル、Shift+クリックで範囲選択
    document.getElementById('panel-user-register')?.addEventListener('click', (e) => {
        const rowCb = e.target.closest('.user-row-cb');
        if (rowCb) {
            e.preventDefault();
            const role = rowCb.getAttribute('data-role');
            const id = rowCb.getAttribute('data-id');
            const key = `${role}:${id}`;
            const rowIndex = parseInt(rowCb.getAttribute('data-row-index'), 10);

            if (e.shiftKey && lastClickedRowIndex !== null) {
                const from = Math.min(lastClickedRowIndex, rowIndex);
                const to = Math.max(lastClickedRowIndex, rowIndex);
                for (let i = from; i <= to; i++) {
                    const u = visibleUserList[i];
                    if (u) selectedUserIds.add(`${u.role}:${u.id}`);
                }
            } else {
                if (selectedUserIds.has(key)) {
                    selectedUserIds.delete(key);
                } else {
                    selectedUserIds.add(key);
                }
            }
            lastClickedRowIndex = rowIndex;
            updateUserSelectionUI();
            return;
        }

        const btn = e.target.closest('.btn-edit');
        const delBtn = e.target.closest('.btn-delete');
        if (btn) {
            const role = btn.getAttribute('data-role');
            const id = btn.getAttribute('data-id');
            const username = btn.getAttribute('data-username') || '';
            const displayName = btn.getAttribute('data-display-name') || '';
            editId.value = id;
            editRole.value = role;
            editUsername.value = username;
            editDisplayName.value = displayName;
            editPassword.value = '';
            editStatus.textContent = '';
            document.getElementById('user-edit-modal-title').textContent = (role === 'teacher' ? '教師' : '生徒') + 'の編集';
            modal.classList.add('show');
        } else if (delBtn) {
            const role = delBtn.getAttribute('data-role');
            const id = delBtn.getAttribute('data-id');
            const label = role === 'teacher' ? '教師' : '生徒';
            if (!confirm(`この${label}を削除してもよろしいですか？`)) return;
            (async () => {
                try {
                    const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
                    if (res.ok) loadUsers();
                    else alert('削除に失敗しました');
                } catch (err) {
                    alert('通信エラー');
                }
            })();
        }
    });

    // 選択したユーザーを一斉削除
    const btnBulkDelete = document.getElementById('btn-bulk-delete-users');
    if (btnBulkDelete) {
        btnBulkDelete.addEventListener('click', async () => {
            const n = selectedUserIds.size;
            if (n === 0) return;
            if (!confirm(`選択した${n}件のユーザーを削除してもよろしいですか？`)) return;
            btnBulkDelete.disabled = true;
            const toDelete = [...selectedUserIds];
            let ok = 0;
            let ng = 0;
            for (const key of toDelete) {
                const [role, id] = key.split(':');
                try {
                    const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
                    if (res.ok) {
                        ok++;
                        selectedUserIds.delete(key);
                    } else {
                        ng++;
                    }
                } catch (err) {
                    ng++;
                }
            }
            btnBulkDelete.disabled = false;
            loadUsers();
            updateUserSelectionUI();
            if (ng > 0) alert(`${ok}件削除しました。${ng}件は削除に失敗しました。`);
        });
    }
}

async function updateRoomFilter() {
    try {
        const response = await fetch('/admin/stats', { credentials: 'include' });
        const data = await response.json();
        
        // Get unique rooms from players
        const playersResponse = await fetch('/admin/players', { credentials: 'include' });
        const players = await playersResponse.json();
        const rooms = [...new Set(players.map(p => p.room))].sort();
        
        const filterSelect = document.getElementById('room-filter');
        const currentValue = filterSelect.value;
        
        // Clear existing options except "全ルーム"
        filterSelect.innerHTML = '<option value="">全ルーム</option>';
        
        // Add room options
        rooms.forEach(room => {
            const option = document.createElement('option');
            option.value = room;
            option.textContent = room;
            filterSelect.appendChild(option);
        });
        
        // Restore previous selection
        if (currentValue) {
            filterSelect.value = currentValue;
        }
    } catch (error) {
        console.error('Failed to update room filter:', error);
    }
}

async function loadLogs() {
    try {
        const response = await fetch('/admin/logs?limit=100', { credentials: 'include' });
        const logs = await response.json();
        
        const container = document.getElementById('logs-container');
        
        if (logs.length === 0) {
            container.innerHTML = '<div class="loading">ログなし</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => {
            const timestamp = new Date(log.timestamp).toLocaleTimeString('ja-JP');
            return `
                <div class="log-entry ${log.level}">
                    <span class="log-timestamp">[${timestamp}]</span>
                    <span>${escapeHtml(log.message)}</span>
                </div>
            `;
        }).join('');
        
        const scrollEl = container.closest('.server-console-scroll');
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    } catch (error) {
        console.error('Failed to load logs:', error);
        document.getElementById('logs-container').innerHTML = 
            '<div class="loading">エラー: ログの取得に失敗しました</div>';
    }
}

function kickPlayer(socketId) {
    if (!confirm(`プレイヤー ${socketId} をキックしますか？`)) {
        return;
    }
    
    fetch('/admin/kick', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('プレイヤーをキックしました');
            loadPlayers();
        } else {
            alert('エラー: ' + (data.error || 'キックに失敗しました'));
        }
    })
    .catch(error => {
        console.error('Kick error:', error);
        alert('エラー: キックに失敗しました');
    });
}

function muteMic(socketId) {
    if (!confirm('このプレイヤーのマイクを強制ミュートしますか？')) {
        return;
    }
    
    fetch('/admin/mute-mic', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('マイクを強制ミュートしました');
            loadPlayers();
        } else {
            alert('エラー: ' + (data.error || 'ミュートに失敗しました'));
        }
    })
    .catch(error => {
        console.error('Mute error:', error);
        alert('エラー: ミュートに失敗しました');
    });
}

function showAlertModal(socketId) {
    currentAlertTarget = socketId;
    document.getElementById('alert-modal').classList.add('show');
    document.getElementById('alert-message').value = '';
    document.getElementById('alert-message').focus();
}

function setupAlertModal() {
    const modal = document.getElementById('alert-modal');
    const sendBtn = document.getElementById('alert-send-btn');
    const cancelBtn = document.getElementById('alert-cancel-btn');
    const messageInput = document.getElementById('alert-message');
    
    sendBtn.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (!message) {
            alert('メッセージを入力してください');
            return;
        }
        
        sendAlert(currentAlertTarget, message);
        modal.classList.remove('show');
        currentAlertTarget = null;
    });
    
    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('show');
        currentAlertTarget = null;
    });
    
    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
            currentAlertTarget = null;
        }
    });
    
    // Enter key to send
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });
}

function sendAlert(socketId, message) {
    fetch('/admin/send-alert', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId, message })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('メッセージを送信しました');
        } else {
            alert('エラー: ' + (data.error || '送信に失敗しました'));
        }
    })
    .catch(error => {
        console.error('Send alert error:', error);
        alert('エラー: 送信に失敗しました');
    });
}

function formatDuration(seconds) {
    if (seconds < 60) {
        return `${seconds}秒`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}分${secs}秒`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}時間${minutes}分`;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** 利用可能なコマンド名（Tab補完用）。 */
const COMMAND_NAMES = ['ban', 'help', 'list', 'tell', 'tp'];

/** コマンド名補完の候補を返す。prefix に一致するコマンドを返す（空なら全件）。 */
function getCommandCompletions(prefix) {
    const pre = prefix.toLowerCase();
    return COMMAND_NAMES.filter((name) => name.startsWith(pre));
}

/** ワールドID補完の候補を返す。prefix に一致するワールドIDを返す。 */
function getWorldCompletions(prefix) {
    const pre = prefix.toLowerCase();
    return cachedWorldIdsForCompletion.filter((id) => id.toLowerCase().startsWith(pre));
}

/** セレクター補完の候補を返す。prefix は @ の後ろの文字列（小文字で渡す）。返却は @ 付きの文字列の配列。 */
function getSelectorCompletions(prefix) {
    const options = [];
    const pre = prefix.toLowerCase();
    if (pre === '' || 'a'.startsWith(pre)) {
        options.push('@a');
    }
    const usernames = [...new Set(cachedPlayersForCompletion.map((p) => p.username))].sort((a, b) => a.localeCompare(b));
    const maxNoPrefix = 4;
    const maxWithPrefix = 8;
    const max = pre === '' ? maxNoPrefix : maxWithPrefix;

    for (const name of usernames) {
        if (options.length >= max) break;
        if (pre === '' || name.toLowerCase().startsWith(pre)) {
            options.push('@' + name);
        }
    }
    if (pre !== '') {
        for (const p of cachedPlayersForCompletion) {
            if (options.length >= max) break;
            if (p.socketId.startsWith(prefix) && !options.includes('@' + p.socketId)) {
                options.push('@' + p.socketId);
            }
        }
    }
    return options.slice(0, max);
}

/** 入力欄でカーソルを含む単語の範囲とトークン位置を返す。 */
function getCurrentSelectorWord(input) {
    const value = input.value || '';
    const pos = input.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const wordStart = before.lastIndexOf(' ') + 1;
    const word = value.slice(wordStart, pos);
    const parts = before.split(/\s+/);
    const tokenIndex = Math.max(0, parts.length - 1);
    const commandName = (parts[0] || '').toLowerCase();
    return { word, wordStart, wordEnd: pos, tokenIndex, commandName };
}

/** コマンド入力のセレクター補完（@ + Tab/Space）を初期化する。 */
function setupCommandCompletion() {
    const input = document.getElementById('command-input');
    const dropdown = document.getElementById('command-completion-dropdown');
    let completionOptions = [];
    let selectedIndex = 0;

    function hideDropdown() {
        dropdown.setAttribute('aria-hidden', 'true');
        dropdown.innerHTML = '';
        completionOptions = [];
    }

    function showDropdown(options) {
        completionOptions = options;
        selectedIndex = 0;
        dropdown.innerHTML = options.map((opt, i) => {
            const escaped = escapeHtml(opt);
            const sel = i === 0 ? ' selected' : '';
            return `<div class="command-completion-item${sel}" role="option">${escaped}</div>`;
        }).join('');
        dropdown.setAttribute('aria-hidden', 'false');
    }

    function updateSelection(newIndex) {
        const items = dropdown.querySelectorAll('.command-completion-item');
        if (items.length === 0) return;
        selectedIndex = ((newIndex % items.length) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    }

    function confirmSelection() {
        if (completionOptions.length === 0) return;
        const sel = completionOptions[selectedIndex];
        const { wordStart, wordEnd } = getCurrentSelectorWord(input);
        const before = input.value.slice(0, wordStart);
        const after = input.value.slice(wordEnd);
        const newValue = before + sel + ' ' + after;
        input.value = newValue;
        input.selectionStart = input.selectionEnd = wordStart + sel.length + 1;
        hideDropdown();
    }

    function updateCompletionFromInput() {
        const { word, wordStart, tokenIndex, commandName } = getCurrentSelectorWord(input);
        if (tokenIndex === 0) {
            const options = getCommandCompletions(word);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        if (tokenIndex === 1 && word.startsWith('@')) {
            const prefix = word.slice(1);
            const options = getSelectorCompletions(prefix);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        if (tokenIndex === 2 && commandName === 'tp') {
            const options = getWorldCompletions(word);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        hideDropdown();
    }

    input.addEventListener('focus', () => {
        updateCompletionFromInput();
    });

    input.addEventListener('blur', () => {
        hideDropdown();
    });

    input.addEventListener('input', () => {
        updateCompletionFromInput();
    });

    input.addEventListener('keydown', (e) => {
        const visible = dropdown.getAttribute('aria-hidden') !== 'true' && completionOptions.length > 0;

        if (visible) {
            if (e.key === 'Tab') {
                e.preventDefault();
                updateSelection(selectedIndex + 1);
                return;
            }
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                confirmSelection();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideDropdown();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                updateSelection(selectedIndex + 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                updateSelection(selectedIndex - 1);
                return;
            }
        }

        if (e.key === 'Enter') {
            executeCommand();
        }
    });
}

function appendCommandOutput(text, isError = false) {
    const output = document.getElementById('command-output');
    const line = document.createElement('div');
    line.className = isError ? 'command-output-line error' : 'command-output-line';
    line.textContent = text;
    output.appendChild(line);
    const scrollEl = output.closest('.server-console-scroll');
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

async function executeCommand() {
    const input = document.getElementById('command-input');
    const raw = (input.value || '').trim();
    if (!raw) return;
    input.value = '';
    try {
        const res = await fetch('/admin/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: raw }),
            credentials: 'include'
        });
        const data = await res.json();
        loadLogs();
    } catch (e) {
        loadLogs();
    }
}
