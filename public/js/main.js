import * as THREE from 'three';
import './addons/registry-game.js';
import SceneManager from './scene-manager.js';
import PhysicsManager from './physics-manager.js';
import CharacterController from './character-controller.js';
import PlayerManager from './player-manager.js';
import NetworkManager from './network-manager.js';
import WorldManager from './world-manager.js';
import TeleportManager from './teleport-manager.js';
import UIManager from './ui-manager.js';
import ChatManager from './chat-manager.js';
import PlayerBlockList from './player-block-list.js';
import PlayerActionMenu from './player-action-menu.js';
import MenuManager from './menu-manager.js';
import VoiceChatManager from './voice-chat-manager.js';
import CaptionManager from './caption-manager.js';
import VideoChatManager from './video-chat-manager.js';
import PdfViewerVoiceChatManager from './pdf-viewer-voice-chat-manager.js';
import PdfViewerManager from './pdf-viewer-manager.js';
import { isMobile, setupFullscreen, tryLockLandscape, onControlSchemeChange, ensureControlSchemeChosen } from './mobile-utils.js';
import MobileJoystickManager from './mobile-joystick-manager.js';
import MobileUIManager from './mobile-ui-manager.js';
import IdleControlHint from './idle-control-hint.js';
import { registerMetaverseServiceWorker } from './service-worker-register.js';
import { renderMetaversePortalNav } from './metaverse-portal-nav.js';
import {
    runClientInits,
    runFrameUpdates,
    runClientDisposes,
    getImmersiveState,
} from '../../lib/client-addon-registry.js';
import { initAircraftSubsystem } from '../../addons/aircraft/client/init.js';
import { initAvatorScalableAnimations } from '../../addons/avator-scalable-animations/client/init.js';
import { initMatsuyamaFlightsSubsystem } from '../../addons/matsuyama-flights/client/init.js';
import { t, applyMetaverseI18nToDocument } from './metaverse-i18n.js';
import { loadClientConfigOnce } from './asset-resolve.js';
import { runEntryWelcomeIfPending } from './metaverse-entry-welcome.js';
import { peekPendingEntryWelcome } from './login-preload-state.js';
import { startLoginWorldPreload, clearLoginPreloadState } from './world-preload.js';
import { fetchAdminMetaverseEntry, isAdminCameraEntryPath, isAdminMetaverseEntryPath } from './admin-metaverse-auth.js';
import AdminCameraController from './admin-camera-controller.js';
import AdminCameraRecorder from './admin-camera-recorder.js';
import {
    applyClientSpawnPlan,
    tryResolveClientSpawn,
} from '../../lib/client-spawn-registry.js';

const DEFAULT_ROOM = 'lobby';

/**
 * 共有用 deep link からワールド ID を読む（?world=… または #world=…）
 * @returns {string|null}
 */
