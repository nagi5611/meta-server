import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationMixer } from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

class PlayerManager {
    constructor(scene) {
        this.scene = scene;
        this.localPlayer = null;
        this.remotePlayers = new Map();
        this.gltfLoader = new GLTFLoader();
        /** @type {{ scene: THREE.Group, animations: THREE.AnimationClip[] } | null} */
        this.avatarModelCache = null;
        this.avatarPath = 'models/avatar.glb';
        /** Avatar GLB scale (change to resize model) */
        this.avatarScale = { x: 1.5, y: 1.5, z: 1.5 };
    }

    /**
     * Load avatar model from GLB file (with animations if present)
     * @returns {Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>}
     */
    async loadAvatarModel() {
        if (this.avatarModelCache) {
            const { scene, animations } = this.avatarModelCache;
            const clonedScene = animations.length > 0
                ? SkeletonUtils.clone(scene)
                : scene.clone();
            return { scene: clonedScene, animations };
        }

        return new Promise((resolve, reject) => {
            this.gltfLoader.load(
                this.avatarPath,
                (gltf) => {
                    const animations = gltf.animations || [];
                    this.avatarModelCache = { scene: gltf.scene, animations };
                    console.log('Avatar model loaded:', this.avatarPath, 'animations:', animations.length);

                    const clonedScene = animations.length > 0
                        ? SkeletonUtils.clone(gltf.scene)
                        : gltf.scene.clone();
                    resolve({ scene: clonedScene, animations });
                },
                (progress) => {
                    if (progress.total) {
                        const percent = (progress.loaded / progress.total) * 100;
                        console.log(`Loading avatar: ${percent.toFixed(2)}%`);
                    }
                },
                (error) => {
                    console.error('Error loading avatar model:', error);
                    reject(error);
                }
            );
        });
    }

    /**
     * Create AnimationMixer and actions for idle(0) / jump(1) / dash(2) / walk(3). Loops and plays idle initially.
     * @param {THREE.Object3D} root
     * @param {THREE.AnimationClip[]} animations
     * @returns {{ mixer: THREE.AnimationMixer, actions: { idle, jump, walk, dash } | null } | null}
     */
    setupAvatarAnimation(root, animations) {
        if (!animations || animations.length === 0) return null;
        const mixer = new AnimationMixer(root);
        const hasIdleWalkDash = animations.length >= 4; // need indices 0, 2, 3
        const jumpClip = animations.find((a) => a.name && /jump/i.test(a.name)) || (animations.length >= 2 ? animations[1] : null);
        if (hasIdleWalkDash) {
            const idle = mixer.clipAction(animations[0]);
            const dash = mixer.clipAction(animations[2]);
            const walk = mixer.clipAction(animations[3]);
            [idle, dash, walk].forEach((a) => a.setLoop(THREE.LoopRepeat));
            let jump = null;
            if (jumpClip) {
                jump = mixer.clipAction(jumpClip);
                jump.setLoop(THREE.LoopOnce);
                jump.clampWhenFinished = true;
            }
            idle.play();
            return { mixer, actions: { idle, walk, dash, jump } };
        }
        mixer.clipAction(animations[0]).play();
        return { mixer, actions: null };
    }

    /**
     * Create a placeholder capsule (fallback)
     */
    createPlaceholder(color = 0x00ff88) {
        const geometry = new THREE.CapsuleGeometry(0.3, 1.0, 4, 8);
        const material = new THREE.MeshStandardMaterial({
            color: color,
            roughness: 0.5,
            metalness: 0.5
        });
        const placeholder = new THREE.Mesh(geometry, material);
        
        // Add head
        const headGeometry = new THREE.SphereGeometry(0.2, 8, 8);
        const headMaterial = new THREE.MeshStandardMaterial({
            color: color === 0x00ff88 ? 0xffff00 : 0xffaa00,
            roughness: 0.3,
            metalness: 0.7
        });
        const head = new THREE.Mesh(headGeometry, headMaterial);
        head.position.y = 0.8;
        placeholder.add(head);
        
        return placeholder;
    }

