import { io } from 'socket.io-client';
import * as THREE from 'three';
import { notifyServiceWorkerInvalidate } from './service-worker-register.js';
import { t } from './metaverse-i18n.js';
import {
    fetchAdminMetaverseEntry,
    isAdminMetaverseEntryPath,
    redirectAdminMetaverseAuthFailed,
} from './admin-metaverse-auth.js';

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
        /** @type {(() => object)|null} report-ping に載せる性能ペイロード */
        this._perfPayloadGetter = null;

        /** @type {(() => object|null)|null} 操縦中の機体姿勢を player-update に同梱 */
        this._getAircraftPoseForNetwork = null;
        /** @type {(() => { position: object, quaternion: object }|null)|null} 操縦中のメインカメラ姿勢（player-update の位置・姿勢） */
        this._getPilotCameraWorldPose = null;
        /** @type {(() => string|null)|null} 同乗中のスロット ID（他クライアントで非表示） */
        this._getPassengeringAircraftId = null;
        /** @type {((list: object[]) => void)|null} */
        this._onAircraftSnapshot = null;
        /** @type {((slotId: string) => void)|null} */
        this._onAircraftReleased = null;
        /** @type {((playerId: string) => boolean)|null} ローカルブロック（クライアントのみ） */
        this._isLocalPlayerBlocked = null;
        /** player-update 操縦時カメラ姿勢用 */
        this._pilotSendQuatScratch = new THREE.Quaternion();
        /** @type {Map<string, boolean>} 前 tick の飛行機搭乗状態（降機検知用） */
        this._remoteAircraftOccupied = new Map();
    }

    /**
     * @param {{ pilotingAircraftId?: string|null, passengeringAircraftId?: string|null }} player
     * @returns {boolean}
     */
    _isPlayerAircraftOccupied(player) {
        return !!(player.pilotingAircraftId || player.passengeringAircraftId);
    }

    /**
     * 搭乗状態の変化を見てリモート可視性と操縦視点ゴースト免除を同期する
     * @param {{ id: string, adminInvisible?: boolean, pilotingAircraftId?: string|null, passengeringAircraftId?: string|null }} player
     */
    _syncRemotePlayerVisible(player) {
        const occupied = this._isPlayerAircraftOccupied(player);
        const wasOccupied = !!this._remoteAircraftOccupied.get(player.id);
        const visible = this._mergedRemoteVisibleForPlayer(player);
        this.playerManager.setRemotePlayerVisible(player.id, visible, {
            exemptFromPilotGhost: wasOccupied && !occupied && visible,
        });
        this._remoteAircraftOccupied.set(player.id, occupied);
    }

    /**
     * リモート表示可否にローカルブロック判定をマージする（players-update 毎に上書きされても維持）
     * @param {(playerId: string) => boolean|null|undefined} fn
     */
    setLocalPlayerBlockedCheck(fn) {
        this._isLocalPlayerBlocked = typeof fn === 'function' ? fn : null;
    }

    /**
     * サーバー条件とローカルブロックをマージしたリモート可視フラグ
     * （操縦・同乗中は他クライアントでアバター非表示）
     * @param {{ id: string, adminInvisible?: boolean, pilotingAircraftId?: string|null, passengeringAircraftId?: string|null }} player
     * @returns {boolean}
     */
    _mergedRemoteVisibleForPlayer(player) {
        const serverOk = !player.adminInvisible
            && !player.pilotingAircraftId
            && !player.passengeringAircraftId;
        const blocked =
            typeof this._isLocalPlayerBlocked === 'function' &&
            this._isLocalPlayerBlocked(player.id);
        return serverOk && !blocked;
    }

    /**
     * ブロック解除直後などに、直近スナップショットに基づき1人分のリモート可視を再計算する
     * @param {string} playerId
     */
    reapplyRemoteVisibilityForPlayer(playerId) {
        if (!playerId || !this.playerManager) return;
        const p = this.lastPlayersSnapshot?.find((x) => x.id === playerId);
        if (!p || p.world !== this.currentWorld) return;
        if (!this.playerManager.hasRemotePlayer(playerId)) return;
        p.pilotingAircraftId = null;
        p.passengeringAircraftId = null;
        this._remoteAircraftOccupied.set(playerId, false);
        this.playerManager.setRemotePlayerVisible(playerId, this._mergedRemoteVisibleForPlayer(p), {
            exemptFromPilotGhost: true,
        });
    }

    /**
     * @param {{ getPose?: () => object|null, onSnapshot?: (list: object[]) => void, onReleased?: (slotId: string) => void }} bridge
     */
    setAircraftNetworkBridge(bridge) {
        const b = bridge && typeof bridge === 'object' ? bridge : {};
        this._getAircraftPoseForNetwork = typeof b.getPose === 'function' ? b.getPose : null;
        this._getPilotCameraWorldPose =
            typeof b.getPilotCameraWorldPose === 'function' ? b.getPilotCameraWorldPose : null;
        this._getPassengeringAircraftId =
            typeof b.getPassengeringAircraftId === 'function' ? b.getPassengeringAircraftId : null;
        this._onAircraftSnapshot = typeof b.onSnapshot === 'function' ? b.onSnapshot : null;
        this._onAircraftReleased = typeof b.onReleased === 'function' ? b.onReleased : null;
    }

    /**
     * report-ping にマージするオブジェクトを返す関数を登録（main.js から設定）
     * @param {() => object} fn
     */
    setPerfPayloadGetter(fn) {
        this._perfPayloadGetter = typeof fn === 'function' ? fn : null;
    }

    /**
     * Socket 接続用 auth（初回・再接続のたびに管理者トークンを新規取得）
     * @returns {Promise<{ adminToken?: string }>}
     */
    async _resolveSocketAuth() {
        if (!isAdminMetaverseEntryPath()) return {};
        const entry = await fetchAdminMetaverseEntry();
        if (!entry) return {};
        if (entry.username) {
            localStorage.setItem('username', entry.username);
            this.username = entry.username;
        }
        return { adminToken: entry.token };
    }

    /**
     * Socket.io サーバーへ接続する（管理者は connect 直前にトークン取得）
     * @returns {Promise<boolean>} 接続開始できたら true（管理者認証失敗時は false）
     */
    async connect() {
        // window.location.origin に統一（Vite プロキシ経由で httpOnly Cookie が Socket に届く）
        const socketUrl = window.location.origin;

        if (isAdminMetaverseEntryPath()) {
            const entry = await fetchAdminMetaverseEntry();
            if (!entry) {
                redirectAdminMetaverseAuthFailed();
                return false;
            }
            localStorage.setItem('username', entry.username);
            this.username = entry.username;
        }

        console.log(`Connecting to Socket.io server at: ${socketUrl}`);

        this.socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            auth: () => this._resolveSocketAuth(),
            withCredentials: true,
        });

        this.socket.io.on('reconnect_attempt', async () => {
            if (!isAdminMetaverseEntryPath()) return;
            const entry = await fetchAdminMetaverseEntry();
            if (entry?.token) {
                this.socket.auth = { adminToken: entry.token };
                if (entry.username) {
                    localStorage.setItem('username', entry.username);
                    this.username = entry.username;
                }
            }
        });

        this.socket.on('connect', () => {
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

        this.socket.on('asset-invalidate', (payload) => {
            const urls = payload && Array.isArray(payload.urls) ? payload.urls : [];
            if (urls.length) notifyServiceWorkerInvalidate(urls);
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
                        await this.playerManager.createRemotePlayer(
                            player.id,
                            player.position,
                            name,
                            player.animState || 'idle'
                        );
                        this._syncRemotePlayerVisible(player);
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
                    await this.playerManager.createRemotePlayer(
                        player.id,
                        player.position,
                        name,
                        player.animState || 'idle'
                    );
                    this._syncRemotePlayerVisible(player);
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
        this.socket.on('username-rejected', async (data) => {
            const msg = data?.message || t('net.adminNameForbidden');
            try {
                await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
            } catch (_) { /* ignore */ }
            localStorage.removeItem('username');
            localStorage.removeItem('userRole');
            this.username = 'Guest';
            alert(msg);
            window.location.href = '/login/';
        });

        this.socket.on('change-world-rejected', (data) => {
            const msg = data?.message || t('net.teleporterDenied');
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
                                await this.playerManager.createRemotePlayer(
                                    player.id,
                                    player.position,
                                    name,
                                    player.animState || 'idle'
                                );
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
                                name,
                                player.animState || 'idle'
                            );
                        }
                        this._syncRemotePlayerVisible(player);
                    } else {
                        // Hide players in different worlds
                        this._remoteAircraftOccupied.delete(player.id);
                        this.playerManager.removeRemotePlayer(player.id);
                    }
                }
            }

            if (snapshot.aircraft && this._onAircraftSnapshot) {
                this._onAircraftSnapshot(snapshot.aircraft);
            }
        });

        this.socket.on('aircraft-initial', (data) => {
            if (Array.isArray(data?.aircraft) && this._onAircraftSnapshot) {
                this._onAircraftSnapshot(data.aircraft);
            }
        });

        this.socket.on('aircraft-released', (data) => {
            const pilotId = data && data.pilotId;
            if (pilotId) {
                this.reapplyRemoteVisibilityForPlayer(String(pilotId));
            }
            const sid = data && data.slotId;
            if (sid && this._onAircraftReleased) {
                this._onAircraftReleased(String(sid));
            }
        });

        // Handle player leaving
        this.socket.on('player-left', (playerId) => {
            console.log('Player left:', playerId);
            this._remoteAircraftOccupied.delete(playerId);
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
        this.socket.on('admin-kicked', async (data) => {
            const message = data && data.message ? data.message : t('net.kicked');
            alert(message);
            try {
                await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
            } catch (_) { /* ignore */ }
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

        this.socket.on('physics-y-correction', (data) => {
            if (this.onPhysicsYCorrection && data && typeof data.y === 'number' && Number.isFinite(data.y)) {
                this.onPhysicsYCorrection(data);
            }
        });

        this.socket.on('physics-position-correction', (data) => {
            if (this.onPhysicsPositionCorrection && data
                && typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number'
                && [data.x, data.y, data.z].every((n) => Number.isFinite(n))) {
                this.onPhysicsPositionCorrection(data);
            }
        });

        return true;
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

    /**
     * player-update 送信用ペイロードを組み立てる
     * @param {import('./character-controller.js').default} characterController
     * @returns {object|null}
     */
    _buildPlayerUpdatePayload(characterController) {
        if (!characterController) return null;

        const camPose = this._getPilotCameraWorldPose?.();
        const position = camPose?.position
            ? { x: camPose.position.x, y: camPose.position.y, z: camPose.position.z }
            : characterController.getPosition();
        const rotation = camPose?.quaternion
            ? this._pilotSendQuatScratch.set(
                  camPose.quaternion.x,
                  camPose.quaternion.y,
                  camPose.quaternion.z,
                  camPose.quaternion.w
              )
            : characterController.getRotation();

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
            animState: characterController.getAnimationState(),
            timestamp: Date.now(),
            world: this.currentWorld,
            adminInvisible: this.adminInvisible,
            passengeringAircraftId: this._getPassengeringAircraftId?.() || null,
        };

        const aircraftPose = this._getAircraftPoseForNetwork?.();
        if (aircraftPose) {
            updateData.aircraftPose = aircraftPose;
        }

        return updateData;
    }

    /**
     * 降機直後などに即座に player-update を送る
     * @param {import('./character-controller.js').default} characterController
     */
    flushPlayerUpdate(characterController) {
        if (!this.socket?.connected) return;
        const updateData = this._buildPlayerUpdatePayload(characterController);
        if (!updateData) return;
        this.socket.emit('player-update', updateData);
    }

    startSendingUpdates(characterController) {
        // Send position/rotation updates at 30fps
        this.updateInterval = setInterval(() => {
            if (!this.socket || !characterController) return;
            const updateData = this._buildPlayerUpdatePayload(characterController);
            if (!updateData) return;
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
            callback({ error: 'not_connected', message: t('net.notConnected') });
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
                    const perf = typeof this._perfPayloadGetter === 'function' ? this._perfPayloadGetter() : {};
                    this.socket.emit('report-ping', { pingMs: rtt, ...perf });
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
