import * as THREE from 'three';
import SceneManager from './scene-manager.js';
import PhysicsManager from './physics-manager.js';
import CharacterController from './character-controller.js';
import PlayerManager from './player-manager.js';
import NetworkManager from './network-manager.js';
import WorldManager from './world-manager.js';
import TeleportManager from './teleport-manager.js';
import UIManager from './ui-manager.js';
import ChatManager from './chat-manager.js';
import MenuManager from './menu-manager.js';
import VoiceChatManager from './voice-chat-manager.js';
import VideoChatManager from './video-chat-manager.js';
import PdfViewerVoiceChatManager from './pdf-viewer-voice-chat-manager.js';
import PdfViewerManager from './pdf-viewer-manager.js';
import { isMobile, setupFullscreen, tryLockLandscape, onResize } from './mobile-utils.js';
import MobileJoystickManager from './mobile-joystick-manager.js';
import MobileUIManager from './mobile-ui-manager.js';

const DEFAULT_ROOM = 'lobby';

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
        this.menuManager = null;
        this.voiceChatManager = null;
        this.videoChatManager = null;
        this.pdfViewerVoiceChatManager = null;
        this.pdfViewerManager = null;
        this.clock = 0;
        this.isPageVisible = true;
        this.nearbyPdfPath = null;
        this.isMobileMode = false;
        this.resizeUnsubscribe = null;

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

    async init() {
        console.log('Initializing Metaverse Simple...');

        // /admin セッション: Basic認証済みでトークン取得が必須
        if (window.location.pathname === '/admin') {
            try {
                const res = await fetch('/admin/enter-metaverse', { credentials: 'include' });
                if (!res.ok) {
                    alert('認証が必要です。Basic認証でログインしてください。');
                    window.location.href = '/admin.html';
                    return;
                }
                const { token, username } = await res.json();
                sessionStorage.setItem('metaverseAdminToken', token);
                localStorage.setItem('username', username);
            } catch (err) {
                console.error('Admin metaverse auth failed:', err);
                alert('管理者認証に失敗しました。');
                window.location.href = '/admin.html';
                return;
            }
        }

        // Initialize scene
        this.sceneManager = new SceneManager();
        this.sceneManager.init();

        // Initialize physics (BVH-based)
        this.physicsManager = new PhysicsManager();
        await this.physicsManager.init();

        // Set physics manager reference in scene manager for BVH collider
        this.sceneManager.physicsManager = this.physicsManager;

        // Initialize UI Manager
        this.uiManager = new UIManager();

        // Initialize World Manager
        this.worldManager = new WorldManager(this.sceneManager);
        await this.worldManager.init();

        // Initialize Teleport Manager
        this.teleportManager = new TeleportManager(this.worldManager, this.uiManager);
        this.userRole = (window.location.pathname === '/admin') ? 'admin' : (localStorage.getItem('userRole') || 'guest');
        this.teleportManager.setUserRole(this.userRole);
        this.teleportManager.setTeleportCallback((destinationWorld, teleporterId) => {
            this.networkManager.changeWorld(destinationWorld, { teleporterId }, (err) => {
                if (err) {
                    alert(err.message || 'このテレポーターは利用できません');
                    return;
                }
                this.worldManager.switchWorld(destinationWorld);
            });
        });

        // Initialize PDF Viewer (E key near PDF object)
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

        // Load initial world (lobby or first available)
        const initialWorldId = this.worldManager.getWorld('lobby') ? 'lobby' : (this.worldManager.getAllWorlds()[0]?.id || 'lobby');
        console.log('Loading world:', initialWorldId);
        await new Promise((resolve) => {
            this.worldManager.loadWorld(initialWorldId, () => {
                console.log('World loaded:', initialWorldId);
                // Setup teleport zones after world is loaded
                this.updateTeleportZones();
                resolve();
            });
        });

        // Get spawn point for current world
        const spawnPoint = this.worldManager.getSpawnPoint();

        this.isMobileMode = isMobile();

        // Now create character controller (BVH is ready)
        this.characterController = new CharacterController(
            this.sceneManager.getCamera(),
            this.physicsManager,
            { isMobileMode: this.isMobileMode }
        );

        // Set initial position
        this.characterController.setPosition(spawnPoint.x, spawnPoint.y, spawnPoint.z);

        // Initialize player manager
        this.playerManager = new PlayerManager(this.sceneManager.getScene());
        console.log('Loading player avatar...');
        try {
            await this.playerManager.createLocalPlayer(spawnPoint);
            console.log('Player avatar loaded successfully');
        } catch (error) {
            console.error('Failed to create player avatar:', error);
            // Continue anyway - PlayerManager will use fallback
        }

        // Initialize network
        this.networkManager = new NetworkManager(this.playerManager);
        this.networkManager.onAdminTp = (data) => this.onAdminTp(data);
        this.networkManager.connect();
        this.networkManager.startSendingUpdates(this.characterController);
        if (this.pdfViewerManager) this.pdfViewerManager.setSocket(this.networkManager.socket);

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
        
        // Wait for socket connection, then join VC and Video VC
        this.networkManager.socket.on('connect', async () => {
            if (this.voiceChatManager && !this.voiceChatManager.isJoined) {
                try {
                    await this.voiceChatManager.joinRoom(DEFAULT_ROOM);
                    console.log('[VC] Auto-joined default room');
                } catch (error) {
                    console.error('[VC] Failed to auto-join:', error);
                }
            }
            if (this.videoChatManager && !this.videoChatManager.isJoined) {
                try {
                    await this.videoChatManager.joinRoom(DEFAULT_ROOM);
                    console.log('[Video VC] Auto-joined default room');
                } catch (error) {
                    console.error('[Video VC] Failed to auto-join:', error);
                }
            }
        });

        // Initialize chat manager (モバイル時は初期でアイコンのみ表示)
        this.chatManager = new ChatManager(
            this.networkManager,
            this.playerManager,
            this.sceneManager,
            { initialMinimized: this.isMobileMode }
        );
        this.chatManager.setCharacterController(this.characterController);

        if (this.isMobileMode) {
            MobileJoystickManager.init(this.characterController);
            MobileUIManager.init();
            this.setupMobileFullscreen();
        }

        this.resizeUnsubscribe = onResize((nowMobile) => {
            if (nowMobile === this.isMobileMode) return;
            this.isMobileMode = nowMobile;
            this.characterController.setMobileMode(nowMobile);
            if (nowMobile) {
                MobileJoystickManager.init(this.characterController);
                MobileUIManager.init();
                if (!this.chatManager.isMinimized) this.chatManager.toggleMinimize();
            } else {
                MobileJoystickManager.destroy();
                MobileUIManager.destroy();
            }
        });

        // Initialize menu manager
        this.menuManager = new MenuManager();
        
        // Connect menu manager to voice chat and video chat
        this.menuManager.setVoiceChatManager(this.voiceChatManager);
        this.menuManager.setVideoChatManager(this.videoChatManager);
        this.menuManager.setReturnToLobbyCallback(() => {
            const world = this.worldManager.getWorld('lobby');
            if (world) this.worldManager.loadWorld('lobby', () => {});
        });

        // プレイヤー一覧の「視聴」ボタン → 指定ユーザーの配信に接続して表示
        this.uiManager.setOnWatchVideo((peerId) => {
            if (this.videoChatManager) this.videoChatManager.showVideoContainer(peerId);
        });

        // Vキー: ビデオ配信中のユーザーを視聴（ポインターロック中でも使える）
        document.addEventListener('keydown', (e) => {
            if (e.code !== 'KeyV' || e.repeat) return;
            const input = document.activeElement?.tagName?.toLowerCase();
            if (input === 'input' || input === 'textarea') return;
            const videoOn = (this.networkManager?.lastPlayersSnapshot || []).find(p => p.vcVideoOn);
            if (videoOn && this.videoChatManager) {
                console.log('[視聴] Vキーで視聴開始 - peerId:', videoOn.id);
                this.videoChatManager.showVideoContainer(videoOn.id);
            }
        });

        // Setup world change handler
        this.worldManager.onWorldChange((world) => {
            this.onWorldChanged(world);
        });

        // Admin: プレイヤーアバタークリックで情報表示
        if (window.location.pathname === '/admin') {
            this.setupAdminPlayerInfoClick();
        }

        // Start game loop
        this.clock = performance.now();
        this.animate();

        console.log('Metaverse Simple initialized!');
        if (this.isMobileMode) {
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
        document.getElementById('admin-info-ip').textContent = data.ip || '-';
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
                access: teleporter.access || 'public'
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

    async onWorldChanged(world) {
        console.log(`World changed to: ${world.id}`);

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

        // Update teleport zones for new world
        this.updateTeleportZones();

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
    }

    async onAdminTp(data) {
        const { world: worldId, position } = data;
        if (!worldId || !position) return;
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

    animate() {
        requestAnimationFrame(() => this.animate());

        // Calculate delta time
        const currentTime = performance.now();
        let deltaTime = (currentTime - this.clock) / 1000;
        this.clock = currentTime;

        // Clamp deltaTime to prevent physics issues when tab is inactive
        // Maximum 100ms (0.1 seconds) to prevent large jumps
        const MAX_DELTA_TIME = 0.1;
        if (deltaTime > MAX_DELTA_TIME) {
            deltaTime = MAX_DELTA_TIME;
            console.warn(`DeltaTime clamped from ${deltaTime.toFixed(3)}s to ${MAX_DELTA_TIME}s`);
        }

        // Only update physics when page is visible
        if (this.isPageVisible) {
            // Update character controller (includes physics)
            this.characterController.update(deltaTime);

            // Update local player visual and animation state
            const position = this.characterController.getPosition();
            const rotation = this.characterController.getRotation();
            const movementState = this.characterController.getMovementState();
            this.playerManager.updateLocalPlayer(position, rotation, movementState);

            // Check teleport and PDF proximity
            if (this.teleportManager) {
                this.teleportManager.update(position);
            }
            const pdfObj = this.sceneManager.getNearbyPdfObject(position, 5);
            this.nearbyPdfPath = pdfObj ? pdfObj.pdfPath : null;
            if (this.pdfViewerManager && this.pdfViewerManager.isOpen()) {
                this.uiManager.hideTeleportPrompt();
            } else if (this.nearbyPdfPath) {
                this.uiManager.showPdfPrompt();
            } else if (this.teleportManager && this.teleportManager.nearestZone) {
                this.uiManager.showTeleportPrompt(this.teleportManager.nearestZone.label);
            } else {
                this.uiManager.hideTeleportPrompt();
            }
        }

        // Always update animations and render (even when hidden for smooth transition)
        this.sceneManager.updateAnimations();
        if (this.playerManager) this.playerManager.updateAnimations(deltaTime);

        // Update chat (emoji positions)
        if (this.chatManager) {
            this.chatManager.update();
        }

        // Update info panel (ワールド名、座標、プレイヤー一覧、ping)
        if (this.uiManager && this.characterController && this.worldManager && this.playerManager && this.networkManager) {
            const world = this.worldManager.getCurrentWorld();
            const position = this.characterController.getPosition();
            const playerCount = this.playerManager.getPlayerCount();
            const players = this.networkManager.lastPlayersSnapshot || [];
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
            this.uiManager.updatePingDisplay(this.networkManager.getPingStatus());
        }

        this.updateLandscapeOverlay();

        // Render scene
        this.sceneManager.render();
    }
}

// Initialize and run the app
const app = new MetaverseApp();
app.init().catch(error => {
    console.error('Failed to initialize application:', error);
});