    async createLocalPlayer(position = { x: 0, y: 2, z: 0 }) {
        console.log('Creating local player avatar...');
        
        try {
            const { scene: avatarModel, animations } = await this.loadAvatarModel();
            
            this.localPlayer = new THREE.Group();
            this.localPlayer.position.set(position.x, position.y, position.z);
            
            avatarModel.position.y = 0;
            avatarModel.scale.set(this.avatarScale.x, this.avatarScale.y, this.avatarScale.z);
            this.localPlayer.add(avatarModel);
            const anim = this.setupAvatarAnimation(avatarModel, animations);
            if (anim) {
                this.localPlayer.userData.mixer = anim.mixer;
                this.localPlayer.userData.avatarActions = anim.actions;
                this.localPlayer.userData.animationState = 'idle';
            }
            
            this.scene.add(this.localPlayer);
            console.log('Local player created with GLB avatar', animations.length ? '(animated)' : '');
        } catch (error) {
            console.error('Failed to load avatar, using placeholder:', error);
            this.localPlayer = this.createPlaceholder(0x00ff88);
            this.localPlayer.position.set(position.x, position.y, position.z);
            this.scene.add(this.localPlayer);
            console.log('Local player created with placeholder');
        }
    }

    /**
     * ローカルプレイヤーの表示/非表示を切り替える（ネームタグ含む）
     * @param {boolean} visible
     */
    setLocalPlayerVisible(visible) {
        if (!this.localPlayer) return;
        this.localPlayer.visible = !!visible;
    }

    /**
     * 他プレイヤー（リモート）の表示/非表示を切り替える（ネームタグ含む）。管理者の透明化で使用。
     * @param {string} playerId
     * @param {boolean} visible
     */
    setRemotePlayerVisible(playerId, visible) {
        const player = this.remotePlayers.get(playerId);
        if (!player) return;
        player.visible = !!visible;
    }

    async createRemotePlayer(playerId, position = { x: 0, y: 2, z: 0 }, username = null) {
        console.log(`Creating remote player: ${playerId}`);
        
        const displayName = username || `Player ${playerId.substring(0, 4)}`;
        
        // Create placeholder first (immediate visual feedback)
        const placeholder = this.createPlaceholder(0xff6600);
        placeholder.position.set(position.x, position.y, position.z);
        placeholder.userData.playerId = playerId;
        placeholder.userData.username = displayName;
        placeholder.userData.isLoading = true;
        
        // Add name tag to placeholder
        this.addNameTag(placeholder, displayName);
        
        this.scene.add(placeholder);
        this.remotePlayers.set(playerId, placeholder);
        
        try {
            const { scene: avatarModel, animations } = await this.loadAvatarModel();
            
            const remotePlayer = new THREE.Group();
            remotePlayer.position.copy(placeholder.position);
            remotePlayer.quaternion.copy(placeholder.quaternion);
            
            avatarModel.position.y = 0;
            avatarModel.scale.set(this.avatarScale.x, this.avatarScale.y, this.avatarScale.z);
            remotePlayer.add(avatarModel);
            const anim = this.setupAvatarAnimation(avatarModel, animations);
            if (anim) remotePlayer.userData.mixer = anim.mixer;
            
            remotePlayer.userData.playerId = playerId;
            remotePlayer.userData.username = displayName;
            remotePlayer.userData.isLoading = false;
            
            // Transfer name tag from placeholder to new avatar
            const nameTag = placeholder.children.find(child => child instanceof THREE.Sprite);
            if (nameTag) {
                placeholder.remove(nameTag);
                remotePlayer.add(nameTag);
            }
            
            // Replace placeholder with GLB avatar
            this.scene.remove(placeholder);
            this.scene.add(remotePlayer);
            this.remotePlayers.set(playerId, remotePlayer);
            
            // Dispose placeholder
            placeholder.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => mat.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
            
            console.log(`Remote player created with GLB avatar: ${playerId} (${displayName})`);
        } catch (error) {
            console.error(`Failed to load avatar for ${playerId}, keeping placeholder:`, error);
            placeholder.userData.isLoading = false;
        }
    }

    /**
     * クリックされたオブジェクトからプレイヤーIDを取得（親をたどる）
     * @param {THREE.Object3D} obj
     * @returns {string|null}
     */
    getPlayerIdFromObject(obj) {
        let o = obj;
        while (o) {
            if (o.userData?.playerId) return o.userData.playerId;
            o = o.parent;
        }
        return null;
    }

