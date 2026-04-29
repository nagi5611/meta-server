import * as THREE from 'three';
import { AnimationMixer } from 'three';
import { createGLTFLoaderWithDraco } from './gltf-loader-draco.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { resolveModelAssetHref } from './asset-resolve.js';

class PlayerManager {
    constructor(scene) {
        this.scene = scene;
        this.localPlayer = null;
        this.remotePlayers = new Map();
        this.gltfLoader = createGLTFLoaderWithDraco();
        /** @type {{ scene: THREE.Group, animations: THREE.AnimationClip[] } | null} */
        this.avatarModelCache = null;
        /** アバター GLB が未設定時のフォールバック（/api/active-avatar が空のとき） */
        this.avatarPath = 'models/avatar.glb';
        /** Avatar GLB scale (change to resize model) */
        this.avatarScale = { x: 1.5, y: 1.5, z: 1.5 };
        this._headWorldOffset = new THREE.Vector3(0, 0.08, 0);
    }

    /**
     * アクティブアバター URL を解決する（署名 URL / CDN / オリジンフォールバック）
     * @returns {Promise<string>}
     */
    async resolveAvatarGltfUrl() {
        try {
            const r = await fetch('/api/active-avatar', { credentials: 'include' });
            if (r.ok) {
                const j = await r.json();
                if (typeof j.signedUrl === 'string' && j.signedUrl.length > 0) {
                    return j.signedUrl;
                }
                if (typeof j.path === 'string' && j.path.length > 0) {
                    return resolveModelAssetHref(j.path);
                }
            }
        } catch {
            /* fall through */
        }
        return resolveModelAssetHref(this.avatarPath);
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

        const url = await this.resolveAvatarGltfUrl();
        return new Promise((resolve, reject) => {
            this.gltfLoader.load(
                url,
                (gltf) => {
                    const animations = gltf.animations || [];
                    this.avatarModelCache = { scene: gltf.scene, animations };
                    console.log('Avatar model loaded:', url, 'animations:', animations.length);

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
            this.localPlayer.userData.headBone = this.findHeadBone(avatarModel);
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
            this.localPlayer.userData.headBone = this.localPlayer.children[0] || null;
            this.scene.add(this.localPlayer);
            console.log('Local player created with placeholder');
        }
    }

    /**
     * アバター階層から頭部ボーンを探索する。
     * @param {THREE.Object3D} root
     * @returns {THREE.Object3D | null}
     */
    findHeadBone(root) {
        let headBone = null;
        root.traverse((obj) => {
            if (headBone) return;
            if (!obj.isBone) return;
            const n = String(obj.name || '').toLowerCase();
            if (n.includes('head')) headBone = obj;
        });
        return headBone;
    }

    /**
     * ローカルプレイヤーの頭部ワールド座標を返す。
     * @param {THREE.Vector3} out
     * @returns {boolean}
     */
    getLocalHeadWorldPosition(out) {
        if (!this.localPlayer || !out) return false;
        const head = this.localPlayer.userData.headBone;
        if (head && typeof head.getWorldPosition === 'function') {
            head.getWorldPosition(out);
            out.add(this._headWorldOffset);
            return true;
        }
        this.localPlayer.getWorldPosition(out);
        out.y += 1.65;
        return true;
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
        player.userData.networkVisible = !!visible;
        const distOk = player.userData.distanceVisible !== false;
        player.visible = !!visible && distOk;
    }

    /**
     * 自プレイヤー足元からの距離でリモートアバターの表示を切り替える（networkVisible と AND）
     * @param {{ x: number, y: number, z: number }} localFeetWorld
     * @param {number} maxDist
     */
    updateRemoteDrawDistance(localFeetWorld, maxDist) {
        if (!localFeetWorld || !Number.isFinite(maxDist)) return;
        const p = new THREE.Vector3(localFeetWorld.x, localFeetWorld.y, localFeetWorld.z);
        for (const player of this.remotePlayers.values()) {
            const d = p.distanceTo(player.position);
            const distOk = d <= maxDist;
            player.userData.distanceVisible = distOk;
            const netOk = player.userData.networkVisible !== false;
            player.visible = netOk && distOk;
        }
    }

    /**
     * @param {string} playerId
     * @param {{ x: number, y: number, z: number }} [position]
     * @param {string|null} [username]
     * @param {'idle'|'walk'|'dash'|'jump'} [animState]
     */
    async createRemotePlayer(playerId, position = { x: 0, y: 2, z: 0 }, username = null, animState = 'idle') {
        console.log(`Creating remote player: ${playerId}`);
        
        const displayName = username || `Player ${playerId.substring(0, 4)}`;
        
        // Create placeholder first (immediate visual feedback)
        const placeholder = this.createPlaceholder(0xff6600);
        placeholder.position.set(position.x, position.y, position.z);
        placeholder.userData.playerId = playerId;
        placeholder.userData.username = displayName;
        placeholder.userData.isLoading = true;
        placeholder.userData.networkAnimState = 'idle';
        
        // Add name tag to placeholder
        this.addNameTag(placeholder, displayName);
        
        placeholder.userData.networkVisible = true;
        placeholder.userData.distanceVisible = true;
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
            if (anim) {
                remotePlayer.userData.mixer = anim.mixer;
                remotePlayer.userData.avatarActions = anim.actions;
                remotePlayer.userData.animationState = 'idle';
                this.attachRemoteJumpFinishedListener(remotePlayer);
            }

            remotePlayer.userData.playerId = playerId;
            remotePlayer.userData.username = displayName;
            remotePlayer.userData.isLoading = false;
            remotePlayer.userData.networkAnimState = 'idle';
            remotePlayer.userData.networkVisible = placeholder.userData.networkVisible !== false;
            remotePlayer.userData.distanceVisible = placeholder.userData.distanceVisible !== false;
            
            // Transfer name tag from placeholder to new avatar
            const nameTag = placeholder.children.find(child => child instanceof THREE.Sprite);
            if (nameTag) {
                placeholder.remove(nameTag);
                remotePlayer.add(nameTag);
            }
            
            // Replace placeholder with GLB avatar
            this.scene.remove(placeholder);
            remotePlayer.visible =
                remotePlayer.userData.networkVisible !== false &&
                remotePlayer.userData.distanceVisible !== false;
            this.scene.add(remotePlayer);
            this.remotePlayers.set(playerId, remotePlayer);

            this.applyRemoteAnimationStateFromNetwork(remotePlayer, animState);
            
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
            this.pollRemoteJumpFinished(player);
        });
    }

    /**
     * ジャンプ clip 終端の検出（mixer の finished が来ない環境・paused 時の crossFade 不整合のフォールバック）
     * @param {THREE.Object3D} player
     */
    pollRemoteJumpFinished(player) {
        if (!player.userData.avatarActions?.jump) return;
        if ((player.userData.animationState || 'idle') !== 'jump') return;

        const ja = player.userData.avatarActions.jump;
        const clip = ja.getClip();
        if (!clip || clip.duration <= 0) return;

        const dur = clip.duration;
        const t = ja.time;
        if (ja.paused && t >= dur - 0.1) {
            this.onRemoteJumpClipFinished(player);
            return;
        }
        if (dur >= 0.2 && t >= dur - 0.025) {
            this.onRemoteJumpClipFinished(player);
        }
    }

    /**
     * リモートアバターのアニメ・移動判定デバッグログ
     * @param {THREE.Object3D} player
     * @param {string} message
     * @param {Record<string, unknown>} [extra]
     */
    logRemoteAnim(player, message, extra = {}) {
        const id = player?.userData?.playerId ?? 'unknown';
        console.log(`[RemoteAnim] playerId=${id} ${message}`, extra);
    }

    /**
     * サーバー同期の animState を反映する（他プレイヤー用）
     * @param {THREE.Object3D} player
     * @param {string} animStateRaw
     */
    applyRemoteAnimationStateFromNetwork(player, animStateRaw) {
        const actions = player.userData.avatarActions;
        if (!actions) return;
        const valid = ['idle', 'walk', 'dash', 'jump'];
        const s = valid.includes(animStateRaw) ? animStateRaw : 'idle';
        player.userData.networkAnimState = s;
        this.applyRemoteLocomotionActionTransition(player, s, actions);
        const applied = player.userData.animationState || 'idle';
        if (applied === 'walk' || applied === 'dash') {
            this.ensureRemoteLocomotionActionActive(player, applied, actions);
        }
    }

    /**
     * jump クリップ終了時。サーバーがまだ jump のときは一旦 idle へ（次の同期で上書き）
     * @param {THREE.Object3D} player
     */
    onRemoteJumpClipFinished(player) {
        const actions = player.userData.avatarActions;
        if (!actions) return;
        if ((player.userData.animationState || 'idle') !== 'jump') return;
        let target = player.userData.networkAnimState || 'idle';
        const valid = ['idle', 'walk', 'dash', 'jump'];
        if (!valid.includes(target)) target = 'idle';
        if (target === 'jump') target = 'idle';
        this.applyRemoteLocomotionActionTransition(player, target, actions);
        if (target === 'walk' || target === 'dash') {
            this.ensureRemoteLocomotionActionActive(player, target, actions);
        }
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
                    const phase = newState === 'idle' ? '待機中' : '移動中';
                    console.log('[RemoteAnim] playerId=local アニメ遷移', {
                        phase,
                        anim: newState,
                        prevAnim: currentState,
                        movementState: {
                            isMoving: movementState.isMoving,
                            isDashing: movementState.isDashing,
                            isGrounded: movementState.isGrounded
                        }
                    });
                }
            }
        }
    }

    /**
     * @param {THREE.Object3D} player
     */
    attachRemoteJumpFinishedListener(player) {
        const actions = player.userData.avatarActions;
        const mixer = player.userData.mixer;
        if (!actions?.jump || !mixer) return;
        const jumpAction = actions.jump;
        const onFinished = (e) => {
            if (e?.type !== 'finished' || e.action !== jumpAction) return;
            if ((player.userData.animationState || 'idle') !== 'jump') return;
            this.onRemoteJumpClipFinished(player);
        };
        mixer.addEventListener('finished', onFinished);
        player.userData._remoteJumpFinishedListener = onFinished;
    }

    /**
     * リモートの idle/walk/dash/jump を切り替える。
     * walk へは Three.js の crossFadeTo を使わず fadeIn のみとし、clip の time を維持してループが頭から切り替わらないようにする。
     * @param {THREE.Object3D} player
     * @param {'idle'|'walk'|'dash'|'jump'} newState
     * @param {*} actions avatarActions（idle / walk / dash / jump）
     */
    applyRemoteLocomotionActionTransition(player, newState, actions) {
        const currentState = player.userData.animationState || 'idle';
        if (newState === currentState) return;

        const cur = actions[currentState];
        const next = actions[newState];
        if (!next) return;

        const duration = 0.15;

        if (newState === 'jump' && actions.jump) {
            actions.jump.reset();
            if (cur) {
                cur.crossFadeTo(actions.jump, duration);
            } else {
                actions.jump.play();
                actions.jump.fadeIn(duration);
            }
            player.userData.animationState = 'jump';
            return;
        }

        if (currentState === 'jump' && newState !== 'jump' && actions.jump) {
            const j = actions.jump;
            j.fadeOut(duration);
            if (newState === 'walk') {
                next.play();
                next.fadeIn(duration);
            } else {
                next.reset();
                next.play();
                next.fadeIn(duration);
            }
            player.userData.animationState = newState;
            return;
        }

        if (newState === 'walk' && (currentState === 'idle' || currentState === 'dash')) {
            if (cur) {
                cur.fadeOut(duration);
            }
            next.play();
            next.fadeIn(duration);
            player.userData.animationState = 'walk';
            return;
        }

        if (cur) {
            cur.crossFadeTo(next, duration);
        } else {
            next.reset().play();
        }
        player.userData.animationState = newState;
    }

    /**
     * userData は walk/dash だが AnimationAction の weight が低いとき、他をフェードアウトして再生を立て直す（dash→dash で apply がスキップされる場合の補修）
     * @param {THREE.Object3D} player
     * @param {'idle'|'walk'|'dash'|'jump'} target
     * @param {*} actions
     */
    ensureRemoteLocomotionActionActive(player, target, actions) {
        if (!actions || target === 'idle' || target === 'jump') return;
        const main = actions[target];
        if (!main) return;

        const w = main.getEffectiveWeight();
        const running = typeof main.isRunning === 'function' ? main.isRunning() : true;
        if (w > 0.4 && running) return;

        const d = 0.12;
        const others = ['idle', 'walk', 'dash'];
        for (let i = 0; i < others.length; i++) {
            const key = others[i];
            if (key === target) continue;
            const a = actions[key];
            if (a) {
                a.fadeOut(d);
            }
        }

        main.paused = false;
        main.enabled = true;
        main.play();
        main.fadeIn(d);

        if (!player.userData._remoteRepairLogAt || performance.now() > player.userData._remoteRepairLogAt) {
            player.userData._remoteRepairLogAt = performance.now() + 2000;
            this.logRemoteAnim(player, 'locomotion アクション再同期（weight 低下時）', {
                target,
                effectiveWeightBefore: w,
                wasRunning: running
            });
        }
    }

    /**
     * @param {string} playerId
     * @param {{ x: number, y: number, z: number }} position
     * @param {{ x: number, y: number, z: number, w?: number }} rotation
     * @param {string|null} [username]
     * @param {string} [animState]
     */
    updateRemotePlayer(playerId, position, rotation, username = null, animState = 'idle') {
        const player = this.remotePlayers.get(playerId);
        if (!player) return;

        this.applyRemoteAnimationStateFromNetwork(player, animState);

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

        if (player.userData.mixer && player.userData._remoteJumpFinishedListener) {
            player.userData.mixer.removeEventListener('finished', player.userData._remoteJumpFinishedListener);
            player.userData._remoteJumpFinishedListener = null;
        }

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
        const ids = [...this.remotePlayers.keys()];
        for (const id of ids) {
            this.removeRemotePlayer(id);
        }
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
