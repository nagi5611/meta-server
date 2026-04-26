import * as THREE from 'three';

/** 1 イベントあたりのヨー（左右）回転の上限（ラジアン） */
const MAX_YAW_VIEW_DELTA_PER_EVENT_RAD = (10 * Math.PI) / 180;
/** 1 イベントあたりのピッチ（上下）回転の上限（ラジアン） */
const MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD = (15 * Math.PI) / 180;

/**
 * マウス movement 等のヨー差分を 1 フレームあたりの上限内に抑える
 * @param {number} deltaRad
 * @returns {number}
 */
function clampYawViewDeltaPerEventRad(deltaRad) {
    return THREE.MathUtils.clamp(
        deltaRad,
        -MAX_YAW_VIEW_DELTA_PER_EVENT_RAD,
        MAX_YAW_VIEW_DELTA_PER_EVENT_RAD
    );
}

/**
 * 上下方向の回転差分を 1 フレームあたり ±15° 以内に抑える
 * @param {number} deltaRad
 * @returns {number}
 */
function clampPitchViewDeltaPerEventRad(deltaRad) {
    return THREE.MathUtils.clamp(
        deltaRad,
        -MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD,
        MAX_PITCH_VIEW_DELTA_PER_EVENT_RAD
    );
}

/** 初回入力で物理再開する対象キー（ロード完了〜操作まで落下させない） */
const GAMEPLAY_KEY_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyE'
]);

class CharacterController {
    constructor(camera, physicsManager, options = {}) {
        this.camera = camera;
        this.physicsManager = physicsManager;

        // Movement state
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.keysShift = false;

        // Mobile input state
        this.isMobileMode = options.isMobileMode ?? false;
        this.mobileMoveVector = { x: 0, y: 0 };
        this.mobileMoveForce = 0;
        this.mobileCameraDelta = { x: 0, y: 0 };

        // Movement parameters
        this.moveSpeed = 2.8;  // 2x faster
        this.dashSpeedMultiplier = 2;  // Shift dash speed

        // Third-person camera parameters
        this.cameraDistance = 5;  // Distance behind player
        this.cameraHeight = 2;    // Height above player
        this.cameraYaw = 0;       // Horizontal camera rotation (radians)
        this.cameraPitch = -0.3;  // Vertical camera angle (radians, slightly looking down)
        this.mouseSensitivity = 0.002;
        this.isPointerLocked = false;
        this.isFirstPersonView = false;
        this.getHeadWorldPosition = null;

        // Player orientation
        this.playerYaw = 0;  // Player's facing direction (radians)
        this.playerQuaternion = new THREE.Quaternion();

        // Movement direction
        this.direction = new THREE.Vector3();
        /** 三人称カメラの理想位置（衝突クランプ前） */
        this._desiredCameraWorld = new THREE.Vector3();
        this._firstPersonHeadWorld = new THREE.Vector3();
        this._firstPersonLookTarget = new THREE.Vector3();

        // Admin controls
        this.isFlyMode = false;
        this.adminSpeedMultiplier = 1;
        this.flyUp = false;
        this.flyDown = false;

        /** WebXR 没入中はカメラ操作をスキップし、移動は HMD＋リグヨー基準 */
        this.xrPresenting = false;
        this.xrMoveVector = { x: 0, y: 0 };
        this.xrMoveForce = 0;
        /** スナップターン累積（ラジアン）。移動の前方向に適用 */
        this.xrRigYaw = 0;
        this._xrVrSpeedScale = 0.72;
        this._xrUp = new THREE.Vector3(0, 1, 0);
        this._xrHeadFwd = new THREE.Vector3();
        this._xrMoveFwd = new THREE.Vector3();
        this._xrMoveRight = new THREE.Vector3();
        this._xrRigQuat = new THREE.Quaternion();

        /** true の間は歩行物理（重力・BVH 移動）を回さない。初回ゲーム入力で false に戻す */
        this._suspendPhysicsUntilGameplayInput = false;

        /** 飛行機操縦中: getPosition/getRotation を委譲し update をスキップ */
        this._aircraftPoseProvider = null;
        this._aircraftFeetScratch = new THREE.Vector3();

        this.setupControls();
    }