    addNameTag(player, name) {
        // Create canvas for text (transparent background)
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 64;

        context.font = 'Bold 24px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        // 黒のアウトラインで視認性確保
        context.strokeStyle = '#000000';
        context.lineWidth = 3;
        context.strokeText(name, canvas.width / 2, canvas.height / 2);
        context.fillStyle = '#ffffff';
        context.fillText(name, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(2, 0.5, 1);
        sprite.position.y = 3; // Fixed height for GLB avatar (raised by 1.5 to avoid overlap)

        player.add(sprite);
    }

    /**
     * Update all avatar animations (call every frame with deltaTime)
     * @param {number} deltaTime
     */
    updateAnimations(deltaTime) {
        if (this.localPlayer?.userData.mixer) {
            this.localPlayer.userData.mixer.update(deltaTime);
        }
        this.remotePlayers.forEach((player) => {
            if (player.userData.mixer) {
                player.userData.mixer.update(deltaTime);
            }
        });
    }

    /**
     * @param {{ x: number, y: number, z: number }} position
     * @param {THREE.Quaternion} rotation
     * @param {{ isMoving: boolean, isDashing: boolean }} [movementState]
     */
    updateLocalPlayer(position, rotation, movementState) {
        if (!this.localPlayer) return;

        this.localPlayer.position.set(position.x, position.y, position.z);
        this.localPlayer.quaternion.copy(rotation);

        const actions = this.localPlayer.userData.avatarActions;
        if (actions && movementState) {
            const isGrounded = movementState.isGrounded !== false;
            const newState = !isGrounded && actions.jump ? 'jump'
                : movementState.isDashing ? 'dash'
                : movementState.isMoving ? 'walk'
                : 'idle';
            const currentState = this.localPlayer.userData.animationState;
            if (newState !== currentState) {
                const newAction = actions[newState];
                const currentAction = actions[currentState];
                if (newAction) {
                    newAction.reset().play();
                    if (currentAction && currentAction !== newAction) currentAction.crossFadeTo(newAction, 0.15);
                    this.localPlayer.userData.animationState = newState;
                }
            }
        }
    }

    updateRemotePlayer(playerId, position, rotation, username = null) {
        const player = this.remotePlayers.get(playerId);
        if (!player) return;

        // Smooth interpolation
        player.position.lerp(
            new THREE.Vector3(position.x, position.y, position.z),
            0.3
        );

        // Update rotation
        const targetQuaternion = new THREE.Quaternion(
            rotation.x,
            rotation.y,
            rotation.z,
            rotation.w
        );
        player.quaternion.slerp(targetQuaternion, 0.3);

        // Update username if provided and different
        if (username && player.userData.username !== username) {
            player.userData.username = username;
            
            // Remove old name tag sprite
            const oldSprite = player.children.find(child => child instanceof THREE.Sprite);
            if (oldSprite) {
                player.remove(oldSprite);
            }
            
            // Add new name tag with updated username
            this.addNameTag(player, username);
        }
    }

    hasRemotePlayer(playerId) {
        return this.remotePlayers.has(playerId);
    }

    removeRemotePlayer(playerId) {
        const player = this.remotePlayers.get(playerId);
        if (!player) return;

        // Remove from scene
        this.scene.remove(player);
        
        // Dispose geometries and materials to prevent memory leak
        player.traverse((child) => {
            if (child.geometry) {
                child.geometry.dispose();
            }
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(mat => {
                        if (mat.map) mat.map.dispose();
                        mat.dispose();
                    });
                } else {
                    if (child.material.map) child.material.map.dispose();
                    child.material.dispose();
                }
            }
        });
        
        this.remotePlayers.delete(playerId);

        console.log(`Remote player removed: ${playerId}`);
    }

    clearRemotePlayers() {
        // Remove all remote players from scene
        this.remotePlayers.forEach((player, playerId) => {
            this.scene.remove(player);
        });
        this.remotePlayers.clear();
        console.log('All remote players cleared');
    }

    updatePlayerUsername(playerId, username) {
        const player = this.remotePlayers.get(playerId);
        if (!player) return;

        // Update stored username
        player.userData.username = username;

        // Remove old name tag sprite
        const oldSprite = player.children.find(child => child instanceof THREE.Sprite);
        if (oldSprite) {
            player.remove(oldSprite);
        }

        // Add new name tag with updated username
        this.addNameTag(player, username);
        console.log(`Updated username for player ${playerId}: ${username}`);
    }

    getPlayerCount() {
        return this.remotePlayers.size + 1; // +1 for local player
    }
}

export default PlayerManager;
