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
        /** @type {ReturnType<typeof setInterval>|null} 応答なし・切断時の再接続試行 */
        this._reconnectInterval = null;
        /** @type {boolean} logout 等の意図的切断 */
        this._intentionalDisconnect = false;
        /** @type {boolean} 再接続試行の同時実行防止 */
        this._reconnectInFlight = false;
        /** @type {boolean} connect() 呼び出し後、初回 connect イベント待ち */
        this._connectionPending = false;
        /** @type {(() => void|Promise<void>)|null} 接続成功時（再接続含む）の追加処理 */
        this._postConnectHandler = null;
        this.currentWorld = 'lobby'; // Track current world
        this.username = localStorage.getItem('username') || 'Guest';
        /** 管理者の透明化状態。他プレイヤーに送り、相手側で非表示にする */
        this.adminInvisible = false;
        /** @type {{ id: string, username: string, position: {x,y,z}, vcMicOn: boolean, vcSpeakerOn?: boolean, pingMs?: number|null }[]} */
        this.lastPlayersSnapshot = [];

        // Ping / latency
        this.pingMs = null;
        this.lastPongTime = 0;
        this.NO_RESPONSE_THRESHOLD_MS = 3000;   // 3秒で応答なし・再接続開始
        this.DISCONNECT_THRESHOLD_MS = 30000;   // 30秒で強制切断（ゾンビ接続の保険）
        this.RECONNECT_TRY_INTERVAL_MS = 3000;  // 応答なし時は3秒ごとに再接続
        this.DISPLAY_READY_CONNECT_WAIT_MS = 1000; // 表示完了時、接続中なら追加で待つ時間
        /** @type {boolean} 表示完了後の接続やり直しを1回だけ行ったか */
        this._displayReadyReconnectAttempted = false;
        /** @type {boolean} restartConnection 中（disconnect で自動再接続しない） */
        this._restartingConnection = false;
        /** @type {{ adminToken?: string }} Socket.io 同期 auth（非 async にしてメインスレッド占有中も即送信） */
        this._cachedSocketAuth = {};
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
        /** @type {((data: { active?: boolean, message?: string, runId?: string|null }) => void)|null} */
        this.onBenchMaintenanceStatus = null;
        /** @type {((data: { active?: boolean, message?: string | null }) => void) | null} */
        this.onServerMaintenanceStatus = null;
        /** @type {Map<string, boolean>} 前 tick の飛行機搭乗状態（降機検知用） */
        this._remoteAircraftOccupied = new Map();
        /** 表示距離内ワールド表示完了までリモートアバター GLB 読み込みを遅延 */
        this._worldViewDisplayReady = false;
        /** @type {object[]} */
        this._pendingRemotePlayerCreates = [];
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
     * 表示距離内のワールド表示が完了するまでリモートアバター作成を遅延する
     * @param {boolean} ready
     */
    setWorldViewDisplayReady(ready) {
        this._worldViewDisplayReady = !!ready;
        if (!ready) {
            this._pendingRemotePlayerCreates = [];
        }
    }

    /**
     * 遅延キューに溜まったリモートプレイヤーを作成する
     */
    async flushPendingRemotePlayers() {
        if (!this._worldViewDisplayReady) return;
        const pending = this._pendingRemotePlayerCreates.splice(0);
        for (const player of pending) {
            try {
                await this._createRemotePlayerIfReady(player);
            } catch (error) {
                console.error(`Failed to create deferred remote player ${player.id}:`, error);
            }
        }
        if (pending.length) {
            this.updatePlayerCount();
        }
    }

    /**
     * @param {object} player
     */
    _queueRemotePlayerCreate(player) {
        if (!player?.id || player.id === this.myPlayerId) return;
        if (player.world !== this.currentWorld) return;
        if (this._pendingRemotePlayerCreates.some((p) => p.id === player.id)) return;
        this._pendingRemotePlayerCreates.push(player);
    }

    /**
     * リモートプレイヤー GLB を作成（表示完了前はキューへ）
     * @param {object} player
     */
    async _createRemotePlayerIfReady(player) {
        if (!player?.id || player.id === this.myPlayerId) return;
        if (player.world !== this.currentWorld) return;

        if (!this._worldViewDisplayReady) {
            this._queueRemotePlayerCreate(player);
            return;
        }

        const name = player.displayName || player.username;
        if (!this.playerManager.hasRemotePlayer(player.id)) {
            await this.playerManager.createRemotePlayer(
                player.id,
                player.position,
                name,
                player.animState || 'idle'
            );
        }
        this._syncRemotePlayerVisible(player);
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
     * 接続成功時（再接続含む）に呼ぶハンドラ
     * @param {() => void|Promise<void>} fn
     */
    setPostConnectHandler(fn) {
        this._postConnectHandler = typeof fn === 'function' ? fn : null;
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
     * @param {Promise<{ token: string, username: string }|null>|null} [adminEntryPromise] 先行取得中の admin トークン
     * @returns {Promise<boolean>} 接続開始できたら true（管理者認証失敗時は false）
     */
    async connect(adminEntryPromise = null) {
        this._intentionalDisconnect = false;
        this._connectionPending = true;
        // window.location.origin に統一（Vite プロキシ経由で httpOnly Cookie が Socket に届く）
        const socketUrl = window.location.origin;

        this._cachedSocketAuth = {};
        if (isAdminMetaverseEntryPath()) {
            const entry = adminEntryPromise
                ? await adminEntryPromise
                : await fetchAdminMetaverseEntry();
            if (!entry) {
                this._connectionPending = false;
                redirectAdminMetaverseAuthFailed();
                return false;
            }
            localStorage.setItem('username', entry.username);
            this.username = entry.username;
            this._cachedSocketAuth = { adminToken: entry.token };
        }

        console.log(`[Net] Attempting connect to ${socketUrl}`);

        // auth は同期オブジェクトのみ（async auth は BVH 等でメインスレッド占有中に
        // 認証パケット送信が遅延し、pingTimeout 45 秒待ちになる）
        this.socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            auth: this._cachedSocketAuth,
            withCredentials: true,
            reconnection: true,
            reconnectionDelay: this.RECONNECT_TRY_INTERVAL_MS,
            reconnectionDelayMax: this.RECONNECT_TRY_INTERVAL_MS,
        });

        this.socket.io.on('reconnect_attempt', async () => {
            if (!isAdminMetaverseEntryPath()) return;
            const entry = await fetchAdminMetaverseEntry();
            if (entry?.token) {
                this._cachedSocketAuth.adminToken = entry.token;
                this.socket.auth = this._cachedSocketAuth;
                if (entry.username) {
                    localStorage.setItem('username', entry.username);
                    this.username = entry.username;
                }
            }
        });

        this.socket.on('connect', () => {
            this.stopReconnectAttempts();
            this._connectionPending = false;
            this.myPlayerId = this.socket.id;
            this.lastPongTime = Date.now();
            console.log(`[Net] Connected. My ID: ${this.myPlayerId}`);

            // Start ping
            this.startPing();
            this.startDisconnectCheck();

            // Send username to server
            this.socket.emit('set-username', this.username);
            console.log(`Sent username to server: ${this.username}`);

            if (this._postConnectHandler) {
                Promise.resolve(this._postConnectHandler()).catch((err) => {
                    console.error('[Net] postConnect handler failed:', err);
                });
            }
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
                if (player.id !== this.myPlayerId && player.world === this.currentWorld) {
                    try {
                        await this._createRemotePlayerIfReady(player);
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
                    await this._createRemotePlayerIfReady(player);
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
            window.location.href = window.metaverseSpawnPending
                ? window.metaverseSpawnPending.appendSpawnQuery('/login/')
                : '/login/';
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
                        if (!this.playerManager.hasRemotePlayer(player.id)) {
                            try {
                                await this._createRemotePlayerIfReady(player);
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
            if (!this._intentionalDisconnect && !this._restartingConnection) {
                this.startReconnectAttempts();
            }
        });

        // Handle admin alert
        this.socket.on('admin-alert', (data) => {
            if (data && data.message) {
                alert(data.message);
            }
        });

        this.socket.on('bench-maintenance-status', (data) => {
            if (this.onBenchMaintenanceStatus) {
                this.onBenchMaintenanceStatus(data);
            }
        });

        this.socket.on('server-maintenance-status', (data) => {
            if (this.onServerMaintenanceStatus) {
                this.onServerMaintenanceStatus(data);
            }
        });

        this.socket.on('bench-maintenance-warning', (data) => {
            if (this.onBenchMaintenanceStatus) {
                this.onBenchMaintenanceStatus({
                    active: true,
                    message:
                        data && data.message
                            ? data.message
                            : undefined,
                });
                return;
            }
            const msg =
                data && data.message
                    ? data.message
                    : '現在ベンチマーク実行中です。接続は維持されます。';
            alert(msg);
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
            window.location.href = window.metaverseSpawnPending
                ? window.metaverseSpawnPending.appendSpawnQuery('/login/')
                : '/login/';
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
        this._intentionalDisconnect = true;
        this._connectionPending = false;
        this.stopSendingUpdates();
        this.stopPing();
        this.stopDisconnectCheck();
        this.stopReconnectAttempts();
        if (this.socket) {
            this.socket.disconnect();
        }
    }

    /**
     * Socket が接続済みか
     * @returns {boolean}
     */
    isSocketConnected() {
        return !!this.socket?.connected;
    }

    /**
     * 接続試行中か（未接続だが socket あり／connect 待ち）
     * @returns {boolean}
     */
    isStillConnecting() {
        if (this.socket?.connected) return false;
        return this._connectionPending || !!this.socket;
    }

    /**
     * 進行中の接続を止めて connect() を最初からやり直す
     * @returns {Promise<boolean>}
     */
    async restartConnection() {
        if (this._intentionalDisconnect) return false;

        this._restartingConnection = true;
        try {
            console.warn('[Net] Aborting in-progress connection and restarting…');
            this.stopSendingUpdates();
            this.stopPing();
            this.stopDisconnectCheck();
            this.stopReconnectAttempts();
            this.pingMs = null;
            this.lastPongTime = 0;
            this.myPlayerId = null;

            if (this.socket) {
                try {
                    if (this.socket.io) this.socket.io.reconnection(false);
                    this.socket.removeAllListeners();
                    this.socket.disconnect();
                } catch (_) { /* ignore */ }
                this.socket = null;
            }

            return await this.connect();
        } finally {
            this._restartingConnection = false;
        }
    }

    /**
     * メタバース表示完了時: まだ接続中なら1秒待ち、未接続なら接続をやり直す（1回のみ）
     * @returns {Promise<boolean>} socket を作り直したら true
     */
    async ensureConnectedAfterDisplayReady() {
        if (this.isSocketConnected()) return false;
        if (!this.isStillConnecting() || this._displayReadyReconnectAttempted) return false;

        console.log('[Net] Display ready but still connecting — waiting 1s…');
        await new Promise((resolve) => {
            setTimeout(resolve, this.DISPLAY_READY_CONNECT_WAIT_MS);
        });

        if (this.isSocketConnected()) return false;

        this._displayReadyReconnectAttempted = true;
        await this.restartConnection();
        return true;
    }

    /**
     * ping 応答が一定時間無いか
     * @returns {boolean}
     */
    _isUnresponsive() {
        if (!this.socket?.connected) return false;
        return Date.now() - this.lastPongTime >= this.NO_RESPONSE_THRESHOLD_MS;
    }

    /** 応答なし・切断中に3秒ごと再接続を試みる */
    startReconnectAttempts() {
        if (this._intentionalDisconnect || this._reconnectInterval) return;
        this._reconnectInterval = setInterval(() => {
            void this._tryReconnect();
        }, this.RECONNECT_TRY_INTERVAL_MS);
        void this._tryReconnect();
    }

    stopReconnectAttempts() {
        if (this._reconnectInterval) {
            clearInterval(this._reconnectInterval);
            this._reconnectInterval = null;
        }
        this._reconnectInFlight = false;
    }

    /**
     * ゾンビ接続の切断または socket.connect() で復旧を試みる
     */
    async _tryReconnect() {
        if (this._intentionalDisconnect || !this.socket || this._reconnectInFlight) return;

        if (this.socket.connected && !this._isUnresponsive()) {
            this.stopReconnectAttempts();
            return;
        }

        this._reconnectInFlight = true;
        try {
            if (this.socket.connected && this._isUnresponsive()) {
                console.warn('[Net] No server response for 3s — forcing disconnect before reconnect');
                this.socket.disconnect();
            }

            if (!this.socket.connected) {
                if (isAdminMetaverseEntryPath()) {
                    const entry = await fetchAdminMetaverseEntry();
                    if (entry?.token) {
                        this._cachedSocketAuth.adminToken = entry.token;
                        this.socket.auth = this._cachedSocketAuth;
                        if (entry.username) {
                            localStorage.setItem('username', entry.username);
                            this.username = entry.username;
                        }
                    }
                }
                console.log('[Net] Attempting reconnect…');
                this.socket.connect();
            }
        } catch (err) {
            console.warn('[Net] Reconnect attempt failed:', err);
        } finally {
            this._reconnectInFlight = false;
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
            if (!this.socket?.connected) {
                if (!this._intentionalDisconnect) {
                    this.startReconnectAttempts();
                }
                return;
            }
            const elapsed = Date.now() - this.lastPongTime;
            if (elapsed >= this.NO_RESPONSE_THRESHOLD_MS && !this._intentionalDisconnect) {
                this.startReconnectAttempts();
            }
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
     * @returns {{ pingMs: number|null, noResponse: boolean, connecting: boolean, reconnecting: boolean }}
     */
    getPingStatus() {
        const reconnecting = !!this._reconnectInterval;
        const connected = !!this.socket?.connected;

        if (!connected) {
            const connecting = this._connectionPending || reconnecting || !!this.socket;
            return { pingMs: null, noResponse: false, connecting, reconnecting };
        }

        if (this.lastPongTime <= 0) {
            return { pingMs: null, noResponse: false, connecting: true, reconnecting: false };
        }

        const elapsed = Date.now() - this.lastPongTime;
        const noResponse = elapsed >= this.NO_RESPONSE_THRESHOLD_MS;
        return { pingMs: this.pingMs, noResponse, connecting: false, reconnecting: false };
    }
}

export default NetworkManager;