function getWorldIdFromUrl() {
    try {
        const fromQuery = new URLSearchParams(window.location.search).get('world');
        if (fromQuery != null) {
            const id = String(fromQuery).trim();
            if (id) return id;
        }
        const rawHash = window.location.hash.replace(/^#/, '');
        if (rawHash.startsWith('world=')) {
            const id = rawHash.slice('world='.length).split('&')[0].trim();
            if (id) return decodeURIComponent(id);
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

class MetaverseApp {
    constructor() {
        this.sceneManager = null;
        this.physicsManager = null;
        this.characterController = null;
        this.playerManager = null;
        this.networkManager = null;
        this.worldManager = null;
        this.teleportManager = null;
        this.uiManager = null;
        this.chatManager = null;
        this.captionManager = null;
        this.menuManager = null;
        this.voiceChatManager = null;
        this.videoChatManager = null;
        this.pdfViewerVoiceChatManager = null;
        this.pdfViewerManager = null;
        this.taikoGameManager = null;
        this.aircraftController = null;
        this.aircraftManager = null;
        this.clock = 0;
        this.isPageVisible = true;
        this.nearbyPdfPath = null;
        this.isMobileMode = false;
        this.resizeUnsubscribe = null;
        this._frameCallback = null;
        /** @type {'first'|'third'|null} 没入開始前の視点モード（終了時に復元） */
        this._viewModeBeforeVr = null;

        // public/js/main.js — report-ping 用クライアント性能サンプル（FPS 1s/10s、LoAF/longtask）
        /** @type {number|null} */
        this._perfLastFpsSample = null;
        /** @type {number|null} */
        this._perfFpsSampleAtMs = null;
        /** @type {'low'|'medium'|'high'} */
        this._lastPerfTier = 'high';
        this._perfLoafAccum = 0;
        this._perfLongtaskAccum = 0;
        /** @type {PerformanceObserver|null} */
        this._perfLoafObserver = null;
        /** @type {PerformanceObserver|null} */
        this._perfLongtaskObserver = null;
        this._perfFpsSamplingActive = false;
        this._perfFpsFrames = 0;
        /** @type {number} */
        this._perfFpsSampleEndAt = 0;
        /** @type {number} */
        this._perfNextFpsWindowAt = 0;

        /** ワールド読込完了後に change-world 同期する */
        this._worldReadyForNetwork = false;
        this._networkConnectPendingRoomSync = false;

        /** 操縦中 updateLocalPlayer 用（カメラ姿勢の再利用バッファ） */
        this._pilotCamPosScratch = new THREE.Vector3();
        this._pilotCamQuatScratch = new THREE.Quaternion();

        // Setup page visibility handling
        this.setupPageVisibility();
    }
    
    setupPageVisibility() {
        // Handle tab visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Tab became hidden
                this.isPageVisible = false;
                console.log('Tab hidden - pausing physics');
            } else {
                // Tab became visible again
                this.isPageVisible = true;
                // Reset clock to prevent huge deltaTime
                this.clock = performance.now();
                console.log('Tab visible - resuming physics');
            }
        });
    }

    /**
     * 操作方式選択の裏で実行するコア初期化（シーン・物理・ワールド読込・Socket 接続）
     */
    async _bootstrapCore() {
        let chartFeaturesEnabled = true;
        try {
            const cfg = await loadClientConfigOnce();
            if (cfg && typeof cfg === 'object' && typeof cfg.chartFeaturesEnabled === 'boolean') {
                chartFeaturesEnabled = cfg.chartFeaturesEnabled;
            }
        } catch (_) {
            /* 既定の true のまま */
        }

        this.sceneManager = new SceneManager();
        this.sceneManager.init();

        this.physicsManager = new PhysicsManager();
        await this.physicsManager.init();

        this.uiManager = new UIManager();

        this.worldManager = new WorldManager(this.sceneManager);
        await this.worldManager.init();

        this.worldManager.setWorldLoadUiHandlers({
            begin: (opts) => this.uiManager.showWorldLoadProgress(opts.totalCount, opts),
            progress: (detail) => this.uiManager.updateWorldLoadProgress(detail),
            finalize: (beforePaint) => this.uiManager.finalizeWorldLoadProgress(beforePaint),
            onLoadStart: () => {
                this.networkManager?.setWorldViewDisplayReady(false);
            },
            onLoadComplete: async () => {
                this.networkManager?.setWorldViewDisplayReady(true);
                await this.networkManager?.flushPendingRemotePlayers();
            },
        });

        this.sceneManager.physicsManager = this.physicsManager;
        this.physicsManager.setSpawnPointGetter(() => this.worldManager.getSpawnPoint());

        window.addEventListener('metaverse-model-load-guard', (ev) => {
            const d = ev.detail || {};
            if (d.reason === 'file_too_large') {
                console.warn('[Metaverse] モデルが大きすぎるため読み込みをスキップ:', d.path);
            } else if (d.reason === 'too_many_triangles') {
                console.warn('[Metaverse] ポリゴン過多のため読み込みをスキップ:', d.path);
            }
        });

        this.teleportManager = new TeleportManager(this.worldManager, this.uiManager);
        this.userRole = isAdminMetaverseEntryPath() ? 'admin' : (localStorage.getItem('userRole') || 'guest');
        this.isAdminCameraMode = isAdminCameraEntryPath();
        this.teleportManager.setUserRole(this.userRole);
        this.teleportManager.setTeleportCallback((destinationWorld, teleporterId) => {
            if (this.aircraftManager) this.aircraftManager.forceLocalPilotingReset();
            this.networkManager.changeWorld(destinationWorld, { teleporterId }, (err) => {
                if (err) {
                    alert(err.message || t('main.teleporterError'));
                    return;
                }
                this.worldManager.switchWorld(destinationWorld);
            });
        });

        this.pdfViewerManager = new PdfViewerManager();
        this.pdfViewerManager.init();
        this.teleportManager.setPdfCallbacks(
            () => this.nearbyPdfPath,
            async (path) => {
                if (this.pdfViewerManager.isOpen()) {
                    await this.pdfViewerManager.close();
                } else {
                    await this.pdfViewerManager.open(path);
                    if (this.pdfViewerVoiceChatManager) {
                        try {
                            await this.pdfViewerVoiceChatManager.joinRoom(path);
                            this.pdfViewerManager.updatePdfVcButtonState?.();
                        } catch (e) {
                            console.error('[PDF VC] joinRoom failed:', e);
                        }
                    }
                    document.exitPointerLock();
                    this.characterController.resetMovement();
                }
            }
        );

        if (chartFeaturesEnabled) {
            const { default: TaikoGameManager } = await import('./taiko-game-manager.js');
            this.taikoGameManager = new TaikoGameManager();
            this.taikoGameManager.init();
            this.teleportManager.setTaikoCallback((zone) => {
                this.taikoGameManager.open(zone || null);
                document.exitPointerLock();
                this.characterController.resetMovement();
            });
        } else {
            this.teleportManager.setTaikoCallback(null);
        }
        this.teleportManager.setGlbInteractPlayHandler((zone) => {
            if (!zone || !zone.model) return;
            this.sceneManager.playGlbInteractAnimation(zone.model, zone.clipName);
        });
        this.uiManager.setMobileInteractAction(() => {
            if (this.teleportManager) this.teleportManager.handleTeleport();
        });

        const spawnPlan = await tryResolveClientSpawn();
        const defaultWorldId = this.worldManager.getWorld('lobby') ? 'lobby' : (this.worldManager.getAllWorlds()[0]?.id || 'lobby');
        const urlWorldId = getWorldIdFromUrl();
        let initialWorldId = defaultWorldId;
        if (spawnPlan?.worldId && this.worldManager.getWorld(spawnPlan.worldId)) {
            initialWorldId = spawnPlan.worldId;
        } else if (urlWorldId && this.worldManager.getWorld(urlWorldId)) {
            initialWorldId = urlWorldId;
        }
        if (spawnPlan?.worldId && spawnPlan.worldId !== initialWorldId) {
            console.warn(`[spawn] Unknown world in spawn token, using default: ${spawnPlan.worldId}`);
        }
        if (!spawnPlan?.worldId && urlWorldId && urlWorldId !== initialWorldId) {
            console.warn(`Unknown world in URL, using default: ${urlWorldId}`);
        }
        console.log('Loading world:', initialWorldId);

        const adminEntryPromise = isAdminMetaverseEntryPath()
            ? fetchAdminMetaverseEntry()
            : null;

        this.playerManager = new PlayerManager(this.sceneManager.getScene());
        this.playerBlockList = new PlayerBlockList();
        this.networkManager = new NetworkManager(this.playerManager);
        this.networkManager.setWorldViewDisplayReady(false);
        this.networkManager.setLocalPlayerBlockedCheck((id) => this.playerBlockList.has(id));
        this.networkManager.currentWorld = initialWorldId;
        this.networkManager.onAdminTp = (data) => this.onAdminTp(data);
        this.networkManager.onBenchMaintenanceStatus = (data) => {
            this.uiManager.setBenchRunningBanner(!!(data && data.active), data?.message);
        };
        this.networkManager.onServerMaintenanceStatus = (data) => {
            this.uiManager.setServerMaintenanceInline(!!(data && data.active), data?.message ?? undefined);
        };
        this.setupClientPerfObservers();
        this.networkManager.setPerfPayloadGetter(() => this.getPerfPayloadForPing());
        this.networkManager.setPostConnectHandler(async () => {
            await this._onNetworkPostConnect();
            await this._joinVoiceAndVideoIfReady();
        });
        this._onMetaverseLocaleChanged = (ev) => {
            const loc = ev?.detail?.locale;
            if (loc) {
                this.networkManager?.emitUiLocale(loc);
            }
        };
        window.addEventListener('metaverse-locale-changed', this._onMetaverseLocaleChanged);
        this._entryNetworkConnectPromise = this.networkManager.connect(adminEntryPromise);

        await startLoginWorldPreload(initialWorldId);

        await this.worldManager.loadWorld(initialWorldId, () => {
            console.log('World loaded:', initialWorldId);
            this.updateGoogleMapsCopyrightVisibility(this.worldManager.getCurrentWorld());
            this.updateTeleportZones();
            this.updateTaikoZones();
            this.updateGlbInteractZones();
            this._worldReadyForNetwork = true;
            if (this._networkConnectPendingRoomSync) {
                this._networkConnectPendingRoomSync = false;
                this._applyInitialRoomSync();
            }
            clearLoginPreloadState();
        });

        const worldSpawn = this.worldManager.getSpawnPoint();
        this._entrySpawnPlan = spawnPlan;
        this._entrySpawnPoint = spawnPlan?.position
            ? { x: spawnPlan.position.x, y: spawnPlan.position.y, z: spawnPlan.position.z }
            : worldSpawn;
    }

    async init() {
        console.log('Initializing Metaverse Simple...');

        registerMetaverseServiceWorker();
        applyMetaverseI18nToDocument();

        // ログイン経由: Welcome（5秒）＋ワールド取得を並行 → 操作形式選択
        // 直接入場: 従来どおり操作形式選択とワールド取得を並行
        if (peekPendingEntryWelcome()) {
            await runEntryWelcomeIfPending(() => this._bootstrapCore());
            await ensureControlSchemeChosen();
        } else {
            await ensureControlSchemeChosen(() => this._bootstrapCore());
        }
        applyMetaverseI18nToDocument();

        const spawnPlan = this._entrySpawnPlan;
        const spawnPoint = this._entrySpawnPoint;
        const networkConnectPromise = this._entryNetworkConnectPromise;

        this.isMobileMode = isMobile() && !this.isAdminCameraMode;
        if (this.isAdminCameraMode) {
            this.characterController = new AdminCameraController(
                this.sceneManager.getCamera(),
                { baseFov: this.sceneManager.getCamera().fov }
            );
        } else {
            this.characterController = new CharacterController(
                this.sceneManager.getCamera(),
                this.physicsManager,
                { isMobileMode: this.isMobileMode }
            );
        }
        this.teleportManager.setInputActiveCheck(() => this.characterController.isInputActive());

        this.networkManager.onPhysicsYCorrection = (data) => {
            const p = this.characterController.getPosition();
            const x = p.x;
            const z = p.z;
            this.characterController.setPosition(x, data.y, z);
            this.characterController.resetVelocity();
            this.playerManager.updateLocalPlayer(
                { x, y: data.y, z },
                this.characterController.getRotation()
            );
        };
        this.networkManager.onPhysicsPositionCorrection = (data) => {
            if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;
            if (![data.x, data.y, data.z].every((n) => Number.isFinite(n))) return;
            this.characterController.setPosition(data.x, data.y, data.z);
            this.characterController.resetVelocity();
            this.playerManager.updateLocalPlayer(
                { x: data.x, y: data.y, z: data.z },
                this.characterController.getRotation()
            );
        };

        // Set initial position
        if (spawnPlan && typeof spawnPlan.yaw === 'number' && Number.isFinite(spawnPlan.yaw)) {
            this.characterController.cameraYaw = (spawnPlan.yaw * Math.PI) / 180;
        }
        this.characterController.setPosition(spawnPoint.x, spawnPoint.y, spawnPoint.z);

        this.characterController.setPosition(spawnPoint.x, spawnPoint.y, spawnPoint.z);

        if (!this.isAdminCameraMode) {
            console.log('Loading player avatar...');
            try {
                await this.playerManager.createLocalPlayer(spawnPoint);
                console.log('Player avatar loaded successfully');
            } catch (error) {
                console.error('Failed to create player avatar:', error);
            }
        } else if (this.networkManager) {
            this.networkManager.setAdminInvisible(true);
        }

        try {
            await initAircraftSubsystem(this);
        } catch (e) {
            console.warn('[Aircraft] init failed', e);
        }
        initAvatorScalableAnimations(this);
        initMatsuyamaFlightsSubsystem(this).catch((e) => console.warn('[matsuyama-flights] init failed', e));

        const connected = await networkConnectPromise;
        if (!connected) return;
        if (spawnPlan) {
            await applyClientSpawnPlan(this, spawnPlan);
        }
        this.networkManager.startSendingUpdates(this.characterController);
        if (this.pdfViewerManager) this.pdfViewerManager.setSocket(this.networkManager.socket);
        if (this.taikoGameManager) this.taikoGameManager.setSocket(this.networkManager.socket);

        // Initialize voice chat manager (room VC)
        this.voiceChatManager = new VoiceChatManager(this.networkManager.socket);

        // Initialize video chat manager (Video VC - camera/screen share)
        this.videoChatManager = new VideoChatManager(this.networkManager.socket);

        // Initialize PDF viewer voice chat manager (PDF-only VC)
        this.pdfViewerVoiceChatManager = new PdfViewerVoiceChatManager(this.networkManager.socket);
        if (this.pdfViewerManager) {
            this.pdfViewerManager.setPdfViewerVoiceChatManager(this.pdfViewerVoiceChatManager);
            this.pdfViewerManager.setOnClose(async () => {
                if (this.pdfViewerVoiceChatManager) await this.pdfViewerVoiceChatManager.leaveRoom();
            });
        }

        await this._joinVoiceAndVideoIfReady();

        if (!this.isAdminCameraMode) {
            // Initialize chat manager (モバイル時は初期でアイコンのみ表示)
            this.chatManager = new ChatManager(
                this.networkManager,
                this.playerManager,
                this.sceneManager,
                { initialMinimized: this.isMobileMode }
            );
            this.chatManager.setCharacterController(this.characterController);
            this.chatManager.setPlayerBlockedCheck((id) => this.playerBlockList.has(id));

            // Initialize caption manager (リアルタイム音声字幕の表示)
            this.captionManager = new CaptionManager(
                this.networkManager,
                this.playerManager,
                this.sceneManager
            );
            this.captionManager.setCharacterController(this.characterController);
            this.captionManager.setPlayerBlockedCheck((id) => this.playerBlockList.has(id));
        } else {
            document.documentElement.dataset.adminCameraMode = 'true';
            document.body.dataset.adminCameraMode = 'true';
            const chatEl = document.getElementById('chat-container');
            if (chatEl) chatEl.style.display = 'none';
        }

        this.playerActionMenu = new PlayerActionMenu({
            blockList: this.playerBlockList,
            chatManager: this.chatManager,
            networkManager: this.networkManager,
            playerManager: this.playerManager,
        });
        this._onMetaversePlayerNameMenu = (ev) => {
            const d = ev.detail;
            if (!d?.anchorEl || !d.playerId) return;
            this.playerActionMenu.open(d.anchorEl, {
                playerId: d.playerId,
                displayName: d.displayName || 'Player',
            });
        };
        window.addEventListener('metaverse-player-name-menu', this._onMetaversePlayerNameMenu);
        this.uiManager.setPlayerBlockedCheck((id) => this.playerBlockList.has(id));
        this.uiManager.setOnPlayerListNameMenu((playerId, displayName, anchorEl) => {
            this.playerActionMenu.open(anchorEl, { playerId, displayName });
        });
        this.uiManager.setOnPlayerListBlockedClick((playerId) => {
            this.playerBlockList.remove(playerId);
            this.networkManager.reapplyRemoteVisibilityForPlayer(playerId);
        });

        if (this.isMobileMode) {
            MobileJoystickManager.init(this.characterController);
            MobileUIManager.init();
            this.setupMobileFullscreen();
        }

        this.resizeUnsubscribe = onControlSchemeChange((nowMobile) => {
            if (nowMobile === this.isMobileMode) return;
            this.isMobileMode = nowMobile;
            this.characterController.setMobileMode(nowMobile);
            if (this.aircraftManager) this.aircraftManager.setMobileMode(nowMobile);
            if (nowMobile) {
                if (
                    this.aircraftManager?.isPiloting
                    && this.aircraftManager.activeSlot?.controlMode === 'easy'
                ) {
                    this.syncMobileAircraftControls?.();
                } else if (!this.aircraftManager?.isPiloting && !this.aircraftManager?.isPassenger) {
                    MobileJoystickManager.init(this.characterController);
                }
                MobileUIManager.init();
                this.setupMobileFullscreen();
                if (this.chatManager && !this.chatManager.isMinimized) this.chatManager.toggleMinimize();
            } else {
                MobileJoystickManager.destroy();
                MobileUIManager.destroy();
                if (this.aircraftManager) {
                    this.syncMobileAircraftControls?.();
                }
            }
        });

        // Initialize menu manager
        this.menuManager = new MenuManager();
        
        // Connect menu manager to voice chat and video chat
        this.menuManager.setVoiceChatManager(this.voiceChatManager);
        this.menuManager.setVideoChatManager(this.videoChatManager);
        // Connect menu manager to captions (字幕トグル)
        if (this.captionManager) this.menuManager.setCaptionManager(this.captionManager);
        this.menuManager.setReturnToLobbyCallback(() => {
            const world = this.worldManager.getWorld('lobby');
            if (world) this.worldManager.loadWorld('lobby', () => {});
        });
        this.menuManager.setRestartWorldCallback(async () => {
            if (this.aircraftManager?.isPiloting) {
                await this.aircraftManager.exitPiloting();
            }
            if (this.aircraftManager?.isPassenger) {
                this.aircraftManager.exitPassenger();
            }
            try {
                document.exitPointerLock();
            } catch (_) {
                /* 未ロック時など */
            }
            this.characterController.resetMovement();
            const sp = this.worldManager.getSpawnPoint();
            this.characterController.setPosition(sp.x, sp.y, sp.z);
            this.characterController.resetVelocity();
            this.playerManager.updateLocalPlayer(
                { x: sp.x, y: sp.y, z: sp.z },
                this.characterController.getRotation()
            );
        });
        this.menuManager.setSceneManager(this.sceneManager);
        this.menuManager.setPlayerManager(this.playerManager);
        this.sceneManager.applyGraphicsSettings(this.menuManager.settings);
        this.playerManager.applyVisualMode(this.menuManager.settings.visualMode);
        this.characterController.setHeadPositionProvider((out) => this.playerManager.getLocalHeadWorldPosition(out));

        this.refreshLocalAvatarVisibility = () => {
            if (!this.playerManager) return;
            const mode = this.menuManager?.settings?.viewMode || 'third';
            const hideForFirst = mode === 'first';
            const hideForAdmin = !!(this.networkManager && this.networkManager.adminInvisible);
            const isPassenger = !!(this.aircraftManager && this.aircraftManager.isPassenger);
            const isPilot = !!(this.aircraftManager && this.aircraftManager.isPiloting);
            this.playerManager.setLocalPlayerVisible(!hideForFirst && !hideForAdmin && !isPassenger);
            this.playerManager.setLocalPlayerAircraftPilotGhostMode(!!isPilot);
            this.playerManager.setAircraftPilotViewGhostRemotes(!!isPilot);
        };
        this.aircraftManager?.setOnPilotingChange?.(() => {
            if (!this.aircraftManager?.isPiloting && !this.aircraftManager?.isPassenger) {
                this.characterController?.setViewMode(this.menuManager?.settings?.viewMode || 'third');
            }
            this.refreshLocalAvatarVisibility();
            this.syncMobileAircraftControls?.();
        });

        this.characterController.setViewMode(this.menuManager.settings.viewMode || 'third');
        this.refreshLocalAvatarVisibility();
        this.menuManager.setViewModeChangeHandler((mode) => {
            this.characterController.setViewMode(mode);
            this.refreshLocalAvatarVisibility();
        });

        // Admin quick controls (透明化 / 飛行 / 高速移動) — カメラログイン時は専用 HUD
        if (this.userRole === 'admin' && this.menuManager && !this.isAdminCameraMode) {
            this.menuManager.setAdminMenuHandlers({
                onInvisibleChange: (enabled) => {
                    if (this.networkManager) {
                        this.networkManager.setAdminInvisible(enabled);
                    }
                    this.refreshLocalAvatarVisibility();
                },
                onFlyChange: (enabled) => {
                    if (this.characterController) {
                        this.characterController.setFlyMode(enabled);
                    }
                },
                onSpeedChange: (enabled) => {
                    if (this.characterController) {
                        this.characterController.setAdminSpeedMultiplier(enabled ? 3 : 1);
                    }
                }
            });
        }

        // プレイヤー一覧の「視聴」ボタン → 指定ユーザーの配信に接続して表示
        this.uiManager.setOnWatchVideo((peerId) => {
            if (this.videoChatManager) this.videoChatManager.showVideoContainer(peerId);
        });

        // Vキー: 歩行時は1/3人称切替（配信中は視聴優先）。飛行機中は aircraft-manager が視点サイクル。
        document.addEventListener('keydown', (e) => {
            if (e.code !== 'KeyV' || e.repeat) return;
            if (this.aircraftManager?.isPiloting || this.aircraftManager?.isPassenger) return;
            if (this.sceneManager?.getRenderer?.()?.xr?.isPresenting) return;
            const input = document.activeElement?.tagName?.toLowerCase();
            if (input === 'input' || input === 'textarea') return;
            const videoOn = (this.networkManager?.lastPlayersSnapshot || []).find(p => p.vcVideoOn);
            if (videoOn && this.videoChatManager) {
                console.log('[視聴] Vキーで視聴開始 - peerId:', videoOn.id);
                this.videoChatManager.showVideoContainer(videoOn.id);
                return;
            }
            this.menuManager?.toggleViewMode?.();
        });

        // Setup world change handler
        this.worldManager.onWorldChange((world) => {
            this.onWorldChanged(world);
        });
        // 初回ロード済みワールドの帰属表示を再同期（onWorldChange 登録前に読み込んだ場合の保険）
        this.updateGoogleMapsCopyrightVisibility(this.worldManager.getCurrentWorld());

        // Admin: プレイヤーアバタークリックで情報表示（カメラログインは非表示のため除外）
        if (isAdminMetaverseEntryPath() && !this.isAdminCameraMode) {
            this.setupAdminPlayerInfoClick();
        }

        if (this.isAdminCameraMode) {
            this.adminCameraRecorder = new AdminCameraRecorder({
                renderer: this.sceneManager.getRenderer(),
                scene: this.sceneManager.getScene(),
                camera: this.sceneManager.getCamera(),
            });
            this.adminCameraRecorder.bindZoomSlider((factor) => {
                this.characterController?.setZoomFactor?.(factor);
            });
            const adminMenuBtn = document.getElementById('admin-menu-btn');
            if (adminMenuBtn) adminMenuBtn.style.display = 'none';
        }

        await runClientInits(this);

        // 初回操作まで歩行・落下物理を止める（カメラモードは物理なし）
        if (!this.isAdminCameraMode) {
            this.characterController.setSuspendPhysicsUntilGameplayInput(true);
        }

        // 表示完了時点でまだ接続中なら1秒待ち、未接続なら接続処理をやり直す
        const socketRestarted = await this.networkManager.ensureConnectedAfterDisplayReady();
        if (socketRestarted) {
            this._rewireSocketConsumers();
            void this._joinVoiceAndVideoIfReady();
        }

        // Start game loop (WebXR 対応の setAnimationLoop)
        this.clock = performance.now();
        this._perfNextFpsWindowAt = performance.now() + 10000;
        this._frameCallback = (time, frame) => this.frameUpdate(time, frame);
        const renderer = this.sceneManager.getRenderer();
        renderer.setAnimationLoop(this._frameCallback);
        window.addEventListener('beforeunload', () => {
            renderer.setAnimationLoop(null);
            this.adminCameraRecorder?.dispose?.();
            runClientDisposes(this);
        });

        IdleControlHint.start(this);

        if (this.isAdminCameraMode) {
            IdleControlHint.stop?.();
        }

        console.log('Metaverse Simple initialized!');
        if (this.isAdminCameraMode) {
            console.log('Admin camera mode: WASD move, drag look, right-drag roll, Enter to capture');
        } else if (this.isMobileMode) {
            console.log('Mobile mode: use virtual joysticks');
        } else {
            console.log('Click to lock pointer, then use WASD to move, Space to jump');
        }
    }

    setupMobileFullscreen() {
        const tryFullscreen = async () => {
            const ok = await setupFullscreen();
            if (ok) await tryLockLandscape();
        };
        document.body.addEventListener('click', tryFullscreen, { once: true });
        document.body.addEventListener('touchstart', tryFullscreen, { once: true, passive: true });
    }

    updateLandscapeOverlay() {
        if (!this.isMobileMode) return;
        const overlay = document.getElementById('mobile-landscape-overlay');
        if (!overlay) return;
        const isPortrait = window.innerHeight > window.innerWidth;
        overlay.classList.toggle('visible', isPortrait);
    }

    setupAdminPlayerInfoClick() {
        const canvas = document.getElementById('canvas');
        const panel = document.getElementById('admin-player-info-panel');
        const closeBtn = document.getElementById('admin-player-info-close');
        if (!canvas || !panel) return;

        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        const onPointerClick = (e) => {
            const rect = canvas.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, this.sceneManager.getCamera());
            const scene = this.sceneManager.getScene();
            const intersects = raycaster.intersectObjects(scene.children, true);

            for (const hit of intersects) {
                const playerId = this.playerManager.getPlayerIdFromObject(hit.object);
                if (playerId && playerId !== this.networkManager.myPlayerId) {
                    this.networkManager.requestPlayerInfo(playerId, (data) => {
                        if (data?.error) {
                            console.warn('Admin player info:', data.error);
                            return;
                        }
                        this.showAdminPlayerInfoPanel(data);
                    });
                    return;
                }
            }
        };

        canvas.addEventListener('pointerdown', onPointerClick);

        closeBtn?.addEventListener('click', () => {
            panel.style.display = 'none';
        });
    }

    showAdminPlayerInfoPanel(data) {
        const panel = document.getElementById('admin-player-info-panel');
        if (!panel) return;

        const fmt = (d) => d ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '-';

        document.getElementById('admin-info-username').textContent = data.displayName || data.username || '-';
        document.getElementById('admin-info-connected').textContent = data.connectedAt ? fmt(new Date(data.connectedAt)) : '-';
        document.getElementById('admin-info-ping').textContent = data.pingMs != null ? `${data.pingMs}ms` : '-';
        document.getElementById('admin-info-fps').textContent = data.fpsSample != null ? String(data.fpsSample) : '-';
        document.getElementById('admin-info-perf-tier').textContent = data.perfTier != null ? String(data.perfTier) : '-';
        const loafLt = (data.loafCount != null || data.longtaskCount != null)
            ? `${data.loafCount ?? '-'} / ${data.longtaskCount ?? '-'}`
            : '-';
        document.getElementById('admin-info-loaf').textContent = loafLt;
        document.getElementById('admin-info-ip').textContent = data.ip || '-';
        document.getElementById('admin-info-location').textContent = data.location || '-';
        document.getElementById('admin-info-browser').textContent = data.browser || '-';
        document.getElementById('admin-info-os').textContent = data.os || '-';

        panel.style.display = 'block';
    }

    updateTeleportZones() {
        // Get teleporters from current world
        const teleporters = this.sceneManager.getTeleporters();
        const currentWorldId = this.worldManager.getCurrentWorldId();

        // Clear existing zones for current world to prevent duplicates
        const existingZones = this.teleportManager.getZonesForWorld(currentWorldId);
        if (existingZones.length > 0) {
            // Remove zones for current world
            this.teleportManager.teleportZones = this.teleportManager.teleportZones.filter(
                zone => zone.worldId !== currentWorldId
            );
        }

        console.log(`Setting up ${teleporters.length} teleport zones for world: ${currentWorldId}`);

        // Auto-generate zones for each teleporter
        teleporters.forEach(teleporter => {
            this.teleportManager.addZone({
                id: teleporter.id,
                position: teleporter.position,
                radius: teleporter.radius,
                destinationWorld: teleporter.destinationWorld,
                label: teleporter.label,
                worldId: currentWorldId,
                access: teleporter.access || 'public',
                autoTeleport: !!teleporter.autoTeleport,
                autoTeleportOnContact: !!teleporter.autoTeleportOnContact
            });
            console.log(`  Teleporter ${teleporter.id}: ${teleporter.label} -> ${teleporter.destinationWorld} (${teleporter.access || 'public'}) at (${teleporter.position.x}, ${teleporter.position.y}, ${teleporter.position.z})`);
        });

        // Manual teleport zones (for non-model teleporters)
        // Uncomment and add manual zones here if needed
        /*
        this.teleportManager.addZone({
            position: { x: 20, y: 1, z: 0 },
            radius: 3,
            destinationWorld: 'school',
            label: '新校舎',
            worldId: 'lobby'
        });
        */
    }

    updateTaikoZones() {
        if (!this.taikoGameManager) {
            if (this.teleportManager) this.teleportManager.clearTaikoZones();
            return;
        }
        const taikos = this.sceneManager.getTaikos();
        const currentWorldId = this.worldManager.getCurrentWorldId();
        const world = this.worldManager.getWorld(currentWorldId);
        const models = world && Array.isArray(world.models) ? world.models : [];
        /** @param {string} gid */
        const countGroup = (gid) => models.filter((m) => m.taiko && m.taiko.multiplayer && String(m.taiko.groupId || '').trim() === gid).length;
        this.teleportManager.clearTaikoZones();
        taikos.forEach((taiko) => {
            const gid = taiko.groupId || '';
            const n = taiko.multiplayer && gid ? countGroup(gid) : 1;
            const slotCount = Math.min(3, Math.max(1, n));
            this.teleportManager.addTaikoZone({
                position: taiko.position,
                radius: taiko.radius,
                worldId: currentWorldId,
                multiplayer: taiko.multiplayer,
                groupId: gid,
                multiplayerChartId: taiko.multiplayerChartId || '',
                slotCount
            });
        });
        console.log(`Setting up ${taikos.length} taiko zones for world: ${currentWorldId}`);
    }

    updateGlbInteractZones() {
        const currentWorldId = this.worldManager.getCurrentWorldId();
        this.teleportManager.clearGlbInteractZonesForWorld(currentWorldId);
        const cfgs = this.sceneManager.getGlbInteractConfigs();
        cfgs.forEach((cfg) => {
            this.teleportManager.addGlbInteractZone({
                model: cfg.model,
                radius: cfg.radius,
                clipName: cfg.clipName,
                label: cfg.label,
                worldId: currentWorldId,
                access: cfg.access
            });
        });
        console.log(`Setting up ${cfgs.length} GLB interact zones for world: ${currentWorldId}`);
    }

    /**
     * ワールド設定に応じて Google Maps 帰属（© Google）の表示を切り替える
     * @param {{ showGoogleMapsCopyright?: unknown } | null} [world]
     */
    updateGoogleMapsCopyrightVisibility(world) {
        const el = document.getElementById('google-maps-attribution');
        if (!el) return;
        const show = !!(world && world.showGoogleMapsCopyright === true);
        el.hidden = !show;
        el.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    async onWorldChanged(world) {
        console.log(`World changed to: ${world.id}`);

        this.updateGoogleMapsCopyrightVisibility(world);

        if (this.aircraftController && world) {
            this.aircraftController.applyWorldPhysics(world.aircraftPhysics);
        }

        if (this.sceneManager?.hydrateAircraftSlotsFromLibrary) {
            try {
                await this.sceneManager.hydrateAircraftSlotsFromLibrary();
            } catch (e) {
                console.warn('[Aircraft] hydrate failed', e);
            }
        }

        if (this.aircraftManager) {
            this.aircraftManager.forceLocalPilotingReset();
            this.aircraftManager.refreshSlotsFromScene();
        }

        // Get new spawn point
        const spawnPoint = world.spawnPoint;

        // Teleport character to new spawn point
        this.characterController.setPosition(spawnPoint.x, spawnPoint.y, spawnPoint.z);
        this.characterController.resetVelocity();

        // Update local player visual
        this.playerManager.updateLocalPlayer(
            { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z },
            this.characterController.getRotation()
        );

        // Notify network manager about world change
        this.networkManager.changeWorld(world.id);

        // Update teleport and taiko zones for new world
        this.updateTeleportZones();
        this.updateTaikoZones();
        this.updateGlbInteractZones();

        // VC: Change to new room (cleanup old, join new)
        if (this.voiceChatManager && this.voiceChatManager.isJoined) {
            try {
                await this.voiceChatManager.changeRoom(world.id);
                console.log(`[VC] Changed to room: ${world.id}`);
            } catch (error) {
                console.error(`[VC] Failed to change room:`, error);
            }
        }

        // Video VC: Change to new room
        if (this.videoChatManager && this.videoChatManager.isJoined) {
            try {
                await this.videoChatManager.changeRoom(world.id);
                console.log(`[Video VC] Changed to room: ${world.id}`);
            } catch (error) {
                console.error(`[Video VC] Failed to change room:`, error);
            }
        }

        console.log(`Teleported to spawn point: ${spawnPoint.x}, ${spawnPoint.y}, ${spawnPoint.z}`);

        try {
            const u = new URL(window.location.href);
            if (world?.id) {
                u.searchParams.set('world', world.id);
                history.replaceState(null, '', u.pathname + u.search + u.hash);
            }
        } catch (_) {
            /* ignore */
        }
    }

    async onAdminTp(data) {
        const { world: worldId, position } = data;
        if (!worldId || !position) return;
        if (this.aircraftManager) this.aircraftManager.forceLocalPilotingReset();
        const { x, y, z } = position;
        const currentWorldId = this.worldManager.getCurrentWorldId();

        if (worldId !== currentWorldId) {
            const world = this.worldManager.getWorld(worldId);
            if (!world) {
                console.error(`[Admin TP] World not found: ${worldId}`);
                return;
            }
            await new Promise((resolve) => {
                this.worldManager.loadWorld(worldId, () => resolve());
            });
            this.updateTeleportZones();
            this.updateTaikoZones();
            this.updateGlbInteractZones();
            this.networkManager.changeWorld(worldId);
            // VC room change is handled by vc-room-changed from server
        }

        this.characterController.setPosition(x, y, z);
        this.characterController.resetVelocity();
        this.playerManager.updateLocalPlayer(
            { x, y, z },
            this.characterController.getRotation()
        );
        console.log(`[Admin TP] Teleported to ${worldId} (${x}, ${y}, ${z})`);
    }

    /**
     * Socket 接続成功時: ワールド同期（読込完了前は defer）
     */
    async _onNetworkPostConnect() {
        if (!this._worldReadyForNetwork) {
            this._networkConnectPendingRoomSync = true;
            return;
        }
        await this._applyInitialRoomSync();
    }

    /**
     * URL 指定ワールド等: サーバー側 room をクライアントの current world に合わせる
     */
    async _applyInitialRoomSync() {
        if (!this.networkManager?.socket?.connected || !this.worldManager) return;
        const roomId = this.worldManager.getCurrentWorldId() || DEFAULT_ROOM;
        if (roomId === DEFAULT_ROOM) return;
        await new Promise((resolve) => {
            this.networkManager.changeWorld(roomId, {}, (err) => {
                if (err) {
                    console.error('[Network] Initial room sync failed:', err);
                }
                resolve();
            });
        });
    }

    /**
     * Socket 差し替え後に socket 参照を持つ各マネージャを更新する
     */
    _rewireSocketConsumers() {
        const sock = this.networkManager?.socket;
        if (!sock) return;
        if (this.pdfViewerManager?.setSocket) this.pdfViewerManager.setSocket(sock);
        if (this.taikoGameManager?.setSocket) this.taikoGameManager.setSocket(sock);
        if (this.pdfViewerVoiceChatManager?.setSocket) this.pdfViewerVoiceChatManager.setSocket(sock);
        if (this.voiceChatManager) this.voiceChatManager.socket = sock;
        if (this.captionManager) this.captionManager.setSocket(sock);
        if (this.videoChatManager) this.videoChatManager.socket = sock;
        if (this.chatManager?.rebindNetworkEvents) this.chatManager.rebindNetworkEvents();
    }

    /**
     * 音声・ビデオ VC を現在のワールド room に参加（マネージャ未初期化時はスキップ）
     */
    async _joinVoiceAndVideoIfReady() {
        if (!this.networkManager?.socket?.connected) return;
        const roomId = this.worldManager?.getCurrentWorldId() || DEFAULT_ROOM;
        const id = roomId || DEFAULT_ROOM;
        if (this.voiceChatManager && !this.voiceChatManager.isJoined) {
            try {
                await this.voiceChatManager.joinRoom(id);
                console.log('[VC] Auto-joined room:', id);
            } catch (error) {
                console.error('[VC] Failed to auto-join:', error);
            }
        }
        if (this.videoChatManager && !this.videoChatManager.isJoined) {
            try {
                await this.videoChatManager.joinRoom(id);
                console.log('[Video VC] Auto-joined room:', id);
            } catch (error) {
                console.error('[Video VC] Failed to auto-join:', error);
            }
        }
    }

    /**
     * LoAF / longtask を PerformanceObserver で集計（report-ping の差分送信用）
     */
    setupClientPerfObservers() {
        try {
            const types = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes
                ? PerformanceObserver.supportedEntryTypes
                : [];
            if (types.includes('long-animation-frame')) {
                const o = new PerformanceObserver((list) => {
                    this._perfLoafAccum += list.getEntries().length;
                });
                o.observe({ type: 'long-animation-frame', buffered: false });
                this._perfLoafObserver = o;
            }
            if (types.includes('longtask')) {
                const o = new PerformanceObserver((list) => {
                    this._perfLongtaskAccum += list.getEntries().length;
                });
                o.observe({ entryTypes: ['longtask'] });
                this._perfLongtaskObserver = o;
            }
        } catch (e) {
            console.warn('[Perf] PerformanceObserver init failed:', e);
        }
    }

    /**
     * report-ping 送信直前に NetworkManager から呼ばれる。LoAF/longtask は読み取り後にリセット。
     * @returns {{ fpsSample: number|null, perfTier: string, loafCount: number, longtaskCount: number, perfSampleAt: number|null }}
     */
    getPerfPayloadForPing() {
        const loaf = this._perfLoafAccum;
        const lt = this._perfLongtaskAccum;
        this._perfLoafAccum = 0;
        this._perfLongtaskAccum = 0;
        return {
            fpsSample: this._perfLastFpsSample != null ? this._perfLastFpsSample : null,
            perfTier: this._lastPerfTier || 'high',
            loafCount: loaf,
            longtaskCount: lt,
            perfSampleAt: this._perfFpsSampleAtMs != null ? this._perfFpsSampleAtMs : null
        };
    }

    /**
     * 没入呈示中か（アドオンが未ロードなら false）
     * @returns {boolean}
     */
    isImmersivePresenting() {
        return getImmersiveState();
    }

    /**
     * 可視または没入中のみ FPS を数え、10 秒周期で 1 秒窓をサンプルしてティアを更新する。
     * @param {number} _timeMs
     */
    _updateClientPerfSampling(_timeMs) {
        if (!this.sceneManager) return;
        const immersiveActive = this.isImmersivePresenting();
        const visibleOrImmersive = document.visibilityState === 'visible' || immersiveActive;
        const now = performance.now();

        if (this._perfFpsSamplingActive) {
            if (visibleOrImmersive) this._perfFpsFrames += 1;
            if (now >= this._perfFpsSampleEndAt) {
                const fps = this._perfFpsFrames;
                this._perfLastFpsSample = fps;
                this._perfFpsSampleAtMs = Date.now();
                this._lastPerfTier = fps <= 25 ? 'low' : fps <= 45 ? 'medium' : 'high';
                this._perfFpsSamplingActive = false;
                this._perfNextFpsWindowAt = now + 9000;
            }
        } else if (now >= this._perfNextFpsWindowAt) {
            this._perfFpsSamplingActive = true;
            this._perfFpsSampleEndAt = now + 1000;
            this._perfFpsFrames = visibleOrImmersive ? 1 : 0;
        }
    }

    /**
     * メインフレーム（WebGLRenderer#setAnimationLoop）。WebXR 時は第2引数に XRFrame が渡る場合がある。
     * @param {number} timeMs
     * @param {XRFrame} [_xrFrame]
     */
    frameUpdate(timeMs, _xrFrame) {
        // Calculate delta time（rAF / XR からの時刻は ms）
        const currentTime = timeMs;
        let deltaTime = (currentTime - this.clock) / 1000;
        this.clock = currentTime;

        this._updateClientPerfSampling(timeMs);

        // Clamp deltaTime to prevent physics issues when tab is inactive
        // Maximum 100ms (0.1 seconds) to prevent large jumps
        const MAX_DELTA_TIME = 0.1;
        if (deltaTime > MAX_DELTA_TIME) {
            deltaTime = MAX_DELTA_TIME;
        }

        runFrameUpdates(this, deltaTime, timeMs, _xrFrame);

        const immersiveActive = this.isImmersivePresenting();
        // 没入中はタブがバックグラウンド扱いでも物理を回す（ヘッドセット表示を維持）
        if (this.isPageVisible || immersiveActive) {
            // 操縦中は機体を先に進めてから、キャラ（物理・非表示アバター）を機体位置へ同期
            if (this.aircraftManager?.isPiloting && this.aircraftController) {
                this.aircraftController.update(deltaTime);
            }
            if (this.aircraftManager?.isPassenger && this.aircraftController) {
                this.aircraftController.updatePassengerCamera();
            }
            if (
                this.aircraftManager
                && (this.aircraftManager.isPiloting || this.aircraftManager.isPassenger)
            ) {
                const snap = this.aircraftManager.getBoardingHudSnapshot();
                if (snap) this.uiManager.updateAircraftHudTelemetry(snap);
                this.aircraftManager.updateMinimap();
            }
            this.characterController.update(deltaTime);

            // Update local player visual and animation state（操縦中はカメラ位置・向きにアバターを合わせ透明化）
            let position = this.characterController.getPosition();
            let rotation = this.characterController.getRotation();
            const movementState = this.characterController.getMovementState();
            if (this.aircraftManager?.isPiloting && this.aircraftController) {
                const cam = this.aircraftController.getNetworkCameraPose();
                if (cam?.position && cam?.quaternion) {
                    this._pilotCamPosScratch.set(cam.position.x, cam.position.y, cam.position.z);
                    this._pilotCamQuatScratch.set(
                        cam.quaternion.x,
                        cam.quaternion.y,
                        cam.quaternion.z,
                        cam.quaternion.w
                    );
                    position = this._pilotCamPosScratch;
                    rotation = this._pilotCamQuatScratch;
                }
            }
            this.playerManager.updateLocalPlayer(position, rotation, movementState);

            const viewDistanceM = this.sceneManager.graphicsOptions.viewDistanceM;
            const vas = this.worldManager.getViewDistanceStreaming();
            if (vas) {
                void vas.tick(position, viewDistanceM).catch((err) => {
                    console.warn('[VAS] tick error:', err);
                });
            }

            this.sceneManager.updatePrefabLodVisibility(position);
            this.sceneManager.updateDrawDistanceCulling(position);
            this.sceneManager.updateViewRangeDebugSpheres(position);
            this.playerManager.updateRemoteDrawDistance(position, viewDistanceM);

            // Check teleport and PDF proximity
            if (this.teleportManager) {
                this.teleportManager.update(position);
            }
            if (this.aircraftManager) {
                this.aircraftManager.updateProximity(position);
            }
            const pdfObj = this.sceneManager.getNearbyPdfObject(position, 5);
            // PDFがテレポーターのときは「PDFを表示」にせずテレポート扱いにする
            this.nearbyPdfPath = (pdfObj && !pdfObj.teleporter) ? pdfObj.pdfPath : null;
            const touchedPdfTeleporter = this.sceneManager.getTouchedPdfTeleporter(position);
            if (touchedPdfTeleporter && this.teleportManager) {
                this.teleportManager.tryAutoTeleportOnContact(touchedPdfTeleporter.teleporter?.id, this.worldManager.getCurrentWorldId());
            } else if (this.teleportManager) {
                this.teleportManager.tryAutoTeleportOnContact('', this.worldManager.getCurrentWorldId());
            }
            if (this.pdfViewerManager && this.pdfViewerManager.isOpen()) {
                this.uiManager.hideTeleportPrompt();
                this.uiManager.hideAircraftBoardPrompt();
            } else if (this.taikoGameManager && this.taikoGameManager.isOpen()) {
                this.uiManager.hideTeleportPrompt();
                this.uiManager.hideAircraftBoardPrompt();
            } else if (this.aircraftManager && (this.aircraftManager.isPiloting || this.aircraftManager.isPassenger)) {
                this.uiManager.hideTeleportPrompt();
                this.uiManager.hideAircraftBoardPrompt();
                if (this.isMobileMode) {
                    this.uiManager.hideMobileInteractButton();
                    this.uiManager.setMobileInteractAction(null);
                }
            } else if (this.teleportManager && this.teleportManager.nearestTaikoZone) {
                this.uiManager.hideAircraftBoardPrompt();
                this.uiManager.showTaikoPrompt();
            } else if (this.nearbyPdfPath) {
                this.uiManager.hideAircraftBoardPrompt();
                this.uiManager.showPdfPrompt();
            } else if (this.teleportManager && this.teleportManager.nearestGlbInteractZone) {
                this.uiManager.hideAircraftBoardPrompt();
                if (this.isMobileMode) {
                    this.uiManager.showMobileInteractButton(this.teleportManager.nearestGlbInteractZone.label);
                } else {
                    this.uiManager.showGlbAnimInteractPrompt(this.teleportManager.nearestGlbInteractZone.label);
                }
            } else if (this.teleportManager && this.teleportManager.nearestZone) {
                this.uiManager.hideAircraftBoardPrompt();
                this.uiManager.showTeleportPrompt(this.teleportManager.nearestZone.label);
            } else if (this.aircraftManager && this.aircraftManager.nearestSlot) {
                this.uiManager.hideTeleportPrompt();
                if (this.isMobileMode) {
                    const slot = this.aircraftManager.nearestSlot;
                    const uiMode = this.aircraftManager.getNearestBoardingUiMode();
                    const canBoardMobile =
                        uiMode === 'passenger' || slot.controlMode === 'easy';
                    if (canBoardMobile && this.aircraftManager.canBoard()) {
                        this.uiManager.showMobileInteractButton(slot.label);
                        this.uiManager.setMobileInteractAction(() => {
                            void this.aircraftManager.tryBoardNearest();
                        });
                    } else {
                        this.uiManager.hideMobileInteractButton();
                        this.uiManager.setMobileInteractAction(null);
                    }
                    this.uiManager.hideAircraftBoardPrompt();
                } else {
                    this.uiManager.hideMobileInteractButton();
                    this.uiManager.setMobileInteractAction(null);
                    this.uiManager.showAircraftBoardPrompt(
                        this.aircraftManager.nearestSlot.label,
                        this.aircraftManager.getNearestBoardingUiMode()
                    );
                }
            } else {
                this.uiManager.hideTeleportPrompt();
                this.uiManager.hideAircraftBoardPrompt();
                if (this.isMobileMode) {
                    this.uiManager.hideMobileInteractButton();
                    this.uiManager.setMobileInteractAction(null);
                }
            }
        }

        // Always update animations and render (even when hidden for smooth transition)
        this.sceneManager.updateAnimations();
        this.sceneManager.updateGltfAnimationMixers(deltaTime);
        if (this.playerManager) this.playerManager.updateAnimations(deltaTime);

        // Update chat (emoji positions)
        if (this.chatManager) {
            this.chatManager.update();
        }

        // Update captions (per-player subtitle positions)
        if (this.captionManager) {
            this.captionManager.update();
        }

        // Update info panel (ワールド名、座標、プレイヤー一覧、ping)
        if (this.uiManager && this.worldManager && this.networkManager) {
            const world = this.worldManager.getCurrentWorld();
            const position = this.characterController?.getPosition?.() ?? null;
            const playerCount = this.isAdminCameraMode
                ? (this.playerManager?.remotePlayers?.size ?? 0)
                : (this.playerManager?.getPlayerCount?.() ?? 0);
            const pingStatus = this.networkManager.getPingStatus();
            const myId = this.networkManager.myPlayerId;
            const players = (this.networkManager.lastPlayersSnapshot || []).map((p) => {
                if (p.id !== myId) return p;
                if (pingStatus.noResponse || pingStatus.connecting || pingStatus.reconnecting) {
                    return { ...p, pingMs: null };
                }
                if (pingStatus.pingMs != null) {
                    return { ...p, pingMs: pingStatus.pingMs };
                }
                return p;
            });
            if (this.isMobileMode) {
                MobileUIManager.updateMobileInfo(world?.name || '-', position, playerCount);
            } else {
                this.uiManager.updateInfoPanel(
                    world?.name || '-',
                    position,
                    playerCount,
                    players
                );
            }
            this.uiManager.updatePingDisplay(pingStatus);
        }

        this.updateLandscapeOverlay();

        // Render scene
        this.sceneManager.render();
    }
}

// Initialize and run the app
renderMetaversePortalNav(document.getElementById('metaverse-portal-links')).then(() => {
    const nav = document.getElementById('metaverse-portal-nav');
    if (nav && nav.querySelector('.portal-nav-links a')) {
        nav.removeAttribute('hidden');
    }
});

const app = new MetaverseApp();
app.init().catch(error => {
    console.error('Failed to initialize application:', error);
});
