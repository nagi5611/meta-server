import { io } from 'socket.io-client';
import * as THREE from 'three';

class NetworkManager {
    constructor(playerManager) {
        this.socket = null;
        this.playerManager = playerManager;
        this.myPlayerId = null;
        this.updateInterval = null;
        this.pingInterval = null;
        this.disconnectCheckInterval = null;
        this.currentWorld = 'lobby'; // Track current world
        this.username = localStorage.getItem('username') || 'Guest';
        /** 管理者の透明化状態。他プレイヤーに送り、相手側で非表示にする */
        this.adminInvisible = false;
        /** @type {{ id: string, username: string, position: {x,y,z}, vcMicOn: boolean, vcSpeakerOn?: boolean, pingMs?: number|null }[]} */
        this.lastPlayersSnapshot = [];

        // Ping / latency
        this.pingMs = null;
        this.lastPongTime = 0;
        this.NO_RESPONSE_THRESHOLD_MS = 10000;  // 10秒で応答なし表示
        this.DISCONNECT_THRESHOLD_MS = 30000;   // 30秒で切断
    }

    connect() {
        // Use relative path in production, or localhost:3000 in development
        const socketUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? 'http://localhost:3000'
            : window.location.origin;

        console.log(`Connecting to Socket.io server at: ${socketUrl}`);

        const adminToken = sessionStorage.getItem('metaverseAdminToken');
        const auth = adminToken ? { adminToken } : {};
        if (!auth.adminToken) {
            const role = localStorage.getItem('userRole');
            if (role === 'student' || role === 'teacher') auth.role = role;
        }
        this.socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            auth
        });

        this.socket.on('connect', () => {
            if (adminToken) sessionStorage.removeItem('metaverseAdminToken');
            this.myPlayerId = this.socket.id;
            this.lastPongTime = Date.now();
            console.log(`Connected to server. My ID: ${this.myPlayerId}`);

            // Start ping
            this.startPing();
            this.startDisconnectCheck();

            // Send username to server
            this.socket.emit('set-username', this.username);
            console.log(`Sent username to server: ${this.username}`);
        });

        // Handle current players (when joining)
        this.socket.on('current-players', async (players) => {
            console.log('Received current players:', players.length);

            // Create all remote players (with async loading)
            const createPromises = players.map(async (player) => {
                // Only show players in same world
                if (player.id !== this.myPlayerId && player.world === this.currentWorld) {
                    try {
                        const name = player.displayName || player.username;
                        await this.playerManager.createRemotePlayer(player.id, player.position, name);
                        this.playerManager.setRemotePlayerVisible(player.id, !player.adminInvisible);
                    } catch (error) {
                        console.error(`Failed to create remote player ${player.id}:`, error);
                    }
                }
            });

            await Promise.all(createPromises);
            this.updatePlayerCount();
        });

        // Handle new player joining
        this.socket.on('player-joined', async (player) => {
            console.log('Player joined:', player.id);

            // Only show if in same world
            if (player.id !== this.myPlayerId && player.world === this.currentWorld) {
                try {
                    const name = player.displayName || player.username;
                    await this.playerManager.createRemotePlayer(player.id, player.position, name);
                    this.playerManager.setRemotePlayerVisible(player.id, !player.adminInvisible);
                    this.updatePlayerCount();
                } catch (error) {
                    console.error(`Failed to create joining player ${player.id}:`, error);
                }
            }
        });

        // Handle player username updates
        this.socket.on('player-username-updated', (data) => {
            const name = data.displayName || data.username;
            console.log(`Player ${data.id} username updated to: ${name}`);
            this.playerManager.updatePlayerUsername(data.id, name);
        });

        // admin 名でのログイン拒否時（管理者以外）→ エラー表示してログインへ
        this.socket.on('username-rejected', (data) => {
            const msg = data?.message || '「admin」は管理者専用です。';
            localStorage.removeItem('username');
            localStorage.removeItem('userRole');
            this.username = 'Guest';
            alert(msg);
            window.location.href = '/login/';
        });

        this.socket.on('change-world-rejected', (data) => {
            const msg = data?.message || 'このテレポーターは利用できません。';
            alert(msg);
        });

        // Handle player updates (30fps snapshot from server)
        this.socket.on('players-update', async (snapshot) => {
            // Support both old format (array) and new format (object with timestamp)
            const players = snapshot.players || snapshot;
            const serverTimestamp = snapshot.timestamp;
            
            if (!Array.isArray(players)) {
                console.warn('Received invalid players-update format');
                return;
            }

            // Store snapshot for info panel (current room players with vcMicOn)
            this.lastPlayersSnapshot = players.filter(p => p.world === this.currentWorld);

            // Process player updates
            for (const player of players) {
                if (player.id !== this.myPlayerId) {
                    // Only show players in same world
                    if (player.world === this.currentWorld) {
                        // Check if player exists, if not create it
                        if (!this.playerManager.hasRemotePlayer(player.id)) {
                            try {
                                const name = player.displayName || player.username;
                                await this.playerManager.createRemotePlayer(player.id, player.position, name);
                            } catch (error) {
                                console.error(`Failed to create remote player ${player.id} during update:`, error);
                            }
                        } else {
                            // Use quaternion if available, otherwise use rotation
                            const rotation = player.quaternion || player.rotation;
                            const name = player.displayName || player.username;
                            this.playerManager.updateRemotePlayer(
                                player.id,
                                player.position,
                                rotation,
                                name
                            );
                        }
                        this.playerManager.setRemotePlayerVisible(player.id, !player.adminInvisible);
                    } else {
                        // Hide players in different worlds
                        this.playerManager.removeRemotePlayer(player.id);
                    }
                }
            }
        });

        // Handle player leaving
        this.socket.on('player-left', (playerId) => {
            console.log('Player left:', playerId);
            this.playerManager.removeRemotePlayer(playerId);
            this.updatePlayerCount();
        });

        this.socket.on('disconnect', () => {
            this.stopPing();
            this.stopDisconnectCheck();
            this.pingMs = null;
            console.log('Disconnected from server');
        });

        // Handle admin alert
        this.socket.on('admin-alert', (data) => {
            if (data && data.message) {
                alert(data.message);
            }
        });

        // Handle admin kick
        this.socket.on('admin-kicked', (data) => {
            const message = data && data.message ? data.message : '管理者によってキックされました。';
            alert(message);
            // Redirect to login page
            localStorage.removeItem('username');
            localStorage.removeItem('userRole');
            window.location.href = '/login/';
        });

        // Handle admin teleport
        this.socket.on('admin-tp', (data) => {
            if (this.onAdminTp && data && data.world && data.position) {
                this.onAdminTp(data);
            }
        });
    }

    /**
     * 管理者向け: プレイヤー情報を取得（アバタークリック時）
     * @param {string} targetSocketId
     * @param {(data: object) => void} callback
     */
    requestPlayerInfo(targetSocketId, callback) {
        if (!this.socket?.connected || !callback) return;
        this.socket.emit('admin-get-player-info', { targetSocketId }, (data) => {
            callback(data);
        });
    }

    startSendingUpdates(characterController) {
        // Send position/rotation updates at 30fps
        this.updateInterval = setInterval(() => {
            if (!this.socket || !characterController) return;

            const position = characterController.getPosition();
            const rotation = characterController.getRotation();

            // Get Euler angles from quaternion for rotation
            const euler = new THREE.Euler().setFromQuaternion(rotation);

            const updateData = {
                position: {
                    x: position.x,
                    y: position.y,
                    z: position.z
                },
                rotation: {
                    x: euler.x,
                    y: euler.y,
                    z: euler.z
                },
                quaternion: {
                    x: rotation.x,
                    y: rotation.y,
                    z: rotation.z,
                    w: rotation.w
                },
                timestamp: Date.now(), // Add timestamp for server validation
                world: this.currentWorld,
                adminInvisible: this.adminInvisible
            };

            this.socket.emit('player-update', updateData);
        }, 33); // 33ms = ~30fps
    }

    /**
     * 管理者の透明化状態を設定。他プレイヤーには players-update で送られ、相手側で非表示になる。
     * @param {boolean} invisible
     */
    setAdminInvisible(invisible) {
        this.adminInvisible = !!invisible;
    }

    stopSendingUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    updatePlayerCount() {
        const count = this.playerManager.getPlayerCount();
        const countElement = document.getElementById('player-count');
        if (countElement) {
            countElement.textContent = count;
        }
    }

    /**
     * Change to a different world
     * @param {string} worldId - New world ID
     * @param {{ teleporterId?: string }} options - Optional; teleporterId でテレポーター経由の移動をサーバーに伝え権限チェックさせる
     * @param {(err?: { error: string, message?: string }) => void} [callback] - 指定時はサーバー ack で完了/拒否を受け取る（テレポーター利用時）
     */
    changeWorld(worldId, options = {}, callback) {
        const payload = { world: worldId };
        if (options.teleporterId != null && options.teleporterId !== '') payload.teleporterId = options.teleporterId;

        if (this.socket) {
            if (typeof callback === 'function') {
                this.socket.emit('change-world', payload, (res) => {
                    if (res && res.error) {
                        callback(res);
                    } else {
                        this.currentWorld = worldId;
                        this.playerManager.clearRemotePlayers();
                        this.lastPlayersSnapshot = [];
                        callback();
                    }
                });
            } else {
                console.log(`Network: Changing world to ${worldId}`);
                this.currentWorld = worldId;
                this.socket.emit('change-world', payload);
                this.playerManager.clearRemotePlayers();
                this.lastPlayersSnapshot = [];
            }
        } else if (typeof callback === 'function') {
            callback({ error: 'not_connected', message: '接続されていません' });
        }
    }

    disconnect() {
        this.stopSendingUpdates();
        this.stopPing();
        this.stopDisconnectCheck();
        if (this.socket) {
            this.socket.disconnect();
        }
    }

    startPing() {
        this.stopPing();
        const doPing = () => {
            if (!this.socket?.connected) return;
            const ts = Date.now();
            this.socket.emit('ping', { ts }, (res) => {
                if (res?.ts != null) {
                    const rtt = Math.round(Date.now() - res.ts);
                    this.pingMs = rtt;
                    this.lastPongTime = Date.now();
                    this.socket.emit('report-ping', { pingMs: rtt });
                }
            });
        };
        doPing();
        this.pingInterval = setInterval(doPing, 2000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    startDisconnectCheck() {
        this.stopDisconnectCheck();
        this.disconnectCheckInterval = setInterval(() => {
            if (!this.socket?.connected) return;
            const elapsed = Date.now() - this.lastPongTime;
            if (elapsed >= this.DISCONNECT_THRESHOLD_MS) {
                console.warn('[Ping] No response for 30s - disconnecting');
                this.socket.disconnect();
            }
        }, 1000);
    }

    stopDisconnectCheck() {
        if (this.disconnectCheckInterval) {
            clearInterval(this.disconnectCheckInterval);
            this.disconnectCheckInterval = null;
        }
    }

    /**
     * Get ping status for UI
     * @returns {{ pingMs: number|null, noResponse: boolean }}
     */
    getPingStatus() {
        const elapsed = Date.now() - this.lastPongTime;
        const noResponse = elapsed >= this.NO_RESPONSE_THRESHOLD_MS;
        return { pingMs: this.pingMs, noResponse };
    }
}

export default NetworkManager;