    /**
     * 操縦中は歩行・マウス視点を無効化し、同期位置を委譲する
     * @param {{ getPosition: (out?: THREE.Vector3) => THREE.Vector3|null, getQuaternion: (out?: THREE.Quaternion) => THREE.Quaternion|null }|null} provider
     */
    setAircraftPoseProvider(provider) {
        this._aircraftPoseProvider = provider && typeof provider.getPosition === 'function'
            ? provider
            : null;
        if (this._aircraftPoseProvider && document.pointerLockElement) {
            document.exitPointerLock();
        }
    }

    /**
     * 歩行キャラとして処理するか（機体操縦・搭乗中は false）
     * @returns {boolean}
     */
    isWalkingCharacter() {
        return this._aircraftPoseProvider == null;
    }

    /**
     * メタバース入室直後など: 初回の移動系入力まで落下・歩行物理を止める
     * @param {boolean} suspended
     */
    setSuspendPhysicsUntilGameplayInput(suspended) {
        this._suspendPhysicsUntilGameplayInput = !!suspended;
        if (suspended) {
            this.physicsManager.resetVelocity();
        }
    }

    /**
     * 移動・ジャンプ・クリック等で物理再開（複数回呼んでも一度だけ有効）
     */
    notifyGameplayInputIntent() {
        if (!this._suspendPhysicsUntilGameplayInput) return;
        this._suspendPhysicsUntilGameplayInput = false;
        this.physicsManager.playerVelocity.set(0, 0, 0);
        this.physicsManager.probeGroundedAtFeet();
    }

    /**
     * WebXR セッションの有無（main / WebXRLocomotion から設定）
     * @param {boolean} presenting
     */
    setXrPresenting(presenting) {
        const next = !!presenting;
        if (this.xrPresenting === next) return;
        this.xrPresenting = next;
        if (!next) {
            this.xrRigYaw = 0;
            this.xrMoveVector.x = 0;
            this.xrMoveVector.y = 0;
            this.xrMoveForce = 0;
        }
    }

    /**
     * VR 用スムーズ移動ベクトル（スティック左右=x、前後=y。WebXRLocomotion が設定）
     * @param {{ x: number, y: number, force?: number }} v
     */
    setXrMoveVector(v) {
        this.xrMoveVector.x = v.x;
        this.xrMoveVector.y = v.y;
        this.xrMoveForce = typeof v.force === 'number' ? Math.min(1, Math.max(0, v.force)) : 1;
    }

    /**
     * スナップターン（ラジアン）
     * @param {number} deltaYaw
     */
    applyXrSnapTurn(deltaYaw) {
        if (!Number.isFinite(deltaYaw)) return;
        this.xrRigYaw += deltaYaw;
    }

    setMobileMode(enabled) {
        this.isMobileMode = enabled;
        if (enabled) {
            this.mobileMoveVector = { x: 0, y: 0 };
            this.mobileMoveForce = 0;
            this.mobileCameraDelta = { x: 0, y: 0 };
        }
    }

    setMobileMove(vector) {
        this.mobileMoveVector.x = vector.x;
        this.mobileMoveVector.y = vector.y;
        this.mobileMoveForce = typeof vector.force === 'number' ? Math.min(1, Math.max(0, vector.force)) : 1;
    }

    addMobileCameraDelta(dx, dy) {
        this.mobileCameraDelta.x += dx;
        this.mobileCameraDelta.y += dy;
    }

    resetMobileCameraDelta() {
        this.mobileCameraDelta.x = 0;
        this.mobileCameraDelta.y = 0;
    }

    trigger() {
        if (this.isInputActive()) return;
        this.notifyGameplayInputIntent();
        this.physicsManager.jump(10.0);
    }

    /**
     * ジャンプ実行（モバイルジャンプボタン用・入力欄チェックなし・移動中も可）
     */
    triggerJump() {
        this.notifyGameplayInputIntent();
        this.physicsManager.jump(10.0);
    }

    setupControls() {
        // Keyboard controls
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Mouse controls - pointer lock (canvas only, skip when mobile mode)
        const canvas = document.getElementById('canvas');
        if (canvas) {
            canvas.addEventListener('click', () => {
                if (this.isMobileMode || this.xrPresenting) return;
                this.notifyGameplayInputIntent();
                if (!this.isPointerLocked) {
                    document.body.requestPointerLock();
                }
            });
        }

        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = document.pointerLockElement === document.body;
        });

        // ポインターロック中はクリックがUIに届かないため、Shift+クリックで解除
        document.addEventListener('mousedown', (e) => {
            if (document.pointerLockElement && (e.shiftKey || e.ctrlKey)) {
                document.exitPointerLock();
            }
        }, true);

        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    }

    onKeyDown(event) {
        if (this._aircraftPoseProvider) {
            if (event.code === 'KeyU' && document.pointerLockElement) document.exitPointerLock();
            return;
        }
        // Ignore keyboard input if user is typing in chat or other input fields
        if (this.isInputActive()) {
            return;
        }
        if (this.xrPresenting) return;

        if (!event.repeat && GAMEPLAY_KEY_CODES.has(event.code)) {
            this.notifyGameplayInputIntent();
        }

        switch (event.code) {
            case 'KeyU':
                if (document.pointerLockElement) document.exitPointerLock();
                break;
            case 'KeyW':
                this.moveForward = true;
                break;
            case 'KeyS':
                this.moveBackward = true;
                break;
            case 'KeyA':
                this.moveLeft = true;
                break;
            case 'KeyD':
                this.moveRight = true;
                break;
            case 'Space':
                if (this.isFlyMode) {
                    this.flyUp = true;
                } else {
                    this.physicsManager.jump(10.0);
                }
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.keysShift = true;
                break;
            case 'KeyC':
                if (this.isFlyMode) {
                    this.flyDown = true;
                }
                break;
        }
    }

    onKeyUp(event) {
        if (this._aircraftPoseProvider) {
            return;
        }
        // Ignore keyboard input if user is typing in chat or other input fields
        if (this.isInputActive()) {
            return;
        }
        if (this.xrPresenting) return;

        switch (event.code) {
            case 'KeyW':
                this.moveForward = false;
                break;
            case 'KeyS':
                this.moveBackward = false;
                break;
            case 'KeyA':
                this.moveLeft = false;
                break;
            case 'KeyD':
                this.moveRight = false;
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.keysShift = false;
                break;
            case 'Space':
                this.flyUp = false;
                break;
            case 'KeyC':
                this.flyDown = false;
                break;
        }
    }

    /**
     * Reset movement keys (e.g. when PDF viewer opens so character stops moving).
     */
    resetMovement() {
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.keysShift = false;
    }

    /**
     * Get movement state for animation (idle / walk / dash / jump)
     * @returns {{ isMoving: boolean, isDashing: boolean, isGrounded: boolean }}
     */
    getMovementState() {
        if (this._aircraftPoseProvider) {
            return { isMoving: false, isDashing: false, isGrounded: true };
        }
        const kbMoving = this.moveForward || this.moveBackward || this.moveLeft || this.moveRight;
        const mobileMoving = this.isMobileMode && (this.mobileMoveVector.x !== 0 || this.mobileMoveVector.y !== 0);
        const xrMoving = this.xrPresenting && (this.xrMoveVector.x !== 0 || this.xrMoveVector.y !== 0);
        const isMoving = kbMoving || mobileMoving || xrMoving;
        const mobileDashing = this.isMobileMode && mobileMoving && this.mobileMoveForce >= 0.85;
        const isGrounded = this.isFlyMode ? true : this.physicsManager.isGrounded();
        return { isMoving, isDashing: (isMoving && this.keysShift) || mobileDashing, isGrounded };
    }

    /**
     * ネットワーク同期用のアニメ状態（idle / walk / dash / jump）。ローカル表示と同じ判定。
     * @returns {'idle'|'walk'|'dash'|'jump'}
     */
    getAnimationState() {
        if (this._aircraftPoseProvider) {
            return 'idle';
        }
        const { isMoving, isDashing, isGrounded } = this.getMovementState();
        if (!isGrounded) return 'jump';
        if (isDashing) return 'dash';
        if (isMoving) return 'walk';
        return 'idle';
    }

    onMouseMove(event) {
        if (this._aircraftPoseProvider) return;
        if (this.xrPresenting) return;
        if (!this.isPointerLocked) return;

        let dYaw = -event.movementX * this.mouseSensitivity;
        let dPitch = -event.movementY * this.mouseSensitivity;
        dYaw = clampYawViewDeltaPerEventRad(dYaw);
        dPitch = clampPitchViewDeltaPerEventRad(dPitch);
        this.cameraYaw += dYaw;
        this.cameraPitch += dPitch;

        // Clamp vertical rotation (prevent camera from going too high or too low)
        this.cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(0.2, this.cameraPitch));
    }

    /**
     * Check if an input field (chat, modal, etc.) is currently active
     */
    isInputActive() {
        const activeElement = document.activeElement;
        
        // Check if user is typing in any input or textarea
        if (activeElement && (
            activeElement.tagName === 'INPUT' || 
            activeElement.tagName === 'TEXTAREA' ||
            activeElement.id === 'chat-input'
        )) {
            return true;
        }

        // Check if any modal is open
        const modals = document.querySelectorAll('.modal.visible');
        if (modals.length > 0) {
            return true;
        }

        // Check if PDF viewer overlay is open
        if (document.body.dataset.pdfViewerOpen === '1') {
            return true;
        }

        return false;
    }

    update(deltaTime) {
        if (this._aircraftPoseProvider) {
            const p = this._aircraftPoseProvider.getPosition(this._aircraftFeetScratch);
            if (p) {
                this.physicsManager.setCharacterPosition(p.x, p.y, p.z);
                this.physicsManager.resetVelocity();
            }
            return;
        }
        if (this.xrPresenting) {
            this._updateXrMovement(deltaTime);
            return;
        }

        // Apply mobile camera delta (right stick) before movement
        if (this.isMobileMode && (this.mobileCameraDelta.x !== 0 || this.mobileCameraDelta.y !== 0)) {
            let dMyaw = -this.mobileCameraDelta.x;
            let dMpitch = -this.mobileCameraDelta.y;
            dMyaw = clampYawViewDeltaPerEventRad(dMyaw);
            dMpitch = clampPitchViewDeltaPerEventRad(dMpitch);
            this.cameraYaw += dMyaw;
            this.cameraPitch += dMpitch;
            this.cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(0.2, this.cameraPitch));
            this.mobileCameraDelta.x = 0;
            this.mobileCameraDelta.y = 0;
        }

        // Calculate movement direction based on camera orientation
        this.direction.set(0, 0, 0);

        // Get camera forward direction (horizontal only)
        // Camera is behind player, so forward is opposite of camera direction
        const cameraForward = new THREE.Vector3(
            -Math.sin(this.cameraYaw),
            0,
            -Math.cos(this.cameraYaw)
        );
        
        const cameraRight = new THREE.Vector3(
            Math.cos(this.cameraYaw),
            0,
            -Math.sin(this.cameraYaw)
        );

        const useMobileMove = this.isMobileMode && (this.mobileMoveVector.x !== 0 || this.mobileMoveVector.y !== 0);
        if (useMobileMove) {
            this.direction.add(cameraForward.clone().multiplyScalar(this.mobileMoveVector.y));
            this.direction.add(cameraRight.clone().multiplyScalar(this.mobileMoveVector.x));
        } else {
            if (this.moveForward) {
                this.direction.add(cameraForward);
            }
            if (this.moveBackward) {
                this.direction.sub(cameraForward);
            }
            if (this.moveLeft) {
                this.direction.sub(cameraRight);
            }
            if (this.moveRight) {
                this.direction.add(cameraRight);
            }
        }

        // Update player rotation based on movement direction
        if (this.direction.length() > 0) {
            this.direction.normalize();
            // Player faces the movement direction
            this.playerYaw = Math.atan2(this.direction.x, this.direction.z);
            this.playerQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.playerYaw);
        }

        // Apply movement (dash・管理者高速移動を含む)
        const moveDirection = new THREE.Vector3();
        if (this.direction.length() > 0) {
            let speed;
            if (useMobileMove && this.isMobileMode) {
                const f = this.mobileMoveForce;
                if (f < 0.5) {
                    speed = this.moveSpeed * this.adminSpeedMultiplier * (0.5 + 0.6 * (f / 0.5));
                } else {
                    speed = this.moveSpeed * this.adminSpeedMultiplier * (0.8 + 1.2 * ((f - 0.5) / 0.5));
                }
            } else {
                const base = this.keysShift ? this.moveSpeed * this.dashSpeedMultiplier : this.moveSpeed;
                speed = base * this.adminSpeedMultiplier;
            }
            moveDirection.copy(this.direction).multiplyScalar(speed * deltaTime);
        }

        if (this.isFlyMode) {
            // 飛行モード: 重力・落下を使わず、そのまま座標を更新
            const pos = this.physicsManager.getCharacterPosition().clone();
            pos.add(moveDirection);
            const flySpeed = this.moveSpeed * this.adminSpeedMultiplier * 2;
            if (this.flyUp) pos.y += flySpeed * deltaTime;
            if (this.flyDown) pos.y -= flySpeed * deltaTime;
            this.physicsManager.setCharacterPosition(pos.x, pos.y, pos.z);
            this.physicsManager.resetVelocity();
        } else if (this._suspendPhysicsUntilGameplayInput) {
            this.physicsManager.playerVelocity.set(0, 0, 0);
        } else {
            // 通常モード: 物理エンジンで移動
            this.physicsManager.updatePlayer(deltaTime, moveDirection);
        }

        // Update camera position (third-person / first-person view)
        const characterPos = this.physicsManager.getCharacterPosition();
        if (this.isFirstPersonView) {
            const headWorld = this._firstPersonHeadWorld;
            if (typeof this.getHeadWorldPosition === 'function' && this.getHeadWorldPosition(headWorld)) {
                // PlayerManager から取得できた頭部位置を使用
            } else {
                headWorld.set(characterPos.x, characterPos.y + 1.65, characterPos.z);
            }
            this.camera.position.copy(headWorld);

            const forward = new THREE.Vector3(
                -Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch),
                Math.sin(this.cameraPitch),
                -Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch)
            ).normalize();
            this._firstPersonLookTarget.copy(headWorld).add(forward);
            this.camera.lookAt(this._firstPersonLookTarget);
            return;
        }

        // Calculate camera position behind and above player
        const cameraOffset = new THREE.Vector3(
            Math.sin(this.cameraYaw) * this.cameraDistance * Math.cos(this.cameraPitch),
            this.cameraHeight - this.cameraDistance * Math.sin(this.cameraPitch),
            Math.cos(this.cameraYaw) * this.cameraDistance * Math.cos(this.cameraPitch)
        );

        const lookAtTarget = new THREE.Vector3(
            characterPos.x,
            characterPos.y + 1.0,
            characterPos.z
        );

        this._desiredCameraWorld.copy(characterPos).add(cameraOffset);
        if (this.isFlyMode) {
            this.camera.position.copy(this._desiredCameraWorld);
        } else {
            this.physicsManager.clampThirdPersonCameraPosition(
                lookAtTarget,
                this._desiredCameraWorld,
                this.camera.position
            );
        }

        this.camera.lookAt(lookAtTarget);
    }

    /**
     * WebXR 中: 物理移動のみ。カメラ姿勢は WebXRManager が更新し、ワールド位置は XrPlayerRig が足元に同期する。
     * @param {number} deltaTime
     */
    _updateXrMovement(deltaTime) {
        this.direction.set(0, 0, 0);

        const headFwd = this._xrHeadFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        headFwd.y = 0;
        if (headFwd.lengthSq() < 1e-8) {
            headFwd.set(0, 0, -1);
        } else {
            headFwd.normalize();
        }

        this._xrRigQuat.setFromAxisAngle(this._xrUp, this.xrRigYaw);
        const moveFwd = this._xrMoveFwd.copy(headFwd).applyQuaternion(this._xrRigQuat);
        const moveRight = this._xrMoveRight.crossVectors(this._xrUp, moveFwd).normalize();

        const useXrMove = this.xrMoveVector.x !== 0 || this.xrMoveVector.y !== 0;
        if (useXrMove) {
            this.direction.add(moveFwd.clone().multiplyScalar(this.xrMoveVector.y));
            this.direction.add(moveRight.clone().multiplyScalar(this.xrMoveVector.x));
        }

        if (this.direction.length() > 0) {
            this.direction.normalize();
            this.playerYaw = Math.atan2(this.direction.x, this.direction.z);
            this.playerQuaternion.setFromAxisAngle(this._xrUp, this.playerYaw);
        }

        const moveDirection = new THREE.Vector3();
        if (this.direction.length() > 0) {
            const speed = this.moveSpeed * this.adminSpeedMultiplier * this._xrVrSpeedScale * this.xrMoveForce;
            moveDirection.copy(this.direction).multiplyScalar(speed * deltaTime);
        }

        if (this.isFlyMode) {
            const pos = this.physicsManager.getCharacterPosition().clone();
            pos.add(moveDirection);
            const flySpeed = this.moveSpeed * this.adminSpeedMultiplier * 2;
            if (this.flyUp) pos.y += flySpeed * deltaTime;
            if (this.flyDown) pos.y -= flySpeed * deltaTime;
            this.physicsManager.setCharacterPosition(pos.x, pos.y, pos.z);
            this.physicsManager.resetVelocity();
        } else if (this._suspendPhysicsUntilGameplayInput) {
            this.physicsManager.playerVelocity.set(0, 0, 0);
        } else {
            this.physicsManager.updatePlayer(deltaTime, moveDirection);
        }
    }

    getPosition() {
        if (this._aircraftPoseProvider) {
            const p = this._aircraftPoseProvider.getPosition(this._aircraftFeetScratch);
            if (p) return p;
        }
        return this.physicsManager.getCharacterPosition();
    }

    setPosition(x, y, z) {
        this.physicsManager.setCharacterPosition(x, y, z);
    }

    resetVelocity() {
        this.physicsManager.resetVelocity();
    }

    getRotation() {
        if (this._aircraftPoseProvider && typeof this._aircraftPoseProvider.getQuaternion === 'function') {
            const q = this._aircraftPoseProvider.getQuaternion(this.playerQuaternion);
            if (q) return q;
        }
        // Return player's facing direction (not camera quaternion)
        return this.playerQuaternion;
    }

    /**
     * 管理者用: 飛行モードON/OFF
     * @param {boolean} enabled
     */
    setFlyMode(enabled) {
        this.isFlyMode = !!enabled;
        if (!this.isFlyMode) {
            this.flyUp = false;
            this.flyDown = false;
            this.physicsManager.resetVelocity();
        }
    }

    /**
     * 管理者用: 移動速度倍率を設定（1が通常）
     * @param {number} multiplier
     */
    setAdminSpeedMultiplier(multiplier) {
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
            this.adminSpeedMultiplier = 1;
            return;
        }
        this.adminSpeedMultiplier = multiplier;
    }

    /**
     * 視点モードを設定する。
     * @param {'first'|'third'} mode
     */
    setViewMode(mode) {
        this.isFirstPersonView = mode === 'first';
    }

    /**
     * 頭部ワールド座標の取得関数を設定する。
     * @param {(out: THREE.Vector3) => boolean} fn
     */
    setHeadPositionProvider(fn) {
        this.getHeadWorldPosition = typeof fn === 'function' ? fn : null;
    }
}

export default CharacterController;
